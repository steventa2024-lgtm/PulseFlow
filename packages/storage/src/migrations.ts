export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Append-only list. Never edit a shipped migration; add a new one instead.
 * Each migration runs inside a transaction together with its bookkeeping row.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'api' CHECK (kind IN ('api','session')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 0,
  published_version_id TEXT,
  draft TEXT NOT NULL,
  settings TEXT NOT NULL,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  template_id TEXT,
  owner_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_workflows_workspace ON workflows(workspace_id, updated_at DESC);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  graph TEXT NOT NULL,
  settings TEXT NOT NULL,
  checksum TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workflow_id, version_number)
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_id TEXT,
  workflow_name TEXT NOT NULL,
  trigger_node_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  trigger_items TEXT NOT NULL,
  graph TEXT NOT NULL,
  settings TEXT NOT NULL,
  graph_checksum TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  resume_at TEXT,
  waiting_node_id TEXT,
  engine_version TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  error TEXT,
  parent_execution_id TEXT,
  retry_of_execution_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  pinned TEXT
);
CREATE INDEX idx_executions_workflow ON executions(workflow_id, queued_at DESC);
CREATE INDEX idx_executions_state ON executions(state, queued_at);
CREATE INDEX idx_executions_queued_at ON executions(queued_at DESC);

CREATE TABLE execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  input TEXT,
  output TEXT,
  raw_output TEXT,
  error TEXT,
  logs TEXT NOT NULL DEFAULT '[]',
  retry_in_ms INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);
CREATE INDEX idx_steps_execution ON execution_steps(execution_id, seq);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, node_id)
);

CREATE TABLE schedules (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  PRIMARY KEY (workflow_id, node_id)
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  encrypted TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_check_ok INTEGER
);

CREATE TABLE kv_store (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE dedupe_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_events(ts DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  workflow_id TEXT,
  execution_id TEXT,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notifications_ts ON notifications(ts DESC);

CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  execution_id TEXT,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
