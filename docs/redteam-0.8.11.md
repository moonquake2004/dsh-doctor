# 红队审计档案 · 0.8.11（独立证伪：P24 / P25 / P0 文案）

**审计者**：fresh-context 红队（未参与本版任何代码编写）
**范围**：`3539c1c feat(0.8.11)` 的整笔 diff —— `plugin/dsh-doctor.mjs` 的 P24 / P25 / P0 文案 / P22 死代码清理，`plugin/test/fixtures.mjs` 的 5 条新用例，`docs/check-inventory.md`
**立场**：默认假设 P24 会**误报健康环境**（本项目最痛的那类缺陷），去找能证明它的反例；**证不出来的如实写"未找到"**
**纪律**：所有反例都在 `/tmp` 副本或 `mktemp` fixture 上实跑；生产仓库的 `plugin/*`、`plugin/test/*`、`plugin/checks.json`、`docs/check-inventory.md` **一个字节未改**（唯一写入的就是本文件）

> **口径说明**：仓库实际状态与任务书的假设不同——任务书说"工作区有未提交改动，`git diff` 可看全貌"，
> 但实测 `git status` 是 **`nothing to commit, working tree clean`**，0.8.11 已作为 commit `3539c1c` 落在 HEAD 上，
> 所以本轮审计用的是 `git show HEAD` 而不是 `git diff`。另外 HEAD 实际是 `86a9edf`（E11 dir-writable），
> 0.8.11 是它的**前一笔** `3539c1c`；我只审了 `3539c1c` 这一笔（这是唯一与本轮新增内容相关的提交）。

---

## 〇、先说结论

| # | 问题 | 严重度 | 是不是真反例 |
|---|---|---|---|
| R1 | **"命中 ≥3 降为 warn"是死代码**：`detail` 文案降级了，`status` 恒为 `fail` 且退出码恒 1。发布说明、代码注释、fix 文案三处都声称会降级 | **High** | 真（实测 + 变异测试双向证明） |
| R2 | `devDependencies` 被并入 ①"装过"，无任何限定 → 往 profile 里装的**工具包**（带 `dsh.bundle` 但根本不该加载）被报 fail | **Medium** | 真（误报类） |
| R3 | 裸名归一化**双向失真**：`bundles` 里一个不相干的裸名可以遮蔽一条真的漏登记（漏报），同一裸名也会让另一 scope 的漏登记**静默放行**（假 pass） | **Medium** | 真 |
| R4 | P24 在 pass 分支把**没落盘**的依赖也算进"核对 N 个依赖"的覆盖量 —— `examined` 报 2、真正读过 `package.json` 的是 0 | **Medium** | 真 |
| R5 | **P25 完全看不见未登记 bundle 的 patch 缺失**（遍历集是 `bundles`）——恰好是"其余检查对该插件失明"这一问题，P25 自己也有；也削弱了 P24 的 fix 文案 | **Medium** | 真 |
| R6 | P25 **只读 `typeof rel === 'string'`**，而宿主 `bundlePatchFiles()` 接受数组 → 数组形态的 bundle 直接 skip，全新漏报（且报成"跳过"而非"看不见"） | **Medium** | 真 |
| R7 | P25 用 `existsSync` 判"文件在"，**目录也返回 true** → 指向目录的 `patch` 判 pass，而宿主 `readFileSync(dir)` 会 EISDIR | **Low** | 真 |
| R8 | `patch` 写成 `exports` 子路径时 P25 报 fail（"文件不存在"）——**能否算误判取决于宿主解析口径，本轮未验证，不算反例**（见 §③ 的否证过程） | Low（待定） | **未确认** |
| — | P24 主干（三条件 + 去 scope 裸名）在**本机真实 profile 上零误报** | — | **未找到反例**（14 个依赖逐个核对，见 §④） |
| — | 新检查是否让别的 fixture 变红（`assertIsolated` 污染） | — | **未找到反例**（全套 257 项 256 pass / 1 skip，见 §⑤） |
| — | "≥3 降 warn" 会不会被当成"多装几个逃过 fail"的漏洞 | — | **未找到反例**——因为这个降级**根本没发生**（见 R1） |

**一句话**：P24/P25 的**判据方向是对的、真机上也确实零误报**，问题全部集中在**边角与"自证"上**——
最重的一条是 R1：这版**声称做了的降级根本没做**，而它的三处声明都在说"做了"。

---

## ① 真反例

复现脚本：`/tmp/rt/reproduced-all.sh`（每条都是独立的 `mktemp` DSH_HOME，全部实跑过，下文贴的是**实测输出**原样）。
我另外保留了一批探针脚本 `/tmp/rt/probe1..24.mjs`、变异副本 `/tmp/rt/mutplug/dsh-doctor.mjs`。

---

### R1（High）"命中 ≥3 降为 warn"是死代码：status 恒为 fail

**位置**：`plugin/dsh-doctor.mjs:865-870`

```js
      const many = unregistered.length >= 3;                       // 865
      ...
      if (many) report('profile', 'P24', false, detail, `先备份 manifest；...`, undefined, unregistered.length, '未登记 bundle');   // 869
      else report('profile', 'P24', false, detail, `手动把名称加入 ...`, undefined, unregistered.length, '未登记 bundle');        // 870
```

**问题**：`report()` 的第 3 个参数是 `ok`（布尔），**没有 severity 参数**。降级成 warn 的唯一机制是
`catalogSeverity.get(r.id) === 'warn'`（见 `plugin/dsh-doctor.mjs:3821`、`:3774`、`:3844` 三处），
而 `catalogSeverity` 里 `P24` / `P25` **都没有登记**（`:2426-2436` 只有 E1-pnpm/E3-node/installed_bundle/P13-P20）。
所以 `many` 只改变了**文案**，`status` 与退出码一字未变。

**三处声明都说了"降级"**：

