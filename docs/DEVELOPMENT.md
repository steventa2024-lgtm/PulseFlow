# Development

Verified on 2026-10-12 with Node v22.14.0 and pnpm 10.33.4.

```bash
pnpm install
pnpm dev          # API on 127.0.0.1:8787 and studio on 127.0.0.1:5173
pnpm test
pnpm typecheck
pnpm exec eslint . --max-warnings 0
pnpm test:templates
pnpm pulseflow doctor
```

`PULSEFLOW_HOME` selects the data directory. The default is `./.pulseflow`. The first launch seeds 24 workflows and writes demo files under `inbox/` only when those files are absent.

Desktop shell:

```bash
PULSEFLOW_DEV=1 pnpm dev:desktop
```

That starts Vite and Electron. Electron downloads its binary on first install (`apps/desktop/node_modules/electron/install.js`). This environment did not complete that download, so the browser studio is the verified UI.

Windows packaging is `pnpm package:win` after the Electron binary exists. It is not claimed to succeed here. An unsigned installer will be flagged by SmartScreen. Do not disable that check.

Troubleshooting:

- `ExperimentalWarning: SQLite is an experimental feature` comes from `node:sqlite` and is expected.
- react-router 8.4 declares `engines.node >=22.22.0`. Install still works on 22.14 because `engine-strict` is false.
- If port 8787 is busy, set `PULSEFLOW_PORT`.
- Live template runs return 409 until a credential of the required kind exists. Use Try demo.
