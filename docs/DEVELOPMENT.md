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

That starts Vite and Electron against the TypeScript main file. Electron 44.7.0 is downloaded by `apps/desktop/node_modules/electron/install.js` on first install. Its Node is 24.21.0 and includes `node:sqlite`.

Windows packaging:

```bash
pnpm package:win
```

That bundles the API and studio into `apps/desktop/dist-electron/main.mjs`, checks that Electron's Node can open SQLite and serve `/health`, then runs electron-builder. On Linux without Wine the result is `apps/desktop/release/PulseFlow-0.1.0-win.zip`. On Windows, or on Linux with Wine, the same command also builds the NSIS installer. The package is unsigned. Leave SmartScreen enabled.

The desktop process stores SQLite, the key file, logs, and workflow files under `PULSEFLOW_HOME` or `%APPDATA%/PulseFlow/pulseflow`. Closing the window quits unless Settings has background execution turned on. Schedules do not run while the computer is asleep, hibernating, signed out, or powered off.

`PULSEFLOW_DEV=1 pnpm dev:desktop` still uses Vite and the TypeScript main file. The packaged app does not use a development server or a system Node install.

Troubleshooting:

- `ExperimentalWarning: SQLite is an experimental feature` comes from `node:sqlite` and is expected.
- react-router 8.4 declares `engines.node >=22.22.0`. Install still works on 22.14 because `engine-strict` is false.
- If port 8787 is busy, set `PULSEFLOW_PORT`.
- Live template runs return 409 until a credential of the required kind exists. Use Try demo.