| 出处 | 原话 |
|---|---|
| `plugin/CHANGELOG.md:27` | "命中 ≥3 个时降级为 warn 并提示可能是 #9753 的 boot recovery" |
| `plugin/dsh-doctor.mjs:849` | "故**命中 ≥3 个时降为 warn** 并提示可能是恢复重置，避免一次误报刷屏" |
| `plugin/dsh-doctor.mjs:869` | `many` 分支的 fix 文案 `先备份 manifest；若确为安装中断：...`（与 warn 分支共用同一条 `report(..., false, ...)`） |

**实测（3 个真实未登记插件）**：

```console
$ DSH_HOME=$H node plugin/dsh-doctor.mjs --json --no-catalog --profile web | ...
P24 status=fail（文档要求 warn）

$ DSH_HOME=$H node plugin/dsh-doctor.mjs --profile web --no-catalog
 ✗ [P24] 已安装但未登记进 dsh.profile.bundles（#10159/#6539：插件装了但永不加载，重跑 add 也不自愈）: u1, u2, u3
  （命中 ≥3 个 —— 也可能是 #9753 的 boot recovery 把 bundles 重置成了内建最小集，请先确认是否刚发生过启动恢复）
     ↳ 修复: 先备份 manifest；若确为安装中断：手动把名称加入 dsh.profile.bundles，或 dsh plugin --profile web remove 后重新 add
✗ 1 个内置问题（profile=web，目录=bundled，5 条）
```

`✗` + `1 个内置问题` + 退出码 1 —— 与 1 个命中时完全一样。

**变异测试（双向闭环证明 it's dead）**：把 `const many = unregistered.length >= 3;` 改成 `const many = true;`：

| 输入 | 真实 HEAD | `many = true` |
|---|---|---|
| 3 个未登记 | `fail` | `fail` |
| 5 个未登记 | `fail`（exit 1） | `fail`（exit 1） |

两者**没有任何可观测差异**。反向也成立：把整个 `many` 分支删掉，全套 257 项**仍然 256 pass**（见 §⑤ 变异实验 M2）。

**是不是误判**：不是。CHANGELOG 是本轮的对外契约，注释是本轮的自我声明，两者都说了"降为 warn"，实现没做。

**影响分层**：
1. **直接后果是文字与行为不一致**（用户和后续维护者都会以为降级存在）。
2. 任务书问的那个风险——"真的装了 3 个未登记插件的用户被降级提示而忽略""多装几个逃过 fail"——**在当前代码里都不存在**，
   因为**永远不降**。一旦按字面把它实现成 `catalogSeverity.set('P24', 'warn')` 或按条数动态降级，
   任务书担心的那个洞**立刻**出现（`catalogSeverity` 是**按 id** 的，一旦设成 warn，1 个命中和 100 个命中都是 warn，
   真正该拦的那一例也会被一起降级 —— 这是比"不动"更坏的选择）。

**建议方向**（不改，只记录）：要么把 `many` 分支做成真正按条数的 severity（需要 `report()` 支持逐条 severity 或改聚合口径），
要么就**删掉** `many` 分支和 CHANGELOG 里那句话，让"命中多少都 fail"成为诚实契约。**当前这种"文案降级、判定不降"是最差的一档**。

---

### R2（Medium）`devDependencies` 被无条件算作"装过" → 工具包被报 fail

**位置**：`plugin/dsh-doctor.mjs:854`

```js
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
```

**构造**：profile 的 `package.json` 把某个声明了 `dsh.bundle.patch`、也确实落在 `node_modules` 里的包
放进 `devDependencies`（压根没打算让它作为 profile 层加载），且不在 `bundles` 里。

```console
$ ./reproduced-all.sh   # F1
===== F1  devDependencies 里的 bundle 未登记 =====
 ✗ [P24] 已安装但未登记进 dsh.profile.bundles（#10159/#6539：插件装了但永不加载，重跑 add 也不自愈）: tooling-bundle
✗ 1 个内置问题（profile=web，目录=bundled，5 条）
```

**为什么这是误报**：用户有意把某个包放进 `devDependencies` = 明确表达"它不是 profile 的运行时层"。
P24 的语义是"装了本该被自动登记却没登记"，而 `devDependencies` 里的包**本来就不该被 `reconcile` 自动登记**。

> **反方证据（我核过宿主源码，写在任务书要求的"否证过程"里）**：
> 线上宿主 `runPluginCommand` 的 `reconcile(before, dir, anchor, options)`（`dsh-plugin-manager/lib/index.js:323`）
> 只遍历 `Object.keys(after.dependencies ?? {})`（**不含** devDependencies），因此 devDependencies 里的 bundle **确实不会被自动登记**。
> 但同一条 reconcile 的 `previous.filter(...)` 也**不会把它从 bundles 里删掉** —— 也就是说，如果用户手工把 devDependency 写进 `bundles`，它是能生效的。
> 结论：`devDependencies` 里的 bundle 是"**可选加载**"的合法状态，报 fail 属误报；报 warn 或直接排除才合适。

**另一条同类但更弱的证据**（也属误报面）：本地开发插件 `file:` 依赖也会被 fail ——

```console
===== F8  本地 file: 开发中插件（设计取舍）=====
 ✗ [P24] 已安装但未登记进 dsh.profile.bundles（#10159/#6539：插件装了但永不加载，重跑 add 也不自愈）: @local/dsh-myplugin
✗ 2 个内置问题（profile=web，目录=bundled，5 条）
```

F8 我判**偏"合理"而非误报**：装了 `file:` 插件却没登记，确实就是"装了却没生效"，报出来是对的。
但它提示了一个表述问题——一个正在开发调试的插件每次都会被判 fail，用户需要知道这是**预期**的。

**修复验证（不是建议，是证明）**：在 `/tmp` 副本里把 `devDependencies` 去掉再跑 F1，P24 变 pass；加上则 fail —— 单一因子，归因成立。

