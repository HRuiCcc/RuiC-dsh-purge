# Changelog

## 1.0.1 — 2026-10-23

Verification release against the shipped DSH Desktop 0.2.1-rc.2 host.

- Added `npm run verify:desktop`: proof of preflight, apply, syntax, idempotence and byte-exact rollback against the installed host, run entirely on a temporary copy, with the signed archive's size/mtime checked before and after.
- Added `materializeArchive()` so a sealed `app.asar` can be reproduced as a real npm-layout tree for the runtime suite; oversized members are reported by name instead of failing or being dropped silently.
- Added `npm run verify:desktop -- --full`, which runs the real Cordis/DSH module integration suite against the extracted 0.2.1-rc.2 runtime.
- Every version string now comes from the packaged manifest (`lib/version.js`), so the CLI, status payload and smoke test cannot drift from `package.json`.
- README credits the upstream derivative (ZiPengWei/dsh-purge) and the non-code reference (Purge Community) in a single 致谢 section.

Verified result on 0.2.1-rc.2: 4/4 modern anchors matched, patches 5–8 reported as `native_setting`, revert byte-exact, archive untouched.

## 1.0.0 — 2026-10-23

Initial RuiC derivative of ZiPengWei/dsh-purge 1.0.0.

- Rebuilt patch execution around full preflight, checked snapshots and per-file atomic writes.
- Added conflict-aware rollback, retained journals, cross-process locks and JSON CLI failures.
- Added DSH 0.2.1 renamed-constant/personaPrefix compatibility and native permission guidance.
- Added read-only Desktop ASAR discovery with bounded member parsing.
- Updated real Cordis lifecycle integration, literal prompt sections and local-only maintenance routes.
- Added isolated tests, a cross-platform CI template (included in the source archive; not enabled remotely) and dependency-free package smoke validation.
