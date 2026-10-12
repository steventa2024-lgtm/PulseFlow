# Feature matrix

This matrix lists what is implemented and the evidence for it. "Tested" points to an automated test that passes in `pnpm verify:release`. Anything without a test says so.

## Nodes (56)

Every node declares `permissions` and a `risk` level (`normal`, `sensitive`, `advanced`). "Requires setup" means the node needs an external service or credential to do anything useful.

### Triggers (10)

| Type                         | Name            | Permissions | Notes                                                                      |
| ---------------------------- | --------------- | ----------- | -------------------------------------------------------------------------- |
| `core.manualTrigger`         | Manual Trigger  | —           | Run button and CLI `run`                                                   |
| `core.scheduleTrigger`       | Schedule        | —           | Interval or cron, IANA timezone, DST-safe, missed-run policy               |
| `core.webhookTrigger`        | Local Webhook   | —           | `/hooks/:token`, method/size limits, HMAC, Idempotency-Key, token rotation |
| `core.fileWatchTrigger`      | File Changed    | fs.read     | Settle delay before firing                                                 |
| `core.folderWatchTrigger`    | Folder Changed  | fs.read     | New/changed files only after they settle                                   |
| `core.httpPollTrigger`       | HTTP Poll       | network     | Fires on change                                                            |
| `core.rssPollTrigger`        | RSS Poll        | network     | Stable entry ids                                                           |
| `core.startupTrigger`        | App Startup     | —           |                                                                            |
| `core.errorTrigger`          | Failure Trigger | —           | Runs when another workflow fails                                           |
| `core.workflowCalledTrigger` | Workflow Called | —           | Entry point for sub-workflows                                              |

### Logic (16)

`core.set` Set Fields · `core.if` IF / Else · `core.filter` Filter Items · `core.switch` Switch · `core.merge` Merge · `core.splitOut` Split Out · `core.batch` Batch · `core.sort` Sort · `core.dedupe` Deduplicate (kv) · `core.aggregate` Aggregate · `core.wait` Wait / Delay (durable beyond the inline limit) · `core.stopError` Stop and Error · `core.executeWorkflow` Execute Sub-workflow (subworkflow) · `core.loopOverItems` Loop Over Items (subworkflow) · `core.log` Log · `core.noop` No Operation

### Data (11)

`core.json` JSON Parse / Stringify · `core.csv` CSV Parse / Build (RFC 4180, BOM, formula neutralization) · `core.dateTime` Date & Time · `core.regex` Regex · `core.text` Text Transform · `core.math` Math · `core.compareDatasets` Compare Datasets · `core.kv` Key/Value Storage (kv) · `core.env` Environment Variables (allow-list only) · `core.markdown` Markdown Builder · `core.jsonSchemaValidate` Validate JSON Schema

### Files (5), all limited to granted folders

`core.fileRead` Read File · `core.fileWrite` Write File · `core.directoryScan` Directory Scan · `core.fileOps` Move / Copy / Rename (risk `sensitive`, no silent overwrite) · `core.fileHash` File Hash

### Network (5), with SSRF policy enforced

`core.httpRequest` HTTP Request · `core.webhookResponse` Webhook Response · `core.graphql` GraphQL Request · `core.rssRead` RSS Read (no XML entity expansion) · `core.httpDownload` HTTP Download

### Notify (2)

`core.notify` Local Notification · `core.emailSend` Send Email (SMTP), which requires setup and is risk `sensitive`

### Developer (3)