> **一个必须写清的诚实说明**：我最初写的 F1 用例是 `devDependencies` 里放宿主自带的
> `@deepseek-ai/dsh-experimental-plugin-market-bundle`（拿本机真实数据构造的），结果 **P24 报 pass**。
> 追下去发现原因是 `findPkg` 走 `installAnchor`（PATH 里的 `dsh` → 宿主安装目录），**连宿主安装自带的可选 bundle 都算"装了"**。
> 这一点对 P24 是**正确行为**（那类包根本不进 profile 的 `node_modules`），
> 但对 P1 是**已知误报**：我造了一个假锚点 `/tmp/rt/fakebin-anchor` 后，P1 对 `@deepseek-ai/dsh-base` 报
> `bundle 条目 @deepseek-ai/dsh-base 无法在安装目录或 profile node_modules 解析`，同时 `installed_bundle` 吐出
> `bundle 版本对比异常: ENOENT ...`。**这是 0.8.10 就有的行为，不是本轮引入的**，不在本次审计范围内，仅记录。

---

### R3（Medium）裸名归一化双向失真：屏蔽真漏登记（漏报） + 假 pass

**位置**：`plugin/dsh-doctor.mjs:855-856`

```js
    const bundleBare = new Set(bundles.map((b) => String(b).replace(/^@[^/]+\//, '')));   // 855：丢掉 scope
    ...
      if (bundleBare.has(depName) || bundleBare.has(depName.replace(/^@[^/]+\//, ''))) continue;  // 856：按裸名放行
```

**失真 A（漏报）**：一个**不相干**的裸名条目就能把一条真的漏登记放行。

```console
$ ./reproduced-all.sh   # 变体：bundles=["alpha-scope-foo"]，dependencies={"@alpha-scope/dsh-foo"}
### bundles=['alpha-scope-foo']（若宿主按裸名查）应登记 @alpha-scope/dsh-foo
 ✗ [P24] 已安装但未登记进 dsh.profile.bundles ... : @alpha-scope/dsh-foo
```

——注意这条**报出来了**（是对的）。真正的漏报在**两个真实包撞裸名**时：

```console
$ ./reproduced-all.sh   # F2
===== F2  两个 scoped 包同裸名：已登记的遮蔽未登记的 =====
 ✓ [P24] 已装且声明 dsh.bundle 的依赖均已登记进 bundles（核对 2 个依赖）
```

`bundles = ["@a/ui-widget"]`，`dependencies = {"@a/ui-widget", "@b/ui-widget"}`。
按宿主语义（`resolveBundleDir` + `bundles.includes(name)`，全名匹配）`@b/ui-widget` **确实没登记**，
但裸名集合 `{"ui-widget"}` 让 `@b/ui-widget` 被当成"已登记" → **假 pass**。

**失真 B（误报）**：`bundles` 里写了裸名 `alpha-scope-foo`，而依赖是 `@alpha-scope/dsh-foo`。
被测代码**认这个裸名**（我给了它最宽的条件），但如果宿主实际按全名解析（`resolveBundleDir` 是
`join(anchor, packageName)`，不会把 `alpha-scope-foo` 解析成 `@alpha-scope/dsh-foo`），
那这就是一个真实"装了但没登记"的案例被放行。**这一条我不敢断言是误报还是漏报，见 §③ 的否证。**

**关键判断**：被测代码自己的注释说的是"**含去掉 scope 的裸名**"（`:846`），暗示作者认为宿主存在按裸名登记的形态。
**我在宿主源码里没找到任何按裸名匹配 `bundles` 的代码**（`resolveBundleDir(...)` 全名 join；
`reconcile` 里 `bundles.includes(name)` 全名；`readProfilePlugins` 里 `enabled: bundles.includes(name)` 全名）。
所以**裸名归一化很可能是凭空加的一层宽松**，它**只引入漏报面，不消除任何误报**。

**那个本意想解决的误报是什么？** 我推测是为了兼容 "bundles 写裸名、依赖是 scoped 名" 的旧 profile。
但如果是这样，正确写法应该是**只在依赖名去 scope 后与 bundles 条目完全相等时**才放行（现在的 856 行前半句
`bundleBare.has(depName)` 正是这个），而不是把 **bundles 里所有条目都去 scope 后放进一个全局集合**
（这就是 F2 那个假 pass 的根因）。这两行的语义完全不同：
- 第 1 个判断 `bundleBare.has(depName)` —— 才是"依赖名去 scope 后等于某条目的裸名"；
- 第 2 个判断 `bundleBare.has(depName.replace(...))` —— **又对 depName 去了一次 scope**，
  这两个值都已经是裸名，碰撞面被放大成"任意两条 scoped 包只要尾段相同就互相顶替"。

**任务书特别要求核查的**：
- `manifest.dependencies` 为 `undefined` → `?? {}` 兜住，实测 pass（未找到反例）。
- `manifest.dependencies` 为**非对象**：字符串 `"see yarn.lock"` → `Object.keys` 返回 `['0','1',...]` 共 13 个**单字符**键，
  每一个都走 `findPkg` 失败后 `continue`，**P24 报 pass 且 `examined=13`**（严重虚高，与 R4 同源）；
  数组 `['a','b']` → 同理。**未崩溃**，但 `examined` 数字完全失真。这是 R4 的一个更极端的实例。
- `bundleBare.has(depName.replace(...))` 对**非 scoped 名**：`'foo'.replace(/^@[^/]+\//,'') === 'foo'`，
  两个判断退化成同一个，**行为正确**（未找到反例）。

---

### R4（Medium）P24 pass 分支把"没落盘"的依赖算进覆盖量

**位置**：`plugin/dsh-doctor.mjs:872`

