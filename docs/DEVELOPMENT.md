# Development

## Requirements

- Node.js ≥ 22.13. The repo is tested on 22.14. `node:sqlite` is used, so no native modules need compiling.
- pnpm 10 (`corepack enable`)
- Linux GUI tests: `xvfb` (`sudo apt-get install xvfb`)
- Windows installer on Linux: `wine` (`sudo apt-get install wine64 wine`)

Windows tooling fixes and the verified starting point are recorded in [CODEX_BASELINE.md](CODEX_BASELINE.md). Vite uses an inline PostCSS configuration so unrelated configuration in parent folders cannot change this build. Git attributes enforce LF across Windows/Linux checkouts.

The restored studio uses a 228px sidebar, a 360px configuration panel, a compact sidebar below 1200px, and a configuration drawer below 1280px. Node search opens with **Add node**. **Save** persists the draft; **Run** executes it; **Deploy** publishes and activates automatic triggers locally. Manual-only workflows can be run on demand and published through More actions. Version history compares immutable versions or the current draft, listing changed fields without exposing values.

**Test Node** saves the current draft and submits explicit sample items to `/api/workflows/:id/nodes/:nodeId/test`. It runs only that node (plus an input trigger) through the existing durable engine and persistence layer, with the same grants, credential redaction, advanced-node gate and retention policy. Tests are recorded with execution mode `test`. References to upstream outputs are intentionally unavailable; users must supply sample input. Side effects remain real and are disclosed before execution.

B09 Social Media Automation is demo-only: the backend rejects live instantiation; its graph uses `$app.fixturesUrl` to reach bundled loopback samples and a preview sink. Saved receipts explicitly contain `demo: true` and `published: false`.

## Layout

```
apps/
  server/      Fastify host, API, services, triggers, fixtures, CLI (bundled to dist/*.cjs)
  desktop/     Electron main/preload (esbuild) + React renderer (Vite), electron-builder config
packages/
  contracts/   zod schemas + types shared everywhere
  security/    crypto, redaction, path grants, network policy, safe JSON
  engine/      validation, expressions, runtime, schedules, fs/http services
  storage/     SQLite + migrations + repositories
  nodes-core/  built-in nodes
  connectors/  GitHub / Discord / Telegram nodes, credential types, SMTP
  templates/   Tier A / Tier B manifests
  testing/     shared test helpers
e2e/           Playwright tests that launch the real Electron app
scripts/       dev loop, license audit, SBOM, release verification, icon generation
```

## Scripts

| Command                                              | What it does                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                           | API host with file watching on port 5199, plus the Vite dev server for the renderer. Open the printed URL in a browser. |
| `pnpm dev:desktop`                                   | Builds desktop in dev mode and launches the Electron shell                                                              |
| `pnpm build`                                         | Production build of server and desktop                                                                                  |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | Static checks                                                                                                           |
| `pnpm test`                                          | All vitest projects (`unit`, `templates`, `perf`)                                                                       |
| `pnpm test:unit` / `test:templates` / `test:perf`    | One project                                                                                                             |
| `pnpm test:e2e`                                      | Playwright Electron tests (needs `pnpm build` first and a display)                                                      |
| `pnpm pulseflow <cmd>`                               | Run the CLI from source (`tsx`)                                                                                         |
| `pnpm license:audit [--update-docs]`                 | License report, third-party notices, refresh `docs/LICENSE_AUDIT.md`                                                    |
| `pnpm sbom`                                          | CycloneDX 1.5 SBOM at `artifacts/verification/sbom.cdx.json`                                                            |
| `pnpm verify:release [--package]`                    | Every gate. Results go to `artifacts/verification/`                                                                     |
| `pnpm package:win` / `package:linux`                 | Installers in `apps/desktop/release/`                                                                                   |

Useful environment variables: `PULSEFLOW_DATA_DIR` (isolated data directory), `PULSEFLOW_PORT`, `PULSEFLOW_HOST`, `PULSEFLOW_MODE=server`.

## Writing a node

Nodes live in `packages/nodes-core/src/<category>.ts` (or `packages/connectors`). Define one with `defineNode(manifest, execute)`:

```ts
export const upperNode = defineNode(
  {
    type: 'core.upper',
    displayName: 'Uppercase',
    description: 'Uppercases a field on every item.',
    category: 'data',
    icon: 'Type',
    parameters: [{ name: 'field', label: 'Field', type: 'string', required: true }],
  },
  async (ctx) => ({
    main: ctx.items.map((it, i) => ({
      json: { ...it.json, [ctx.param<string>('field', i)]: String(it.json[ctx.param<string>('field', i)] ?? '').toUpperCase() },
    })),
  }),
);
```

Rules:

- Declare `permissions` (`fs.read`, `fs.write`, `network`, `notify`, `email`, `kv`, `subworkflow`, `advanced`) and set `risk`. The engine and UI enforce and display both.
- Use `ctx.services.fs` and `ctx.services.http` for files and network. Never use `node:fs` or `fetch` directly, because those services enforce grants and SSRF policy.
- Throw `NodeError(code, message)` with a stable `code` and a message a user can act on.
- Respect `ctx.signal` for anything long-running.
- Add the node to the category's exported array and write a test.

## Writing a template

Add a manifest with `t({...})` in `packages/templates/src/tier-a.ts` or `tier-b.ts`. Use `node(...)` and edges to build the graph, `variables` for user-configurable paths and values (`${templateDir}` resolves to a demo folder), and `fixtures` for seed files. Then add an E2E test in `apps/server/test/templates/`. Tier B templates must have a demo mode that points at `/demo/*` fixtures, must label demo output as demo, and must fail clearly when a live credential is missing.

## Testing tips

- `e2e/studio.spec.ts` launches the real Electron app for responsive checks at 1920×1080, 1440×900, 1280×800 and 1024×800, plus Save/Run/Deploy, permission review, node testing, version comparison, B09, errors, SQLite/DPAPI persistence, and close-to-tray/second-instance restoration. Each test uses an isolated temporary data directory.
- `node scripts/qa-windows.mjs` runs an additional actual Windows utility-process crash/recovery scenario using isolated data under `artifacts/native-windows/`. Accept the real **Restart engine** dialog when prompted. `--accept-restart` substitutes only the dialog decision for automation and explicitly marks native button interaction NOT TESTED; engine crash, SQLite recovery and durable continuation remain real.

- Host and integration tests use `startTestHost()`, `instantiate()` and `runTemplate()` from `apps/server/test/helpers.ts`. Each host gets a temporary data directory.
- On Linux, run E2E as `xvfb-run -a pnpm test:e2e`. Screenshots are written to `artifacts/screenshots/`.
- `node apps/server/dist/cli.cjs templates:test` runs every template's demo path headlessly.
