# Contributing to PulseFlow

Thanks for helping. PulseFlow is Apache-2.0 and is built clean-room.

## Clean-room rule

Do **not** copy, translate or closely paraphrase code, node definitions, templates, UI assets or docs from n8n (Sustainable Use License), Zapier, Power Automate, Make, Node-RED or any other product whose license is incompatible with Apache-2.0. You may use public protocol and API documentation (for example the GitHub REST docs) and your own general knowledge. If you're unsure, ask in the PR before writing code.

Dependencies must use OSI-approved permissive licenses (MIT, Apache-2.0, BSD, ISC and similar). `pnpm license:audit` fails on copyleft or unknown licenses in the shipped graph.

## Workflow

The proposed collaboration model is `main` for stable releases, `develop` for integration, and individual `feature/<name>` branches reviewed through pull requests. **The reconstructed baseline and shared develop branch are pending maintainer approval.** Until a develop branch is actually published, ask the maintainer for the agreed pushed implementation branch; do not base implementation work on README-only `main`.

Issue [#1](https://github.com/steventa2024-lgtm/PulseFlow/issues/1), Templates search/filter empty states, is reserved for **ar935**. This takeover leaves that implementation untouched.

1. `pnpm install`
2. Make your change and add tests next to it: `packages/*/test`, `apps/server/test/{unit,templates,perf}`, or `e2e/`.
3. Run `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
4. For UI changes, also run `pnpm test:e2e` (on Linux: `xvfb-run -a pnpm test:e2e`).
5. Once the maintainer confirms the published collaboration baseline, open a PR against the agreed integration branch that describes the behavior change and how you verified it. Do not push directly to stable or integration branches.

## Contribution areas

- **Nodes:** see "Writing a node" in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Every node declares its permissions and risk level.
- **Templates:** Tier A templates must run offline and have an E2E test in `apps/server/test/templates`. Tier B templates must ship a demo mode backed by the loopback fixture server, and must never fake success when a credential is missing.
- **Security issues:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under Apache-2.0.