```js
      report('profile', 'P24', true, `已装且声明 dsh.bundle 的依赖均已登记进 bundles（核对 ${Object.keys(deps).length} 个依赖）`, undefined, undefined, Object.keys(deps).length, '依赖');
```

`Object.keys(deps).length` 是**依赖表里的条目总数**，不是"真正检查过的数"。循环里 `findPkg` 找不到、
`package.json` 读不出来的依赖全是 `continue`（`:857`、`:860`），**一个都没被核对**，却被计入。

```console
$ ./reproduced-all.sh   # F3
===== F3  没落盘的依赖被算作已核对（覆盖量虚高）=====
P24 status=pass examined=2 (依赖)；其中被真正读过 package.json 的依赖=0
```

项目自己的 R3 覆盖律（"我看了多少才说它没问题"）就是为这类数字立的。42 号纪律「一个事实只有一个归属」
的姊妹条：**覆盖量必须与被核对的集合同源**。这里文案说"已装且声明 dsh.bundle 的依赖均已登记"，
而 `examined` 说的是"依赖表里有几条"——两个事实被塞进了一个数字。

**为什么之前没人发现**：`report()` 的 `examined===0 → skip` 守卫（`:277`）只在**总数确实是 0** 时触发。
依赖表非空、但**一条都落不了盘**时（例如 profile 刚被 `dsh plugin` 破坏、或 `node_modules` 被删），
P24 会**带一个漂亮的大数字报 pass**。这正是本项目最痛的那类"假绿灯"。

---

### R5（Medium）P25 看不见未登记 bundle 的 patch 缺失

**位置**：`plugin/dsh-doctor.mjs:885`（`for (const b of bundles)`）

P25 的遍历集是 `bundles`。一个**不在** `bundles` 里的包，哪怕它的 `patch` 指向不存在的文件，P25 也**完全看不见**。
讽刺的是，P24 的注释（`:842-843`）恰恰用"没登记的插件对整棵检查树都是隐形的"来论证 P24 的价值，
而 **P25 自己就是那棵树上失明的一员**。

```console
$ ./reproduced-all.sh   # F7
===== F7  P25 看不到未登记 bundle 的缺失 patch =====
 ✗ [P24] 已安装但未登记进 dsh.profile.bundles ... : broken-unreg
 ✓ [P25] bundle 声明的 patch 文件均在（检查 1 个）
```

`broken-unreg` 的 `patch: "./cordis.patch.yml"` 指向的文件不存在，P25 报 **✓**。

**连带影响 P24 的 fix 文案**：P24 在 `many` 分支给的修复建议是"先备份 manifest；**若确为安装中断**：
手动把名称加入 dsh.profile.bundles，或 `dsh plugin remove` 后重新 add"。但如果那个未登记的包里
**patch 本就缺失**（#6539 形态），用户照着这两条做——手工加进 `bundles`，或 `dsh plugin add`（宿主 reconcile 会
`loadOverlayPatches` 校验，**会失败**）——**profile 会直接起不来**：`loadProfileDirectory` 里
`resolveBundleDir → bundlePatchPaths → loadOverlayPatches` 一旦抛错，该 bundle 被 push 进 `skippedBundles`
（`dsh-app-boot` profile.js），用户会看到"插件装了但没加载"却不知道原因。
**"先让 P25 判一遍"这条前置条件，文案里没有。**

---

### R6（Medium）P25 只认字符串，数组形态的 `patch` 直接 skip

**位置**：`plugin/dsh-doctor.mjs:888`

```js
      const rel = pkg25?.dsh?.bundle?.patch;
      if (typeof rel !== 'string' || !rel) continue;     // ← 数组被静默跳过
```

**宿主实际支持数组**（`/Applications/DeepSeek Harness.app/.../app.asar` 内 `dsh-app-boot` 的 `bundlePatchFiles()`）：

```js
function bundlePatchFiles(bundle) {
const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
return declared;
```

且 `loadProfileDirectory` 对它 `flatMap(loadOverlayPatches)` —— **列表里任何一个缺失都会 ENOENT**。

```console
$ ./reproduced-all.sh   # F5
===== F5  P25 对 patch 数组视而不见 =====
 ✓ [P24] 已装且声明 dsh.bundle 的依赖均已登记进 bundles（核对 1 个依赖）
 ⊖ [P25] 无 bundle 声明 patch 文件——无对象可查，跳过
```

`patch: ["./cordis.patch.yml", "./extra.patch.yml"]`，第二个文件不存在 → P25 **⊖ 跳过**，
而且跳过的理由是"**无 bundle 声明 patch 文件**"，这句话是**错的**（有声明，是数组）。
项目对"跳过"的定义是"不适用而非通过"，这里连"不适用"都不成立——是**采集没覆盖到**。

**最坏形态**：`patch: "./cordis.patch.yml"`（字符串、文件在）与 `patch: ["./cordis.patch.yml"]`（数组、文件在）
在宿主里**完全等价**，但 P25 对前者报 ✓、对后者报 ⊖。**同一事实两个答案**。

---

### R7（Low）P25 用 `existsSync` 判"文件在"，目录也返回 true

**位置**：`plugin/dsh-doctor.mjs:890`

```js
      if (!existsSync(join(d25, rel))) missing25.push(`${b} → ${rel}`);
```

`existsSync` 对**目录**返回 true。而宿主 `loadOverlayPatches` 是 `readFileSync(file, "utf8")`，
对目录会抛 `EISDIR`（不是 ENOENT，但同样让 `loadProfileDirectory` 把这个 bundle 推进 `skippedBundles`）。

```console
$ ./reproduced-all.sh   # F6
===== F6  P25 把'目录'当文件存在 =====
 ✓ [P25] bundle 声明的 patch 文件均在（检查 1 个）
```

**构造**：`node_modules/dir-bundle/cordis.patch.yml/` 是个**目录**。P25 报 ✓。

