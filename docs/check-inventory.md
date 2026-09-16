# 检查清单（由 `scripts/gen-check-inventory.mjs` 生成，请勿手改）

> R1 来源律 / R5 唯一归属律的机制：**加检查前先查这里**。
> 覆盖范围：以字面量出现的 id + `DYNAMIC` 显式列出的动态 id；若新增检查后本文件未更新，CI 会红。`source` 为空表示该检查尚未标注权威来源（待补，见 docs/check-authoring-rules.md §2）。

共 51 项。

| id | 段 | 范围（取自代码注释） | 来源 |
|---|---|---|---|
| `C0` | catalog | 远程检查目录（层 A） | — |
| `E0` | env | --security-only 跳过非安全检查 | — |
| `E1-node` | env | node 可执行文件是否可用 | — |
| `E1-pnpm` | env | pnpm 可执行文件是否可用 | — |
| `E1-zstd` | env | zstd 可执行文件是否可用 | — |
| `E10-port-3080` | env | 应答 → 正常；无应答 → 如实报"绑着但不服务"，这正是崩溃重启循环的样子。 | #6693 |
| `E11-settings-writable` | env | settings.yaml 可写性 | #1719 |
| `E12` | env | `dsh web` 无法启动，换到 Node 26 后正常，怀疑写入侧不稳。故这里如实报告运 | #6341 #6651 |
| `E13` | env | 只有"入口根本没执行"才会连版本号都不输出。故这里直接问一次版本号。 | #2259 #6651 |
| `E2-env` | env | 单位不同的检查（如 E1 系列各自查一个可执行文件）如需别的数量应显式传入。 | #1270 |
| `E3-node` | env | 在那之前，任何写死它的地方都必须标注**出处与核对日期**。 | #6651 #2259 |
| `E4` | env | 二者皆无（合成 HOME、干净容器）→ 这里没有"已安装的 dsh"可言，报 fail 是无 | — |
| `E5` | env | E5 | #1219 #1219 |
| `E6` | env | r5 语义 | #1357 #1357 |
| `E7-dsh-in-path` | env | dsh 是否在 PATH 中 | — |
| `E8-npmrc-workspace-flag` | env | profile .npmrc 的 workspace 标志 | — |
| `E9-storages-json-valid` | env | storages.json 是否合法 | — |
| `installed_bundle` | profile | 安装形态两种都找 | #1846 #1719 |
| `P0` | profile |  | #6693 #1719 |
| `P1` | profile | 不在 profile node_modules 里，installAnchor 缺失时 fi | #917 #917 |
| `P10` | profile | P10 | #1904 #1904 |
| `P11` | profile | P11 | #1904 #1947 |
| `P13` | profile |  | #2752 #2752 |
| `P14` | profile | execBit 仅作兜底提示（文本文件解释器识别靠 shebang），不作为通过条件 | #1846 #1846 |
| `P15` | profile | 加上 config/*.json | #5176 |
| `P16` | profile | patch 的 id 可能是裸名（dsh-noema）而 bundle 名是 scoped（ | #5864 |
| `P17` | profile |  | #5719 |
| `P18` | profile | DeepSeek 请求以 REQUEST_EXTENSION 失败（#6667 报告的最小复 | #1197 #880 |
| `P19` | profile | 不生成发现——声明与否是作者的选择，消费者该做的是别把它读成"已核对"。 | — |
| `P2` | profile | bundle vs 用户 patch 冲突（#1404） | #1377 #1404 |
| `P20` | profile | 注意 | — |
| `P21` | profile | client 侧还常通过 ctx.get('host'/'styles') 取沙箱服务 | — |
| `P3` | profile | 并向上找一层以覆盖 profile 根安装（~/.dsh/profiles/node_mod | #1197 #880 |
| `P4` | profile | P4 file | #1197 |
| `P5` | profile | symlink 指向宿主同一份（#1697 的 link | #1197 #1486 |
| `P6-patch-name-space` | profile | 用户 patch 的 insert name 无空格 | — |
| `P7` | profile | 顶层混排检测 | #1724 #1724 |
| `P8` | profile | P8 | #1904 #1904 |
| `P9` | profile | 注意边界 | #1904 #1904 |
| `S0` | session | 三层 | — |
| `S1` | session | S6/S7 | #1469 #1363 |
| `S10` | session | S10 | #1363 #466 |
| `S11` | session | 真实链不可用 → 回退启发式规则（覆盖子集，明确标注） | #6045 #6328 |
| `S12` | session |  | #6045 #6328 |
| `S13` | session | S11 甚至会报"均健康"；而 harness 侧会 `corrupt Zstandard  | #6686 #6686 |
| `S14` | session |  | — |
| `S2` | session | S6/S7 | #1363 #466 |
| `S6` | session | S6（官方版） | #1363 #466 |
| `S7` | session | 只查文件序在最后一个 end-seed 之后的记录 | #1469 #1469 |
| `S8` | session | S8 | #466 #1265 |
| `S9` | session | S9 | #1043 |
