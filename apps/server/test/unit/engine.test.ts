import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pulseflow/contracts';
import { makeTempDir, removeDir } from '@pulseflow/testing';
import { chain, edge, node } from '@pulseflow/templates';
import { runWorkflow, startTestHost, stepSummary, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

const g = (nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph => ({ schemaVersion: 1, nodes, edges });
const manual = (data: Record<string, unknown> = {}) => node('t', 'core.manualTrigger', 'Start', 0, 0, { sampleData: data });

async function create(graph: WorkflowGraph, settings: Record<string, unknown> = {}): Promise<string> {
  const res = await host.api<{ id: string }>('POST', '/api/workflows', { name: `wf-${crypto.randomUUID().slice(0, 8)}`, draft: graph, settings });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id;
}

describe('execution engine (through the host)', () => {
  it('runs a linear chain and persists every step with its output', async () => {
    const id = await create(g([manual({ a: 2 }), node('s', 'core.set', 'Double', 1, 0, { fields: [{ name: 'b', value: '{{ $json.a * 2 }}' }], keepExisting: true })], chain('t', 's')));
    const { execution, steps } = await runWorkflow(host, id);
    expect(execution.state, stepSummary(steps)).toBe('succeeded');
    expect(steps.map((s) => s.nodeId)).toEqual(['t', 's']);
    expect(steps[1]!.output?.main?.[0]?.json).toEqual({ a: 2, b: 4 });
    const list = await host.api<{ id: string }[]>('GET', `/api/executions?workflowId=${id}`);
    expect(list.body.map((e) => e.id)).toContain(execution.id);
  });

  it('routes IF branches and skips the branch without items', async () => {
    const id = await create(
      g(
        [manual({ n: 5 }), node('if', 'core.if', 'Big?', 1, 0, { conditions: [{ left: '{{ $json.n }}', operator: 'gt', right: '3' }] }), node('yes', 'core.noop', 'Yes', 2, 0), node('no', 'core.noop', 'No', 2, 1)],
        [edge('t', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false')],
      ),
    );
    const { execution, steps } = await runWorkflow(host, id);
    expect(execution.state).toBe('succeeded');
    expect(steps.find((s) => s.nodeId === 'yes')?.state).toBe('succeeded');
    expect(steps.find((s) => s.nodeId === 'no')?.state ?? 'skipped').toBe('skipped');
  });

  it('retries with backoff and records each attempt', async () => {
    const id = await create(
      g([manual(), node('h', 'core.httpRequest', 'Flaky', 1, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/flaky?failures=2&key={{ $execution.id }}', failOnError: true, timeoutMs: 5000 }, { retry: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, jitter: false } })], chain('t', 'h')),
    );
    const started = Date.now();
    const { execution, steps } = await runWorkflow(host, id);
    expect(execution.state, stepSummary(steps)).toBe('succeeded');
    const attempts = steps.filter((s) => s.nodeId === 'h');
    expect(attempts.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(attempts.slice(0, 2).every((s) => s.state === 'retrying' && s.error?.code === 'HTTP_503')).toBe(true);
    expect(attempts.slice(0, 2).map((s) => s.retryInMs)).toEqual([100, 200]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('fails after exhausting retries and continues when onError=continue', async () => {
    const failing = (extra: Record<string, unknown>) => node('h', 'core.httpRequest', 'Always 500', 1, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/api/error', failOnError: true }, { retry: { maxAttempts: 2, initialDelayMs: 10, jitter: false }, ...extra });
    const stopId = await create(g([manual(), failing({}), node('after', 'core.noop', 'After', 2, 0)], chain('t', 'h', 'after')));
    const stopped = await runWorkflow(host, stopId);
    expect(stopped.execution.state).toBe('failed');
    expect(stopped.execution.error?.code).toBe('HTTP_500');
    expect(stopped.steps.some((s) => s.nodeId === 'after' && s.state === 'succeeded')).toBe(false);

    const contId = await create(g([manual(), failing({ onError: 'continue' }), node('after', 'core.noop', 'After', 2, 0)], chain('t', 'h', 'after')));
    const cont = await runWorkflow(host, contId);
    expect(cont.execution.state).toBe('succeeded');
    expect(cont.steps.find((s) => s.nodeId === 'after')?.output?.main?.[0]?.json.error).toBeTruthy();
  });

  it('routes errors to the error port when onError=route', async () => {
    const id = await create(
      g(
        [manual(), node('h', 'core.httpRequest', 'Fails', 1, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/api/error', failOnError: true }, { onError: 'route' }), node('ok', 'core.noop', 'OK', 2, 0), node('handler', 'core.noop', 'Handle', 2, 1)],
        [edge('t', 'h'), edge('h', 'ok'), edge('h', 'handler', 'error')],
      ),
    );
    const { execution, steps } = await runWorkflow(host, id);
    expect(execution.state).toBe('succeeded');
    expect(steps.find((s) => s.nodeId === 'handler')?.state).toBe('succeeded');
    expect(steps.find((s) => s.nodeId === 'ok')?.state ?? 'skipped').toBe('skipped');
  });

  it('enforces node timeouts', async () => {
    const id = await create(g([manual(), node('slow', 'core.httpRequest', 'Slow', 1, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/api/slow', timeoutMs: 300 })], chain('t', 'slow')));
    const { execution, steps } = await runWorkflow(host, id);
    expect(execution.state).toBe('failed');
    expect(steps.at(-1)?.error?.code).toMatch(/TIMEOUT/);
  });

  it('cancels a running execution', async () => {
    const id = await create(g([manual(), node('w', 'core.wait', 'Wait', 1, 0, { amount: 5, unit: 'seconds' }), node('after', 'core.noop', 'After', 2, 0)], chain('t', 'w', 'after')));
    const run = await host.api<{ executionId: string }>('POST', `/api/workflows/${id}/run`, {});
    await new Promise((r) => setTimeout(r, 300));
    const c = await host.api('POST', `/api/executions/${run.body.executionId}/cancel`, {});
    expect(c.status).toBe(200);
    const done = await host.ctx.executions.waitFor(run.body.executionId, 10_000);
    expect(done.state).toBe('cancelled');
    expect(host.ctx.store.steps.list(done.id).some((s) => s.nodeId === 'after')).toBe(false);
  });

  it('passes items through disabled nodes', async () => {
    const id = await create(g([manual({ v: 1 }), { ...node('x', 'core.set', 'Disabled', 1, 0, { fields: [{ name: 'v', value: '2' }] }), disabled: true }, node('end', 'core.noop', 'End', 2, 0)], chain('t', 'x', 'end')));
    const { steps } = await runWorkflow(host, id);
    expect(steps.find((s) => s.nodeId === 'end')?.output?.main?.[0]?.json).toEqual({ v: 1 });
  });

  it('rejects invalid graphs (cycles, unknown nodes, bad expressions) before running', async () => {
    const cyc = await create(g([manual(), node('a', 'core.noop', 'A', 1, 0), node('b', 'core.noop', 'B', 2, 0)], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')]));
    const r1 = await host.api<{ error: { code: string; details: { code: string }[] } }>('POST', `/api/workflows/${cyc}/run`, {});
    expect(r1.status).toBe(422);
    expect(r1.body.error.details.map((d) => d.code)).toContain('CYCLE');
    const bad = await create(g([manual(), node('a', 'core.set', 'A', 1, 0, { fields: [{ name: 'x', value: '{{ 1 + }}' }] }), node('u', 'vendor.unknown', 'U', 2, 0)], chain('t', 'a', 'u')));
    const r2 = await host.api<{ issues: { code: string }[] }>('POST', `/api/workflows/${bad}/validate`, {});
    expect(r2.body.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EXPRESSION_SYNTAX', 'UNKNOWN_NODE_TYPE']));
  });

  it('runs sub-workflows and returns their final items', async () => {
    const child = await create(g([node('c', 'core.workflowCalledTrigger', 'Called', 0, 0), node('s', 'core.set', 'Mark', 1, 0, { fields: [{ name: 'fromChild', value: '{{ true }}' }], keepExisting: true })], chain('c', 's')));
    await host.api('POST', `/api/workflows/${child}/publish`, { note: 'v1' });
    const parent = await create(g([manual({ x: 1 }), node('call', 'core.executeWorkflow', 'Call Child', 1, 0, { workflowId: child, mode: 'once' })], chain('t', 'call')));
    const { execution, steps } = await runWorkflow(host, parent);
    expect(execution.state, stepSummary(steps)).toBe('succeeded');
    expect(steps.find((s) => s.nodeId === 'call')?.output?.main?.[0]?.json).toEqual({ x: 1, fromChild: true });
  });

  it('retries from the failed node, reusing earlier outputs', async () => {
    const id = await create(
      g([manual(), node('stamp', 'core.set', 'Stamp', 1, 0, { fields: [{ name: 'stampedAt', value: '{{ $now }}' }] }), node('h', 'core.httpRequest', 'Flaky once', 2, 0, { method: 'GET', url: '{{ $app.fixturesUrl }}/flaky?failures=1&key={{ $json.stampedAt }}', failOnError: true })], chain('t', 'stamp', 'h')),
    );
    const first = await runWorkflow(host, id);
    expect(first.execution.state).toBe('failed');
    const stamp = first.steps.find((s) => s.nodeId === 'stamp')!.output!.main![0]!.json.stampedAt;
    const retry = await host.api<{ executionId: string }>('POST', `/api/executions/${first.execution.id}/retry`, { from: 'failed' });
    const done = await host.ctx.executions.waitFor(retry.body.executionId);
    expect(done.state).toBe('succeeded');
    expect(done.retryOfExecutionId).toBe(first.execution.id);
    const steps = host.ctx.store.steps.list(done.id);
    expect(steps.find((s) => s.nodeId === 'h')?.output?.main?.[0]?.json.url).toContain(encodeURIComponent(String(stamp)).slice(0, 4));
  });

  it('blocks file access outside granted folders', async () => {
    const outside = makeTempDir('pf-outside-');
    try {
      const target = path.join(outside, 'x.txt');
      const id = await create(g([manual(), node('w', 'core.fileWrite', 'Write', 1, 0, { path: target, content: 'hi', mode: 'overwrite' })], chain('t', 'w')));
      const denied = await runWorkflow(host, id);
      expect(denied.execution.state).toBe('failed');
      expect(denied.execution.error?.code).toBe('PERMISSION_DENIED');
      expect(fs.existsSync(target)).toBe(false);
      await host.api('PUT', `/api/workflows/${id}/permissions`, { fs: [{ path: outside, access: 'readwrite' }], allowPrivateNetwork: false, notifications: true, email: false, advancedNodes: false });
      const allowed = await runWorkflow(host, id);
      expect(allowed.execution.state).toBe('succeeded');
      expect(fs.readFileSync(target, 'utf8')).toBe('hi');
    } finally {
      removeDir(outside);
    }
  });

  it('blocks requests to private networks unless permitted', async () => {
    const id = await create(g([manual(), node('h', 'core.httpRequest', 'Metadata', 1, 0, { method: 'GET', url: 'http://169.254.169.254/latest/meta-data', timeoutMs: 1000 })], chain('t', 'h')));
    const { execution } = await runWorkflow(host, id);
    expect(execution.state).toBe('failed');
    expect(execution.error?.code).toBe('NETWORK_DENIED');
  });

  it('keeps advanced nodes disabled unless both the app and the workflow allow them', async () => {
    const id = await create(g([manual(), node('c', 'core.code', 'Code', 1, 0, { code: 'return items;' })], chain('t', 'c')));
    const { execution } = await runWorkflow(host, id);
    expect(execution.state).toBe('failed');
    expect(execution.error?.code).toBe('ADVANCED_DISABLED');
  });
});

describe('durability', () => {
  it('marks runs interrupted by a crash as failed and resumes durable waits after restart', async () => {
    const dataDir = makeTempDir('pf-durable-');
    const masterKey = crypto.randomBytes(32);
    try {
      const h1 = await startTestHost({ dataDir, masterKey });
      const wfRes = await h1.api<{ id: string }>('POST', '/api/workflows', {
        name: 'durable',
        draft: g([manual({ k: 'v' }), node('w', 'core.wait', 'Wait 6s', 1, 0, { amount: 6, unit: 'seconds' }), node('after', 'core.set', 'After', 2, 0, { fields: [{ name: 'resumed', value: '{{ true }}' }], keepExisting: true })], chain('t', 'w', 'after')),
      });
      const run = await h1.api<{ executionId: string }>('POST', `/api/workflows/${wfRes.body.id}/run`, {});
      const waiting = await h1.ctx.executions.waitFor(run.body.executionId);
      expect(waiting.state).toBe('waiting');
      // Simulate a run that was mid-flight when the process died.
      const ghost = h1.ctx.store.executions.create({ workflowId: wfRes.body.id, workflowName: 'durable', versionId: null, triggerNodeId: 't', mode: 'manual', triggerItems: [], graph: waiting.graph, settings: waiting.settings, engineVersion: 'test' });
      h1.ctx.store.executions.setState(ghost.id, 'running');
      await h1.close();

      const h2 = await startTestHost({ dataDir, masterKey });
      try {
        expect(h2.ctx.store.executions.get(ghost.id)?.state).toBe('failed');
        expect(h2.ctx.store.executions.get(ghost.id)?.error?.code).toBe('INTERRUPTED');
        const done = await h2.ctx.executions.waitFor(run.body.executionId, 15_000).then((r) => (r.state === 'waiting' ? new Promise<typeof r>((res) => setTimeout(() => res(h2.ctx.executions.waitFor(r.id, 15_000)), 7000)) : r));
        expect(done.state).toBe('succeeded');
        const after = h2.ctx.store.steps.list(done.id).find((s) => s.nodeId === 'after');
        expect(after?.output?.main?.[0]?.json).toEqual({ k: 'v', resumed: true });
      } finally {
        await h2.close();
      }
    } finally {
      removeDir(dataDir);
    }
  }, 40_000);
});
