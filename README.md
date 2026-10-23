# RuiC-dsh-purge

基于 [ZiPengWei/dsh-purge](https://github.com/ZiPengWei/dsh-purge) 重写的 DSH 本机维护插件：**先预检、再快照、后写入；失败有记录，回滚查冲突。**

[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

版本 **1.0.0** · Node.js **22+** · 包名与 CLI：`ruic-dsh-purge`

## 最新 DSH 兼容情况

针对实际 **DSH Desktop 0.2.1-rc.2 / Cordis 4.0.5** 发行包做了检查与隔离测试：

| 场景 | 支持范围 |
| --- | --- |
| 桌面签名 `app.asar` | 自动发现、只读预检、独立提示词、插件命令与工具、权限默认值观察 |
| 0.2.1 解包目录 | 精确匹配新版 4 个提示词目标、快照应用、冲突检测回滚 |
| 旧版 npm 布局 | 保留上游 8 条补丁；所有目标精确匹配后才写入 |
| 新版会话权限 | 使用 DSH 原生 `/permission`；不把文件标记当成当前会话权限 |
| 未知版本 | 报告实际版本和匹配结果，不凭版本号宣称兼容 |

**不会直接改写签名 ASAR、修改 app 签名或自动退出/重启 DSH。** 归档内补丁能匹配只证明预检通过，不表示已经写入或运行生效。完整 Desktop UI、登录会话与 Windows/macOS 签名换包不在本版本验证范围。详细证据与限制见 [兼容说明](docs/COMPATIBILITY.md)。

### 为什么新版不用旧版权限补丁？

新版 `never` 审批策略仍然拒绝需要审批的请求；将提示词改成“所有操作全权限”并不能改变它。只修改 macOS Seatbelt 也无法同步改变内建文件工具的权限。0.2.1 适配器因此把原补丁 #5–#8 标记为 `native_setting`，使用官方权限机制：

```text
/permission
/permission danger-full-access
```

第二条按用户选择授予当前会话完整访问。`permission.defaultPreset` 代表未来会话默认值，已恢复会话可能保留自己的权限；RuiC 面板会明确标注证据范围，不自动切换权限。

## 安装

从 [Releases](https://github.com/HRuiCcc/RuiC-dsh-purge/releases) 下载 `ruic-dsh-purge-1.0.0.tgz`，在 **对应 DSH 实例** 的 CLI 上安装：

```sh
dsh plugin --profile desktop add ./ruic-dsh-purge-1.0.0.tgz
# Web 实例使用 --profile web
```

完成后手动重新打开对应 DSH 实例，在设置中找到 **RuiC Purge**。如果系统 PATH 中没有 `dsh`，使用 DSH 自带的命令行入口；不要安装另一个旧版全局 DSH 来代替现有桌面实例。已有 profile 需要先由 DSH 初始化。

开发者也可以从源码安装：

```sh
git clone https://github.com/HRuiCcc/RuiC-dsh-purge.git
cd RuiC-dsh-purge
npm test
npm pack --ignore-scripts
dsh plugin --profile desktop add .
```

项目未发布到 npm registry，不能使用 `npm install -g ruic-dsh-purge` 作为下载安装方式。已下载的 tgz 可以本地全局安装 CLI：`npm install -g ./ruic-dsh-purge-1.0.0.tgz`。

## 使用

不安装全局 CLI 也能直接在项目目录使用：

```sh
node bin/ruic-dsh-purge.js status --json
node bin/ruic-dsh-purge.js plan --base '/Applications/DeepSeek Harness.app' --json

# 只在明确选择的解包宿主上应用；先查看 dry-run
node bin/ruic-dsh-purge.js apply --base /path/to/node_modules/@deepseek-ai --dry-run --json
node bin/ruic-dsh-purge.js apply --base /path/to/node_modules/@deepseek-ai --json
node bin/ruic-dsh-purge.js snapshots --json
node bin/ruic-dsh-purge.js revert <snapshot-id> --base /path/to/node_modules/@deepseek-ai --dry-run
node bin/ruic-dsh-purge.js revert <snapshot-id> --base /path/to/node_modules/@deepseek-ai
```

| 命令 | 说明 |
| --- | --- |
| `status` / `selfcheck` | 宿主布局、版本、补丁证据、未完成操作 |
| `plan` | 目标路径、匹配结果、前后 SHA256；不写入 |
| `apply --dry-run` | 完整预检；不创建锁或快照 |
| `apply` | 完整备份校验后逐文件原子写入 |
| `snapshots` | 列出保留的快照与操作状态 |
| `revert <id>` | 所有文件通过哈希冲突检查后还原 |
| `prompt` | 读取独立提示词 |
| `prompt --file rules.md` | 导入 UTF-8 提示词，最大 128 KiB |

默认行为是只读 `status`。JSON 中 `ok:false` 或异常退出码为 1；`pending` 是待应用，`sealed` 是归档只读，两者可有 `ok:true`，**不能把退出码 0 当作补丁已生效**。

选项：`--base` 指定包目录、`.app`、Resources 或 ASAR；`--home` 指定数据目录；`--json` 输出机器可读结果。也支持 `DSH_BASE` / `DSH_HOME`。显式路径错误时不会悄悄改用另一个安装。

Windows 旧版 npm shim 需明确传 `--shim-dir <npm-prefix>`，两份 `dsh.cmd` / `dsh.ps1` 都存在并匹配才加入同一快照。回滚时传回相同目录。已有 `DSH_PERMISSION_MODE` 会被保留。

聊天命令：`/ruic-purge status|plan|apply|snapshots|revert <id>`。
模型工具：`ruic_purge_status`、`ruic_purge_plan`、`ruic_purge_apply`、`ruic_purge_snapshots`、`ruic_purge_revert`。

## 相比上游的调整

- 备份失败、锚点缺失或重复时停止整次应用，避免一半成功一半失败。
- 使用完整替换内容核对状态，避免短 marker 假阳性；保留 CRLF。
- 快照含 SHA256 与操作阶段；写入中失败尝试恢复已写文件，恢复失败保留明确状态。
- 回滚前检查全部目标：用户后续修改或宿主升级会触发冲突，不覆盖。
- 进程间锁避免并发写入；不递归扫描用户主目录。
- 新版常量名、personaPrefix、字面提示词模板以及 Cordis 生命周期适配。
- 设置面板刷新状态不覆盖提示词草稿；保存有版本冲突检查；错误可重试。
- HTTP 维护接口仅限本机直接访问，阻止跨站请求及代理请求；远程管理使用 CLI。
- 独立命名空间、提示词和快照，不接管其他 Purge 发行版的备份。

## 数据与迁移

```text
$DSH_HOME/ruic-dsh-purge/
├── prompt.md
└── snapshots/<uuid>/
    ├── manifest.json
    └── 0.bin, 1.bin, ...
```

默认为 `~/.dsh`，测试和并行实例请明确设置 `--home`。旧版 `prompt-inject.md` 不会被读取、覆盖或删除；需要迁移时显式导入：

```sh
node bin/ruic-dsh-purge.js prompt --file /path/to/prompt-inject.md
```

旧版插件与 RuiC 同时开启可能重复注入提示词或竞争宿主文件。迁移前请先在 DSH 中停用旧插件；RuiC 不自动卸载其他插件，也不读取旧快照。保留 MIT 原作者署名，见 [NOTICE](NOTICE.md)。

## 故障恢复

1. 运行 `selfcheck --json`，查看具体匹配状态。
2. 若操作异常退出，锁不会被猜测为过期。先确认原进程已结束，再手动移除目标包目录的 `.ruic-dsh-purge.lock`。
3. 使用 `snapshots` 查找 `prepared`、`applying`、`reverting` 或 `recovery_required` 记录，显式 `revert <id>`。
4. 遇到 `Rollback conflict` 保留当前文件和快照，先比较两者；本版本不提供强制覆盖开关。

逐文件 rename 是原子的，**多文件操作不是整个文件系统事务**。没有承诺断电零风险或抵抗外部进程在检查与写入之间修改目标；恢复依据是保留的阶段日志与备份。快照不自动清理，用户应按需归档。

## 开发与验证

```sh
npm run check
npm test
npm run smoke

# 可选：使用本地已解包发行包验证真实 Cordis/DSH API 与源文件副本
DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai npm test
```

测试使用临时目录，不会对真实安装执行 apply。真实 API 集成测试可在未提供发行包时跳过；CI 的绿色状态不代表完整 Desktop 端到端验收。

本次发布未启用 GitHub Actions。跨平台工作流模板位于 Release 源码压缩包的 `.github/workflows/checks.yml`，需要具备 workflow 写权限后推送启用。

MIT © 原作者小杨及 RuiC。独立社区项目，与 DeepSeek 无隶属关系。
