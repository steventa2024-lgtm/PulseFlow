import {
  newId,
  WorkflowSettingsSchema,
  type AuditEvent,
  type Execution,
  type ExecutionError,
  type ExecutionMode,
  type ExecutionState,
  type ExecutionStep,
  type Item,
  type Workflow,
  type WorkflowGraph,
  type WorkflowSettings,
  type WorkflowVersion,
} from '@pulseflow/contracts';
import crypto from 'node:crypto';
import type { Database } from './db';

const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(v: string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const nowIso = () => new Date().toISOString();

export function graphChecksum(graph: WorkflowGraph, settings?: WorkflowSettings): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ graph, settings: settings ?? null }))
    .digest('hex')
    .slice(0, 16);
}

interface WorkflowRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  tags: string;
  active: number;
  published_version_id: string | null;
  draft: string;
  settings: string;
  draft_revision: number;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

function toWorkflow(r: WorkflowRow): Workflow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    description: r.description,
    tags: pj(r.tags, []),
    active: r.active === 1,
    publishedVersionId: r.published_version_id,
    draft: pj(r.draft, { schemaVersion: 1, nodes: [], edges: [] }),
    settings: WorkflowSettingsSchema.parse(pj(r.settings, {})),
    draftRevision: r.draft_revision,
    templateId: r.template_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class WorkflowRepo {
  constructor(private readonly db: Database) {}

  create(input: {
    workspaceId: string;
    name: string;
    description?: string;
    tags?: string[];
    draft: WorkflowGraph;
    settings: WorkflowSettings;
    templateId?: string | null;
    ownerId?: string;
    id?: string;
  }): Workflow {
    const id = input.id ?? newId('wf');
    const ts = nowIso();
    this.db.run(
      `INSERT INTO workflows (id, workspace_id, name, description, tags, active, draft, settings, draft_revision, template_id, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?)`,
      id,
      input.workspaceId,
      input.name,
      input.description ?? '',
      j(input.tags ?? []),
      j(input.draft),
      j(input.settings),
      input.templateId ?? null,
      input.ownerId ?? null,
      ts,
      ts,
    );
    return this.get(id)!;
  }

  get(id: string): Workflow | undefined {
    const r = this.db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', id);
    return r ? toWorkflow(r) : undefined;
  }

  list(workspaceId: string, opts: { search?: string; active?: boolean } = {}): Workflow[] {
    const where = ['workspace_id = ?'];
    const params: (string | number)[] = [workspaceId];
    if (opts.search) {
      where.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)');
      const s = `%${opts.search.replace(/[%_]/g, '')}%`;
      params.push(s, s, s);
    }
    if (opts.active !== undefined) {
      where.push('active = ?');
      params.push(opts.active ? 1 : 0);
    }
    return this.db.all<WorkflowRow>(`SELECT * FROM workflows WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, ...params).map(toWorkflow);
  }

  listActive(): Workflow[] {
    return this.db.all<WorkflowRow>('SELECT * FROM workflows WHERE active = 1').map(toWorkflow);
  }

  update(id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'tags' | 'draft' | 'settings'>>, baseRevision?: number): Workflow {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Workflow ${id} not found`);
      if (baseRevision !== undefined && baseRevision !== current.draftRevision) {
        throw Object.assign(new Error('Workflow was modified elsewhere; reload to continue'), { code: 'REVISION_CONFLICT' });
      }
      const next = { ...current, ...patch };
      this.db.run(
        `UPDATE workflows SET name = ?, description = ?, tags = ?, draft = ?, settings = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?`,
        next.name,
        next.description,
        j(next.tags),
        j(next.draft),
        j(next.settings),
        nowIso(),
        id,
      );
      return this.get(id)!;
    });
  }

  setActive(id: string, active: boolean): void {
    this.db.run('UPDATE workflows SET active = ?, updated_at = ? WHERE id = ?', active, nowIso(), id);
  }

  setPublishedVersion(id: string, versionId: string | null): void {
    this.db.run('UPDATE workflows SET published_version_id = ?, updated_at = ? WHERE id = ?', versionId, nowIso(), id);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM workflows WHERE id = ?', id).changes > 0;
  }
}

interface VersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  graph: string;
  settings: string;
  checksum: string;
  note: string;
  created_by: string;
  created_at: string;
  published: number;
}

