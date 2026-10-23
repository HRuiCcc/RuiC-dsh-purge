# Changelog

## 1.0.2 — 2026-10-23

第三方 Electron 外壳兼容（实测 DSH 0.2.1-rc.2 的 DeepSeek Bot 外壳，运行时打包在 `app.asar` 根 `node_modules/@deepseek-ai`）。

- ASAR 发现支持运行时位于归档根的打包布局；官方 `dsh/node_modules/@deepseek-ai` 仍优先，两种都在时选官方布局。
- Electron 会把所有 `.asar` 路径当作包内成员解析，直接 `fs.open` 读归档会报 `ENOENT, not found in ...app.asar`；读取原始归档字节期间临时关闭 asar 支持（`process.noAsar`），结束立即恢复原值。
- 宿主探测不再在非 macOS 平台尝试硬编码的 macOS 路径；新增 `<可执行文件目录>/resources` 候选，兼容 `ELECTRON_RUN_AS_NODE` 子进程。
- 显式传入归档根成员时按真实成员校验；ASAR 链接与元数据拒绝继续上抛，不会被布局探测吞掉。
- 测试新增「归档根布局可发现」「官方布局优先」两例；显式传入不支持成员时的断言改为按真实失败原因匹配。

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
