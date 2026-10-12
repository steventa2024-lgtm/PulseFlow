# Contributing

PulseFlow is Apache-2.0. Contributions are welcome under the same license.

- Run `pnpm install`, `pnpm typecheck`, `pnpm exec eslint .`, and `pnpm test` before sending a change.
- Do not add a dependency whose license is GPL, AGPL, SSPL, BUSL, or another non-OSI restriction that would block commercial redistribution. `node scripts/license-audit.mjs` checks the lockfile.
- Do not copy source, artwork, or templates from n8n, Zapier, Make, Power Automate, or Node-RED. Public behavior can inspire an independent design.
- A template is not done until `pnpm test:templates` executes it and checks a real side effect.
- Do not label a provider adapter "connected" without a credential-backed test or a clearly separate demo fixture.
- Shell and code execution stay off until a workflow sets `allowShell`. Do not describe the Node VM as a sandbox.
