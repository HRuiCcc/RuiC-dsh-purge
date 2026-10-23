# Compatibility evidence

Inspection date: 2026-10-23. Target: locally installed DeepSeek Harness Desktop
**0.2.1-rc.2**, bundled Cordis **4.0.5**. This records observations from shipped
source and isolated runtime tests, not proof of a running user's session state.

## Reproduce it yourself

```sh
npm run verify:desktop -- --full
```

That command discovers the installed host (or takes `--app`), copies the target
files out of the sealed archive into a temporary base, and asserts, in order:
`plan` matches, `apply` succeeds, the patched module parses, a second `apply`
changes nothing, `revert` restores byte-identical bytes, and the archive's
size/mtime is unchanged. With `--full` it also materializes the whole
`dsh/node_modules` tree and runs the real Cordis/DSH integration suite against
the shipped modules.

Result for 0.2.1-rc.2 on 2026-10-23:

| Step | Result |
| --- | --- |
| Profile selection | `dsh-0.2-native-permissions` |
| Modern anchors 1–4 | 4/4 matched (`pending` before apply) |
| Patches 5–8 | `native_setting`, never written |
| Apply → syntax check | pass |
| Second apply | 0 changes |
| Revert | byte-exact for both target files |
| Signed archive | size/mtime unchanged |
| Runtime suite | pass against the extracted shipped modules |

One archive member
(`dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/bin/libreoffice-kit`,
~134 MiB) exceeds the single-member limit and is reported as skipped by name
during `--full`; it is a native binary unrelated to the patched JavaScript.

Verification only proves these steps on this build. It does not prove a running
user's session state, model behavior, or any other DSH version.

## Findings and implementation

| Shipped evidence | RuiC behavior |
| --- | --- |
| `dsh-agent-instructions/lib/index.js` renames WORKSPACE constants to AGENT constants | Match and replace paired modern constants; retain referenced identifiers |
| `dsh-web-app/cordis.patch.yml` uses personaPrefix without cwd | Modern replacement retains model interpolation, never introduces removed cwd placeholder |
| `dsh-user-approval/package.json` points at bundled lib/index.js, while lib/types still exists | Do not report success based on editing unused types source |
| `never` policy returns rejected for approval requests | Retire misleading full-access wording in modern profile |
| sandbox-local and fs-sandbox implement separate boundaries | Use official permission preset rather than changing only Seatbelt |
| permission-presets stores per-session policy and defaultPreset | Runtime evidence is explicitly scoped to future sessions; current session remains unknown |
| systemPrompt.section supports interpolate:false | User prompt braces remain literal |
| tools output schema/render matches bundled runtime | Real tool registration and output validation tested |
| commands, WebServer and permission services have scoped lifecycle | Late attach, replace, unload and reload tested |
| raw WebServer handlers are not Typert-authenticated | Require direct loopback sockets; reject proxy and cross-site requests |
| Desktop distribution has app.asar and ElectronAsarIntegrity metadata | Read-only ASAR inspection; no signature rewriting or automatic unpack/swap |

The installed `dsh-agent-instructions/lib/index.js` examined has SHA256
`4011f6e4c08228601bd4348ac78e322913142264f6e491ffdf9dcfda97393988`.
The original application artifact and user profile data are not distributed.

## Third-party Electron carriers (2026-10-23)

Observed on a DSH 0.2.1-rc.2 carrier that packages the runtime at the archive
root (`app.asar/node_modules/@deepseek-ai`, no `dsh/` prefix) and launches
`host.mjs` as an `ELECTRON_RUN_AS_NODE` child:

| Shipped evidence | RuiC behavior |
| --- | --- |
| Runtime at the archive root, canonical `dsh/` member absent | Both members are probed; the canonical layout still wins when present |
| `fs.lstat` on a `.asar` path returns size 0; `fs.open` throws `ENOENT, not found in <archive>` | Raw archive reads run with `process.noAsar` set, then restore the previous value |
| `process.resourcesPath` is undefined in the as-Node host child | `<dirname(process.execPath)>/resources` is probed as well |
| A hardcoded macOS candidate resolves to `C:\Applications\...` on Windows | The macOS path is only probed on darwin |
| ASAR `link` metadata | Still refused with `ASAR linked members are not supported`, never downgraded to "member missing" |

Because the runtime lives inside a sealed archive, this carrier reports
`sealed`: read-only preflight, independent prompt, commands and tools work;
patch writing does not.

## Validation scope

- Real module imports, Cordis contexts, command/tool/prompt registration and route lifecycle.
- Full modern patch planning against the actual sealed archive.
- Apply and byte-exact revert on an isolated copy of the real affected source files.
- Legacy synthetic fixtures, failure injection, checksum corruption, concurrent prompt saves and path boundaries.
- Desktop/mobile settings panel smoke tests use an isolated harness, not a user's logged-in application.

WebServer socket startup is disabled in the real-module lifecycle test so it
does not attach to an existing user service. The test exercises the real class's
registration and disposal methods. It does not claim a full Electron UI boot,
user login, provider request, runtime model behavior, or signed application
update/rollback. The supplied Windows/Linux CI template covers fixtures and
packaging, not installed DSH desktop distributions. Remote CI was not enabled
for this release; no remote Windows/Linux passing result is claimed.

## Version policy

The 0.2+ adapter uses modern anchors and native permissions. Exact matches are
required even for an advertised version. A future release that changes an
anchor reports incompatible rather than partially applying. Unknown package
versions use the legacy profile and still need all anchors. Version detection
does not silently rewrite package metadata or user configuration.
