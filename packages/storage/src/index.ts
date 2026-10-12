import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ENGINE_VERSION,
  type ExecutionState,
  type RetryPolicy,
  type WorkflowGraph,
  defaultRetry,
  parseGraph,
  sanitizeUnknown,
} from "@pulseflow/contracts";
import { decryptJson, encryptJson, type EncryptedBlob } from "@pulseflow/security";

export interface WorkflowRecord {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  currentPublishedVersionId: string | null;
  draftGraph: WorkflowGraph;
  concurrency: number;
  timezone: string;
  retryPolicy: RetryPolicy;
  interruptPolicy: "fail" | "requeue";
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRecord {
  id: string;
  workflowId: string;
  schemaVersion: number;
  graph: WorkflowGraph;
  checksum: string;
  published: boolean;
  createdBy: string | null;
  createdAt: string;
  note: string;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowVersionId: string | null;
  triggerType: string;
  triggerNodeId: string | null;
  triggerPayload: unknown;
  state: ExecutionState;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  runAt: string | null;
  engineVersion: string;
  correlationId: string;
  errorSummary: string | null;
  errorCode: string | null;
  replayOf: string | null;
  pinMode: boolean;
  mode: string;
  idempotencyKey: string | null;
  response: unknown;
  checkpoint: unknown;
}

export interface StepRecord {
  id: string;
  executionId: string;
  nodeId: string;
  attempt: number;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  input: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  errorStack: string | null;
  retryWaitMs: number | null;
  logs: unknown[];
}

export interface ScheduleRecord {
  id: string;
  workflowId: string;
  nodeId: string;
  kind: string;
  cron: string | null;
  intervalMs: number | null;
  timezone: string;
  missedPolicy: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface WebhookRecord {
  id: string;
  workflowId: string;
  nodeId: string;
  secretHash: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface CredentialMeta {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  kind: string;
  payload: unknown;
  state: string;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedAt: string | null;
  lastError: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | undefined {
  if (!value || typeof value !== "object") return undefined;
  return { ...(value as Row) };
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected string column ${key}`);
  return value;
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Expected number column ${key}`);
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return Number(value);
}

function bool(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

function jsonValue(row: Row, key: string): unknown {
  const raw = row[key];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return sanitizeUnknown(JSON.parse(raw) as unknown);
}

export class PulseStore {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed.
      }
      throw error;
    }
  }