**为什么还会发生**：打包工具把 `cordis.patch.yml` 当目录（例如 `files` 里写成了 `cordis.patch.yml/`）、
或 `.npmignore` 覆盖顺序出错时，这是现实可发生的形态；而 #6539 的 dsh-cad 正是"打包漏文件"这一类。

**修法一行**：`statSync(p, { throwIfNoEntry: false })?.isFile()`。注意 `existsSync` 在别处（P1 等）也被这么用，
**这属同一类既有瑕疵**，只是 P25 把它抬到了"决定 fail/pass"的位置。

---

## ② 任务书点名、但我**没能**证明的反例（逐条否证过程）

任务书列了整整一串"已知能想到的形态"，我逐个造出来跑过。下列形态**未找到反例**，写明我做了什么、为什么没证出来：

| 形态 | 我的构造 | 结果 | 否证/保留原因 |
|---|---|---|---|
| **workspace/monorepo 里未被依赖的工作区包** | `dependencies` 里没有它、只有 `packages/*` 目录 | 循环只遍历 `Object.keys(deps)`，**不进循环** → 不可能报 | 结构上免疫，非反例 |
| **`optionalDependencies`** | `optionalDependencies: { 'opt-bundle': '1.0.0' }`，包在 `node_modules` 里且有 `dsh.bundle` | **P24 pass** | 被测代码只合并 `dependencies` + `devDependencies`。**这既是"不误报"也是"漏报面"**：若宿主 reconcile 真的会登记 optional 依赖，那它属于漏报；但我没找到宿主对 optionalDependencies 的自动登记路径，故只记录、不判反例 |
| **`peerDependencies`** | 同上，放 `peerDependencies` | **pass** | 不进遍历集，结构上免疫 |
| **只声明 `dsh.client` 不声明 `dsh.bundle`** | `{dsh:{client:{...}}}` | **pass**（`:861` `if (!depPkg?.dsh?.bundle?.patch) continue;`） | 判据正确，**未找到反例** |
| **`bundles` 用完全不同的名字（别名）** | `bundles:['alias-name']` + `dependencies:{'real-bundle'}`，`findPkg('alias-name')` 解析不到 | **P24 fail**（报 `real-bundle`） | **疑似误报但未坐实**：我没有证据表明 DSH 允许"别名登记"（`reconcile` 里 `bundles.includes(name)` 是**全名**，别名只会被 `previous.filter` 里的 `bundleNames.has(name)` 判掉）。若宿主确实不支持别名，那 fail 是对的。**不作为反例** |
| **`findPkg` 找不到包** | 依赖声明了但 `node_modules` 里没有 | `continue` → 不报 | 判据正确（但覆盖量因此虚高，见 R4） |
| **`devDependencies` 里的包** | 见 R2 | **fail** | **已证为误报 → R2** |
| **`dsh.bundle.patch` 指向目录** | 见 R7 | **pass（错）** | **已证 → R7** |
| **包在 `node_modules/.pnpm` 里只有软链** | `node_modules/linked-bundle -> _shared/linked-bundle`（`link:` 依赖形态） | **P25 pass 正确**（`join` 穿软链、`existsSync` 跟随），**P24 也正确** | `findPkg` 用 `existsSync(join(c,'package.json'))`，天然跟随软链。**未找到反例** |
| **`manifest.dependencies` 为 undefined** | `dependencies` 键不存在 | pass（`?? {}` 兜底） | **未找到反例** |
| **`manifest.dependencies` 为非对象** | `"see yarn.lock"`（字符串）/ `['a','b']`（数组） | 不崩溃，但 `examined` 变成 13 / 2 这类虚高数字 | 归入 R4 |
| **subpath exports（`patch` 指向 exports 子路径）** | 见 §③ R8 | fail | **未能判定**，见下 |

---

## ③ 关于 R8（`exports` 子路径）：我**没有**证成误判，这里只记录证据

**构造**：包 `exp-bundle` 的 `package.json` 里
```json
{"exports": {"./patch": "./dist/patch.yml"}, "dsh": {"bundle": {"patch": "exp-bundle/patch"}}}
```
**实测**：`✗ [P25] bundle 声明的 patch 文件不存在 ... : exp-bundle → exp-bundle/patch`

**为什么我不敢判它是误报**：宿主的 `bundlePatchPaths(packageDir, bundle)` 做的是
```js
bundlePatchFiles(bundle).map((file) => join(packageDir, file))
```
—— 就是一个**裸 `join`**，包内相对路径语义。它**不做 `exports` 解析**。
所以宿主对 `"exp-bundle/patch"` 也会 `join` 出一个不存在的路径 → ENOENT → 与 P25 的结论一致。

反过来说，如果 `patch` 写成了某种宿主支持而 P25 不支持的形态，P25 才会误报——而我在 `bundlePatchPaths`
里**没找到任何非 `join` 的解析分支**。因此 **R8 不是反例**，只是"P25 的解析口径恰好与宿主一致"的证据。

> 记录这条，是因为任务书点名要查。**"未找到"也是个结论**。

---

## ④ 真机复核：P24/P25 在本机真实 profile 上**零误报**（且不是"检查没生效"）

任务是"拿真实 profile 复核，确认这是对的，而不是检查其实没生效"。我做了**三件事**：

**(1) 直接跑**：
```console
$ DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --profile web --no-catalog
 ✓ [P24] 已装且声明 dsh.bundle 的依赖均已登记进 bundles（核对 16 个依赖）
 ✓ [P25] bundle 声明的 patch 文件均在（检查 13 个）
```
```console
$ DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --profile daily --no-catalog
 ✓ [P24] 已装且声明 dsh.bundle 的依赖均已登记进 bundles（核对 7 个依赖）
 ✓ [P25] bundle 声明的 patch 文件均在（检查 7 个）
```

