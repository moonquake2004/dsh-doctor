# 红队审计档案 · 0.8.10（独立证伪：S1 / E9 / E4 三条修复）

**审计者**：fresh-context 红队（未参与本版任何修复的编写）
**范围**：`git diff HEAD -- plugin/` 中的三条修复 + 新增 `detailSkip` 原语改动
**立场**：默认假设三条修复"有洞"，去找能证明它的反例；**证不出来的如实写"未找到"，不把疑点写成结论**
**纪律**：所有反例都在 `/tmp` 副本上实跑；生产仓库的 `plugin/*` 与 `plugin/test/*` 我**未改动一个字节**

---

## 〇、先说结论

| # | 问题 | 严重度 | 是不是真反例 |
|---|---|---|---|
| R1 | 新增的独立 `tool/call` 收集**零测试覆盖**：删掉整段，全套 241 项仍全绿；而删掉后一个**真孤儿被漏报成 pass** | **High** | 真 |
| R2 | `file-size-above` 原语**漏改**：缺文件时打印 `✓ …（在限内）`，正是本版要消灭的"跳过却说通过"；且 `catalog.test.mjs:106` 把这个 bug **钉成了契约** | **High** | 真 |
| R3 | E4 的 `profileHasContent` 是**半修复**：`.bin` / 空 `.pnpm` / 任意无关文件仍让干净环境报 `fail`，与被修的是同一类假 fail | **Medium** | 真 |
| R4 | 作者注释断言 `rememberCall` 取 min "当前**不可观测**"——**可证伪**：临界用例下 min 判 `fail`、覆盖实现判 `pass` | **Medium**（注释失实 + 无区分度用例） | 真 |
| R5 | CHANGELOG 测试数字两处皆错（`228 → 241` / `240 pass`），实测 `229 → 242` / `241 pass` | **Low** | 真 |
| — | S1 主修复（收集独立 `tool/result` 行） | — | **未找到反例，判为有效** |
| — | E9 路径修正 + 降 warn | — | **未找到反例**（但有 1 项未能验证，见 §④） |

S1 的**核心修复是对的**——在真实会话库上 HEAD 报 59 个假孤儿、现行版报 1 个真 in-flight。E9 在健康机上从"恒 skip 且谎称合法"变成真正 `pass`。问题集中在**修复的边角与验证强度**，不在主线。

---

## ① 真反例

### R1（High）独立 `tool/call` 收集无测试覆盖，删掉它真孤儿会漏报

**位置**：`plugin/dsh-doctor.mjs:1976`（`if (d.type === 'tool/call')` 块）
**声称**（CHANGELOG + 代码注释）："并补收独立的 `tool/call` 行"、"同一处修复"

**构造 A（变异存活）**：在 `/tmp` 副本里删掉整个 `if (d.type === 'tool/call') {...}` 块：

```
ℹ tests 242   ℹ pass 241   ℹ fail 0   ℹ skipped 1
```

**全套 241 项仍全绿**——即这段新增逻辑**没有任何测试能发现它被删除**。查证原因：`regression-0.8.10.test.mjs` 里 `grep -c "tool/call"` = **0**，13 条用例一条都没构造过独立的 `tool/call` 行。

**构造 B（该缺失导致的真假阴）**：造一个"只有独立 `tool/call` 行、无 assistant 内联块、无 result"的会话（宿主侧若只落行、或内联块被压缩掉，就是这种形态）：

| 版本 | S1 结论 |
|---|---|
| 现行（含 `tool/call` 收集） | `fail` — 孤儿 `c-ONLY` ✓ 正确 |
| 删掉该块（等价于"只修 tool/result"的半吊子修法） | **`pass` — "无孤儿 tool_call"** ✗ **漏报真孤儿** |

**判定**：真反例。而且它精确对应本项目的纪律条目——**"没有测试的修复会消失"**。这版 CHANGELOG 自己写了"对抗自检确认都被拦住"，但对这一条并不成立。
**修法**：补一条用例——只有 `tool/call` 行、无 result → 必须 `fail` 且点名该 id。删掉实现时它会立刻红。

---

### R2（High）`file-size-above` 漏改：缺文件仍说"在限内"

**位置**：`plugin/dsh-doctor.mjs:2530`（`case 'file-size-above'`），缺文件分支为
`return { ok: true, detail: check.detailOk ?? \`${fp} 不存在（跳过）\` }`
**声称**（CHANGELOG）："探测原语（`json-valid` / `text-contains` / `file-writable`）在目标缺失时返回 `detail: detailOk`……新增 `detailSkip` 字段。"

