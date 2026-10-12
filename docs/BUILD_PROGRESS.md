# Build progress

Date: 2026-10-12. Branch: `cursor/pulseflow-studio-7509`.

## Phase 0 and the Phase 1 slice

The repository started as a README-only project. This session added the monorepo, engine, templates, API, CLI, and studio.

Commands run in this environment:

- `pnpm install` — exit 0
- `pnpm typecheck` — exit 0 after the expression, SQLite, and package-export fixes
- `pnpm exec eslint . --max-warnings 0` — exit 0
- `pnpm exec vitest run` — 24 tests, exit 0 after the live-mode assertion used a template without a stored credential
- Template catalog: 24 graphs validate; A01–A16 and B01–B08 demo fixtures execute

Not done:

- Electron binary download and `pnpm package:win`
- Playwright browser install in this session (see the UI note below)
- A measured 100-node canvas frame time. The engine test runs a 100-node chain and a 1000-row history query with a 15s and 2s ceiling. Those ceilings passed; they are not a hardware benchmark sheet.

## UI

`pnpm dev` equivalent used for review:

- API: `PULSEFLOW_HOME=/tmp/pulseflow-demo pnpm --filter @pulseflow/server exec tsx src/main.ts` → `http://127.0.0.1:8787/health` returned `{"ok":true}`
- Studio: Vite on `http://127.0.0.1:5173`

The first route is `/workflow/wf_a01`.

Browser check on 2026-10-12 against `PULSEFLOW_HOME=/tmp/pulseflow-demo`:

- The studio loaded the Hello Automation graph (manual, set, check, write, log, notify, false log).
- Run demo finished `succeeded`. The false branch step was `skipped`. Open demo output showed `{"name":"PulseFlow","greeting":"Hello, PulseFlow"}`.
- File: `/tmp/pulseflow-demo/demo/hello-automation.json`.
- Templates page lists Tier A and Tier B. Tier B Run live is disabled with “needs setup”. Try demo on CSV to JSON returned `A04 demo succeeded`.
- History listed `wf_a01` and `wf_a04` as succeeded.
- At 1280px the three columns stayed usable.

A React Query v5 issue blocked the first paint: `bootstrapSession` resolved to `undefined`, which Query rejects. It now returns `true`.

`node scripts/license-audit.mjs` passed for 14 license groups. `pnpm pulseflow doctor` reported 24 workflows and telemetry false.

## Phase 2 baseline and desktop package

Recorded at `ab5eb86a35104b962d35e14cd81199680aeea4dc` before these changes. `pnpm typecheck`, eslint, `pnpm test` (24 tests), `pnpm test:templates` (10 tests), and `node scripts/license-audit.mjs` all exited 0.

After the desktop and subflow changes, the same commands passed with 27 engine and API tests. `pnpm package:win` on this Linux machine wrote `apps/desktop/release/PulseFlow-0.1.0-win.zip` (about 148 MB). Electron's own Node ran the bundled server: `/health` returned ok and 24 workflows were present. A second launch of that bundle under Linux Electron served the studio HTML and JavaScript, ran template A01 in demo mode, wrote `hello-automation.json`, and left a checkpointed SQLite file after quit.

The Windows `PulseFlow.exe` inside the zip was not started here. NSIS did not finish because Wine is absent. `.github/workflows/ci.yml` builds the zip and the installer on `windows-latest` and uploads them. The build sets `signAndEditExecutable` to false so the executable stays unsigned. SmartScreen is not disabled.

Subflow execution now checks the child graph, stops a self-call at depth 5, and cancels the child when the parent is cancelled. The History page can compare a saved version with the current draft as lists of node and edge ids. The studio header shows Draft, Active, or Disabled, and labels a finished run as demo or live.