function toVersion(r: VersionRow): WorkflowVersion {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    versionNumber: r.version_number,
    graph: pj(r.graph, { schemaVersion: 1, nodes: [], edges: [] }),
    settings: WorkflowSettingsSchema.parse(pj(r.settings, {})),
    checksum: r.checksum,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    published: r.published === 1,
  };
}

export class VersionRepo {
  constructor(private readonly db: Database) {}

  create(input: {
    workflowId: string;
    graph: WorkflowGraph;
    settings: WorkflowSettings;
    note: string;
    createdBy: string;
    published: boolean;
  }): WorkflowVersion {
    return this.db.transaction(() => {
      const max = this.db.get<{ n: number | null }>('SELECT MAX(version_number) AS n FROM workflow_versions WHERE workflow_id = ?', input.workflowId);
      const id = newId('ver');
      this.db.run(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, graph, settings, checksum, note, created_by, created_at, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.workflowId,
        (max?.n ?? 0) + 1,
        j(input.graph),
        j(input.settings),
        graphChecksum(input.graph, input.settings),
        input.note,
        input.createdBy,
        nowIso(),
        input.published,
      );
      if (input.published) {
        this.db.run('UPDATE workflow_versions SET published = 0 WHERE workflow_id = ? AND id != ?', input.workflowId, id);
      }
      return this.get(id)!;
    });
  }

  get(id: string): WorkflowVersion | undefined {
    const r = this.db.get<VersionRow>('SELECT * FROM workflow_versions WHERE id = ?', id);
    return r ? toVersion(r) : undefined;
  }

  latest(workflowId: string): WorkflowVersion | undefined {
    const r = this.db.get<VersionRow>('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT 1', workflowId);
    return r ? toVersion(r) : undefined;
  }

  list(workflowId: string): WorkflowVersion[] {
    return this.db.all<VersionRow>('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC', workflowId).map(toVersion);
  }
}

interface ExecutionRow {
  id: string;
  workflow_id: string;
  version_id: string | null;
  workflow_name: string;
  trigger_node_id: string;
  mode: string;
  state: string;
  trigger_items: string;
  graph: string;
  settings: string;
  graph_checksum: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  resume_at: string | null;
  waiting_node_id: string | null;
  engine_version: string;
  correlation_id: string;
  error: string | null;
  parent_execution_id: string | null;
  retry_of_execution_id: string | null;
  depth: number;
  pinned: string | null;
}

export interface ExecutionRecord extends Execution {
  graph: WorkflowGraph;
  settings: WorkflowSettings;
  resumeAt: string | null;
  waitingNodeId: string | null;
  depth: number;
  pinned: Record<string, Item[]> | null;
}

function toExecution(r: ExecutionRow): ExecutionRecord {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    versionId: r.version_id,
    workflowName: r.workflow_name,
    triggerNodeId: r.trigger_node_id,
    mode: r.mode as ExecutionMode,
    state: r.state as ExecutionState,
    triggerItems: pj(r.trigger_items, []),
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    engineVersion: r.engine_version,
    correlationId: r.correlation_id,
    error: pj<ExecutionError | null>(r.error, null),
    parentExecutionId: r.parent_execution_id,
    retryOfExecutionId: r.retry_of_execution_id,
    graphChecksum: r.graph_checksum,
    graph: pj(r.graph, { schemaVersion: 1, nodes: [], edges: [] }),
    settings: WorkflowSettingsSchema.parse(pj(r.settings, {})),
    resumeAt: r.resume_at,
    waitingNodeId: r.waiting_node_id,
    depth: r.depth,
    pinned: pj(r.pinned, null),
  };
}

export interface ExecutionQuery {
  workflowId?: string;
  states?: ExecutionState[];
  mode?: ExecutionMode;
  search?: string;
  before?: string;
  limit?: number;
}

export class ExecutionRepo {
  constructor(private readonly db: Database) {}