本版只改了三个原语，**漏了 `file-size-above`**。而它恰好是**唯一**一个缺文件时**不自报 `skipped`** 的原语（另三个都带 `skipped: true`），于是它在报告里被渲染成 **✓ pass**。

**构造**（`plugin/checks.local.json` 本地覆盖层，`required: false`，路径指向不存在的文件）：

```json
{ "id": "RT-file-size", "section": "env", "severity": "warn",
  "probe": { "type": "file-size-above", "path": "{home}/nope.log", "min": 1000000, "required": false },
  "detailOk": "日志大小在限内", "detailFail": "过大" }
```

**实测输出**：

```
 ✓ [RT-file-size] 日志大小在限内  [目录]
```

文件 `{home}/nope.log` **根本不存在**，工具却说"日志大小在限内"并给 ✓。同一轮对照（三个已修原语）：

```
 ⊖ [RT-writable-ok-default] …/nope.yml 不存在——无对象可查，跳过  [目录]
 ⊖ [RT-json-ok-default]     …/nope.json 不存在——无对象可查，跳过  [目录]
 ⊖ [RT-text-ok-default]     …/nope.txt 不存在——无对象可查，跳过  [目录]
```

**为什么它没被修掉**：`plugin/test/catalog.test.mjs:106` 明确把这个 bug 断言成了契约——

```js
assert.equal(runCatalogCheck({ probe: { type: 'file-size-above', path: '{profile}/missing.log', minBytes: 10 } }, c).ok, true);
```

**这个断言应该怎么写才不退化**：`ok === true` 本身在 `required:false` 下是允许的（"不适用"用 `ok:true + skipped` 表达，见 R1 修复），真正要断言的是**状态与文案**：必须 `skipped === true`，且 `detail` 不得等于 `detailOk`。只断言 `ok` 会让"pass 与 skip 互换"完全隐形。

**判定**：真反例，且是"同类修复只修了它想起来的三个"的典型漏网。附带说明：该原语被正式承认（`plugin/observer.mjs:30/151/173` 接受并会生成它），不是死代码。

---

### R3（Medium）E4 判据半修复：`.bin` / 空 `.pnpm` / 任意无关文件仍报假 fail

**位置**：`plugin/dsh-doctor.mjs:567` `profileHasContent = readdirSync(profileNM).length > 0`，`:572` `hasInstall = … || profileHasContent || existsSync(pnpmStore) || …`

**代码注释自己给的判据**（`:565-566`）：

> 反例（用过的）：空目录 `~/.dsh/profiles/web/node_modules` 存在但里面什么都没装 —— 那不是安装树，旧判据 `existsSync(profileNM)` 却认了它，于是干净环境报 fail。

**但新判据只把"严格空目录"排除了**：只要目录里有**任何**东西——一个空的 `.bin/`、一个空的 `.pnpm/`、一个无关的 `README.md`——`readdirSync().length > 0` 就成立 → `hasInstall = true` → 找不到 node-pty → **fail**。这与注释自己援引的反例**在语义上完全同类**。

**构造与实测**（受控 PATH = `/opt/homebrew/Cellar/node@24/24.20.0/bin:/usr/bin:/bin`，不含 dsh；合成 HOME）：

| 合成 HOME 内容 | HEAD(0.8.9) | 现行(0.8.10) |
|---|---|---|
| 空 profile（无 node_modules） | skip | **skip** ✓ |
| 空 `node_modules/`（严格为空） | fail | **skip** ✓ 已修 |
| 只有空 `node_modules/.bin/` | fail | **fail** ✗ 未修 |
| 只有空 `node_modules/.pnpm/` | fail | **fail** ✗ 未修 |
| 只有 `node_modules/README.md` | fail | **fail** ✗ 未修 |

实测输出（现行版）：

```
A 只有一个无关空目录 .bin（无 node-pty）   => fail | 未找到 node-pty（dsh web 终端依赖它，#1219）
B 空 .pnpm store（无 node-pty 条目）      => fail | 未找到 node-pty（dsh web 终端依赖它，#1219）
A2 只有一个无关包 readme.txt             => fail | 未找到 node-pty（dsh web 终端依赖它，#1219）
```

**为什么它仍然有实际影响**：`profiles/web/node_modules/.bin/` 在**任何** pnpm 安装过的 profile 里都会存在——包括"曾经装过、又被 `pnpm prune` / 手动清理清空"的 profile，以及 CI 里先 `mkdir -p node_modules/.bin` 再跑工具的 fixture。这正是原 CHANGELOG 描述的场景（"CI 三次红都源于此类"）。

