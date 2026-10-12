# Decisions

Recorded 2026-10-12 while building the first working slice.

## License

Apache-2.0 for original PulseFlow code. n8n is source-available under the Sustainable Use License, which n8n distinguishes from OSI open source (https://github.com/n8n-io/n8n-docs/blob/main/docs/n8n-community-license/README.md). None of that code is a dependency. Node-RED is Apache-2.0 and was used only as a public behavior reference; no Node-RED source was copied.

## TypeScript 5.9.3

`typescript-eslint` 8.71.2 accepts TypeScript `>=4.8.4 <6.1.0`. TypeScript 5.9.3 is inside that range. Current TypeScript 7 is not.

## SQLite via node:sqlite

Node 22.14 includes `node:sqlite` (`DatabaseSync`). It supports WAL, foreign keys, and `RETURNING` here. `better-sqlite3` would need a native rebuild inside Electron, so it is not a dependency. The experimental warning is expected. If a future Electron build drops `node:sqlite`, the storage package is the only place that must change.

## react-router 8.4.0

The package asks for Node `>=22.22.0`. This environment is Node 22.14.0. `.npmrc` sets `engine-strict=false` so install can proceed. The studio typechecks and the routes used (`BrowserRouter`, `Routes`, `Route`, `Link`, `useParams`) are the supported API. Prefer Node 22.22 or newer when packaging the desktop app.

## Expressions

A recursive-descent parser instead of `expr-eval` or `jsep`, so the allow-list and the prototype-key block stay in this repository and can be tested directly.

## Demo fixtures

Tier B graphs declare `needsFixture`. The engine starts a loopback fixture server unless the run mode is `live`. Live mode returns HTTP 409 when the declared credential kind is missing. That is the difference between Try demo and Run live.

## Secrets

AES-256-GCM with a 32-byte key file at `secret.key` (mode 0600). This is not the operating-system keystore. Portable copies of the database are readable by anyone who also has the key file. Webhook secrets are returned once at activation and stored encrypted.

## Electron packaging

Electron 44.7.0 is MIT. The binary was not downloaded in this environment (`apps/desktop/node_modules/electron/dist` is absent until `electron/install.js` runs). No Windows installer was produced. Unsigned Windows builds would show SmartScreen; this project does not disable OS protections.