  create(input: {
    workflowId: string;
    workflowName: string;
    versionId: string | null;
    triggerNodeId: string;
    mode: ExecutionMode;
    triggerItems: Item[];
    graph: WorkflowGraph;
    settings: WorkflowSettings;
    engineVersion: string;
    parentExecutionId?: string | null;
    retryOfExecutionId?: string | null;
    depth?: number;
    pinned?: Record<string, Item[]> | null;
    correlationId?: string;
    id?: string;
  }): ExecutionRecord {
    const id = input.id ?? newId('exe');
    this.db.run(
      `INSERT INTO executions (id, workflow_id, version_id, workflow_name, trigger_node_id, mode, state, trigger_items, graph, settings, graph_checksum,
        queued_at, engine_version, correlation_id, parent_execution_id, retry_of_execution_id, depth, pinned)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.workflowId,
      input.versionId,
      input.workflowName,
      input.triggerNodeId,
      input.mode,
      j(input.triggerItems),
      j(input.graph),
      j(input.settings),
      graphChecksum(input.graph, input.settings),
      nowIso(),
      input.engineVersion,
      input.correlationId ?? newId('cor', 12),
      input.parentExecutionId ?? null,
      input.retryOfExecutionId ?? null,
      input.depth ?? 0,
      input.pinned ? j(input.pinned) : null,
    );
    return this.get(id)!;
  }

  get(id: string): ExecutionRecord | undefined {
    const r = this.db.get<ExecutionRow>('SELECT * FROM executions WHERE id = ?', id);
    return r ? toExecution(r) : undefined;
  }

  setState(
    id: string,
    state: ExecutionState,
    extra: { error?: ExecutionError | null; startedAt?: string; finishedAt?: string; resumeAt?: string | null; waitingNodeId?: string | null } = {},
  ): void {
    const sets = ['state = ?'];
    const params: (string | null)[] = [state];
    if (extra.error !== undefined) {
      sets.push('error = ?');
      params.push(extra.error ? j(extra.error) : null);
    }
    if (extra.startedAt) {
      sets.push('started_at = COALESCE(started_at, ?)');
      params.push(extra.startedAt);
    }
    if (extra.finishedAt) {
      sets.push('finished_at = ?');
      params.push(extra.finishedAt);
    }
    if (extra.resumeAt !== undefined) {
      sets.push('resume_at = ?');
      params.push(extra.resumeAt);
    }
    if (extra.waitingNodeId !== undefined) {
      sets.push('waiting_node_id = ?');
      params.push(extra.waitingNodeId);
    }
    this.db.run(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Atomically claims the oldest queued execution respecting a per-workflow concurrency cap. */
  claimNext(isAllowed: (workflowId: string) => boolean): ExecutionRecord | undefined {
    return this.db.transaction(() => {
      const rows = this.db.all<ExecutionRow>("SELECT * FROM executions WHERE state = 'queued' ORDER BY queued_at, rowid LIMIT 200");
      for (const r of rows) {
        if (!isAllowed(r.workflow_id)) continue;
        const ts = nowIso();
        const res = this.db.run("UPDATE executions SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state = 'queued'", ts, r.id);
        if (res.changes === 1) return this.get(r.id);
      }
      return undefined;
    });
  }

  countRunning(workflowId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ? AND state = 'running'", workflowId)?.n ?? 0;
  }

  countQueued(workflowId?: string): number {
    if (workflowId) return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE workflow_id = ? AND state = 'queued'", workflowId)?.n ?? 0;
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM executions WHERE state = 'queued'")?.n ?? 0;
  }

  listByState(state: ExecutionState): ExecutionRecord[] {
    return this.db.all<ExecutionRow>('SELECT * FROM executions WHERE state = ? ORDER BY queued_at', state).map(toExecution);
  }

  list(q: ExecutionQuery = {}): Execution[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.workflowId) {
      where.push('workflow_id = ?');
      params.push(q.workflowId);
    }
    if (q.states?.length) {
      where.push(`state IN (${q.states.map(() => '?').join(',')})`);
      params.push(...q.states);
    }
    if (q.mode) {
      where.push('mode = ?');
      params.push(q.mode);
    }
    if (q.search) {
      where.push('(workflow_name LIKE ? OR id LIKE ? OR error LIKE ?)');
      const s = `%${q.search.replace(/[%_]/g, '')}%`;
      params.push(s, s, s);
    }
    if (q.before) {
      where.push('queued_at < ?');
      params.push(q.before);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const sql = `SELECT * FROM executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY queued_at DESC, rowid DESC LIMIT ${limit}`;
    return this.db.all<ExecutionRow>(sql, ...params).map((r) => {
      const { graph: _g, settings: _s, resumeAt: _r, waitingNodeId: _w, depth: _d, pinned: _p, ...rest } = toExecution(r);
      return rest;
    });
  }

  stats(workflowId?: string): Record<string, number> {
    const rows = workflowId
      ? this.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM executions WHERE workflow_id = ? GROUP BY state', workflowId)
      : this.db.all<{ state: string; n: number }>('SELECT state, COUNT(*) AS n FROM executions GROUP BY state');
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /** Retention: delete finished executions older than `maxAgeDays` or beyond `keepPerWorkflow`. */
  prune(opts: { maxAgeDays?: number; keepPerWorkflow?: number }): number {
    let removed = 0;
    const terminal = "state IN ('succeeded','failed','cancelled','timed_out')";
    if (opts.maxAgeDays) {
      const cutoff = new Date(Date.now() - opts.maxAgeDays * 86_400_000).toISOString();
      removed += this.db.run(`DELETE FROM executions WHERE ${terminal} AND queued_at < ?`, cutoff).changes;
    }
    if (opts.keepPerWorkflow) {
      removed += this.db.run(
        `DELETE FROM executions WHERE ${terminal} AND id IN (
          SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY queued_at DESC) AS rn FROM executions) WHERE rn > ?)`,
        opts.keepPerWorkflow,
      ).changes;
    }
    return removed;
  }
}

interface StepRow {
  id: string;
  execution_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  attempt: number;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  raw_output: string | null;
  error: string | null;
  logs: string;
  retry_in_ms: number | null;
  truncated: number;
}

function toStep(r: StepRow): ExecutionStep {
  return {
    id: r.id,
    executionId: r.execution_id,
    nodeId: r.node_id,
    nodeName: r.node_name,
    nodeType: r.node_type,
    attempt: r.attempt,
    state: r.state as ExecutionStep['state'],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    input: pj(r.input, null),
    output: pj(r.output, null),
    error: pj(r.error, null),
    logs: pj(r.logs, []),
    retryInMs: r.retry_in_ms,
    truncated: r.truncated === 1,
  };
}

export class StepRepo {
  constructor(private readonly db: Database) {}

  upsert(step: ExecutionStep & { rawOutput?: string | null }): void {
    this.db.run(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_name, node_type, attempt, state, started_at, finished_at, duration_ms, input, output, raw_output, error, logs, retry_in_ms, truncated, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM execution_steps WHERE execution_id = ?))
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, started_at = excluded.started_at, finished_at = excluded.finished_at,
         duration_ms = excluded.duration_ms, input = excluded.input, output = excluded.output, raw_output = excluded.raw_output,
         error = excluded.error, logs = excluded.logs, retry_in_ms = excluded.retry_in_ms, truncated = excluded.truncated`,
      step.id,
      step.executionId,
      step.nodeId,
      step.nodeName,
      step.nodeType,
      step.attempt,
      step.state,
      step.startedAt,
      step.finishedAt,
      step.durationMs,
      step.input ? j(step.input) : null,
      step.output ? j(step.output) : null,
      step.rawOutput ?? null,
      step.error ? j(step.error) : null,
      j(step.logs),
      step.retryInMs,
      step.truncated,
      step.executionId,
    );
  }

  list(executionId: string): ExecutionStep[] {
    return this.db.all<StepRow>('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY seq', executionId).map(toStep);
  }

  /** Raw (unredacted, untruncated) outputs of succeeded steps — used for resume / restart. */
  rawOutputs(executionId: string, decode: (stored: string) => string = (x) => x): Record<string, Record<string, Item[]>> {
    const rows = this.db.all<{ node_id: string; raw_output: string | null; output: string | null }>(
      "SELECT node_id, raw_output, output FROM execution_steps WHERE execution_id = ? AND state = 'succeeded' ORDER BY seq",
      executionId,
    );
    const out: Record<string, Record<string, Item[]>> = {};
    for (const r of rows) {
      const v = pj<Record<string, Item[]> | null>(r.raw_output ? decode(r.raw_output) : r.output, null);
      if (v) out[r.node_id] = v;
    }
    return out;
  }

  markInterrupted(executionId: string, error: ExecutionError): void {
    this.db.run(
      "UPDATE execution_steps SET state = 'failed', error = ?, finished_at = ? WHERE execution_id = ? AND state IN ('running','queued','retrying')",
      j(error),
      nowIso(),
      executionId,
    );
  }
}

