import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkflowSettings, emptyGraph } from '@pulseflow/contracts';
import { Store, openDatabase, type Database } from '../src';

let dir = '';
let db: Database;

function open(): Store {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-store-'));
  db = openDatabase(path.join(dir, 'test.db'));
  db.migrate();
  return new Store(db);
}

afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const graph = { ...emptyGraph(), nodes: [{ id: 't', type: 'core.manualTrigger', typeVersion: 1, name: 'T', position: { x: 0, y: 0 }, parameters: {} }] };

describe('storage', () => {
  it('migrates idempotently and passes integrity check', () => {
    open();
    const v = db.schemaVersion();
    db.migrate();
    expect(db.schemaVersion()).toBe(v);
    expect(v).toBeGreaterThanOrEqual(1);
    expect(db.integrityCheck()).toBe('ok');
  });

  it('guards drafts with optimistic revisions', () => {
    const store = open();
    const ws = store.workspaces.ensureDefault();
    const wf = store.workflows.create({ workspaceId: ws.id, name: 'A', draft: emptyGraph(), settings: defaultWorkflowSettings() });
    const updated = store.workflows.update(wf.id, { name: 'B' }, 0);
    expect(updated.draftRevision).toBe(1);
    expect(() => store.workflows.update(wf.id, { name: 'C' }, 0)).toThrow(/modified elsewhere/);
  });

  it('numbers versions and keeps them immutable', () => {
    const store = open();
    const ws = store.workspaces.ensureDefault();
    const wf = store.workflows.create({ workspaceId: ws.id, name: 'A', draft: graph, settings: defaultWorkflowSettings() });
    const v1 = store.versions.create({ workflowId: wf.id, graph, settings: wf.settings, note: 'one', createdBy: 'test', published: true });
    const v2 = store.versions.create({ workflowId: wf.id, graph: emptyGraph(), settings: wf.settings, note: 'two', createdBy: 'test', published: false });
    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect(store.versions.get(v1.id)!.graph.nodes).toHaveLength(1);
    expect(v1.checksum).not.toBe(v2.checksum);
  });

  it('claims queued executions in order and respects the per-workflow gate', () => {
    const store = open();
    const ws = store.workspaces.ensureDefault();
    const wf = store.workflows.create({ workspaceId: ws.id, name: 'A', draft: graph, settings: defaultWorkflowSettings() });
    const mk = () =>
      store.executions.create({
        workflowId: wf.id,
        workflowName: 'A',
        versionId: null,
        triggerNodeId: 't',
        mode: 'manual',
        triggerItems: [],
        graph,
        settings: wf.settings,
        engineVersion: 'test',
      });
    const a = mk();
    const b = mk();
    expect(store.executions.countQueued(wf.id)).toBe(2);
    expect(store.executions.claimNext(() => false)).toBeUndefined();
    expect(store.executions.claimNext(() => true)?.id).toBe(a.id);
    expect(store.executions.get(a.id)?.state).toBe('running');
    expect(store.executions.claimNext(() => true)?.id).toBe(b.id);
  });

  it('cascades workflow deletion to executions', () => {
    const store = open();
    const ws = store.workspaces.ensureDefault();
    const wf = store.workflows.create({ workspaceId: ws.id, name: 'A', draft: graph, settings: defaultWorkflowSettings() });
    const e = store.executions.create({
      workflowId: wf.id,
      workflowName: 'A',
      versionId: null,
      triggerNodeId: 't',
      mode: 'manual',
      triggerItems: [],
      graph,
      settings: wf.settings,
      engineVersion: 'test',
    });
    store.workflows.delete(wf.id);
    expect(store.executions.get(e.id)).toBeUndefined();
  });

  it('records dedupe keys once and persists kv values', () => {
    const store = open();
    expect(store.dedupe.checkAndRecord('s', 'k')).toBe(false);
    expect(store.dedupe.checkAndRecord('s', 'k')).toBe(true);
    store.kv.set('ns', 'key', { a: 1 });
    expect(store.kv.get('ns', 'key')).toEqual({ a: 1 });
  });

  it('rolls back failed transactions', () => {
    const store = open();
    expect(() =>
      db.transaction(() => {
        store.kv.set('ns', 'tx', 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.kv.get('ns', 'tx')).toBeUndefined();
  });

  it('prunes finished executions by age and per-workflow cap, and cascades steps', () => {
    const store = open();
    const ws = store.workspaces.ensureDefault();
    const wf = store.workflows.create({ workspaceId: ws.id, name: 'A', draft: graph, settings: defaultWorkflowSettings() });
    const other = store.workflows.create({ workspaceId: ws.id, name: 'B', draft: graph, settings: defaultWorkflowSettings() });
    const make = (workflowId: string, name: string, state: 'succeeded' | 'failed' | 'running' | 'waiting' | 'queued', queuedAt: string) => {
      const rec = store.executions.create({
        workflowId,
        workflowName: name,
        versionId: null,
        triggerNodeId: 't',
        mode: 'manual',
        triggerItems: [],
        graph,
        settings: wf.settings,
        engineVersion: 'test',
      });
      if (state !== 'queued') store.executions.setState(rec.id, state, state === 'running' || state === 'waiting' ? {} : { finishedAt: queuedAt });
      db.run('UPDATE executions SET queued_at = ? WHERE id = ?', queuedAt, rec.id);
      return rec.id;
    };
    const old = make(wf.id, 'A', 'succeeded', '2020-01-01T00:00:00.000Z');
    const recent = make(wf.id, 'A', 'succeeded', new Date().toISOString());
    const failedOld = make(wf.id, 'A', 'failed', '2020-01-02T00:00:00.000Z');
    const runningOld = make(wf.id, 'A', 'running', '2020-01-03T00:00:00.000Z');
    const waitingOld = make(wf.id, 'A', 'waiting', '2020-01-04T00:00:00.000Z');
    const queuedOld = make(wf.id, 'A', 'queued', '2020-01-05T00:00:00.000Z');
    const otherOld = make(other.id, 'B', 'succeeded', '2020-01-01T00:00:00.000Z');
    store.steps.upsert({
      id: 'step-old',
      executionId: old,
      nodeId: 't',
      nodeName: 'T',
      nodeType: 'core.manualTrigger',
      attempt: 1,
      state: 'succeeded',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      input: null,
      output: null,
      error: null,
      logs: [],
      retryInMs: null,
      truncated: false,
    });

    expect(store.executions.prune({ maxAgeDays: 30 })).toBe(3);
    for (const id of [old, failedOld, otherOld]) expect(store.executions.get(id)).toBeUndefined();
    expect(store.steps.list(old)).toEqual([]);
    for (const id of [recent, runningOld, waitingOld, queuedOld]) expect(store.executions.get(id)).toBeDefined();

    const mid = make(wf.id, 'A', 'succeeded', '2024-06-01T00:00:00.000Z');
    const older = make(wf.id, 'A', 'succeeded', '2024-01-01T00:00:00.000Z');
    // Newest first: recent, mid, older, then the in-progress rows. Cap 1 deletes finished runs past the newest one.
    expect(store.executions.prune({ keepPerWorkflow: 1 })).toBe(2);
    expect(store.executions.get(recent)?.state).toBe('succeeded');
    expect(store.executions.get(mid)).toBeUndefined();
    expect(store.executions.get(older)).toBeUndefined();
    expect(store.executions.get(queuedOld)?.state).toBe('queued');
    expect(store.executions.get(runningOld)?.state).toBe('running');
    expect(store.executions.get(waitingOld)?.state).toBe('waiting');
  });

  it('writes a consistent backup that can be reopened', () => {
    const store = open();
    store.kv.set('ns', 'k', 'v');
    const backup = path.join(dir, 'backup.db');
    db.backupTo(backup);
    const copy = openDatabase(backup);
    expect(new Store(copy).kv.get('ns', 'k')).toBe('v');
    copy.close();
  });
});