**(2) 不信输出，自己用独立脚本重算**（不复用被测代码）：
```
deps count: 16 → 逐个核对
未登记且声明 dsh.bundle 的依赖：无
@local/dsh-emoji-picker      hit=false hasPatch=false  ← 用户 patch 包，本就不该登记
@local/dsh-ui-customizer     hit=false hasPatch=false  ← 同上
@zseven-w/dsh-noema-darwin-arm64 hit=false hasPatch=false  ← 平台二进制依赖
其余 13 个：hit=true hasPatch=true
```
→ **16 = 13 个已登记的 bundle 依赖 + 3 个不声明 `dsh.bundle` 的普通依赖**。**零误报成立，且这个 16 是实数不是占位。**

**(3) 反向验证"检查确实在跑"**：去掉检测（整段 `P24/P25` 删掉后全套 257 项仍有 256 过），
只说明现有用例没守住它的**边界**；但 §① 的 F1~F8 用同一个 CLI 二进制都**能**被它判 fail，
证明判定路径**确实生效**。覆盖量的单位也对得上（P24 报"依赖"、P25 报"bundle patch"，两者数量不同 16 vs 13，说明不是同一个占位数字）。

**覆盖量自洽性交叉验证**：P25 报"检查 13 个"，正好等于 13 个声明 `dsh.bundle.patch` 的已登记 bundle —— 与 P24 的明细表完全吻合。

---

## ⑤ 回归考古：新检查有没有污染别的 fixture（实跑全套）

### (a) 全套测试

```console
$ node --test plugin/test/*.mjs
ℹ tests 257
ℹ pass 256
ℹ fail 0
ℹ skipped 1
```
—— **未找到反例**：新增的 fail 没有污染任何 `assertIsolated` 用例。

### (b) 删除整段 P24/P25（在 `/tmp` 副本上）

```console
$ python3 → 去掉 3675 字符（P24+P25 两个块）
$ node --test plugin/test/*.mjs
✖ R5：docs/check-inventory.md 与代码一致（…）
✖ P24：依赖里装了、声明了 dsh.bundle、但不在 bundles 里 → 失败
✖ P24 反向：普通依赖（不声明 dsh.bundle）不得被报
✖ P24 反向：scoped 包用裸名登记也须认
✖ P25：bundle 声明了 patch 但文件不存在 → 失败
✖ P25 反向：patch 文件在位 → 通过
ℹ pass 250  fail 6
```
—— 只有**新增的 5 条 + 清单一致性**变红，**没有**任何既有用例变红。说明新检查确实**没有**污染别处，
`assertIsolated` 那条纪律在本轮守住了。

> 但注意 CHANGELOG 的说法是"禁用检测后恰好 **2 条**正向用例变红"。实测是 **5 条新用例全红**（其中 2 条是正向用例，3 条是反向/锚点）。
> 这句话**字面不准确**——"2 条正向用例"可能指的是"正向用例有 2 条"，而另外 3 条是反向用例。**属表述含糊，不列反例**。

### (c) `bash scripts/audit.sh`

```console
$ bash scripts/audit.sh
  ✓ boot-check 零对象未谎报通过
  ✓ JSON: ok=true 蕴含 verified>0
  ✓ 全跳过时未说「全部通过」
  ✓ 带 BOM 时 P15 仍报出（故障隔离）
  ⊘ manifest 无法解析时 profile 段只剩 2 条（**已知缺口 D2：R4 隔离律未落地**）
  ✓ 论坛病例 12/12
  ✓ 检查清单与代码一致
  ✓ 全套测试通过
审计结果：通过 7 项，失败 0 项，已知缺口 1 项
```

### (d) `docs/check-inventory.md` 与代码一致

```console
$ node scripts/gen-check-inventory.mjs | diff - docs/check-inventory.md
inventory: IDENTICAL
```
—— 52 → 54 项，P24/P25 都在清单里，**未找到反例**。
（顺带发现清单里 `P25` 的 `source` 列是 `#6539 #6539` —— 重复了，生成器去重没做。**Low，纯观感**。）

### (e) 变异测试：新用例的"守门强度"

| 变异 | 是否被杀 | 说明 |
|---|---|---|
| M1：去掉 `if (!depDir) continue;`（把"没落盘"也报） | **存活**（257 项全绿） | 与 R4 同源：没有用例约束"没落盘不该被报" |
| M2：`const many = true`（强制走降级分支） | **存活** | R1 的直接证据：降级分支没有任何可观测差异 |
| M3：P24 跳过 `installAnchor`（只查 profile `node_modules`） | **存活** | `runCli` 继承 `process.env`，但我的 PATH 里没有 `*/node_modules/.bin`，**本机 `installAnchor` 恒为 `null`** → 测试环境压根走不到那条分支。这是**测试环境与真机不一致**导致的覆盖盲区（真机注释 `:826` 还专门讨论过"web GUI/无锚点"） |

> 注：M3 的"存活"也可能是因为测试 fixture 里 `bundles` 都不含宿主安装自带的包，所以这条分支对判定无影响。
> 但**至少说明**：`installAnchor` 有值时的行为**零测试覆盖**。

### (f) `node scripts/mutation-test.mjs`（既有变异集）

```console
变异测试：9 个变异 —— 杀死 8，**存活 0**，等价（已记录）1
```
—— 既有变异集不含 P24/P25，这本身不是缺陷；但意味着"新增检查有没有牙齿"完全靠新增的 5 条用例，而它们没守住 §⑤-e 那三个边界。

---

## ⑥ 与既有检查的重复性（"一个事实只有一个归属"）

