# Codex takeover baseline — 2026-10-20

The original workspace `C:\Users\steve\PulseFlow` was empty. A bounded local search of the user's repositories, Cursor/Codex worktrees, Documents, Desktop, source and Downloads found no PulseFlow checkout. No other project was modified.

- Clone: `C:\Users\steve\github-work\PulseFlow`, branch `cursor/pulseflow-durability-a2d7`.
- Both `git ls-remote` and local HEAD: `fdb4147e107f2a87df04508afbd97413c4982e42`.
- Working worktree: `C:\Users\steve\PulseFlow`, branch `codex/pulseflow-modern-dark`.
- One local object inspection (`cat-file` for both missing commits and `fsck --full --no-reflogs`) found neither `afc9dbe05aa0c32f4ccb4ffd0a0994f93ce1bead` nor `f46d4cd7fad93049dc170eac6d279aa2976f8682`. Neither SHA was fetched. The newer implementation was not recovered.
- No visual reference or newer Cursor handoff files were attached or found. Reconstruction uses the maintainer's written requirements; visual equivalence to the missing design cannot be established.
- Issue #1 (Templates filtering/empty states) is reserved for ar935. Its implementation is outside this takeover.

## Environment

Microsoft Windows 11 Home x64, version 10.0.26300, display version 26H2 (confirmed by Win32_OperatingSystem; the legacy registry ProductName reports Windows 10 Home). Node 26.8.2, Git 2.55.0.windows.3, GitHub CLI 2.101.0, global pnpm 11.23.0. The repository selects pnpm 10.33.4 and installation used that version and the unchanged lockfile. Installed Electron 44.7.0, Playwright 1.64.0, TypeScript 5.9.3. No C++ toolchain is required for the built-in `node:sqlite` persistence.

`pnpm install` passed. Initial warnings: server CLI bin did not exist before the first build; optional electron-winstaller build script was not approved (NSIS is the configured Windows packaging target). Electron runtime downloaded successfully. Restricted-shell pnpm launches stalled; execution/install gates were run with approved local process/network access.

## Original checks and diagnosis

| Command             | Result                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| pnpm install        | PASS                                                                                          |
| pnpm typecheck      | PASS                                                                                          |
| pnpm lint           | PASS                                                                                          |
| pnpm test           | PASS — 106 tests, 11 files                                                                    |
| pnpm build          | FAIL — inherited home-directory Tailwind 3 PostCSS config                                     |
| pnpm verify:release | FAIL before repairs; stopped after known failed gates and before completing invalid-build E2E |

The original release attempt also exposed CRLF formatting failures (154 files), `spawnSync pnpm ENOENT` in license/SBOM tools, and failed native smoke because the renderer build was absent. Raw initial logs are retained in `artifacts/baseline/`.

Repairs: inline empty PostCSS config isolates Vite from parent projects; `.gitattributes` declares LF; formatting normalizes the checkout without broad source changes; Windows audit tools resolve the pnpm command shim; dependency paths normalize separators; dev loop invokes pnpm's JS entry point on Windows.

## Repaired baseline verification

`pnpm verify:release`: **14/14 gates PASS** on win32-x64, 2026-10-21T03:35:54Z. Unit 71/71, templates 33/33, performance 2/2, Electron E2E 6/6. Desktop smoke returned `ok: true`, `keyProtection: os-keychain`. All 23 CLI demo templates passed; doctor confirms 56 node types. License audit: 497 packages, 91 shipped, zero denied; SBOM: 538 components. These are baseline counts, before reconstruction.

Evidence: `artifacts/baseline/repaired-verification/`, `artifacts/baseline/repaired-release.log`, and `artifacts/baseline/screenshots/`. The Electron tests launched the actual Windows runtime, used unique temporary data directories, executed A01, wrote and read a greeting file, and tested bridge isolation, credentials, canvas editing, local fixtures, logs and navigation.

No production database or credential directory was opened or migrated. All execution tests used isolated temporary data. No pushes, PRs, merges or releases were performed.
