# Feature matrix

Status words: Implemented, Partial, Planned, Blocked. Counts for this tree: Implemented 18, Partial 8, Planned 6, Blocked 1.

| Capability | Design | Implementation | Test | Status | Limitation |
| --- | --- | --- | --- | --- | --- |
| Visual editor | Dark studio, xyflow canvas | `apps/desktop/src/studio` | browser check in BUILD_PROGRESS | Implemented | 100-node run is an engine test, not a canvas frame-time measurement |
| Unlimited local runs | No license check | engine + API | template catalog | Implemented | Hardware and provider quotas still apply |
| Drafts and publish | Activate writes a version and schedules | `runtime.activate` | API activate test | Implemented | Deactivate clears schedules |
| Version history and restore | Restore copies a snapshot into a new version | `POST /restore/:versionId` | API covered indirectly; UI restores A01 | Partial | Diff endpoint exists; UI diff is not drawn |
| Import and export | Bundle kind `pulseflow.bundle`, no secrets | API and CLI | `app.test.ts` import | Implemented | |
| Expressions | Allow-list parser | `packages/engine/src/expr.ts` | `expr.test.ts` | Implemented | No user-defined functions |
| Execution history | SQLite executions and steps | storage + console | engine 1000-row query; A01 API | Implemented | Measured under 2s for a 50-row page in the unit test, not a published benchmark |
| Retries | Exponential backoff | `logic.transient`, runner | A16 template test | Implemented | |
| Cancellation | AbortSignal | `engine.cancel` | `engine.test.ts` | Implemented | |
| Restart policy | Interrupted running work fails by default | `Runtime.recover` | `engine.test.ts` | Implemented | Requeue is stored but not separately tested |
| Scheduling and DST | croner | `nextCronRun` | DST unit test | Implemented | Live clock fire is not a CI test |
| Webhooks | HMAC over raw body | `POST /hooks/:id` | `app.test.ts` | Implemented | Local bind by default |
| Credentials | AES-GCM, metadata GET | storage | `app.test.ts`, `security.test.ts` | Implemented | Key file, not OS keystore |
| Subflows | Depth cap 5 | `logic.subworkflow` | node exists; no dedicated test | Partial | |
| Pins and debug | Pins apply only in debug mode | runner | `engine.test.ts` | Implemented | |
| Templates A01–A16 | Real graphs | `packages/templates` | `catalog.test.ts` | Implemented | A11/A12/A15 use the fixture server |
| Templates B01–B08 | Demo vs live | same | catalog demo loop; live 409 | Partial | Live provider calls are not certified |
| Custom node SDK | `NodeRegistry.register` | `packages/nodes-core` | no third-party package fixture | Partial | In-process only |
| CLI | doctor, run, validate, import, export, backup, token | `packages/cli` | not a separate CLI test; uses the same engine | Partial | |
| RBAC and SSO | schema tables | `001_init.sql` | none | Planned | Single local user |
| Postgres and Redis adapters | optional | `postgres.query` dynamic import | none | Planned | Not installed |
| Browser automation | demo HTML extract | `browser.extract` | B08 demo in catalog | Blocked | Live Playwright is not implemented |
| Ollama | fixture or local HTTP | `ai.ollama` | B07 demo in catalog | Partial | No model required for the rest of the app |
| Windows installer | electron-builder zip | `package:win` script | not run | Planned | Electron binary not downloaded here |
| Telemetry | off | settings default false | seed sets false | Implemented | No telemetry client exists |
