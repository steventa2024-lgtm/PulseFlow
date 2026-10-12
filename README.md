# PulseFlow

**PulseFlow by ZeroPulse** is a free, open-source (Apache-2.0), local-first workflow automation studio. Build automations on a visual canvas, run them on your own machine, and keep your data and credentials local. It is a clean-room project and is not affiliated with or derived from n8n, Zapier, Power Automate, Make or Node-RED.

> Status: **0.1.0 preview.** Read [docs/BUILD_PROGRESS.md](docs/BUILD_PROGRESS.md) to see what has been verified and what hasn't.

## What you get

- **Desktop studio** (Electron, Windows 11 first, Linux supported). It has a dark canvas editor, a node library, an execution console (timeline, node input/output, logs, errors, history), versions, and per-workflow permissions.
- **Durable engine.** It runs workflows as DAGs with retries and backoff, timeouts, cancellation, durable waits, crash recovery, sub-workflows, a dead-letter queue, retention pruning, and immutable versions you can restore.
- **56 nodes** across triggers, logic, data, files, network, notifications, developer tools, local AI (Ollama), and GitHub, Discord and Telegram connectors. See [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md).
- **23 templates.** 16 Tier A templates run fully offline. 7 Tier B templates use connected services, and each one has a truthful **demo mode** that only talks to a built-in loopback fixture server.
- **Secure defaults.** Folder access is scoped by grants, outbound HTTP has SSRF protection, credentials are encrypted with AES-256-GCM and are write-only, the renderer is sandboxed with context isolation, and the expression language is safe (no `eval`).
- **Headless CLI and API.** `pulseflow serve | run | validate | export | import | backup | doctor`, plus an OpenAPI description at `/api/openapi.json`.

## Quick start

Requirements: Node.js ≥ 22.13 and pnpm 10.

```bash
pnpm install
pnpm build
pnpm --filter @pulseflow/desktop start   # launch the desktop app
```

Development loop (API host with file watching plus the Vite renderer dev server, open the printed URL):

```bash
pnpm dev
```

Headless server (local API and UI on 127.0.0.1):

```bash
pnpm build
pnpm start:server -- --static apps/desktop/dist/renderer
```

## Verify

```bash
pnpm test               # unit + template + perf suites (vitest)
pnpm test:e2e           # Playwright drives the real Electron app (needs a display or xvfb-run)
pnpm verify:release     # every gate; writes artifacts/verification/summary.{json,md}
```

## Package

```bash
pnpm package:win        # NSIS installer (on Windows, or Linux with Wine)
pnpm package:linux      # AppImage + tar.gz
```

Installers are unsigned by default. See [SECURITY.md](SECURITY.md).

## Documentation

| Doc                                              | Contents                                          |
| ------------------------------------------------ | ------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | Processes, packages, data model, execution engine |
| [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md) | Nodes, templates, and what each test verifies     |
| [docs/SECURITY.md](docs/SECURITY.md)             | Threat model and security controls                |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)       | Repo layout, scripts, writing nodes and templates |
| [docs/DECISIONS.md](docs/DECISIONS.md)           | Architecture decision records                     |
| [docs/LICENSE_AUDIT.md](docs/LICENSE_AUDIT.md)   | Dependency licenses                               |
| [docs/ROADMAP.md](docs/ROADMAP.md)               | What comes next                                   |
| [docs/BUILD_PROGRESS.md](docs/BUILD_PROGRESS.md) | Phase status with evidence                        |

## License

Apache-2.0. See [LICENSE](LICENSE). Third-party notices ship inside the app as `THIRD_PARTY_NOTICES.txt`.