export class KvRepo {
  constructor(private readonly db: Database) {}

  get(namespace: string, key: string): unknown {
    const r = this.db.get<{ value: string }>('SELECT value FROM kv_store WHERE namespace = ? AND key = ?', namespace, key);
    return r ? pj(r.value, null) : undefined;
  }

  set(namespace: string, key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO kv_store (namespace, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      namespace,
      key,
      j(value ?? null),
      nowIso(),
    );
  }

  delete(namespace: string, key: string): void {
    this.db.run('DELETE FROM kv_store WHERE namespace = ? AND key = ?', namespace, key);
  }

  deleteNamespace(prefix: string): void {
    this.db.run('DELETE FROM kv_store WHERE namespace = ? OR namespace LIKE ?', prefix, `${prefix}:%`);
  }

  list(namespace: string, prefix = ''): { key: string; value: unknown }[] {
    return this.db
      .all<{ key: string; value: string }>(
        'SELECT key, value FROM kv_store WHERE namespace = ? AND key LIKE ? ORDER BY key',
        namespace,
        `${prefix.replace(/[%_]/g, '')}%`,
      )
      .map((r) => ({ key: r.key, value: pj(r.value, null) }));
  }
}

export class DedupeRepo {
  constructor(private readonly db: Database) {}

  checkAndRecord(scope: string, key: string): boolean {
    const res = this.db.run('INSERT OR IGNORE INTO dedupe_keys (scope, key, created_at) VALUES (?, ?, ?)', scope, key, nowIso());
    return res.changes === 0;
  }

