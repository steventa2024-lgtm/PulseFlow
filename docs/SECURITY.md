# Security model

This document describes the threat model and the controls PulseFlow implements. Every control listed below has an automated test unless it says otherwise. To report a vulnerability, see the root [SECURITY.md](../SECURITY.md).

## Assets

- Credentials (API tokens, SMTP passwords, webhook secrets)
- Files the user grants workflows access to
- Execution data (it can contain personal data)
- The user's machine and local network

## Threats considered

| Threat                                                    | Control                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A malicious website or other local app calls the host API | Loopback bind, a random per-launch bearer token, rejection of foreign `Host` headers (DNS rebinding) and of cross-origin writes. Tested in `api.test.ts`.                                                                                                                                                     |
| XSS or a compromised renderer escalates to the OS         | `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity`. The preload exposes a small allow-listed bridge. IPC handlers check the sender origin. Navigation and window-open are restricted to the host origin. Permission requests are denied. Strict CSP (below). Tested in `e2e/desktop.spec.ts`. |
| An imported workflow abuses granted access                | Imports reset permissions, start inactive, and are checksum-verified. Tested in `api.test.ts`.                                                                                                                                                                                                                |
| A workflow reads or writes outside intended folders       | Per-workflow folder grants (read-only or read-write), realpath checks that defeat symlink escapes, and prefix-collision checks. Tested in `security.test.ts` and `engine.test.ts`.                                                                                                                            |
| SSRF to the LAN or cloud metadata endpoints               | DNS is resolved before connecting. Loopback, RFC 1918, link-local, ULA and metadata addresses are blocked unless the workflow enables "Allow private network". Tested in `security.test.ts` and `engine.test.ts`.                                                                                             |
| Credential leakage via API, logs or exports               | Secrets are AES-256-GCM encrypted with the credential id as AAD. The API returns metadata only. Execution data and logs are redacted (sensitive keys, known secret values, bearer tokens, URL userinfo). Exports never include secrets. Tested in `api.test.ts` and `security.test.ts`.                       |
| Expression injection or code execution                    | A Pratt parser with an AST interpreter (no `eval`/`Function`), allow-listed functions, and blocked prototype access. Tested in `expressions.test.ts`.                                                                                                                                                         |
| Prototype pollution, oversized or deeply nested JSON      | Safe JSON parsing rejects `__proto__`/`constructor`/`prototype` keys and enforces size and depth limits. Tested in `security.test.ts`.                                                                                                                                                                        |
| XML bombs in feeds                                        | No entity expansion. Tested in `parsers.test.ts`.                                                                                                                                                                                                                                                             |
| CSV formula injection                                     | Cells starting with `= + - @` (and tab/CR) are neutralized on output. Tested in `parsers.test.ts` and A05.                                                                                                                                                                                                    |
| Webhook abuse                                             | Unguessable rotating tokens, method allow-list, body size limit (default 1 MB), optional HMAC-SHA256 signatures, Idempotency-Key dedupe. Webhooks stop answering after deactivation. Tested in `api.test.ts`.                                                                                                 |
| Arbitrary program execution                               | The `Run Program` and `Code` nodes are risk `advanced`, off by default, and need both the app setting and a per-workflow permission. Tested in `engine.test.ts`.                                                                                                                                              |

## Credential storage

- The 32-byte master key is generated on first run. On the desktop it is sealed with Electron `safeStorage` (DPAPI on Windows, libsecret/kwallet on Linux) as `master.key.safe`. If no OS keyring is available it falls back to a `0600` `master.key` file, and the app reports the protection level (`keyProtection` in the smoke output).
- Each credential is AES-256-GCM encrypted with a random 12-byte IV, bound to its id with AAD. Tampering, or decrypting under the wrong AAD, fails. Tested in `security.test.ts`.
- Passphrase-protected exports use scrypt (N=2^15) and AES-256-GCM.
- Server-mode passwords use scrypt with a per-user salt. API tokens are stored as SHA-256 hashes.

## Renderer CSP

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

`'unsafe-inline'` for styles is needed by the canvas library's inline positioning. Scripts are never inline.

## Known limitations

- **The `Code` node is not a sandbox.** It uses the Node permission model (no FS writes, no child processes, no workers) plus memory and time caps, but network access is not blocked. Treat it as running code with your own privileges.
- **`Run Program`** runs any executable you name, with an argument array and no shell interpolation. It has your user's privileges.
- **Unsigned installers** in 0.1.x. Windows SmartScreen will warn. Compare the SHA-256 before running.
- **Server mode** has no built-in TLS. Put it behind a reverse proxy if you bind beyond loopback.
- The host process trusts the data directory. Anyone who can write to it as your OS user can tamper with workflows.
- The secret scan in `verify:release` is pattern-based and is not a substitute for review.
