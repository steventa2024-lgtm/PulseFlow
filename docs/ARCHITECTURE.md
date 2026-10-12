# Architecture

PulseFlow is a local workflow studio. The editor never executes a graph by itself. The same `WorkflowEngine` runs from the API, the CLI, and tests.

```
Studio (React, Vite, @xyflow/react)
        |  cookie session + x-pulseflow-client
        v
Fastify on 127.0.0.1:8787
        |
        v
WorkflowEngine  --->  node executors (packages/nodes-core)
        |                 |
        |                 +--> files under approved roots
        |                 +--> safeFetch (SSRF checks)
        v
SQLite (node:sqlite, WAL)  executions, versions, secrets
```

Packages:

- `packages/contracts` — graph schema, bundle schema, ids
- `packages/security` — path jail, SSRF address policy, AES-GCM, redaction, HMAC
- `packages/storage` — migrations and repositories
- `packages/nodes-core` — first-party node manifests and executors
- `packages/engine` — validation, expression parser, scheduler, runner
- `packages/templates` — the 24 installed graphs and demo fixtures
- `packages/connectors` — HTTP, RSS, SMTP, demo fixture server
- `apps/server` — local API
- `apps/desktop` — studio UI and Electron shell
- `packages/cli` — doctor, run, validate, import, export

An execution inserts a version snapshot, then walks a DAG. `logic.forEach` is the only supported cycle, and the back edge must target the `loop` port. Branch ports are stored separately so an IF true result cannot leak into the false path.

Expressions are a small parser with an allow-list of functions. There is no `eval` and no `new Function` on workflow expressions. The optional `pg` driver is loaded with a dynamic import so PostgreSQL is not a dependency.

Desktop mode is Electron with `contextIsolation`, `nodeIntegration: false`, and `sandbox: true`. The preload exposes only `pulseflow.version`. The renderer talks to the local API. Closing the window stops the host unless background execution is enabled, and nothing runs while the computer is off.
