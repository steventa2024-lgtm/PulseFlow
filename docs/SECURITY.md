# Threat model

| Threat | Control in this version | Test |
| --- | --- | --- |
| Malicious workflow import | `sanitizeUnknown` strips `__proto__`, `constructor`, and `prototype` before Zod parsing | `security.test.ts`, `app.test.ts` |
| Path traversal and symlink escape | `resolveInside` checks the lexical path and `realpath` | `security.test.ts`, engine unwritable-folder test |
| SSRF, including redirect to the metadata address | `assertUrlAllowed` on every hop; metadata and link-local addresses blocked | `ssrf.test.ts` |
| Secret leakage | Redaction of authorization, token, password, and webhook-looking strings; credential GET returns metadata | `security.test.ts`, `app.test.ts` |
| Unauthenticated management API | Loopback plus cookie or bearer token. Mutations with a cookie require `x-pulseflow-client: studio` | `app.test.ts` |
| Webhook replay and forgery | HMAC-SHA256 over the raw body, required when a hook secret exists | `app.test.ts` |
| Shell execution | `code.shell` stays disabled unless `settings.allowShell` is true and confirm text is `I_UNDERSTAND_SHELL`. The process is `spawn` with `shell: false`. This is not a sandbox. | validation warning |
| Community nodes | Only the in-process registry exists. There is no installer that grants a third-party package full OS rights. | planned |
| Multi-user privilege escalation | Tables for users and roles exist. The running server is single-user local. Remote mode is opt-in and still has no RBAC. | planned |
| Prompt injection via an AI node | The Ollama node is optional and demo mode uses the fixture. Generated text is data, not an activated graph. | template demo |
| Supply chain | `scripts/license-audit.mjs` fails on GPL, AGPL, SSPL, and BUSL groups in the lockfile | CI |

Limits: the local key is a file, not an OS keystore. Worker threads are not a security boundary. Browser automation does not ship a live Playwright path; the demo parser only reads the fixture HTML. Do not expose `PULSEFLOW_ALLOW_REMOTE=1` to the public internet without your own TLS terminator and a firewall. The compose file publishes the port on host `127.0.0.1` only.