  migrate(): void {
    const sqlPath = new URL("../migrations/001_init.sql", import.meta.url);
    const sql = readFileSync(sqlPath, "utf8");
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!existing) {
      this.db.exec(sql);
      this.db
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run("001_init", new Date().toISOString());
      return;
    }
    const applied = asRow(this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("001_init"));
    if (!applied) {
      this.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run("001_init", new Date().toISOString());
      });
    }
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(FULL);");
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(key, JSON.stringify(value));
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = asRow(this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key));
    if (!row) return fallback;
    return jsonValue(row, "value_json") as T;
  }

  addRoot(id: string, rootPath: string, purpose: string): void {
    this.db
      .prepare(
        "INSERT INTO approved_roots (id, path, purpose, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING",
      )
      .run(id, rootPath, purpose, new Date().toISOString());
  }

  listRoots(): string[] {
    return this.db
      .prepare("SELECT path FROM approved_roots ORDER BY path")
      .all()
      .map((row) => str(asRow(row)!, "path"));
  }

  countWorkflows(): number {
    const row = asRow(this.db.prepare("SELECT COUNT(*) AS count FROM workflows").get());
    return row ? num(row, "count") : 0;
  }

  ensureLocalIdentity(): { workspaceId: string; projectId: string; userId: string } {
    const now = new Date().toISOString();
    const existing = asRow(this.db.prepare("SELECT id FROM workspaces LIMIT 1").get());
    if (existing) {
      const workspaceId = str(existing, "id");
      const project = asRow(this.db.prepare("SELECT id FROM projects WHERE workspace_id = ? LIMIT 1").get(workspaceId));
      const user = asRow(this.db.prepare("SELECT id FROM users LIMIT 1").get());
      return {
        workspaceId,
        projectId: project ? str(project, "id") : "proj_personal",
        userId: user ? str(user, "id") : "user_local",
      };
    }
    this.transaction(() => {
      this.db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "ws_local",
        "Local",
        now,
        now,
      );
      this.db
        .prepare("INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("proj_personal", "ws_local", "Personal", now, now);
      this.db
        .prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("user_local", null, "Local Owner", null, now);
      this.db
        .prepare("INSERT INTO roles (id, workspace_id, name, permissions_json) VALUES (?, ?, ?, ?)")
        .run(
          "role_owner",
          "ws_local",
          "owner",
          JSON.stringify([
            "workflow.read",
            "workflow.write",
            "workflow.run",
            "workflow.publish",
            "credential.read",
            "credential.write",
            "audit.read",
            "admin",
          ]),
        );
      this.db
        .prepare("INSERT INTO memberships (id, workspace_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("mem_local", "ws_local", "user_local", "role_owner", now);
    });
    return { workspaceId: "ws_local", projectId: "proj_personal", userId: "user_local" };
  }

  insertWorkflow(input: {
    id: string;
    workspaceId: string;
    projectId?: string | null;
    name: string;
    description?: string;
    tags?: string[];
    graph: WorkflowGraph;
    timezone?: string;
    retryPolicy?: RetryPolicy;
    ownerId?: string | null;
  }): WorkflowRecord {
    const now = new Date().toISOString();
    const retry = input.retryPolicy ?? defaultRetry();
    this.db
      .prepare(
        `INSERT INTO workflows (
          id, workspace_id, project_id, name, description, tags_json, active,
          current_published_version_id, draft_graph_json, concurrency, timezone,
          retry_policy_json, interrupt_policy, owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, 'fail', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.projectId ?? null,
        input.name,
        input.description ?? "",
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.graph),
        input.graph.settings?.concurrency ?? 1,
        input.timezone ?? input.graph.settings?.timezone ?? "UTC",
        JSON.stringify(retry),
        input.ownerId ?? null,
        now,
        now,
      );
    return this.getWorkflow(input.id)!;
  }

  updateWorkflow(
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      tags: string[];
      graph: WorkflowGraph;
      active: boolean;
      currentPublishedVersionId: string | null;
      timezone: string;
      retryPolicy: RetryPolicy;
      interruptPolicy: "fail" | "requeue";
      concurrency: number;
    }>,
  ): WorkflowRecord {
    const current = this.getWorkflow(id);
    if (!current) throw new Error(`Workflow not found: ${id}`);
    const next = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      tags: patch.tags ?? current.tags,
      graph: patch.graph ?? current.draftGraph,
      active: patch.active ?? current.active,
      version: patch.currentPublishedVersionId === undefined ? current.currentPublishedVersionId : patch.currentPublishedVersionId,
      timezone: patch.timezone ?? current.timezone,
      retry: patch.retryPolicy ?? current.retryPolicy,
      interrupt: patch.interruptPolicy ?? current.interruptPolicy,
      concurrency: patch.concurrency ?? current.concurrency,
    };
    this.db
      .prepare(
        `UPDATE workflows SET name=?, description=?, tags_json=?, draft_graph_json=?, active=?,
         current_published_version_id=?, timezone=?, retry_policy_json=?, interrupt_policy=?,
         concurrency=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.description,
        JSON.stringify(next.tags),
        JSON.stringify(next.graph),
        next.active ? 1 : 0,
        next.version,
        next.timezone,
        JSON.stringify(next.retry),
        next.interrupt,
        next.concurrency,
        new Date().toISOString(),
        id,
      );
    return this.getWorkflow(id)!;
  }

  getWorkflow(id: string): WorkflowRecord | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
    return row ? mapWorkflow(row) : undefined;
  }

  listWorkflows(workspaceId?: string): WorkflowRecord[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM workflows WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId)
      : this.db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all();
    return rows.map((row) => mapWorkflow(asRow(row)!));
  }

  deleteWorkflow(id: string): void {
    this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  insertVersion(input: {
    id: string;
    workflowId: string;
    graph: WorkflowGraph;
    published: boolean;
    createdBy?: string | null;
    note?: string;
  }): VersionRecord {
    const now = new Date().toISOString();
    const graphJson = JSON.stringify(input.graph);
    const checksum = createHash("sha256").update(graphJson).digest("hex");
    this.db
      .prepare(
        `INSERT INTO workflow_versions (
          id, workflow_id, schema_version, graph_json, checksum, published, created_by, created_at, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowId,
        input.graph.schemaVersion,
        graphJson,
        checksum,
        input.published ? 1 : 0,
        input.createdBy ?? null,
        now,
        input.note ?? "",
      );
    return this.getVersion(input.id)!;
  }

  getVersion(id: string): VersionRecord | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM workflow_versions WHERE id = ?").get(id));
    return row ? mapVersion(row) : undefined;
  }

  listVersions(workflowId: string): VersionRecord[] {
    return this.db
      .prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY created_at DESC")
      .all(workflowId)
      .map((row) => mapVersion(asRow(row)!));
  }

  insertExecution(input: {
    id: string;
    workflowId: string;
    workflowVersionId?: string | null;
    triggerType: string;
    triggerNodeId?: string | null;
    triggerPayload: unknown;
    state?: ExecutionState;
    correlationId: string;
    replayOf?: string | null;
    pinMode?: boolean;
    mode?: string;
    idempotencyKey?: string | null;
    runAt?: string | null;
  }): ExecutionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO executions (
          id, workflow_id, workflow_version_id, trigger_type, trigger_node_id, trigger_payload_json,
          state, queued_at, run_at, engine_version, correlation_id, replay_of, pin_mode, mode, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowId,
        input.workflowVersionId ?? null,
        input.triggerType,
        input.triggerNodeId ?? null,
        JSON.stringify(sanitizeUnknown(input.triggerPayload ?? {})),
        input.state ?? "queued",
        now,
        input.runAt ?? now,
        ENGINE_VERSION,
        input.correlationId,
        input.replayOf ?? null,
        input.pinMode ? 1 : 0,
        input.mode ?? "production",
        input.idempotencyKey ?? null,
      );
    return this.getExecution(input.id)!;
  }

  updateExecution(id: string, patch: Record<string, unknown>): void {
    const sets: string[] = [];
    const values: Array<string | number | bigint | null> = [];
    const mapping: Record<string, string> = {
      state: "state",
      startedAt: "started_at",
      endedAt: "ended_at",
      runAt: "run_at",
      errorSummary: "error_summary",
      errorCode: "error_code",
      workflowVersionId: "workflow_version_id",
      response: "response_json",
      checkpoint: "checkpoint_json",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        const value = patch[key];
        const stored =
          key === "response" || key === "checkpoint" || typeof value === "object"
            ? JSON.stringify(sanitizeUnknown(value))
            : value;
        values.push(stored as string | number | bigint | null);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE executions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id));
    return row ? mapExecution(row) : undefined;
  }

  getExecutionByIdempotency(key: string): ExecutionRecord | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM executions WHERE idempotency_key = ?").get(key));
    return row ? mapExecution(row) : undefined;
  }

  listExecutions(filter: { workflowId?: string; state?: string; limit?: number; offset?: number } = {}): ExecutionRecord[] {
    const where: string[] = [];
    const values: Array<string | number | null> = [];
    if (filter.workflowId) {
      where.push("workflow_id = ?");
      values.push(filter.workflowId);
    }
    if (filter.state) {
      where.push("state = ?");
      values.push(filter.state);
    }
    const sql = `SELECT * FROM executions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY queued_at DESC LIMIT ? OFFSET ?`;
    values.push(filter.limit ?? 100, filter.offset ?? 0);
    return this.db.prepare(sql).all(...values).map((row) => mapExecution(asRow(row)!));
  }

  countExecutions(): number {
    const row = asRow(this.db.prepare("SELECT COUNT(*) AS count FROM executions").get());
    return row ? num(row, "count") : 0;
  }

  countExecutionsByState(state: string): number {
    const row = asRow(this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE state = ?").get(state));
    return row ? num(row, "count") : 0;
  }

  listRecoverableExecutions(): ExecutionRecord[] {
    return this.db
      .prepare("SELECT * FROM executions WHERE state IN ('queued', 'running', 'retrying', 'waiting') ORDER BY queued_at")
      .all()
      .map((row) => mapExecution(asRow(row)!));
  }

  claimExecution(id: string, fromStates: string[], now: string): boolean {
    const placeholders = fromStates.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE executions SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(now, id, ...fromStates);
    return Number(result.changes) === 1;
  }

  insertStep(step: Omit<StepRecord, "logs"> & { logs?: unknown[] }): void {
    this.db
      .prepare(
        `INSERT INTO execution_steps (
          id, execution_id, node_id, attempt, state, started_at, ended_at, input_json, output_json,
          error_code, error_message, error_stack, retry_wait_ms, logs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id,
        step.executionId,
        step.nodeId,
        step.attempt,
        step.state,
        step.startedAt,
        step.endedAt,
        step.input === undefined ? null : JSON.stringify(step.input),
        step.output === undefined ? null : JSON.stringify(step.output),
        step.errorCode,
        step.errorMessage,
        step.errorStack,
        step.retryWaitMs,
        JSON.stringify(step.logs ?? []),
      );
  }

  listSteps(executionId: string): StepRecord[] {
    return this.db
      .prepare("SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY started_at, rowid")
      .all(executionId)
      .map((row) => mapStep(asRow(row)!));
  }

  addEvent(executionId: string, type: string, data: unknown, ts = new Date().toISOString()): void {
    this.db
      .prepare("INSERT INTO execution_events (execution_id, ts, type, data_json) VALUES (?, ?, ?, ?)")
      .run(executionId, ts, type, JSON.stringify(sanitizeUnknown(data ?? {})));
  }

  listEvents(executionId: string, afterId = 0): Array<{ id: number; ts: string; type: string; data: unknown }> {
    return this.db
      .prepare("SELECT * FROM execution_events WHERE execution_id = ? AND id > ? ORDER BY id")
      .all(executionId, afterId)
      .map((row) => {
        const record = asRow(row)!;
        return {
          id: num(record, "id"),
          ts: str(record, "ts"),
          type: str(record, "type"),
          data: jsonValue(record, "data_json"),
        };
      });
  }

  replaceSchedules(workflowId: string, schedules: Array<Omit<ScheduleRecord, "lastRunAt"> & { lastRunAt?: string | null }>): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM schedules WHERE workflow_id = ?").run(workflowId);
      const stmt = this.db.prepare(
        `INSERT INTO schedules (
          id, workflow_id, node_id, kind, cron, interval_ms, timezone, missed_policy, enabled, next_run_at, last_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const schedule of schedules) {
        stmt.run(
          schedule.id,
          workflowId,
          schedule.nodeId,
          schedule.kind,
          schedule.cron,
          schedule.intervalMs,
          schedule.timezone,
          schedule.missedPolicy,
          schedule.enabled ? 1 : 0,
          schedule.nextRunAt,
          schedule.lastRunAt ?? null,
        );
      }
    });
  }

  listSchedules(workflowId?: string): ScheduleRecord[] {
    const rows = workflowId
      ? this.db.prepare("SELECT * FROM schedules WHERE workflow_id = ?").all(workflowId)
      : this.db.prepare("SELECT * FROM schedules").all();
    return rows.map((row) => mapSchedule(asRow(row)!));
  }

  dueSchedules(nowIso: string): ScheduleRecord[] {
    return this.db
      .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
      .all(nowIso)
      .map((row) => mapSchedule(asRow(row)!));
  }

  updateSchedule(id: string, patch: { nextRunAt?: string | null; lastRunAt?: string | null; enabled?: boolean }): void {
    this.db
      .prepare("UPDATE schedules SET next_run_at = COALESCE(?, next_run_at), last_run_at = COALESCE(?, last_run_at), enabled = COALESCE(?, enabled) WHERE id = ?")
      .run(
        patch.nextRunAt === undefined ? null : patch.nextRunAt,
        patch.lastRunAt === undefined ? null : patch.lastRunAt,
        patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
        id,
      );
  }

  replaceWebhooks(
    workflowId: string,
    hooks: Array<{ id: string; nodeId: string; secretHash: string | null; secret?: EncryptedBlob | null; enabled: boolean }>,
  ): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM webhook_endpoints WHERE workflow_id = ?").run(workflowId);
      const stmt = this.db.prepare(
        `INSERT INTO webhook_endpoints (id, workflow_id, node_id, secret_hash, secret_cipher, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const hook of hooks) {
        stmt.run(
          hook.id,
          workflowId,
          hook.nodeId,
          hook.secretHash,
          hook.secret ? JSON.stringify(hook.secret) : null,
          hook.enabled ? 1 : 0,
          new Date().toISOString(),
        );
      }
    });
  }

  listWebhooks(workflowId?: string): WebhookRecord[] {
    const rows = workflowId
      ? this.db.prepare("SELECT * FROM webhook_endpoints WHERE workflow_id = ?").all(workflowId)
      : this.db.prepare("SELECT * FROM webhook_endpoints").all();
    return rows.map((row) => mapWebhook(asRow(row)!));
  }

  getWebhook(id: string): (WebhookRecord & { secret: EncryptedBlob | null }) | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(id));
    if (!row) return undefined;
    const secretRaw = strOrNull(row, "secret_cipher");
    return {
      ...mapWebhook(row),
      secret: secretRaw ? (JSON.parse(secretRaw) as EncryptedBlob) : null,
    };
  }

  insertCredential(input: { id: string; workspaceId: string; name: string; kind: string; secret: unknown; key: Buffer }): CredentialMeta {
    const now = new Date().toISOString();
    const blob = encryptJson(input.secret, input.key);
    this.db
      .prepare(
        `INSERT INTO credentials (id, workspace_id, name, kind, ciphertext, iv, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.workspaceId, input.name, input.kind, blob.ciphertext, blob.iv, blob.tag, now, now);
    return this.getCredentialMeta(input.id)!;
  }

  listCredentials(workspaceId: string): CredentialMeta[] {
    return this.db
      .prepare("SELECT id, workspace_id, name, kind, created_at, updated_at FROM credentials WHERE workspace_id = ? ORDER BY name")
      .all(workspaceId)
      .map((row) => mapCredential(asRow(row)!));
  }

  getCredentialMeta(id: string): CredentialMeta | undefined {
    const row = asRow(
      this.db.prepare("SELECT id, workspace_id, name, kind, created_at, updated_at FROM credentials WHERE id = ?").get(id),
    );
    return row ? mapCredential(row) : undefined;
  }

  readCredential(id: string, key: Buffer): unknown {
    const row = asRow(this.db.prepare("SELECT ciphertext, iv, tag FROM credentials WHERE id = ?").get(id));
    if (!row) return undefined;
    return decryptJson(
      { ciphertext: str(row, "ciphertext"), iv: str(row, "iv"), tag: str(row, "tag") },
      key,
    );
  }

  deleteCredential(id: string): void {
    this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
  }

  listCredentialsByKind(workspaceId: string, kind: string): CredentialMeta[] {
    return this.listCredentials(workspaceId).filter((item) => item.kind === kind);
  }

  insertJob(input: {
    id: string;
    kind: string;
    payload: unknown;
    runAt?: string;
    maxAttempts?: number;
    idempotencyKey?: string | null;
  }): JobRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload_json, state, run_at, attempts, max_attempts, idempotency_key, created_at)
         VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        JSON.stringify(sanitizeUnknown(input.payload)),
        input.runAt ?? now,
        input.maxAttempts ?? 3,
        input.idempotencyKey ?? null,
        now,
      );
    return this.getJob(input.id)!;
  }

  getJob(id: string): JobRecord | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id));
    return row ? mapJob(row) : undefined;
  }

  claimJob(nowIso: string): JobRecord | undefined {
    const row = asRow(
      this.db
        .prepare(
          `UPDATE jobs SET state = 'running', locked_at = ?, attempts = attempts + 1
           WHERE id = (
             SELECT id FROM jobs WHERE state = 'queued' AND run_at <= ? ORDER BY run_at, created_at LIMIT 1
           ) AND state = 'queued'
           RETURNING *`,
        )
        .get(nowIso, nowIso),
    );
    return row ? mapJob(row) : undefined;
  }

  finishJob(id: string, state: "succeeded" | "failed" | "dead" | "queued", lastError?: string, runAt?: string): void {
    this.db
      .prepare("UPDATE jobs SET state = ?, last_error = ?, locked_at = NULL, run_at = COALESCE(?, run_at) WHERE id = ?")
      .run(state, lastError ?? null, runAt ?? null, id);
  }

  recordDelivery(input: { id?: string; jobId?: string | null; executionId?: string | null; nodeId?: string | null; status: string; detail?: string }): void {
    this.db
      .prepare(
        `INSERT INTO delivery_attempts (id, job_id, execution_id, node_id, attempted_at, status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id ?? `del_${randomBytes(8).toString("hex")}`,
        input.jobId ?? null,
        input.executionId ?? null,
        input.nodeId ?? null,
        new Date().toISOString(),
        input.status,
        input.detail ?? null,
      );
  }

  listDeliveries(executionId: string): Array<{ status: string; detail: string | null; nodeId: string | null }> {
    return this.db
      .prepare("SELECT status, detail, node_id FROM delivery_attempts WHERE execution_id = ? ORDER BY attempted_at")
      .all(executionId)
      .map((row) => {
        const record = asRow(row)!;
        return { status: str(record, "status"), detail: strOrNull(record, "detail"), nodeId: strOrNull(record, "node_id") };
      });
  }

  putIdempotency(key: string, scope: string, executionId: string): void {
    this.db
      .prepare(
        "INSERT INTO idempotency_keys (key, scope, created_at, execution_id) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
      )
      .run(key, scope, new Date().toISOString(), executionId);
  }

  getIdempotency(key: string): { executionId: string | null } | undefined {
    const row = asRow(this.db.prepare("SELECT execution_id FROM idempotency_keys WHERE key = ?").get(key));
    if (!row) return undefined;
    return { executionId: strOrNull(row, "execution_id") };
  }

  audit(input: { id: string; workspaceId?: string | null; actorId?: string | null; action: string; targetType?: string; targetId?: string; detail?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId ?? null,
        input.actorId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(sanitizeUnknown(input.detail ?? {})),
        new Date().toISOString(),
      );
  }

  listAudit(limit = 100): Array<{ id: string; action: string; targetId: string | null; createdAt: string; detail: unknown }> {
    return this.db
      .prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => {
        const record = asRow(row)!;
        return {
          id: str(record, "id"),
          action: str(record, "action"),
          targetId: strOrNull(record, "target_id"),
          createdAt: str(record, "created_at"),
          detail: jsonValue(record, "detail_json"),
        };
      });
  }

  kvGet(namespace: string, key: string): unknown {
    const row = asRow(this.db.prepare("SELECT value_json FROM kv_store WHERE namespace = ? AND key = ?").get(namespace, key));
    return row ? jsonValue(row, "value_json") : undefined;
  }

  kvSet(namespace: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(namespace, key, JSON.stringify(sanitizeUnknown(value)), new Date().toISOString());
  }

  insertToken(input: { id: string; name: string; tokenHash: string; scopes: string[] }): void {
    this.db
      .prepare("INSERT INTO api_tokens (id, name, token_hash, scopes_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.name, input.tokenHash, JSON.stringify(input.scopes), new Date().toISOString());
  }

  findToken(tokenHash: string): { id: string; name: string; scopes: string[] } | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash));
    if (!row) return undefined;
    return { id: str(row, "id"), name: str(row, "name"), scopes: jsonValue(row, "scopes_json") as string[] };
  }

  listTokens(): Array<{ id: string; name: string; scopes: string[]; createdAt: string; revokedAt: string | null }> {
    return this.db
      .prepare("SELECT id, name, scopes_json, created_at, revoked_at FROM api_tokens ORDER BY created_at DESC")
      .all()
      .map((row) => {
        const record = asRow(row)!;
        return {
          id: str(record, "id"),
          name: str(record, "name"),
          scopes: jsonValue(record, "scopes_json") as string[],
          createdAt: str(record, "created_at"),
          revokedAt: strOrNull(record, "revoked_at"),
        };
      });
  }

  revokeToken(id: string): void {
    this.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  getPin(workflowId: string, nodeId: string): unknown {
    const row = asRow(this.db.prepare("SELECT data_json FROM pins WHERE workflow_id = ? AND node_id = ?").get(workflowId, nodeId));
    return row ? jsonValue(row, "data_json") : undefined;
  }

  setPin(id: string, workflowId: string, nodeId: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO pins (id, workflow_id, node_id, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, node_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(id, workflowId, nodeId, JSON.stringify(sanitizeUnknown(data)), new Date().toISOString());
  }

  insertNotification(input: { id: string; workspaceId: string; executionId?: string | null; title: string; body: string }): void {
    this.db
      .prepare("INSERT INTO notifications (id, workspace_id, execution_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.workspaceId, input.executionId ?? null, input.title, input.body, new Date().toISOString());
  }

  listNotifications(limit = 50): Array<{ id: string; title: string; body: string; createdAt: string; executionId: string | null }> {
    return this.db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => {
        const record = asRow(row)!;
        return {
          id: str(record, "id"),
          title: str(record, "title"),
          body: str(record, "body"),
          createdAt: str(record, "created_at"),
          executionId: strOrNull(record, "execution_id"),
        };
      });
  }

  purgeExecutionsOlderThan(iso: string): number {
    const result = this.db.prepare("DELETE FROM executions WHERE queued_at < ? AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'skipped')").run(iso);
    return Number(result.changes);
  }

  insertUser(input: { id: string; email: string; displayName: string; passwordHash: string }): void {
    this.db
      .prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id, input.email, input.displayName, input.passwordHash, new Date().toISOString());
  }

  findUserByEmail(email: string): { id: string; email: string; displayName: string; passwordHash: string } | undefined {
    const row = asRow(this.db.prepare("SELECT * FROM users WHERE email = ?").get(email));
    if (!row) return undefined;
    return {
      id: str(row, "id"),
      email: str(row, "email"),
      displayName: str(row, "display_name"),
      passwordHash: str(row, "password_hash"),
    };
  }
}