**判定**：真反例。判据应收口为"**能证明装了 dsh**"而不是"**目录非空**"——例如 `readdirSync` 后排除 `.` 前缀的元目录、并要求存在 `@deepseek-ai` 或 `node-pty`/`.pnpm/node-pty@*` 之类实条目；空 `.pnpm` 同理（`existsSync(pnpmStore)` 应改为"存在 `node-pty@*` 条目"）。
**注**：本条的严重度定 Medium 而非 High，因为触发需要 profile 里存在"非空但无安装"的残留；在纯空合成 HOME 上现行版确实正确 skip。

---

### R4（Medium）"min 不可观测"的断言可被证伪

**位置**：`plugin/dsh-doctor.mjs:1953` `rememberCall` 的注释
**现已写入的注释**（审查期间作者刚更新）：

> 诚实说明：当前**不可观测**——实测两种收集点的 seq 最多相差 1，而阈值留了 2 的余量，回退成"后写入覆盖"跑不出差异……**不要为它写断言说"已测"**

**这个"不可观测"只对"正常会话"成立，作为普遍断言是错的。** 真孤儿判定是 `o.seq < maxSeq - 1`；只要独立 `tool/call` 行落在最后两个 seq 内、而内联块更早，两种实现就分叉。

**构造**（inline 块 seq=8；独立 `tool/call` 行 seq=11；maxSeq=12；无任何 result）：

```js
[ turn/start(1), assistant/message{seq:8, tool-call id=c-Z},
  turn/end(9), turn/end(10), tool/call{seq:11, callId=c-Z}, turn/end(12) ]
```

| 实现 | 实测 S1 |
|---|---|
| 现行（取 min → seq=8） | `fail` — 孤儿 `c-Z` ✓ |
| 改为"后写覆盖"（seq=11，`11 < 11` 不成立） | **`pass` — "无真孤儿（仅尾部 in-flight: 1 个）"** ✗ **漏报** |

**判定**：真反例（**结论层**：注释里"不可观测"是失实断言，会误导后来者删掉 `min` 或不写用例）。
**自我否证的部分**：我最初怀疑"新收集与 `calls.set` 重复计入"会让 **seq 判定错位**——用正常宿主形态（两者间隔 1）跑 F1/F2/F3/F4/F5/F6 六个变体，结论**全部正确**，这部分我**没有**证出反例。真正的洞是"**缺乏区分度用例**"，不是"当前逻辑错"。所以这条应记为"断言强度超过证据"，与本项目 §6 的教训同类。

---

### R5（Low）CHANGELOG 测试数字两处皆错

**位置**：`plugin/CHANGELOG.md:55`
**声称**："全套 **228 → 241**（240 pass / 1 主动 skip / 0 fail）"
**实测**：

```
HEAD(0.8.9) 基线：tests 229  pass 228  fail 0  skipped 1
现行(0.8.10)  ：tests 242  pass 241  fail 0  skipped 1
```

原因：新增文件实为 **13** 条用例（`grep -c "^test("` = 13），不是声称的 12；起点也是 229 不是 228。`229 + 13 = 242`，自洽。
**判定**：真反例（发布说明的可核对数字错了）。虽小，但本项目的 `release-check.sh` 与审计闸门正是靠这类数字判断"这次到底改了什么"。

---

## ② 已覆盖 / 试过但**未找到反例**的部分（如实记录，不作为结论）

### S1 主修复：判为有效
- **外部实物差分（最硬的证据）**：用宿主自己的解压路径 `zstd -dc` 解出真实会话行（**121,522 行 / 80 个日志**），实测 `tool/result` 的 shape 是
  `{"type":"tool/result","seq":…,"data":{"turn","step","message":{"source":{"kind":"tool","callId":…},"content":[…]}}}` ——`data` 下**没有** `toolCallId`，id **只在** `data.message.source.callId`。这与修复里 `?? d.data?.message?.source?.callId` 的分支一致。
- **真实库前后对比**（`DSH_HOME=/Users/waterfly/.dsh`，同一"最新会话"）：
  - HEAD 0.8.9：`✗ [S1]` 列出 **59 个**孤儿 id（假阳）
  - 现行 0.8.10：`✗ [S1]` 仅 1 个 —— 经逐行核查，那是**审计当时我正在执行的那条 `bash` 调用**（真实尾部 in-flight），判定正确
