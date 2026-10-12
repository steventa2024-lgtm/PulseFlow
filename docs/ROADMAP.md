# Roadmap

None of these items are built yet. They're listed roughly in priority order. See [BUILD_PROGRESS.md](BUILD_PROGRESS.md) for what has been verified.

## Next

- **Windows 11 validation on real hardware.** Install the NSIS build, then check tray behaviour, DPAPI key sealing, toast notifications, folder watching on NTFS, and uninstall. Today the installer is built on Linux with Wine and only smoke-tested under Wine.
- **Green Windows CI.** `.github/workflows/ci.yml` defines a `windows-latest` job that runs `verify:release --package`. It hasn't run yet, and any Windows-specific failures it surfaces need fixing.
- **Code signing** for the Windows installer, plus an auto-update channel (opt-in).
- **B08 Browser Automation: Price Watch.** This needs a headless browser node with a permission model and a size budget.

## Later

- Live-mode contract tests against provider sandboxes (opt-in, with secrets kept out of CI by default)
- More connectors: Slack, Microsoft Teams, Notion, Google Sheets as a first-class node (B05 currently uses HTTP Request), IMAP trigger
- Node SDK for third-party node packages, with manifest signing and per-package permissions
- A stronger sandbox for the `Code` node (an isolated process with network blocked by an OS-level policy)
- Workflow diff view between versions
- macOS builds
- Localization