function mapWorkflow(row: Row): WorkflowRecord {
  return {
    id: str(row, "id"),
    workspaceId: str(row, "workspace_id"),
    projectId: strOrNull(row, "project_id"),
    name: str(row, "name"),
    description: str(row, "description"),
    tags: (jsonValue(row, "tags_json") as string[]) ?? [],
    active: bool(row, "active"),
    currentPublishedVersionId: strOrNull(row, "current_published_version_id"),
    draftGraph: parseGraph(jsonValue(row, "draft_graph_json")),
    concurrency: num(row, "concurrency"),
    timezone: str(row, "timezone"),
    retryPolicy: jsonValue(row, "retry_policy_json") as RetryPolicy,
    interruptPolicy: str(row, "interrupt_policy") === "requeue" ? "requeue" : "fail",
    ownerId: strOrNull(row, "owner_id"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

function mapVersion(row: Row): VersionRecord {
  return {
    id: str(row, "id"),
    workflowId: str(row, "workflow_id"),
    schemaVersion: num(row, "schema_version"),
    graph: parseGraph(jsonValue(row, "graph_json")),
    checksum: str(row, "checksum"),
    published: bool(row, "published"),
    createdBy: strOrNull(row, "created_by"),
    createdAt: str(row, "created_at"),
    note: str(row, "note"),
  };
}

function mapExecution(row: Row): ExecutionRecord {
  return {
    id: str(row, "id"),
    workflowId: str(row, "workflow_id"),
    workflowVersionId: strOrNull(row, "workflow_version_id"),
    triggerType: str(row, "trigger_type"),
    triggerNodeId: strOrNull(row, "trigger_node_id"),
    triggerPayload: jsonValue(row, "trigger_payload_json"),
    state: str(row, "state") as ExecutionState,
    queuedAt: str(row, "queued_at"),
    startedAt: strOrNull(row, "started_at"),
    endedAt: strOrNull(row, "ended_at"),
    runAt: strOrNull(row, "run_at"),
    engineVersion: str(row, "engine_version"),
    correlationId: str(row, "correlation_id"),
    errorSummary: strOrNull(row, "error_summary"),
    errorCode: strOrNull(row, "error_code"),
    replayOf: strOrNull(row, "replay_of"),
    pinMode: bool(row, "pin_mode"),
    mode: str(row, "mode"),
    idempotencyKey: strOrNull(row, "idempotency_key"),
    response: jsonValue(row, "response_json"),
    checkpoint: jsonValue(row, "checkpoint_json"),
  };
}

function mapStep(row: Row): StepRecord {
  return {
    id: str(row, "id"),
    executionId: str(row, "execution_id"),
    nodeId: str(row, "node_id"),
    attempt: num(row, "attempt"),
    state: str(row, "state"),
    startedAt: strOrNull(row, "started_at"),
    endedAt: strOrNull(row, "ended_at"),
    input: jsonValue(row, "input_json"),
    output: jsonValue(row, "output_json"),
    errorCode: strOrNull(row, "error_code"),
    errorMessage: strOrNull(row, "error_message"),
    errorStack: strOrNull(row, "error_stack"),
    retryWaitMs: numOrNull(row, "retry_wait_ms"),
    logs: (jsonValue(row, "logs_json") as unknown[]) ?? [],
  };
}

function mapSchedule(row: Row): ScheduleRecord {
  return {
    id: str(row, "id"),
    workflowId: str(row, "workflow_id"),
    nodeId: str(row, "node_id"),
    kind: str(row, "kind"),
    cron: strOrNull(row, "cron"),
    intervalMs: numOrNull(row, "interval_ms"),
    timezone: str(row, "timezone"),
    missedPolicy: str(row, "missed_policy"),
    enabled: bool(row, "enabled"),
    nextRunAt: strOrNull(row, "next_run_at"),
    lastRunAt: strOrNull(row, "last_run_at"),
  };
}

function mapWebhook(row: Row): WebhookRecord {
  return {
    id: str(row, "id"),
    workflowId: str(row, "workflow_id"),
    nodeId: str(row, "node_id"),
    secretHash: strOrNull(row, "secret_hash"),
    enabled: bool(row, "enabled"),
    createdAt: str(row, "created_at"),
  };
}

function mapCredential(row: Row): CredentialMeta {
  return {
    id: str(row, "id"),
    workspaceId: str(row, "workspace_id"),
    name: str(row, "name"),
    kind: str(row, "kind"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
  };
}

function mapJob(row: Row): JobRecord {
  return {
    id: str(row, "id"),
    kind: str(row, "kind"),
    payload: jsonValue(row, "payload_json"),
    state: str(row, "state"),
    runAt: str(row, "run_at"),
    attempts: num(row, "attempts"),
    maxAttempts: num(row, "max_attempts"),
    lockedAt: strOrNull(row, "locked_at"),
    lastError: strOrNull(row, "last_error"),
    idempotencyKey: strOrNull(row, "idempotency_key"),
    createdAt: str(row, "created_at"),
  };
}

export function openStore(file: string): PulseStore {
  const store = new PulseStore(file);
  store.migrate();
  return store;
}