- **两个"孤儿"逐个证伪**：全库独立探针发现 2 个无 result 的 call，分别位于两个会话；`--session` 直查其中一个为 `✓ 无真孤儿（仅尾部 in-flight: 1 个）`，核查该 id 上下文是一次真实 `wait_agent`（会话尾部）——两例均为真 in-flight，**S1 判定正确**。所谓"全会话扫描只报 1 个、另一个被瞒"是**误判**（S1 的设计对象是单份最新会话，不是全库；`--session` 直查即报）。
- **真实数据里 id 冲突不存在**：8,268 条 `tool/result` 中 `data.toolCallId` 出现 **0** 次、`conflict` **0** 次、`source.kind` **全部**是 `tool`。故构造用例 E1（`data.toolCallId=OLD` 与 `source.callId=NEW` 冲突）虽会误报，但**宿主不会产生这种行**——我据此**撤销**该条反例（原判定 fail 属实，但无现实触发面，不写进结论）。
- 空串 / 非字符串 callId、重复 result、result 先于 call、`tool/result` 无 `message`、老形态内联 `tool-result`、`source.kind≠tool` —— 逐条实跑，**结论均正确**，未发现反例。

### E9：路径修正与降级
- **路径修正确实生效**：真实家目录 `storages/workspace.json`（合法，keys=`unit/global/tables`）→ `pass | storages/workspace.json 为合法 JSON`。HEAD 版在 `config/` 路径上恒 skip。
- **降 warn 未破坏隔离律**：`plugin/test/fixtures.mjs:72` 的 `assertIsolated` 允许 `pass|warn|skip`，warn 不触发误报。
- **没有别的用例依赖 E9=error**：`grep -rn E9 plugin/test scripts test` 的命中全部落在 `regression-0.8.10.test.mjs` 内，且断言的是 `warn`；其余测试零命中。
- **`--json` 计数与状态自洽**（损坏场景实测）：

  ```
  EXIT=1  ok=False  verified=3  skipped=11  failed=3
  E5 fail / E8 warn / E9-storages-json-valid warn
  ```

  `failed` 计的是"非 skip 且非 ok"（含 warn），`ok` 来自 `aggregateVerdict` 的 `failed.length`——**两者口径一致**，不会出现 `ok:true` 却 `failed>0`。
- **`detailSkip` 缺省文案生效**：`json-valid` / `text-contains` / `file-writable` 三个原语缺失时均输出 `⊖ … 不存在——无对象可查，跳过`（实测），不再沿用 `detailOk` 的肯定句。

---

## ③ 未能验证的部分（明确标注，不推测）

1. **"只有 E9 失败、E5 不失败"的孤立场景构造不出来**。E9 与 E5 查同一文件，而 E5 扫整个 `storages/`、判定更宽，所以"E9 fail 而 E5 pass"在内容与类型层面都不可达（试过 `{oops` / BOM / `null` / `"str"` / 目录）。因此 **"warn 不进退出码"我只验到了"status 层是 warn"**（且 `bad[]` 按 `catalogSeverity==='warn'` 排除，代码路径为 `:3620`），**未能实测**一个"仅 warn 且 exit 0"的端到端样例。
2. **E9 的 `{home}/storages/workspace.json` 是否在 Windows 上是唯一/正确路径**未验证（本机仅 darwin）。
3. **`pathHasDsh` 的 Windows 分支**（`dsh.cmd`）：本机无法构造 win32 的 PATH 分隔符与 `.cmd` 语义，**未跑**。代码层面 `join(p,'dsh')` 与 `join(p,'dsh.cmd')` 并列，未见明显缺陷，但仅属**读码判断**，不算验证。
4. **E4 的 pnpm store 真实布局**：只验了"空 `.pnpm`"与"有 `node-pty@*` 条目"的合成形态，**未**在真实 pnpm 生成的 `.pnpm` 上跑。
5. **S1 对 `tool-workflow/agent-start` / `tool/ptc-dispatch` 等相邻事件类型**是否会携带孤儿语义未展开（它们不在 `calls` 收集面内）。

---

## ④ 回归考古：会不会"修一个引入一个"

| 相邻逻辑 | 检查结果 |
|---|---|
| 新增 `tool/call` 收集 × 原有 `calls.set` **重复计入** | **未发现 seq 判定错位**。正常宿主形态下两者间隔 1，F1–F6 六个方向性变体结论全对；`rememberCall` 取 min 方向正确（宁严不松）。真正的回归是 **R1 的测试盲区**，不是逻辑错 |
| `tool/call` 的 id 取值顺序 vs 真实主机 | 真实行是 `data.callId`；代码的 `?? d.data?.callId` 在首选之后、仍在链上，实测命中 ✓ |
| `detailSkip` × 其余原语 | **引入了一个漏网**：`file-size-above`（R2）。三个改了的都对，没改的那个仍说谎 |
| E4 `profileHasContent` × 原来的 `existsSync(profileNM)` | **是半修复**，不是新回归（HEAD 在相同场景下同样 fail）；但它**没有达成 CHANGELOG 声称的目标**（R3） |
| E4 `pathHasDsh` 是否污染合成 HOME 用例 | **我曾怀疑、已自我否证**：测试的 `CTRL_PATH` 用 `process.execPath` 的目录（`/opt/homebrew/Cellar/node@24/24.20.0/bin`），**不含** dsh；实测该 PATH 下 E4 正确 `skip`。误判撤销 |
| E9 降 warn × `assertIsolated` | 隔离律成立（warn 被允许）；无其他用例依赖 E9=error |

