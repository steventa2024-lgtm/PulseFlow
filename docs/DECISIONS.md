# Architecture decisions

Short ADRs. Each one gives the decision, why it was made, and its consequences.

## ADR-001: Clean-room, Apache-2.0

**Decision:** Write everything from scratch under Apache-2.0. Don't use or adapt code, node definitions or templates from n8n (Sustainable Use License) or other non-permissive products.
**Why:** Users can redistribute, embed and commercialize PulseFlow without license risk.
**Consequences:** Node and template behaviour is designed from public API docs and first principles. `pnpm license:audit` enforces a permissive dependency graph.

## ADR-002: Electron + a loopback HTTP host in a utility process

**Decision:** The renderer talks to a Fastify host over `127.0.0.1` HTTP + SSE, authenticated by a per-launch token. The host runs in an Electron `utilityProcess`.
**Why:** The same host and API serve the desktop app, the headless CLI (`pulseflow serve`) and tests. Heavy work stays off the main and renderer processes. A crash in the host doesn't take down the window. The IPC surface stays tiny (pickers, shell helpers).
**Consequences:** We need the DNS-rebinding and Origin checks, and token handling in EventSource URLs.

## ADR-003: `node:sqlite` instead of a native SQLite module

**Decision:** Use the SQLite built into Node 22 and Electron's Node runtime.
**Why:** No native rebuilds (`npmRebuild: false`), simpler cross-compilation (the Windows installer builds on Linux), and a smaller supply chain.
**Consequences:** The API is marked experimental, so we suppress `ExperimentalWarning` and keep a thin wrapper (`packages/storage/src/db.ts`) in case it changes.

## ADR-004: A hand-written expression language

**Decision:** `{{ }}` expressions use a Pratt parser and AST interpreter with allow-listed functions.
**Why:** `eval`, `new Function` and `vm` aren't safe boundaries. A small language is auditable and gives precise validation errors before a run.
**Consequences:** Users can't write arbitrary JS in expressions. The opt-in `Code` node covers that, with explicit risk labelling.

## ADR-005: Durable state in SQLite, not in memory

**Decision:** Every execution and step is persisted as it progresses. Waits beyond a short inline limit become durable rows with a resume time.
**Why:** Crash recovery, history, retry-from-failed-node and long waits all fall out of one model.
**Consequences:** Write volume per step. The 1,000-run perf test (around 380 runs/s locally) shows this is acceptable for a desktop workload. Retention pruning bounds growth.

## ADR-006: Honest demo mode for connected templates

**Decision:** Tier B templates have a demo mode that sends real HTTP to `/demo/*` loopback fixtures on the host, and the UI discloses this. Live mode needs a real credential, and a missing credential is a hard error.
**Why:** Users can try connected templates offline without being misled. Tests exercise the real code paths, including pagination, retries and error handling.
**Consequences:** The fixtures must be maintained to match provider APIs closely enough. Live mode isn't covered by CI.

## ADR-007: Two-key gate for advanced nodes

**Decision:** `Run Program` and `Code` require an app-level switch **and** a per-workflow permission.
**Why:** An imported or template workflow can't silently run programs, and a user can enable the capability for one workflow only.
**Consequences:** One extra step for power users.

## ADR-008: Unsigned installers in 0.1.x

**Decision:** Ship unsigned NSIS and AppImage builds with published SHA-256 checksums.
**Why:** A code-signing certificate isn't available for the preview.
**Consequences:** SmartScreen warnings on Windows. Signing is on the roadmap.
