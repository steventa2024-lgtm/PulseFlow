# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"** (Security Advisories) on this repository. Don't open a public issue. Include reproduction steps and the affected version. We aim to acknowledge reports promptly and to coordinate disclosure with you.

## Supported versions

| Version         | Supported |
| --------------- | --------- |
| 0.1.x (preview) | Yes       |

## Scope notes

- **Advanced nodes** (`Run Program`, `Code`) run code you supply. They are disabled by default and need both the app setting and a per-workflow permission. The Code node's Node.js permission model is a seat belt, not a sandbox, and network access is not blocked.
- **Installers are unsigned** in 0.1.x. Windows SmartScreen may warn on first run. Verify the SHA-256 published with each release.
- In **server mode** (`pulseflow serve --server --host 0.0.0.0`) you are responsible for TLS and network exposure. The default binding is loopback only.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and the list of controls.