---

## ⑤ 自证（跑了哪些命令、结果如何）

全部在副本 `/tmp/rt0810`（`cp -R` 自 `/Users/waterfly/dsh工作区/dsh-doctor`，审查期间多次与生产仓库 `diff -q` 同步确认）与 `HEAD` 基线副本 `/tmp/rt-head` 上执行。**生产仓库我只读，`git status` 中无我造成的改动。**

```bash
# 基线
node --test plugin/test/*.mjs
#   现行 0.8.10：tests 242 / pass 241 / fail 0 / skipped 1
#   HEAD 0.8.9 ：tests 229 / pass 228 / fail 0 / skipped 1
bash scripts/audit.sh
#   审计结果：通过 7 项，失败 0 项，已知缺口 1 项（D2：R4 隔离律未落地，本版之前即存在）
node scripts/mutation-test.mjs
#   9 个变异 —— 杀死 8，存活 0，等价 1，跳过 0

# 外部实物差分（拿到宿主真实行形状）
zstd -dc <会话文件> | node -e '…统计 tool/result / tool/call 形状…'
#   121,522 行 / 80 日志：tool/result 的 data 下无 toolCallId；tool/call 的 id 在 data.callId
#   data.toolCallId 出现 0 次；冲突 0 次；source.kind 全为 tool

# S1 真实库前后对比
DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --no-catalog          # 现行
DSH_HOME=/Users/waterfly/.dsh node /tmp/rt-head/plugin/dsh-doctor.mjs --no-catalog  # HEAD
#   HEAD：59 个孤儿 id（假阳）；现行：1 个（经核实=审计时我自己的 bash 调用，真 in-flight）
DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --no-catalog --session <另一孤儿所在会话>
#   ✓ 无真孤儿（仅尾部 in-flight: 1 个）→ 逐行核查确为真实 wait_agent

# S1 对抗电池（受控 PATH + 合成 HOME，--session 收窄）
#   E1 id 冲突 / E2 重复 result / E3 result 先于 call / E4 无 message / E5 空串 /
#   E6 数字 vs 字符串 / E7 source.kind≠tool / E8 老形态内联 → 结论全部正确，未发现反例
#   F1–F6 rememberCall 方向性变体 → 结论全部正确

# R1 变异：删掉整段 tool/call 收集
node --test plugin/test/*.mjs        # tests 242 / pass 241 / fail 0  ← 变异存活
#   配合构造"仅 tool/call 行、无 result"：删块后 pass（漏报），未删时 fail（正确）

# R2：file-size-above 缺文件
#   写入 plugin/checks.local.json（required:false，路径不存在）后跑 CLI
#   ✓ [RT-file-size] 日志大小在限内  [目录]      ← 缺文件却说在限内
#   对照三个已修原语：⊖ … 不存在——无对象可查，跳过（正确）
grep -n "missing.log" plugin/test/catalog.test.mjs
#   :106 把 ok:true 断言成契约 ← 该 bug 因此不会被修

# R3：E4 绕过电池（受控 PATH=/opt/homebrew/Cellar/node@24/24.20.0/bin:/usr/bin:/bin）
#   空 node_modules → skip（已修）；空 .bin / 空 .pnpm / README.md → fail（未修）

# R4：min vs 覆盖（临界 inline seq=8 / 独立行 seq=11 / maxSeq=12）
#   现行(min) → fail（正确）；变异(覆盖) → pass（漏报）→ "不可观测"被证伪

# E9
DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --json --no-catalog
#   E5 pass / E9 pass（真实 storages/workspace.json 合法）
#   损坏场景：EXIT=1, ok=False, verified=3, skipped=11, failed=3, E9 status=warn
#   --envelope：exitCode=2, summary {pass:24, warn:2, fail:1, skip:11} —— status 层自洽
```

**审计闸门现状（补本档案前）**：红色项唯一 = 缺本文件。补上后本版应转绿。
