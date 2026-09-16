# 红队审计档案 · 0.8.3 工作树（第二轮）

**背景**：0.8.3 引入了"自造对抗者"的三件机制——变异测试、发布闸门、缺陷台账。
按 `docs/redteam-brief.md` 起了一个 fresh-context 证伪者（只读、只许证伪、不共享作者上下文），
**专门攻击这批新机制本身**。

**结果：8 条真反例，其中 1 条推翻了台账里"R1 已修 0.8.2"的结论，2 条证明新机制本身可被绕过。**

---

## ① 真反例（按严重度）

### F1（严重）profile 段的"阶段占位覆盖量"仍能伪造数字并放行假绿灯 —— **台账 #11 的同一缺陷类，只修了一半**

**最小复现**
```bash
H=$(mktemp -d); mkdir -p $H/profiles/web
echo '{"name":"web","version":"0.0.0","dsh":{"profile":{"bundles":["ghost-a","ghost-b","ghost-c"]}}}' > $H/profiles/web/package.json
DSH_HOME=$H node plugin/dsh-doctor.mjs --no-catalog --profile web; echo "EXIT=$?"
```
**修前实测**：`✓ 16 项通过、4 项未检查（skip）`，`EXIT=0`，JSON `ok=true, verified=16` —— 而**三个 bundle 一个都没装**。
≥13 条通过记录带 `examined=3, examinedWhat="bundle 条目"`，这个 3 来自**阶段占位值**
（`setCoverage(bundles.length,'bundle 条目')` + `report()` 的 `zeroCheck = examined ?? coverageNow()?.n`），
而对应的报告调用**根本没传** examined。自相矛盾肉眼可见：P21 文案「扫描 **0** 个 host 入口与 **0** 个 client 产物」却记 `examined=3`。

**判定**：0.8.2 只修了**目录段**的同类问题（RT R1），profile 段仍用占位值绕过"零对象不变量"。

**处置（本轮已修）**：删除占位回退 —— **`examined` 只能由检查显式申报**；未申报者标为 `coverage:'unreported'`
并**单独计数、暴露在 JSON**（既不算已验证、也不隐形）；补齐 P11/P15/P17/P19/P20/P21 的显式数量与单位
（`examinedWhat` 亦改为**必须显式申报**，删除"数量巧合就继承单位"的回退——它会把"检查 3 个文件"的 P15 误贴成"3 个 bundle 条目"）。
修后复验：幽灵 bundle 场景**不再出现任何 `examined=3`/`bundle 条目` 记录**，`unreported` 如实计数。

### F2（严重）"闭集律"只是文本律：语义上可绕过

在副本向主程序注入 `console.log(String.fromCharCode(0x2713)+' …')` → **闭集测试 PASS**，而 CLI 实际打印 `✓ …`。
另外 `plugin/client/client.js:109` 有裸写 `c.ok ? '✓' : '✗'`，而闭集测试**只读 `plugin/dsh-doctor.mjs`**；
GUI 会把 `{ok:true, skip:true}` 记录渲染成绿色 ✓。"绿只能由一个收口点产出"在**语义层与 GUI 层都不成立**。

**处置**：列为 **D6（待决策）** —— 真正的修法是把闭集从"扫源码找字形"升级为**运行时拦截 stdout**
（例如在测试里包一层 `console.log`，任何非收口点输出的判定符号即失败），并覆盖全部输出模块（含 client）。属于结构性改动，未在本轮擅动。

### F3（高）发布闸门可被空文件旁路

```bash
: > docs/redteam-9.9.9.md && bash scripts/release-check.sh 9.9.9   # 修前：✓ 红队档案存在
```
**处置（本轮已修）**：闸门现在①**拒绝参数版本与 package.json 不一致**；②档案必须**≥500 字节且含反例章节**。
复验：`bash scripts/release-check.sh 0.0.0` → 直接拒绝；用真实版本跑时，仓库只有按日期命名的档案 → **红的**（这正是闸门该有的行为，见下方"自证"一节）。

### F4（高）闸门与变异清单**不在版本控制里**

