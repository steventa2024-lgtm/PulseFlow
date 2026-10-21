import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chain, node } from '@pulseflow/templates';
import type { ExecutionStep, Workflow } from '@pulseflow/contracts';
import { startTestHost, type TestHost } from '../helpers';

let host: TestHost;
beforeAll(async () => {
  host = await startTestHost();
});
afterAll(async () => {
  await host.dispose();
});

async function workflow(type = 'core.set', parameters: Record<string, unknown> = { fields: [{ name: 'answer', value: '{{ $json.value * 2 }}' }] }) {
  return (
    await host.api<Workflow>('POST', '/api/workflows', {
      name: 'Node testing',
      draft: {
        schemaVersion: 1,
        nodes: [
          node('t', 'core.manualTrigger', 'Start', 0, 0),
          node('target', type, 'Selected', 200, 0, parameters),
          node('danger', 'core.stopError', 'Must not run', 400, 0),
        ],
        edges: chain('t', 'target', 'danger'),
      },
    })
  ).body;
}
async function testNode(wf: Workflow, patch: Record<string, unknown> = {}) {
  return host.api<{ executionId: string; error: { code: string } }>('POST', `/api/workflows/${wf.id}/nodes/target/test`, {
    baseRevision: wf.draftRevision,
    items: [{ json: { value: 21 } }],
    ...patch,
  });
}

describe('isolated node tests', () => {
  it('executes actual code, persists mode/IO, and never executes downstream nodes or edits the draft', async () => {
    const wf = await workflow();
    const r = await testNode(wf);
    expect(r.status).toBe(200);
    const done = await host.ctx.executions.waitFor(r.body.executionId);
    expect(done).toMatchObject({ mode: 'test', state: 'succeeded', versionId: null });
    const detail = (await host.api<{ steps: ExecutionStep[] }>('GET', `/api/executions/${done.id}`)).body;
    expect(detail.steps.find((s) => s.nodeId === 'target')?.output?.main?.[0]?.json.answer).toBe(42);
    expect(detail.steps.map((s) => s.nodeId)).not.toContain('danger');
    expect((await host.api<Workflow>('GET', `/api/workflows/${wf.id}`)).body).toEqual(wf);
  });
  it('retains filesystem permissions and records a real permission failure', async () => {
    const wf = await workflow('core.fileRead', {
      path: process.platform === 'win32' ? 'C:\\outside-pulseflow-grants\\private.txt' : '/outside-pulseflow-grants/private.txt',
    });
    const r = await testNode(wf);
    const done = await host.ctx.executions.waitFor(r.body.executionId);
    expect(done.state).toBe('failed');
    expect(done.error?.message).toMatch(/denied|grant/i);
  });
  it('rejects stale drafts, invalid ports, empty input and missing authorization', async () => {
    const wf = await workflow();
    expect((await testNode(wf, { baseRevision: wf.draftRevision + 1 })).body.error.code).toBe('REVISION_CONFLICT');
    expect((await testNode(wf, { inputPort: 'unknown' })).body.error.code).toBe('INVALID_INPUT_PORT');
    expect((await testNode(wf, { items: [] })).status).toBe(400);
    expect((await host.api('POST', `/api/workflows/${wf.id}/nodes/target/test`, {}, null)).status).toBe(401);
  });
});
