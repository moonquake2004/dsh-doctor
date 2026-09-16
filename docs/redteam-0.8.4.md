# 红队审计档案 · 0.8.4 增量（P23 / 语料 / 变异 / 闸门）

**范围**：本版本只改三处（新增检查 `P23`、新增语料 2 条、新增变异条目 1 条），故红队只攻这三处及其周边。
**审计者**：fresh-context 子代理（只读、只许证伪、不共享作者上下文），实验在 `/tmp` 副本内进行。
**一个重要前提**：审计期间仓库被作者并发修改，红队按测量时刻标注结论（见其报告）。

**结果：7 条真反例。核心是同一个病——P23 判的是"代理"（manifest 里有没有那个键），不是"条件"（第二份副本是否真的存在）。**

---

## ① 真反例与处置

| # | 反例 | 严重度 | 处置 |
|---|---|---|---|
| **F1** | **P23 对"副本已实际存在"完全失明**：bundle manifest 不写 `dependencies`，但磁盘上已有 `bundle/node_modules/@deepseek-ai/dsh-scope/` → P23 **pass**、P3 pass、P5 pass —— **#6789 的失败状态就摆在盘上，全库零检查命中** | 高 | **已修**：判据从"manifest 有没有键"改为**扫 bundle 自己的 `node_modules/@deepseek-ai/*`**（判条件本身）。语料新增 `host-copy-on-disk-without-manifest-key` |
| **F2** | `optionalDependencies` 漏报（npm/pnpm 默认安装，后果与 #6789 同构） | 高 | **已修**：依赖声明同时扫 `dependencies` 与 `optionalDependencies`；语料新增该例 |
| **F3** | 别名漏报：`"scope-copy": "npm:@deepseek-ai/dsh-scope@0.1.6"`（键名不含 `@deepseek-ai/` → 旧判据直接放行） | 中高 | **已修**：解析 `npm:` 别名里的目标名；语料新增该例 |
| **F4** | **解析根不对称**：bundle 装在 `~/.dsh/profiles/node_modules`（父层，本机 `dsh-base`/`dsh-web-app` 就是）时 `existsSync(join(dir,'node_modules',b,'package.json'))` 为假 → `continue` → **整条检查 skip**，P1 也不报 | 中 | **已修**：解析根与 `resolveHostVersion` 一致（profile nm + 父层两根） |
| **F5** | **误报**：同 scope 的另一**插件**作为依赖（唯一正确写法）被判为"宿主机包"；且厂商核心 bundle 自身把 80+ 个 `@deepseek-ai/*` 写成普通 dependencies | 中 | **已修**：判定改为**内容判据** —— 读副本自己的 manifest，带 `dsh.bundle`/`dsh.client` 的是插件（放行），不带的才是宿主库；另排除本身就是 bundle 的名字。语料新增 `plugin-depends-on-plugin-control`（期望 pass） |
| **F6** | 扫描面 ≠ 真正被加载的插件集：仅由用户 patch `insert` 加载的插件不被扫；未排除 `_quarantined` | 低 | **部分修**：已排除 `_quarantined`；"用户 patch 加载的插件"仍在扫描面之外 → 记入 §5 待决策 **D8** |
| **F7** | `scanned23++` 发生在 manifest 解析**之前** → manifest 不可读时 `examined` 多算 1 | 低 | **已修**：改为解析成功后再计数（`readPkg` + 存在性判定） |

### 红队同时指出的**机制层面**问题（比反例更重要）

1. **变异 kill 只有一个判官**：把语料里那条期望从 `fail` 改成 `pass`，未变异的代码就会让用例红 →
   变异测试记成"基线未通过 → 跳过（inconclusive）"而**不是存活**。即"改一行期望即可把 kill 静默降级为 skip"。
   → **已知弱点**，记入 §5 **D9**（修法：kill 需要第二个独立判官，例如另有一条断言直接钉住检出行为）。
2. **变异条目 id 与简报不一致**（简报写 `P23-host-dep-dep`，实际 `P23-host-dep-detection`）——**作者写简报时凭记忆**，
   又是一次 W1 违规。已按实际 id 更新条目与简报表述。
3. **闸门在编辑窗口中的表现**：红队首轮撞上"P23 已落地但 `docs/check-inventory.md` 未同步"的窗口 → 闸门红 3 项
   （含 R5 清单不一致）——**反过来说明闸门真的在守**。

### 判据为什么改了三版（值得留档）

| 版本 | 判据 | 被哪条反例打死 |
|---|---|---|
| v1 | manifest 键名里有 `@deepseek-ai/*` | F1（副本在盘上但没写键）、F2、F3、F5 |
| v2 | 用 CLI 安装树（`installAnchor`）判定"宿主是否提供" | **实测本机 `installAnchor` 也是 null** → 永远判不出宿主包（静默失效） |
| v3（现行） | **判条件**：扫 bundle 内 `node_modules/@deepseek-ai/*`；用**副本自身 manifest 的 `dsh.bundle`/`dsh.client`** 区分"插件 vs 宿主库" | 通过 F1–F5 全部变体实测 |

**v1→v3 的过程本身就是这一轮最大的教训**：判"代理"会同时产生漏报与误报；只有判**条件本身**、并用**内容**（而不是名字前缀或路径锚点）作区分，才两个方向都站得住。

---

## ② 已覆盖（红队试过并确认成立）

- **skip 语义正确**：0 个可解析 bundle → `status=skip`、`coverage=none`，不伪报 pass。
- **误报对照有效**：`peerDependencies` 写法的插件 → P23 pass。
- **变异打点唯一且正确**：旧判据字面量在源码中只出现 1 次；新判据（`if (!isPluginPkg(nmf)) {`）同样唯一。
- **闸门**：当前唯一失败项 = 缺本档案（"不许发布"），理由合理。

## ③ 未能验证（如实保留）

1. F5 的"厂商核心 bundle 被误判"：本机 `dsh-base`/`dsh-web-app` 落在父层，故真实布局下走的是 F4 的修复路径（已修）；
   要证实"误判"需要另一种布局，**未构造**。
2. `overrides`/`resolutions`/`bundledDependencies`：红队实测 pass，并判定为**非真漏报**（npm 只认根 overrides、
   `resolutions` 属 Yarn），但**该判定是推理、未跑包管理器验证**。
3. F7 的"多算"只在新版修复后被逻辑消除，未在旧版上实测到该分支（坏 manifest 会让 profile 段整体异常 → 已知缺口 D2）。

## ④ 待决策（已记入 `docs/check-authoring-rules.md` §5）

- **D8**：P23 的扫描面不含"仅由用户 patch insert 加载的插件"（它们同样会被加载）。
- **D9**：变异 kill 的单判官问题（改一行语料期望即可把 kill 降级为 skip）。
