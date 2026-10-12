# License audit

PulseFlow's original code is Apache-2.0. `node scripts/license-audit.mjs` runs `pnpm licenses list --json` and exits non-zero if a license group matches GPL, AGPL, SSPL, BUSL, or Commons Clause.

The audit output for a given install is written to `artifacts/verification/licenses.json` when the script runs. That directory is gitignored. CI runs the same script.

Direct choices and why they are compatible with Apache-2.0 redistribution:

| Package | Version checked | License | Role |
| --- | --- | --- | --- |
| electron | 44.7.0 | MIT | Desktop shell |
| react / react-dom | 19.3.0 | MIT | UI |
| vite | 8.3.4 | MIT | Dev server and build |
| @xyflow/react | 12.12.0 | MIT | Canvas. Attribution stays visible |
| fastify | 5.12.5 | MIT | Local API |
| zod | 4.6.7 | MIT | Schemas |
| better-sqlite3 | not used | — | Avoided because of native rebuilds |
| n8n | not used | Sustainable Use License | Not OSI open source; not imported |

LGPL libraries were not added. If one is proposed later, document the dynamic-linking obligations before merging.