| Type               | Risk     | Notes                                                                                                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.sqliteQuery` | normal   | SQLite file in a granted folder. Opened read-only unless the operation is `execute`.                                                                    |
| `core.shell`       | advanced | Runs a program with an argument array (no shell string). Off by default.                                                                                |
| `core.code`        | advanced | JavaScript in a child Node process with the permission model, memory and time caps. **Not a security sandbox**: network is not blocked. Off by default. |

Advanced nodes only run when **Settings → Advanced** is on **and** the workflow has the `advancedNodes` permission.

### AI and connectors (4), all requiring setup except GitHub

`ai.ollama` Local AI (Ollama) · `connector.github` GitHub (REST, pagination, rate-limit aware) · `connector.discordWebhook` Discord Webhook · `connector.telegram` Telegram Bot

Credential types: `githubToken`, `discordWebhook`, `telegramBot`, `smtp`, `httpBearer`, `httpBasic`, `httpHeader`, `webhookSecret`. Secrets are write-only through the API and UI.

## Templates (23)

### Tier A: offline (16). Each one has an E2E test in `apps/server/test/templates/tier-a.test.ts`.

| ID  | Template                   | What the test checks                                                                    |
| --- | -------------------------- | --------------------------------------------------------------------------------------- |
| A01 | Hello Automation           | Writes the greeting and notifies. Empty name writes nothing and logs why.               |
| A02 | Downloads Organizer        | Sorts without overwriting, writes an undo manifest, watch mode moves only settled files |
| A03 | Batch File Renamer         | Preview by default, renames on confirm                                                  |
| A04 | CSV to JSON                | Quotes, Unicode, embedded newlines, number typing. Missing input fails clearly.         |
| A05 | JSON to CSV Report         | Escaping and formula neutralization                                                     |
| A06 | Duplicate Finder (safe)    | Reports duplicates, deletes nothing                                                     |
| A07 | Scheduled Desktop Reminder | Weekday 09:00 schedule fires, notifies and logs                                         |
| A08 | Folder Backup              | Copies, verifies checksums, never overwrites. A tampered copy fails verification.       |
| A09 | Markdown Daily Report      | Revenue by region                                                                       |
| A10 | Local Webhook Intake       | Validates, appends NDJSON, replies 200 / 422                                            |
| A11 | Website Response Monitor   | Records a baseline, notifies on change                                                  |
| A12 | API Health Check           | Healthy, slow (timeout) and failing endpoints                                           |
| A13 | Log Keyword Watch          | Alerts only on new matching lines                                                       |
| A14 | Personal Task Digest       | Open tasks due soon, overdue first                                                      |
| A15 | RSS to Reading List        | Each entry saved exactly once                                                           |
| A16 | Error Recovery Example     | Fails twice, then succeeds with backoff. Exhausting retries fails clearly.              |

### Tier B: connected (7). Demo mode is tested in `apps/server/test/templates/tier-b.test.ts`.

| ID  | Template                     | Live requirement                               | Demo-mode test                                                             |
| --- | ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| B01 | GitHub Release Digest        | GitHub token (optional for public repos)       | Paginates the fixture, writes the 10 newest                                |
| B02 | RSS to Discord               | Discord webhook                                | Posts each new entry once. Fails `CREDENTIAL_REQUIRED` with no credential. |
| B03 | Website Monitor → Telegram   | Telegram bot                                   | Alerts on down and on recovery                                             |
| B04 | Daily Email Digest           | SMTP                                           | Sends only to the local SMTP sink. Rejected with no credential.            |
| B05 | Webhook Form → Google Sheets | Google OAuth access token (bearer)             | Appends RAW rows to the fixture                                            |
| B06 | Local AI Note Summarizer     | Ollama running locally                         | Labels fixture output as not-AI                                            |
| B07 | GitHub Issue Triage Report   | GitHub (token optional), optional local Ollama | Classifies issues (PRs excluded) into a CSV                                |

A shared test asserts that live variables point at real provider endpoints, not fixtures. **Live mode against real providers is not exercised by automated tests**: that would need real accounts and secrets.

Planned, not built: **B08 Browser Automation: Price Watch**, which is listed in the gallery as "planned".

## Platform capabilities

| Capability                                               | Status       | Evidence                                                                                                                     |
| -------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Versions, publish, restore                               | Done         | `api.test.ts`, `storage.test.ts`                                                                                             |
| Retries, backoff, timeouts, cancel, onError modes        | Done         | `engine.test.ts`                                                                                                             |
| Durable waits and crash recovery                         | Done         | `engine.test.ts` ("marks runs interrupted by a crash…")                                                                      |
| Sub-workflows, retry from failed node                    | Done         | `engine.test.ts`                                                                                                             |
| Dead-letter queue and replay                             | Done         | API and UI. No dedicated replay test.                                                                                        |
| Retention pruning                                        | Done         | Runs on host startup. No dedicated test.                                                                                     |
| Export/import (checksums, permissions reset, no secrets) | Done         | `api.test.ts`                                                                                                                |
| Server mode: users, roles, API tokens                    | Done         | `api.test.ts` ("requires an owner setup…")                                                                                   |
| SSE live events                                          | Done         | `api.test.ts`, E2E                                                                                                           |
| 1,000-run history                                        | Done         | `perf/history.test.ts`                                                                                                       |
| Desktop isolation and bridge allow-list                  | Done         | `e2e/desktop.spec.ts`                                                                                                        |
| Build a workflow on the canvas and run it                | Done         | `e2e/desktop.spec.ts`                                                                                                        |
| Windows NSIS installer                                   | Built        | Built on Linux with Wine. `win-unpacked/PulseFlow.exe --smoke-test` passes under Wine. Not yet installed on real Windows 11. |
| Linux AppImage / tar.gz                                  | Built        | `linux-unpacked/pulseflow --smoke-test` passes                                                                               |
| macOS                                                    | Not targeted |                                                                                                                              |
| Code signing                                             | Not done     |                                                                                                                              |
