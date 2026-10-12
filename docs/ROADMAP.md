# Roadmap

Shipped in 0.1.0 means a test or a local run exercises it. Planned means the code is absent or only a schema exists.

## Done enough to use

- Workflow CRUD, validation, autosave, undo/redo, node canvas, inspector, execution history
- Tier A templates A01–A16 and Tier B demo fixtures B01–B08
- Schedule math including a New York DST example, webhook HMAC, retries, cancellation, restart policy
- Import/export bundles, encrypted backup with a passphrase, local CLI

## Partial

- Electron shell is written and typechecks. The Electron binary and a Windows zip were not produced in this session.
- File watchers are registered on activate. There is no dedicated watcher integration test.
- OAuth helpers exist (`buildAuthorizeUrl`, `exchangeOAuthCode`). There is no provider consent UI.
- Version restore works through the API. The history page restores Hello Automation only.
- Docker Compose builds a self-hosted process. It is not a multi-user product.

## Planned or blocked

- OS keystore (`safeStorage`) instead of the key file
- Playwright browser actions with a visible confirmation step. Live browser extract throws `BROWSER_UNAVAILABLE`.
- RBAC enforcement, SSO, and per-user audit in server mode
- Redis and PostgreSQL as optional queue/storage adapters. The PostgreSQL node loads `pg` only if the user installs it.
- Windows code signing
- A plugin host that runs third-party nodes without full OS rights
