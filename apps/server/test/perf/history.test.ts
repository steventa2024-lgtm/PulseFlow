import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestHost, type TestHost } from '../helpers';

const RUNS = 1000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

describe(`execution history with ${RUNS} real runs`, () => {
  let host: TestHost;
  let workflowId: string;
  const report: Record<string, number> = {};

  beforeAll(async () => {
    host = await startTestHost({ maxConcurrentExecutions: 8 }, { startTriggers: false });
    const wf = await host.api<{ id: string }>('POST', '/api/workflows', {
      name: 'Perf chain',
      settings: { maxConcurrentRuns: 8 },
      draft: {
        nodes: [
          { id: 'trigger', type: 'core.manualTrigger', name: 'Manual', position: { x: 0, y: 0 }, parameters: { sampleData: { n: 1 } } },
          {
            id: 'set',
            type: 'core.set',
            name: 'Set',
            position: { x: 300, y: 0 },
            parameters: { fields: [{ name: 'doubled', value: '{{ $json.n * 2 }}' }], keepExisting: true },
          },
          {
            id: 'filter',
            type: 'core.filter',
            name: 'Filter',
            position: { x: 600, y: 0 },
            parameters: { conditions: [{ left: '{{ $json.doubled }}', operator: 'gt', right: '0' }], combine: 'and' },
          },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'set' },
          { id: 'e2', source: 'set', target: 'filter' },
        ],
      },
    });
    workflowId = wf.body.id;
  });

  afterAll(async () => {
    const out = path.resolve(import.meta.dirname, '../../../../artifacts/verification');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'perf.json'), `${JSON.stringify({ runs: RUNS, ...report }, null, 2)}\n`);
    await host.dispose();
  });

  it('executes 1,000 runs and records every one durably', async () => {
    const start = performance.now();
    const ids: string[] = [];
    for (let i = 0; i < RUNS; i++) ids.push(host.ctx.workflows.run(workflowId, { useDraft: true, wait: false, items: [{ json: { n: i + 1 } }] }, 'perf').id);
    const results = await Promise.all(ids.map((id) => host.ctx.executions.waitFor(id, 240_000)));
    report.totalRunMs = Math.round(performance.now() - start);
    report.runsPerSecond = Math.round((RUNS / report.totalRunMs) * 1000);
    expect(results.filter((r) => r.state !== 'succeeded')).toEqual([]);
    expect(host.ctx.store.executions.stats(workflowId).succeeded).toBe(RUNS);
  });

  it('serves history queries quickly at 1,000 runs', async () => {
    const list = timed(() => host.ctx.store.executions.list({ workflowId, limit: 50 }));
    expect(list.value).toHaveLength(50);
    const filtered = timed(() => host.ctx.store.executions.list({ states: ['succeeded'], limit: 200 }));
    expect(filtered.value).toHaveLength(200);
    const stats = timed(() => host.ctx.store.executions.stats());
    const page2 = timed(() => host.ctx.store.executions.list({ workflowId, before: list.value.at(-1)!.queuedAt, limit: 50 }));
    expect(page2.value.length).toBeGreaterThan(0);
    const steps = timed(() => host.ctx.store.steps.list(list.value[0]!.id));
    expect(steps.value.length).toBe(3);

    const t = performance.now();
    const res = await host.api<unknown[]>('GET', `/api/executions?workflowId=${workflowId}&limit=100`);
    report.apiListMs = Math.round(performance.now() - t);
    expect(res.status).toBe(200);

    Object.assign(report, {
      listMs: +list.ms.toFixed(2),
      filteredMs: +filtered.ms.toFixed(2),
      statsMs: +stats.ms.toFixed(2),
      page2Ms: +page2.ms.toFixed(2),
      stepsMs: +steps.ms.toFixed(2),
    });
    for (const ms of [list.ms, filtered.ms, stats.ms, page2.ms, steps.ms]) expect(ms).toBeLessThan(100);
    expect(report.apiListMs).toBeLessThan(500);
  });
});