  has(scope: string, key: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM dedupe_keys WHERE scope = ? AND key = ?', scope, key);
  }

  clearScope(scope: string): void {
    this.db.run('DELETE FROM dedupe_keys WHERE scope = ? OR scope LIKE ?', scope, `${scope}:%`);
  }
}

export class AuditRepo {
  constructor(private readonly db: Database) {}

  record(actor: string, action: string, target: string, details: Record<string, unknown> = {}): AuditEvent {
    const ev: AuditEvent = { id: newId('aud'), ts: nowIso(), actor, action, target, details };
    this.db.run('INSERT INTO audit_events (id, ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?, ?)', ev.id, ev.ts, actor, action, target, j(details));
    return ev;
  }

  list(limit = 200): AuditEvent[] {
    return this.db
      .all<{ id: string; ts: string; actor: string; action: string; target: string; details: string }>(
        'SELECT * FROM audit_events ORDER BY ts DESC, rowid DESC LIMIT ?',
        Math.min(limit, 1000),
      )
      .map((r) => ({ ...r, details: pj(r.details, {}) }));
  }
}

export interface CredentialRow {
  id: string;
  workspace_id: string;
  name: string;
  type: string;
  encrypted: string;
  fields: string;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  last_check_ok: number | null;
}

export class CredentialRepo {
  constructor(private readonly db: Database) {}

  create(row: Omit<CredentialRow, 'created_at' | 'updated_at' | 'last_checked_at' | 'last_check_ok'>): void {
    const ts = nowIso();
    this.db.run(
      'INSERT INTO credentials (id, workspace_id, name, type, encrypted, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id,
      row.workspace_id,
      row.name,
      row.type,
      row.encrypted,
      row.fields,
      ts,
      ts,
    );
  }

  update(id: string, patch: { name?: string; encrypted?: string; fields?: string }): void {
    const cur = this.get(id);
    if (!cur) throw new Error('Credential not found');
    this.db.run(
      'UPDATE credentials SET name = ?, encrypted = ?, fields = ?, updated_at = ? WHERE id = ?',
      patch.name ?? cur.name,
      patch.encrypted ?? cur.encrypted,
      patch.fields ?? cur.fields,
      nowIso(),
      id,
    );
  }

  setHealth(id: string, ok: boolean): void {
    this.db.run('UPDATE credentials SET last_checked_at = ?, last_check_ok = ? WHERE id = ?', nowIso(), ok, id);
  }

  get(id: string): CredentialRow | undefined {
    return this.db.get<CredentialRow>('SELECT * FROM credentials WHERE id = ?', id);
  }

  list(workspaceId: string): CredentialRow[] {
    return this.db.all<CredentialRow>('SELECT * FROM credentials WHERE workspace_id = ? ORDER BY name', workspaceId);
  }

  all(): CredentialRow[] {
    return this.db.all<CredentialRow>('SELECT * FROM credentials');
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM credentials WHERE id = ?', id).changes > 0;
  }
}