`git status`：`?? scripts/mutation-test.mjs`、`?? scripts/release-check.sh`、`?? docs/defect-ledger.md`、`?? docs/redteam-brief.md`。
文档声称闸门"把对抗者变成默认动作"，但闸门未入库 → **新克隆/CI 没有这个机制**。

**处置（本轮已修）**：全部纳入版本控制并提交。

### F5（高）测试与变异判定不可复现（依赖网络）→ **假杀死**

同一份代码：原仓库 `node --test plugin/test/*.mjs` → exit 0；`/tmp` 副本同一命令 → exit 1。
根因：`fixtures.mjs` 里那条目录用例自陈"不加 `--no-catalog`"，**新 HOME + 网络可用时取到远程目录**，
其 E7 判 pass，断言失败。后果：变异测试把 `spawnSync(...).status !== 0` 一律当"被杀死"——
**环境导致的红会被记成 kill（false kill）**；超时（`status=null`）同样算 killed。

**处置（本轮已修）**：① 新增离线开关 `DSH_DOCTOR_OFFLINE=1`（等价 `noRemote`），目录用例改为离线运行；
② 变异判据收紧为"必须出现**测试断言失败**的标记"；③ 每条变异**先跑基线**，基线未通过则本轮不做判定（inconclusive）；
④ 超时单列，不算 kill。

### F6（中）"等价变异"是自证后门

`equivalent` 由写清单的同一作者手填、无独立校验；标上就永不进 survivors、不翻退出码；且 `--json` **完全不含 equivalents**。

**处置（本轮已修）**：`--json` 输出 `equivalents` 与 `budget`；**等价变异有预算（1）**，超出即失败；
并将该条变异标注为"当前冗余"的具体理由。

### F7（中）台账计数与自己列的 20 行不自洽

统计表写 `EXT 6 / RT 6 / MUT 1 / AUDIT 7`，逐行实为 `EXT 6 / RT 7（含 #17）/ MUT 1 / AUDIT 6` → 6+6+1+6=19≠20。

**处置（本轮已修）**：按行重算并明确归属规则；同时**更正上一轮的一处过度声称**——
"R1 已修 0.8.2"应改为"R1 只修了目录段；profile 段同类问题在 0.8.3 才修"（F1）。

### F8（中）闸门自身的失败诊断会崩、且从不核对数量

第 1 项失败时 `sed 's/^/      /'` 在 C locale 下报 `illegal byte sequence`，无任何诊断；
`grep -o '杀死 [0-9]*'` 实测返回空（无数字），闸门照样打勾。

**处置（本轮已修）**：改用 `awk` 输出（避开多字节 sed）；闸门**核对数量**（要求 杀死≥6 且 等价≤1），
不再只看退出码。

---

## ② 已覆盖（试了什么 / 主张为何成立）

- 变异测试本身可运行且与声称一致（8 个变异 → 修后 7 杀死 / 0 存活 / 1 等价）。
- 目录段"目标不存在"分支基本收口（逐个原语读过：`json-valid`/`text-*`/`file-writable` 的缺省路径已带 `skipped:true`）。
- 闸门退出码传播正常（`RELEASE_EXIT=1`）；路径穿越尝试失败。
- 台账中可核对的部分为真：`bash scripts/audit.sh` → "通过 7 项，失败 0，已知缺口 1"。

## ③ 未能验证（如实保留）

1. `mutation-test.mjs` 被 SIGKILL 后的**实际**残留（按规定未真的 kill；仅有源码级证据。本轮已加信号处理器，但 SIGKILL 不可捕获）。
2. `file-size-above` + 数据注入 `detailOk` 的实跑复现（需写 `plugin/checks.local.json`，未做）。
3. `--no-catalog` 只是 `noRemote`：**本地覆盖层 `plugin/checks.local.json` 仍会被合并**，而它被 `.gitignore` 忽略
   → 能写该文件者即可改判定，且 CI 关不掉。**列为信任边界问题（D7）**。
4. 远程 `checks.json` 与内置 `checks.json` 的差异未逐条比对。

## ④ 自证

**闸门用真实版本跑是红的**（缺 `docs/redteam-0.8.3.md`）——本档案即为补齐该要求而写。
按闸门规矩：**没有红队档案就不许发布**，这正是它存在的意义。