| 既有检查 | 它查的事实 | 与 P24/P25 的关系 | 结论 |
|---|---|---|---|
| **P1**（`bundles` → 可解析） | 方向：`bundles → 包`。判"能解析"+"声明了 `dsh.bundle`" | P24 是**反方向**（`依赖 → bundles`）；P25 是 P1 同一事实的**更细一层**（"声明了" vs "声明指向的文件在"） | P24 **不重复**；P25 与 P1 **是同一事实的两个精度**，但 P1 的 detail 写的是"存但未声明 dsh.bundle"，P25 写的是"声明了但文件不在"——**事实可区分，可接受**。⚠️ 但 P1 报 fail 时**同时**会触发 P25 的"✓ 检查 1 个"（因为我造的那个 P1 fixture 里包存在且 patch 声明位置对）—— 两条同时绿的场景需要核对 |
| **P3**（用户 patch insert name 可解析） | 用户 `cordis.patch.yml` 里的 entry name | 无关 | 不重复 |
| **P15**（BOM） | 关键文件 BOM | 无关 | 不重复。**P0 改指 P15 这件事我复核了**：`plugin/dsh-doctor.mjs:744` 注释、`:748` 文案、`:3188` 注释都已改指 P15，`:2437` 的 `catalogSeverity.set('P22','error')` 死代码已删。`grep -rn P22` 剩余命中全部是 CHANGELOG/docs 的历史记录与 `:1195` 的"P22 已撤销"注释 —— **正确** |
| **`installed_bundle`**（profile bundle 版本 vs 运行 CLI 版本） | 版本一致性 | 无关 | 不重复 |
| **P23 / P19 / P20 / P21** | 以 `bundles` / `listProfilePackages` 为遍历集 | P24 让这些检查**看得见**未登记插件（这正是 P24 的价值论证），但**当前代码没有真的让它们看见**——P24 只是"报告"，没有把未登记插件并入遍历集 | **P24 的价值论证成立，落地不完整**（见 R5 同源问题） |

**值得记录的一条同源重复**：`bundlesMissingManifest()`（`:3055`）在 `--boot-check` 路径里查"`bundles` 里的包没声明 `dsh.bundle`"，
与 P1 的第二个分支（`:832`）**查的是同一事实**，只是入口不同。这不是本轮引入的，但与本轮 P24/P25 的"反方向/细一层"对比，
说明项目在"同一事实几条检查"上的边界**确实需要继续收紧**。

---

## ⑦ 自证：我跑了什么、结果如何

**环境**：`/Users/waterfly/dsh工作区/dsh-doctor` @ `3539c1c`（0.8.11），DSH home `/Users/waterfly/.dsh`，node v24.20.0。
**写入**：生产仓库只写了 `docs/redteam-0.8.11.md` 这一个文件。所有试反例都在 `/tmp/rt/repo`（`cp -R` 副本）与 `mktemp -d` fixture 上。

| # | 命令 | 结果 |
|---|---|---|
| 1 | `git status` / `git log --oneline -8` / `git show HEAD --stat` | 工作区 **clean**（与任务书描述不符，已在开头说明）；0.8.11 = `3539c1c`，HEAD 实际是 `86a9edf` |
| 2 | `DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --profile web --no-catalog` | P24 ✓（16 依赖）/ P25 ✓（13 bundle）；P5 ✗（既存问题，非本轮） |
| 3 | `DSH_HOME=/Users/waterfly/.dsh node plugin/dsh-doctor.mjs --profile daily --no-catalog` | P24 ✓（7）/ P25 ✓（7）；0 个内置问题 |
| 4 | 独立脚本重算真实 profile 的 P24 三条件 | 16 = 13 已登记 + 3 无 `dsh.bundle`；**零误报成立** |
| 5 | `node --test plugin/test/*.mjs`（生产仓库） | 257 tests / 256 pass / 1 skip / **0 fail** |
| 6 | `bash scripts/audit.sh` | 通过 7 / 失败 0 / 已知缺口 1 |
| 7 | `node scripts/gen-check-inventory.mjs \| diff - docs/check-inventory.md` | IDENTICAL |
| 8 | `node scripts/mutation-test.mjs` | 9 变异 / 杀 8 / 存活 0 / 等价 1 |
| 9 | `/tmp/rt/reproduced-all.sh`（F1~F8，8 条反例） | F1/F2/F3/F4/F5/F6/F7/F8 全部复现 |
| 10 | `/tmp/rt/probe1..24.mjs`（形态探针：optional/peer/dev/file:/软链/非对象 deps/exports/数组/目录/未登记 patch/真机可选 bundle…） | 逐条见 §② 表格 |
| 11 | `/tmp/rt/repo` 上删掉 P24+P25 整段 → `node --test` | 恰 6 红（5 新用例 + 清单一致性），**既有用例零变红** |
| 12 | `/tmp/rt/mutplug/dsh-doctor.mjs` 三组变异（见 §⑤-e） | M1 存活 / M2 存活 / M3 存活 |
| 13 | 对照实验：`git show HEAD~1:plugin/dsh-doctor.mjs` 跑同一 fixture | 0.8.11 与 0.8.10 在畸形 `bundles` 上都报同一条 `P0 检查异常` —— **该崩溃是 0.8.10 就有的，不是本轮引入**（我最初怀疑是本轮引入，被自己否掉了） |
| 14 | 宿主源码比对（`/Applications/DeepSeek Harness.app/.../app.asar`、`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh*`） | `bundlePatchFiles`/`bundlePatchPaths`/`resolveBundleDir`/`loadProfileDirectory`/`reconcile` 逐段读过，用于 R3/R6/R7/R8 的归因 |

**我否掉的自己的三条怀疑**（写下来是因为"证不出来就写未找到"是纪律的一部分）：
1. 以为 0.8.11 引入了畸形 `bundles` 的崩溃 → 对照 0.8.10 后否掉。
2. 以为 `devDependencies` 里的宿主安装自带 bundle 会被误报 → 实测 pass（`findPkg` 走 `installAnchor` 能解析到宿主安装），否掉。
3. 以为 `patch` 写 `exports` 子路径是 P25 误报 → 比对宿主 `bundlePatchPaths`（裸 `join`）后，两者口径一致，**不判反例**，只记录证据。