export class WebhookRepo {
  constructor(private readonly db: Database) {}

  ensure(workflowId: string, nodeId: string, token: string): { id: string; token: string } {
    const existing = this.db.get<{ id: string; token: string }>(
      'SELECT id, token FROM webhook_endpoints WHERE workflow_id = ? AND node_id = ?',
      workflowId,
      nodeId,
    );
    if (existing) return existing;
    const id = newId('hook');
    this.db.run('INSERT INTO webhook_endpoints (id, workflow_id, node_id, token, created_at) VALUES (?, ?, ?, ?, ?)', id, workflowId, nodeId, token, nowIso());
    return { id, token };
  }

  byToken(token: string): { id: string; workflow_id: string; node_id: string; token: string } | undefined {
    return this.db.get('SELECT id, workflow_id, node_id, token FROM webhook_endpoints WHERE token = ?', token);
  }

  forWorkflow(workflowId: string): { id: string; node_id: string; token: string }[] {
    return this.db.all('SELECT id, node_id, token FROM webhook_endpoints WHERE workflow_id = ?', workflowId);
  }

  rotate(workflowId: string, nodeId: string, token: string): void {
    this.db.run('UPDATE webhook_endpoints SET token = ? WHERE workflow_id = ? AND node_id = ?', token, workflowId, nodeId);
  }
}

export interface ScheduleRow {
  workflow_id: string;
  node_id: string;
  kind: string;
  expression: string;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
}

export class ScheduleRepo {
  constructor(private readonly db: Database) {}

  upsert(row: ScheduleRow): void {
    this.db.run(
      `INSERT INTO schedules (workflow_id, node_id, kind, expression, timezone, next_run_at, last_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, node_id) DO UPDATE SET kind = excluded.kind, expression = excluded.expression, timezone = excluded.timezone,
         next_run_at = excluded.next_run_at, last_run_at = COALESCE(excluded.last_run_at, schedules.last_run_at)`,
      row.workflow_id,
      row.node_id,
      row.kind,
      row.expression,
      row.timezone,
      row.next_run_at,
      row.last_run_at,
    );
  }

  get(workflowId: string, nodeId: string): ScheduleRow | undefined {
    return this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE workflow_id = ? AND node_id = ?', workflowId, nodeId);
  }

  list(): ScheduleRow[] {
    return this.db.all<ScheduleRow>('SELECT * FROM schedules ORDER BY next_run_at');
  }

  forWorkflow(workflowId: string): ScheduleRow[] {
    return this.db.all<ScheduleRow>('SELECT * FROM schedules WHERE workflow_id = ?', workflowId);
  }

  markRun(workflowId: string, nodeId: string, lastRunAt: string, nextRunAt: string | null): void {
    this.db.run('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE workflow_id = ? AND node_id = ?', lastRunAt, nextRunAt, workflowId, nodeId);
  }

  deleteForWorkflow(workflowId: string): void {
    this.db.run('DELETE FROM schedules WHERE workflow_id = ?', workflowId);
  }
}

export interface NotificationRow {
  id: string;
  ts: string;
  title: string;
  body: string;
  workflow_id: string | null;
  execution_id: string | null;
  read: number;
}

export class NotificationRepo {
  constructor(private readonly db: Database) {}

  add(n: { title: string; body: string; workflowId?: string | null; executionId?: string | null }): NotificationRow {
    const row: NotificationRow = {
      id: newId('ntf'),
      ts: nowIso(),
      title: n.title,
      body: n.body,
      workflow_id: n.workflowId ?? null,
      execution_id: n.executionId ?? null,
      read: 0,
    };
    this.db.run(
      'INSERT INTO notifications (id, ts, title, body, workflow_id, execution_id, read) VALUES (?, ?, ?, ?, ?, ?, 0)',
      row.id,
      row.ts,
      row.title,
      row.body,
      row.workflow_id,
      row.execution_id,
    );
    return row;
  }

  list(limit = 100): NotificationRow[] {
    return this.db.all<NotificationRow>('SELECT * FROM notifications ORDER BY ts DESC, rowid DESC LIMIT ?', Math.min(limit, 500));
  }

  markAllRead(): void {
    this.db.run('UPDATE notifications SET read = 1 WHERE read = 0');
  }
}

export class DeadLetterRepo {
  constructor(private readonly db: Database) {}

