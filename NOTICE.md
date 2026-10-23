# Attribution

RuiC-dsh-purge is an independently maintained derivative of
[ZiPengWei/dsh-purge](https://github.com/ZiPengWei/dsh-purge), based on upstream commit
`084b10d754c4640ea1fa44bcb76490b0c2ff1068` (package version 1.0.0).

The original project credits 小杨 / YuJunZhiXue. Its MIT license and copyright
notice are retained in LICENSE. The legacy patch definitions in lib/patches.js
are derived from that source. The DSH settings-slot integration follows the
original client integration. RuiC rewrote transaction handling, snapshots,
host discovery, CLI, HTTP service, compatibility adapters and settings behavior.

This project is not affiliated with or endorsed by DeepSeek. DSH itself is not
included. No DSH installation, account data, credentials, sessions or extracted
application source is redistributed in this repository or its release package.

The README structure and the "check the host, then apply" presentation were
informed by Purge Community
([kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)),
a separate derivative of the same upstream. No code from that project is
included here; it is credited as a reference, not as a source.

RuiC changes: Copyright (c) 2026 RuiC, released under the MIT license.