---

## ⑧ 建议的最小修复集（仅供 Lead 决策，我没有改任何代码）

| 优先级 | 项 | 一行修法 |
|---|---|---|
| P0 | R1 降级死代码 | 二选一：**删掉** `many` 分支 + CHANGELOG 那句话（诚实契约），或让 `report` 支持逐条 severity。**不要**把 P24 加进 `catalogSeverity`（那会把 1 个命中一起降级） |
| P1 | R2 devDependencies | ① 去掉 `devDependencies`；或 ② 把它单独收集，命中时只出 warn 且文案写"可选加载（devDependency）" |
| P1 | R3 裸名 | 删掉 `:856` 后半句（`bundleBare.has(depName.replace(...))`）。前半句 `bundleBare.has(depName)` 已经覆盖"bundles 写裸名、依赖是 scoped 名"这个**唯一**可能的兼容需求，且**不会**造成 F2 那种遮蔽 |
| P1 | R6 patch 数组 | `const rels = typeof rel === 'string' ? [rel] : Array.isArray(rel) ? rel.filter(x=>typeof x==='string') : [];`，再逐条判 |
| P2 | R4 覆盖量 | 用实际核对过的计数（`checked++` 放在 `try { parse }` 之后） |
| P2 | R5 P25 视野 | 遍历集改为 `bundles ∪ 已装且声明 bundle 的依赖`；至少在 P24 的 fix 文案里加一句"先确认该包的 patch 文件存在（P25）" |
| P3 | R7 目录 | `existsSync` → `statSync(p,{throwIfNoEntry:false})?.isFile()` |
| P3 | 清单 | `gen-check-inventory.mjs` 的 `source` 列去重（`#6539 #6539`） |

---

## 附：给下一轮的两条方法论备注

1. **"降级"这类改动必须有"判定会变"的用例**。R1 之所以能活到发布，是因为新增的 5 条用例**没有一条**覆盖"≥3 个命中"，
   而 `many` 分支只影响 detail 文字——**文字断言是最弱的一种断言**。变异测试（`many = true` 存活）一眼就能抓到这种"假实现"，
   建议把 P24/P25 加进 `scripts/mutation-test.mjs` 的变异集。
2. **"遍历集"是这类检查的隐藏设计决策**。P24 的整套价值论证建立在"没登记 = 对整棵树隐形"上，
   但 P25（以及 P19/P20/P21/P23）**自己就是那棵树上失明的一员**。下一轮同类检查立项时，第一个要问的问题应该是
   "**我的遍历集从哪里来，它本身是否已经漏掉了我要找的东西**"。

---

# 附录：修复记录（Lead 在收到本档案后所做的处置）

| 编号 | 处置 | 证据 |
|---|---|---|
| **R1**（High，降级是死代码） | **不降级**，改为在 detail 里追加"可能是 #9753 恢复重置"的提示；代码注释写明"`report()` 无 severity 参数、`catalogSeverity` 是按 id 全局降级会更坏"。 | 实测 3 个命中仍 fail + exit 1；注释与 CHANGELOG 已改为"追加提示"而非"降为 warn"。 |
| **R2**（devDependencies 误报） | 只遍历 `dependencies`。 | 新增用例「devDependencies 里的 bundle 包 → 不得误报」；变异 M2 被杀。 |
| **R3**（裸名归一化双向失真） | **删掉裸名比对**，改为与宿主一致的 `bundles.includes(depName)` 全名匹配。已核 `dsh-app-boot/lib/index.js:1217/1176/1223`。 | 原用例（断言裸名可脱罪）**本身是错的**，已改写为断言"裸名 ≠ 全名，必须 fail"。 |
| **R4**（examined 虚高） | 改为只数真的读到 manifest 的包；一个都没读到时 `reportSkip`。 | 新增用例「依赖全都没落盘 → skip 而非 pass」。 |
| **R5**（P25 看不见未登记的 bundle） | P25 遍历集并入 P24 收集到的 `withPatch24`。 | 新增用例「未登记 bundle 的 patch 缺失也要被看见」。 |
| **R6**（数组形态被 skip） | 支持数组（宿主 `bundlePatchFiles()` 接受数组）。 | 新增用例「patch 写成数组 → 逐个检查」；变异 M6 被杀。 |
| **R7**（目录被当文件） | 改用 `statSync(...).isFile()`。 | 新增用例「patch 路径是目录 → fail」；变异 M7 被杀。 |
| **M1**（`if (!depDir) continue` 变异存活） | **不再假装有守卫**：`findPkg` 返回 null 时后续 `join(null,…)` 抛错被 catch，行为等价 —— 该行不可被测试区分。已在代码里如实标注"保留它是可读性，不是守卫"。 | 变异 M1 仍存活，且**这是正确的结论**，不是用例不足。 |
| **P1 在 installAnchor 有值时对宿主自带 `@deepseek-ai/dsh-base` 报 fail** | 非本轮引入，未修；已记入本档"已知问题"。 | — |
| 清单里 P25 的 source 显示 `#6539 #6539` | 生成器未去重，低优先级，未修。 | — |

**修复期间的回归**：新增检查第一次落地时，`withPatch24` 被声明在块作用域内导致 P25 访问不到，
profile 段整体崩成 `P0 检查异常`，**8 条语料用例同时变红**。这正是本仓库"故障隔离"纪律要防的形态——
一条检查的改动不得让别的用例变红。修复方式：把变量提到块外，并在注释里记录这次踩坑。

**最终自证**：全套 **263 tests / 262 pass / 0 fail / 1 skip**；变异 M2/M6/M7 均被新用例杀死；
`bash scripts/audit.sh` 7 项通过 0 失败；清单与代码一致。