  add(input: { workflowId: string; executionId?: string | null; reason: string; payload: unknown }): string {
    const id = newId('dlq');
    this.db.run(
      'INSERT INTO dead_letters (id, workflow_id, execution_id, reason, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      input.workflowId,
      input.executionId ?? null,
      input.reason,
      j(input.payload),
      nowIso(),
    );
    return id;
  }

  list(limit = 100): { id: string; workflow_id: string; execution_id: string | null; reason: string; payload: unknown; created_at: string }[] {
    return this.db
      .all<{ id: string; workflow_id: string; execution_id: string | null; reason: string; payload: string; created_at: string }>(
        'SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT ?',
        limit,
      )
      .map((r) => ({ ...r, payload: pj(r.payload, null) }));
  }

  delete(id: string): void {
    this.db.run('DELETE FROM dead_letters WHERE id = ?', id);
  }
}

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get<T>(key: string, fallback: T): T {
    const r = this.db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
    return r ? pj(r.value, fallback) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db.run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, j(value));
  }
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  disabled: number;
  created_at: string;
}

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string;
  kind: 'api' | 'session';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export class UserRepo {
  constructor(private readonly db: Database) {}

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  create(u: { email: string; name: string; passwordHash: string | null; role: UserRow['role']; id?: string }): UserRow {
    const id = u.id ?? newId('usr');
    this.db.run(
      'INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      u.email,
      u.name,
      u.passwordHash,
      u.role,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  byEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  }

  list(): UserRow[] {
    return this.db.all<UserRow>('SELECT * FROM users ORDER BY created_at');
  }

  setRole(id: string, role: UserRow['role']): void {
    this.db.run('UPDATE users SET role = ? WHERE id = ?', role, id);
  }

  setDisabled(id: string, disabled: boolean): void {
    this.db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled, id);
  }

  addToken(t: Omit<TokenRow, 'created_at' | 'last_used_at'>): void {
    this.db.run(
      'INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      t.id,
      t.user_id,
      t.name,
      t.token_hash,
      t.scopes,
      t.kind,
      nowIso(),
      t.expires_at,
    );
  }

  tokenByHash(hash: string): TokenRow | undefined {
    return this.db.get<TokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?', hash);
  }

  touchToken(id: string): void {
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), id);
  }

  listTokens(userId: string): TokenRow[] {
    return this.db.all<TokenRow>("SELECT * FROM api_tokens WHERE user_id = ? AND kind = 'api' ORDER BY created_at DESC", userId);
  }

  deleteToken(id: string, userId: string): boolean {
    return this.db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId).changes > 0;
  }
}

export class WorkspaceRepo {
  constructor(private readonly db: Database) {}

  ensureDefault(): { id: string; name: string } {
    const row = this.db.get<{ id: string; name: string }>('SELECT id, name FROM workspaces ORDER BY created_at LIMIT 1');
    if (row) return row;
    const ws = { id: 'ws_default', name: 'My Workspace' };
    this.db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws.id, ws.name, nowIso());
    return ws;
  }
}

export class Store {
  readonly workflows: WorkflowRepo;
  readonly versions: VersionRepo;
  readonly executions: ExecutionRepo;
  readonly steps: StepRepo;
  readonly kv: KvRepo;
  readonly dedupe: DedupeRepo;
  readonly audit: AuditRepo;
  readonly credentials: CredentialRepo;
  readonly webhooks: WebhookRepo;
  readonly schedules: ScheduleRepo;
  readonly notifications: NotificationRepo;
  readonly deadLetters: DeadLetterRepo;
  readonly settings: SettingsRepo;
  readonly users: UserRepo;
  readonly workspaces: WorkspaceRepo;

  constructor(readonly db: Database) {
    this.workflows = new WorkflowRepo(db);
    this.versions = new VersionRepo(db);
    this.executions = new ExecutionRepo(db);
    this.steps = new StepRepo(db);
    this.kv = new KvRepo(db);
    this.dedupe = new DedupeRepo(db);
    this.audit = new AuditRepo(db);
    this.credentials = new CredentialRepo(db);
    this.webhooks = new WebhookRepo(db);
    this.schedules = new ScheduleRepo(db);
    this.notifications = new NotificationRepo(db);
    this.deadLetters = new DeadLetterRepo(db);
    this.settings = new SettingsRepo(db);
    this.users = new UserRepo(db);
    this.workspaces = new WorkspaceRepo(db);
  }
}
