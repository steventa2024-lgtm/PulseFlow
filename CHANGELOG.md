# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/).

## [0.1.0] — Unreleased (preview)

### Added

- Monorepo: `contracts`, `security`, `engine`, `storage`, `nodes-core`, `connectors`, `templates`, `testing`, `apps/server`, `apps/desktop`.
- Execution engine: DAG validation and reachability, a safe Pratt-parser expression language, retries with exponential backoff, timeouts, cancellation, `onError` modes (stop / continue / route), durable waits, crash recovery, sub-workflows, a dead-letter queue, retry-from-failed-node, and retention pruning.
- SQLite storage (`node:sqlite`) with migrations, optimistic draft revisions, immutable versions with restore, a KV store, dedupe keys, an audit log, notifications and online backup.
- 56 nodes (triggers, logic, data, files, network, notifications, developer, local AI, plus GitHub, Discord and Telegram connectors).
- 16 offline Tier A templates and 7 connected Tier B templates with a loopback demo mode, each with E2E tests.
- Fastify loopback host: REST API, SSE events, local webhooks (HMAC, idempotency, size limits), per-launch token auth, Host/Origin checks, and an optional multi-user server mode with roles.
- AES-256-GCM write-only credentials, with the master key protected by the OS keychain (Electron `safeStorage`) or a `0600` file fallback.
- Electron desktop app: a sandboxed renderer, an allow-listed preload bridge, a utility-process host, tray mode, and a Modern Dark Studio UI (canvas editor, execution console, templates, credentials, executions, settings, command palette).
- CLI: `serve`, `doctor`, `validate`, `run`, `templates`, `templates:test`, `export`, `import`, `backup`, `migrate`.
- Release tooling: `verify:release`, a license audit with third-party notices, a CycloneDX SBOM, a secret scan, a 1,000-run performance suite, Playwright Electron E2E tests, and electron-builder configs for NSIS and AppImage.
