# Architecture

PulseFlow is a local-first application. One machine runs everything: the UI, the API host, the engine and the database. Nothing leaves the machine unless a workflow you built makes a network request.

## Processes (desktop)

```
┌──────────────────────── Electron main (main.cjs) ────────────────────────┐
│ window/tray lifecycle · safeStorage master key · session hardening        │
│ IPC: pf:connection, pf:selectFolder, pf:selectFile, pf:showItem,          │
│      pf:openExternal, pf:setKeepInTray                                    │
└───────────┬──────────────────────────────────────────┬───────────────────┘
            │ utilityProcess.fork(host/utility.cjs)    │ BrowserWindow
            ▼                                          ▼
┌──────── Host (utility process) ────────┐   ┌──── Renderer (sandboxed) ────┐
│ Fastify on 127.0.0.1:<random>          │◄──┤ React + Vite + Tailwind v4   │
│ REST /api/*, SSE /api/events,          │   │ xyflow canvas, Zustand,      │
│ webhooks /hooks/*, fixtures /demo/*,   │   │ TanStack Query               │
│ static renderer + CSP                  │   │ window.pulseflow (preload)   │
│ Engine · Triggers · Storage (SQLite)   │   └──────────────────────────────┘
└────────────────────────────────────────┘
```

- **Main** decrypts the master key with `safeStorage`, forks the host, and passes it the data directory, the key and the static directory over `postMessage`. It denies permission requests, blocks navigation to anything other than the host origin, and opens external links only after an `http(s)` allow-check.
- **Host** generates a random per-launch token and only accepts `/api` requests that carry it (`Authorization: Bearer`, or `access_token` for EventSource). It rejects foreign `Host` headers (DNS-rebinding protection) and cross-origin writes.
- **Renderer** runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. It gets the host URL and token from `pulseflow.connection()` and then uses plain `fetch` and `EventSource`.

The same host runs headless via `pulseflow serve`. With `--server` it switches from the local token to user accounts (owner/editor/viewer), sessions and API tokens.

## Packages

| Package                 | Responsibility                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `@pulseflow/contracts`  | Zod schemas and types: workflow graph, bundle, node manifest, execution, API                |
| `@pulseflow/security`   | AES-256-GCM, scrypt, HMAC, redaction, path grants, SSRF policy, safe JSON                   |
| `@pulseflow/engine`     | Graph validation, expression language, runtime, schedules, FS/HTTP services                 |
| `@pulseflow/storage`    | SQLite (`node:sqlite`), migrations, repositories, backup                                    |
| `@pulseflow/nodes-core` | 52 built-in nodes plus the CSV, feed and JSON Schema helpers                                |
| `@pulseflow/connectors` | GitHub, Discord and Telegram nodes, credential types, SMTP client                           |
| `@pulseflow/templates`  | Tier A and Tier B template manifests and builders                                           |
| `@pulseflow/testing`    | Test helpers                                                                                |
| `apps/server`           | Fastify host, API, auth, workflow and execution services, triggers, webhooks, fixtures, CLI |
| `apps/desktop`          | Electron main, preload, renderer, build and packaging                                       |

## Workflow model

A workflow graph has `nodes` (`id`, `type`, `typeVersion`, `parameters`, `position`, retry/timeout/`onError` settings, `disabled`) and `edges` (`source`, `sourcePort` → `target`, `targetPort`). Items are `{ json }` objects. Each node receives an array of items per input port and emits arrays per output port.

Drafts are edited with optimistic revisions. **Publish** creates an immutable, numbered version. **Activate** arms the published version's triggers (schedule, webhook, file/folder watch, HTTP/RSS poll, startup). **Restore** copies a version back into the draft.

## Execution engine

1. **Validate:** unknown node types, invalid parameters, bad expressions, cycles and disconnected required inputs are rejected before anything runs.
2. **Plan:** start from the trigger and walk reachable nodes in topological order. A node runs once all of its connected inputs have resolved. A branch that receives no items (for example the false side of an IF) is marked skipped and its descendants are skipped too.
3. **Run a step:** resolve parameters (expressions evaluated per item), check permissions (FS grants, network policy, advanced-node gate), then execute with an `AbortSignal` and timeout. Retries use exponential backoff. On final failure, `onError` either stops the run, continues with the input items, or routes to the `error` port.
4. **Persist:** each step (inputs, outputs, attempts, timings, redacted logs) goes to `execution_steps`, and progress is streamed over SSE.
5. **Durable waits:** long `Wait` nodes and resumable executions are stored with a resume time. They survive restarts.
6. **Recovery:** on startup, runs that were `running` when the process died are marked failed with `INTERRUPTED`, durable waits are rescheduled, and queued runs are resumed. Executions older than `retentionDays` are pruned.
7. **Failures:** failed trigger-driven runs, and trigger events rejected because the queue is full, are added to the dead-letter queue for replay. You can retry from the failed node, which reuses earlier step outputs.

Concurrency: executions are claimed from the queue in order, with a per-workflow concurrency gate.

## Expressions

`{{ … }}` templates are parsed by a hand-written Pratt parser into an AST and evaluated by a tree walker. There is no `eval` or `Function`. Roots: `$json`, `$item`, `$input`, `$node`, `$vars`, `$env` (allow-listed variables only), `$execution`, `$workflow`, `$trigger`, `$now`, `$today`. Only allow-listed functions can be called (string, array, math, date and path helpers). Prototype access (`__proto__`, `constructor`, `prototype`) is blocked, and inherited properties are invisible. A template that is a single expression keeps its type. Mixed text becomes a string.

## Storage

SQLite in WAL mode lives in the data directory. The desktop app uses Electron's `userData` (`%APPDATA%/PulseFlow` on Windows, `~/.config/PulseFlow` on Linux). The CLI uses `%APPDATA%/PulseFlow` on Windows and `$XDG_DATA_HOME/pulseflow` (default `~/.local/share/pulseflow`) on Linux. `PULSEFLOW_DATA_DIR` overrides both. Tables: `workspaces`, `users`, `memberships`, `api_tokens`, `workflows`, `workflow_versions`, `executions`, `execution_steps`, `webhook_endpoints`, `schedules`, `credentials`, `kv_store`, `dedupe_keys`, `audit_events`, `notifications`, `dead_letters`, `app_settings`. Backups use `VACUUM INTO`, which is safe while the app is running.

## Demo fixtures

The host serves `/demo/*` loopback endpoints that imitate GitHub, Discord, Telegram, an SMTP sink, Google Sheets, Ollama and a monitored website. Tier B templates in demo mode point their `apiBaseUrl` at these endpoints and say so in the UI. Live mode points at the real provider and needs a real credential. A missing credential fails with `CREDENTIAL_REQUIRED` and never fakes success. `--no-fixtures` turns the fixture endpoints off.
