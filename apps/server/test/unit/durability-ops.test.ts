import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@pulseflow/contracts';
import { makeTempDir, removeDir } from '@pulseflow/testing';
import { chain, node } from '@pulseflow/templates';
import { DLQ_REPLAY_NS } from '../../src/executions';
import { runWorkflow, startTestHost, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

const g = (nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph => ({ schemaVersion: 1, nodes, edges });

interface Letter {
  id: string;
  workflow_id: string;
  execution_id: string | null;
  reason: string;
  payload: { triggerNodeId?: string; items?: { json: { body?: { msg?: string } } }[] };
}

async function create(graph: WorkflowGraph): Promise<string> {
  const res = await host.api<{ id: string }>('POST', '/api/workflows', { name: `ops-${crypto.randomUUID().slice(0, 8)}`, draft: graph });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id;
}

async function activate(id: string): Promise<string> {
  const act = await host.api('POST', `/api/workflows/${id}/activate`, {});
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  const triggers = await host.api<{ webhookPath?: string }[]>('GET', `/api/workflows/${id}/triggers`);
  return triggers.body.find((t) => t.webhookPath)!.webhookPath!;
}

const letters = async (workflowId: string) => (await host.api<Letter[]>('GET', '/api/dead-letters')).body.filter((d) => d.workflow_id === workflowId);

describe('dead-letter queue', () => {
  it('records failed trigger runs, ignores manual failures, and puts a failed replay back', async () => {
    const id = await create(
      g(
        [
          node('hook', 'core.webhookTrigger', 'Hook', 0, 0, { method: 'POST', responseMode: 'onReceived', auth: 'none' }),
          node('stop', 'core.stopError', 'Stop', 1, 0, { message: 'nope', code: 'RULE' }),
        ],
        chain('hook', 'stop'),
      ),
    );
    const path = await activate(id);
    const posted = await host.api<{ executionId: string }>('POST', path, { msg: 'keep-me' });
    expect(posted.status).toBe(202);
    const failed = await host.ctx.executions.waitFor(posted.body.executionId);
    expect(failed.state).toBe('failed');
    expect(failed.mode).toBe('trigger');

    const queued = await letters(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe('RULE');
    expect(queued[0]!.execution_id).toBe(failed.id);
    expect(queued[0]!.payload.items?.[0]?.json.body?.msg).toBe('keep-me');

    const manual = await runWorkflow(host, id, { items: [{ json: { body: { msg: 'manual' } } }] });
    expect(manual.execution.state).toBe('failed');
    expect(manual.execution.mode).toBe('manual');
    expect(await letters(id)).toHaveLength(1);

    const replay = await host.api<{ executionId: string }>('POST', `/api/dead-letters/${queued[0]!.id}/replay`, {});
    expect(replay.status).toBe(200);
    const again = await host.ctx.executions.waitFor(replay.body.executionId);
    expect(again.state).toBe('failed');
    expect(again.mode).toBe('manual');
    const restored = await letters(id);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).not.toBe(queued[0]!.id);
    expect(restored[0]!.reason).toBe('RULE');
    expect(restored[0]!.execution_id).toBe(again.id);
    expect(restored[0]!.payload.items?.[0]?.json.body?.msg).toBe('keep-me');
    expect(host.ctx.store.kv.get(DLQ_REPLAY_NS, again.id)).toBeUndefined();

    expect((await host.api('DELETE', `/api/dead-letters/${restored[0]!.id}`)).status).toBe(200);
    expect(await letters(id)).toHaveLength(0);
    expect((await host.api('POST', `/api/dead-letters/${restored[0]!.id}/replay`, {})).status).toBe(404);
  });

  it('drops the dead letter when the replay succeeds', async () => {
    const id = await create(
      g(
        [
          node('hook', 'core.webhookTrigger', 'Hook', 0, 0, { method: 'POST', responseMode: 'onReceived', auth: 'none' }),
          node('h', 'core.httpRequest', 'Flaky', 1, 0, {
            method: 'GET',
            url: '{{ $app.fixturesUrl }}/flaky?failures=1&key=dlq-replay-once',
            failOnError: true,
            timeoutMs: 5000,
          }),
        ],
        chain('hook', 'h'),
      ),
    );
    const path = await activate(id);
    const posted = await host.api<{ executionId: string }>('POST', path, { msg: 'once' });
    expect((await host.ctx.executions.waitFor(posted.body.executionId)).state).toBe('failed');
    const letter = (await letters(id))[0]!;
    expect(letter.reason).toBe('HTTP_503');
    const replay = await host.api<{ executionId: string }>('POST', `/api/dead-letters/${letter.id}/replay`, {});
    const done = await host.ctx.executions.waitFor(replay.body.executionId);
    expect(done.state).toBe('succeeded');
    expect(await letters(id)).toHaveLength(0);
    expect(host.ctx.store.kv.get(DLQ_REPLAY_NS, done.id)).toBeUndefined();
  });

  it('moves a trigger to the dead-letter queue when the per-workflow queue is full, then replays it', async () => {
    const limited = await startTestHost({ maxConcurrentExecutions: 1, maxQueuedPerWorkflow: 1 });
    try {
      const res = await limited.api<{ id: string }>('POST', '/api/workflows', {
        name: 'queue-cap',
        draft: g(
          [
            node('hook', 'core.webhookTrigger', 'Hook', 0, 0, { method: 'POST', responseMode: 'onReceived', auth: 'none' }),
            node('wait', 'core.wait', 'Wait', 1, 0, { amount: 3, unit: 'seconds' }),
            node('s', 'core.set', 'Echo', 2, 0, { fields: [{ name: 'msg', value: '{{ $json.body.msg }}' }], keepExisting: true }),
          ],
          chain('hook', 'wait', 's'),
        ),
      });
      expect(res.status).toBe(200);
      const act = await limited.api('POST', `/api/workflows/${res.body.id}/activate`, {});
      expect(act.status, JSON.stringify(act.body)).toBe(200);
      const triggers = await limited.api<{ webhookPath?: string }[]>('GET', `/api/workflows/${res.body.id}/triggers`);
      const path = triggers.body.find((t) => t.webhookPath)!.webhookPath!;
      const post = (msg: string) => limited.api<{ executionId?: string; error?: { code: string } }>('POST', path, { msg });

      const first = await post('one');
      expect(first.status).toBe(202);
      const started = Date.now();
      while (limited.ctx.store.executions.get(first.body.executionId!)?.state !== 'running') {
        if (Date.now() - started > 5000) throw new Error('first run did not start');
        await new Promise((r) => setTimeout(r, 15));
      }
      expect((await post('two')).status).toBe(202);
      const third = await post('three');
      expect(third.status).toBe(429);
      expect(third.body.error?.code).toBe('QUEUE_FULL');

      const queued = (await limited.api<Letter[]>('GET', '/api/dead-letters')).body.filter((d) => d.workflow_id === res.body.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.reason).toBe('QUEUE_FULL');
      expect(queued[0]!.payload.items?.[0]?.json.body?.msg).toBe('three');

      const blocked = await limited.api('POST', `/api/dead-letters/${queued[0]!.id}/replay`, {});
      expect(blocked.status).toBe(429);
      const still = (await limited.api<Letter[]>('GET', '/api/dead-letters')).body.filter((d) => d.workflow_id === res.body.id);
      expect(still).toHaveLength(1);
      expect(still[0]!.payload.items?.[0]?.json.body?.msg).toBe('three');

      await limited.ctx.executions.waitFor(first.body.executionId!);
      const second = limited.ctx.store.executions.list({ workflowId: res.body.id, limit: 10 }).find((e) => e.id !== first.body.executionId);
      await limited.ctx.executions.waitFor(second!.id);

      const replay = await limited.api<{ executionId: string }>('POST', `/api/dead-letters/${still[0]!.id}/replay`, {});
      expect(replay.status).toBe(200);
      expect((await limited.api<Letter[]>('GET', '/api/dead-letters')).body.filter((d) => d.workflow_id === res.body.id)).toHaveLength(0);
      const done = await limited.ctx.executions.waitFor(replay.body.executionId);
      expect(done.state).toBe('succeeded');
      const steps = limited.ctx.store.steps.list(done.id);
      expect(steps.find((s) => s.nodeId === 's')?.output?.main?.[0]?.json.msg).toBe('three');
      expect((await limited.api<Letter[]>('GET', '/api/dead-letters')).body.filter((d) => d.workflow_id === res.body.id)).toHaveLength(0);
    } finally {
      await limited.dispose();
    }
  });
});

describe('retention on startup', () => {
  it('deletes finished executions older than the configured retention and keeps the rest', async () => {
    const dataDir = makeTempDir('pf-retain-');
    const masterKey = crypto.randomBytes(32);
    const host1 = await startTestHost({ dataDir, masterKey });
    try {
      const wf = await host1.api<{ id: string }>('POST', '/api/workflows', { name: 'retain', draft: g([node('t', 'core.manualTrigger', 'T', 0, 0)], []) });
      expect((await host1.api('PATCH', '/api/settings', { retentionDays: 7 })).status).toBe(200);
      const make = (state: 'succeeded' | 'running', queuedAt: string) => {
        const rec = host1.ctx.store.executions.create({
          workflowId: wf.body.id,
          workflowName: 'retain',
          versionId: null,
          triggerNodeId: 't',
          mode: 'manual',
          triggerItems: [],
          graph: g([node('t', 'core.manualTrigger', 'T', 0, 0)], []),
          settings: host1.ctx.store.workflows.get(wf.body.id)!.settings,
          engineVersion: 'test',
        });
        if (state === 'succeeded') host1.ctx.store.executions.setState(rec.id, 'succeeded', { finishedAt: queuedAt });
        else host1.ctx.store.executions.setState(rec.id, 'running');
        host1.ctx.store.db.run('UPDATE executions SET queued_at = ? WHERE id = ?', queuedAt, rec.id);
        return rec.id;
      };
      const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
      const stale = make('succeeded', daysAgo(10));
      const fresh = make('succeeded', daysAgo(1));
      // Recovery marks this failed (INTERRUPTED) before retention runs, so it is kept: it is newer than 7 days.
      const running = make('running', daysAgo(1));
      await host1.close();

      const host2 = await startTestHost({ dataDir, masterKey });
      try {
        expect(host2.ctx.store.executions.get(stale)).toBeUndefined();
        expect(host2.ctx.store.executions.get(fresh)?.state).toBe('succeeded');
        expect(host2.ctx.store.executions.get(running)?.state).toBe('failed');
        expect(host2.ctx.store.executions.get(running)?.error?.code).toBe('INTERRUPTED');
      } finally {
        await host2.dispose();
      }
    } finally {
      await host1.close();
      removeDir(dataDir);
    }
  });
});
