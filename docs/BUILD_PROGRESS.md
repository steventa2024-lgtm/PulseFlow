# Build progress

This is the status of each build phase with its evidence. "Verified" means an automated gate in `pnpm verify:release` passed. Results from the last run are in `artifacts/verification/summary.md`, which isn't committed and is regenerated on every run.

## Last verification run

- Date: 2026-10-13, linux-x64, Node 22.14.0, Electron 44.7.0, under Xvfb
- Command: `pnpm verify:release` (packaging was not re-run; the 2026-10-12 `--package` run built the Linux AppImage and passed its smoke test)
- Result: **PASS. 14 of 14 gates passed.**

| Gate                                                                                   | Result      |
| -------------------------------------------------------------------------------------- | ----------- |
| typecheck, lint (ESLint), format (Prettier)                                            | passed      |
| unit (vitest)                                                                          | 71/71       |
| templates (vitest, Tier A + B demo)                                                    | 33/33       |
| perf (1,000 runs in 2.6 s ≈ 388 runs/s; storage history queries ≤ 3 ms; API list 8 ms) | 2/2         |
| build                                                                                  | passed      |
| CLI `templates:test` (all 23 templates, demo path)                                     | 23/23 PASS  |
| CLI `doctor` (56 node types, 23 templates, schema v1)                                  | passed      |
| license audit (497 packages, 91 shipped, 0 denied)                                     | passed      |
| CycloneDX SBOM                                                                         | written     |
| secret scan                                                                            | no findings |
| Electron smoke test                                                                    | passed      |
| Playwright Electron E2E (includes the dead-letter tab)                                 | 6/6         |

## Phases

| Phase                    | Scope                                                                                                                                                              | Status                                     | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0: Foundation            | Monorepo, contracts, security primitives, storage, CI, lint/format, license policy                                                                                 | **Verified**                               | typecheck/lint/format, `security.test.ts`, `storage.test.ts`, license audit                                                                                                                                                                                                                                                                                 |
| 1: Vertical slice        | Canvas editor → save → publish → run → live console, with A01 end-to-end in the real desktop app                                                                   | **Verified**                               | `e2e/desktop.spec.ts` (A01 from the gallery, a workflow built from scratch), A01 template tests                                                                                                                                                                                                                                                             |
| 2: Engine depth          | Retries/backoff, timeouts, cancel, onError, durable waits, crash recovery, sub-workflows, retry-from-failed, DLQ, retention, versions/restore                      | **Verified**                               | `engine.test.ts`, `api.test.ts`, `durability-ops.test.ts`, `storage.test.ts`                                                                                                                                                                                                                                                                                |
| 3: Node library          | 56 nodes with permissions and risk levels                                                                                                                          | **Verified** where tests reach. See notes. | Nodes exercised by the engine and template suites. Not every parameter combination of every node has its own unit test.                                                                                                                                                                                                                                     |
| 4: Templates             | 16 Tier A offline + 7 Tier B with demo mode                                                                                                                        | **Verified** (demo mode)                   | `tier-a.test.ts`, `tier-b.test.ts`, CLI `templates:test`. Tier B **live** mode isn't tested (it needs real accounts). B08 is planned and not built.                                                                                                                                                                                                         |
| 5: Security hardening    | Scoped FS, SSRF, write-only credentials, renderer isolation, CSP, webhook protections, advanced-node gate                                                          | **Verified**                               | `security.test.ts`, `api.test.ts`, `engine.test.ts`, E2E isolation test                                                                                                                                                                                                                                                                                     |
| 6: Desktop UX            | Modern Dark Studio UI: library, inspector, console (timeline, node IO, logs, errors, history), templates, credentials, executions, settings, command palette, tray | **Verified** for the flows covered by E2E  | E2E screenshots in `artifacts/screenshots/` (10)                                                                                                                                                                                                                                                                                                            |
| 7: Packaging and release | NSIS + AppImage, SBOM, notices, verify:release, CI                                                                                                                 | **Partial**                                | Linux: AppImage built, and `linux-unpacked/pulseflow --smoke-test` passes. Windows: NSIS installer built on Linux with Wine (`PulseFlow-Setup-0.1.0.exe`, 112 MB), and `win-unpacked/PulseFlow.exe --smoke-test` passes under Wine. **Not yet installed or run on real Windows 11.** The Windows CI job is defined but hasn't run. Installers are unsigned. |

## Not done / known gaps

- Real Windows 11 install test (installer UI, DPAPI key sealing, tray, toasts, uninstall)
- GitHub Actions runs: the workflow is committed, but no CI run has been observed yet
- Code signing and auto-update
- Tier B live mode against real providers
- B08 Browser Automation template
- macOS builds
