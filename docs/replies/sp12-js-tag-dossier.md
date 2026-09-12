# SP12 取证档案 — 两个第三方插件的 `!!js` 配置即代码

Status: **DRAFT / 内部取证材料**（未发布任何 GitHub 内容；作者沟通草稿见 §5，需 owner 逐条批准后才可发出）

调查范围：只读。所有结论均标注了可复核的源码位置或实测命令。
被测宿主：`@deepseek-ai/dsh@0.1.5-rc.1`（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`），Node v24.20.0。

---

## 0. 结论速览

| | `@tt-a1i/archify-dsh` | `dsh-better-sidebar` |
|---|---|---|
| 版本（已装） | 0.1.0 | 0.18.1 |
| npm `latest` | 0.1.0（相同） | **0.19.1（有更新）** |
| patch sha256 | `9d9f68e3caf27847ff0837dca0d1df95e2cecc5c98de901b13e7b2b2746e07ba` | `d363acad7f1521559194a3e04de06fe68974b4a7b1ad3cc74db54bca63c4248b` |
| `!!js` 处数 | 1 处（第 10 行，生效） | 1 处生效（第 49 行）+ 1 处仅注释提及（第 36 行） |
| 表达式实际行为 | 纯路径拼接，读包自身 `package.json` 的解析结果 | 纯内存反射，遍历 loader 条目列表求布尔值 |
| 副作用（fs 写 / 网络 / env） | **无** | **无** |
| 威胁判定 | 按现状**良性**；风险在"未来版本可改" | 按现状**良性**；风险同上 |
| 是否存在无 `!!js` 的等价实现 | **存在**（作者自己的 `lib/index.js` 里已有等价函数） | 静态配置**无法**表达该跨条目条件；只在用户侧"知道自己在干什么"时可手工替代 |
| 建议 | **pin 到 0.1.0（作者 README 本就要求精确版本）+ 用 profile 静态覆盖彻底消掉求值**；并建议向作者提 issue（草稿 §5.1） | **按现状接受 + 加注释**；若要零求值需用 `disabled: false` 覆盖（会放弃聚合守卫）；pin 0.18.1 兜底 |
| 作者沟通草稿 | 已起草（§5.1，英文，建议发） | 已起草（§5.2，中文，可选/弱建议） |

**给 owner 的一条关键补充事实**：SP12 报的是 `web` profile，但**当前 3080 端口的实时宿主跑的是 `dsh --profile daily`**（PID 17538）。`daily` 也装了这两个插件、patch 文件 sha256 与 `web` **逐字节相同**，因此两个 profile 都真实受影响，`daily` 是"现在就在被加载"的那一个。

---

## 1. 机制：宿主到底怎么求值 `!!js`（全部已读源码 + 实测）

### 1.1 YAML 标签注册

`dsh-app-boot/lib/index.js:17-23`（同一份定义也复制在 `cordis-plugin-include/lib/index.js:17-23`）：

```js
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data["__jsExpr"]
});
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
```

`!!js` 标量在解析期**不求值**，只被包成 `{ __jsExpr: "<源码字符串>" }`。`dsh --dump-config` 用同一 schema，所以它**只打印不求值**（`dsh-app-boot/lib/index.js:1213` 注释 + `renderConfigDump` 只调 `applyEntryPatches`）——这是一个安全的审计入口。

### 1.2 求值器本体

`cordis-plugin-loader/lib/index.js:289-293`：

```js
/** Evaluate a JavaScript expression against a loader context scope. */
const evaluate = new Function("ctx", "expr", `
  with (ctx) {
    return eval(expr)
  }
`);
```

即 `with (loader-entry-context) { return eval(<表达式>) }`。`new Function` 的函数体在**全局作用域**下执行，所以 `process`、`fetch`、`globalThis` 全部可见；`with (ctx)` 又把该条目的 loader context（含 `baseUrl`、`loader`、以及挂在该 ctx 上的宿主服务）暴露为裸标识符。

### 1.3 什么时候被调用

两条路径，都在 **boot 期、宿主进程内**：

1. **`config` 字段**：`cordis-plugin-loader/lib/index.js:295-301` 的 `interpolate()` 递归替换（`internal/config` hook，`:697` 附近注册）→ archify 走这条。
2. **`disabled` 字段**：`Entry.disabledOf()`（`:377-379`）
   ```js
   disabledOf(options) {
     return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.__jsExpr)) : Boolean(options.disabled);
   }
   ```
   → better-sidebar 走这条。

### 1.4 实测：表达式在这个宿主里能碰到什么

用**宿主自己的 `evaluate` 导出**（`@deepseek-ai/cordis-plugin-loader`）做只读探针（只取 `typeof` / `Object.keys().length`，未执行任何有副作用的动作）：

```
global process reachable         => object
env reachable (count only)       => 37          // process.env 可枚举
node:fs reachable                => function    // readFileSync
node:child_process reachable     => function    // execSync
fetch reachable                  => function
require-via-module reachable     => function
isJsExpr({__jsExpr:'1'})         => true
```

结论：`!!js` 是一个**完整的、宿主进程内的任意代码执行面**，且**不在** dsh 的 bash/fs 沙箱与审批链路之内（沙箱只约束工具调用）。这与 SP12 的定级（CRITICAL、`#454/#587/#3354`）一致。

### 1.5 补一个 SP12 之外的事实（影响"改完还报不报"）

`dsh-security/src/checks/sp12-config-as-code-tag.mjs` 是**静态文本扫描**（`collectPatchLayers()` → 逐行正则 `!!js\b`，见 `sp11-patch-security-override.mjs:27-53`）。因此：**即使我们用自己的 patch 层把 `!!js` 覆盖掉、让它永不求值，SP12 仍会继续报错**，因为 bundle 文件本身没变。这点在决定"要不要容忍"时必须先接受。

---

## 2. 影响面

- `~/.dsh/profiles/daily`（**实时宿主**，PID 17538 监听 127.0.0.1:3080）：装了这两个包，`daily/node_modules/.../cordis.patch.yml` 与 web 的 sha256 完全相同；profile package.json 是**精确版本** `"@tt-a1i/archify-dsh": "0.1.0"`、`"dsh-better-sidebar": "0.18.1"`。
- `~/.dsh/profiles/web`（实验田）：同样两个包，但声明为 **`^0.1.0` / `^0.18.1`**（允许漂移）。
- 两个 profile 的 `cordis.patch.yml` 用户层都**没有**覆盖这两行；`daily` 的用户层正文是 `[]`。`~/.dsh/cordis.patch.yml`（home 层）不存在。
- 两个 profile 的 node_modules 都是 `nodeLinker: hoisted` 的**真实目录**（`lstatSync().isSymbolicLink() === false`，`realpathSync()` 返回自身，`.pnpm/` 只有 `lock.yaml`）。→ **SP12 简报里"可能是 symlink，需先 realpath"的提醒在本机不成立**，已用 `realpathSync` 核对。
- 全量扫描两个 profile 的**所有**已装 bundle patch：生效中的 `!!js` **只有这两处**（其余全在注释里）。
- 两个包都**没有** `preinstall`/`postinstall` 钩子（`dsh-better-sidebar` 的 scripts 全是 build/test 类；`archify-dsh` 无 scripts）。

---

## 3. 插件 A：`@tt-a1i/archify-dsh@0.1.0`

### 3.1 精确代码（逐字，来自真实文件）

文件：`~/.dsh/profiles/{daily,web}/node_modules/@tt-a1i/archify-dsh/cordis.patch.yml`（10 行，sha256 见 §0）

全文只有**一处** `!!js`（第 10 行）：

```yaml
        bundledSkillDir: !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@tt-a1i/archify-dsh/package.json')), 'skills')
```

纯表达式部分（逐字）：

```js
process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@tt-a1i/archify-dsh/package.json')), 'skills')
```

包内其余位置（`lib/`、`skills/`、README）**无** `!!js`。

### 3.2 它算什么、为什么这么写

逐层展开：

1. `process.getBuiltinModule('node:module').createRequire(baseUrl)` — 用 profile 目录的 file URL 建一个 `require`，因为这里是 ESM 上下文、没有 `require`。
2. `.resolve('@tt-a1i/archify-dsh/package.json')` — 走 Node 的包解析（本包 `exports` 里显式导出了 `"./package.json"`），拿到**本包自己 `package.json` 的绝对路径**。
3. `dirname(...)` — 得到包根目录。
4. `join(..., 'skills')` — 得到包内 `skills/` 目录。
5. 该值赋给宿主 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir`，给这个 provider（`providerName: archify-plugin`）一个技能根目录。

**实测两个 profile 的求值结果**（用宿主自己的 `evaluate`，纯读）：

```
daily => /Users/waterfly/.dsh/profiles/daily/node_modules/@tt-a1i/archify-dsh/skills
web   => /Users/waterfly/.dsh/profiles/web/node_modules/@tt-a1i/archify-dsh/skills
```

两个路径都真实存在（`skills/archify/SKILL.md`，13036 字节）。

**用途（平实说法）**：作者想表达"把这个包里自带的 skill 目录指给宿主"，但不能写死绝对路径（那样换机器/换 profile 就废），又不能写相对 `baseUrl` 的路径拼接（注释里明说"never as a path concatenated onto baseUrl"），于是用 `!!js` 在 boot 时算一次。这是一个**路径解析便利**，不是刻意藏东西。

### 3.3 威胁评估

**按现状：良性。** 表达式只调用 `node:path` / `node:module` 的解析函数，读的是本包 `package.json` 的解析结果（解析过程会让 require 去 stat/读 node_modules 下的 `package.json`，属正常模块解析，不涉及用户数据）。没有 `process.env`、没有 `fs` 写、没有网络、没有 `child_process`。我已逐字符核对，没有隐藏的额外调用。`getBuiltinModule` 在这里只用于在 ESM 下取 builtin，不是逃避审计的技巧。

**它能够到什么（能力面，而非本表达式的行为）**：同上 §1.4 —— 一旦这段字符串被作者改成别的，它就能拿到 `process.env`（`~/.dsh` 里的凭据、各插件 API key 往往就在 env 或 `~/.dsh/credentials`）、`node:fs`、`node:child_process`、`fetch`。而它在 **boot 期、宿主进程里**执行，**不经过任何审批提示、不受 agent 沙箱限制**。

**最坏情况（作者未来版本被改 / 账号被投毒 / 上游被劫持）**：
用户在 `web` 里执行一次 `dsh plugin add @tt-a1i/archify-dsh@latest`（该 profile 是 `^0.1.0`），或在 `daily` 里手工升级，新版本的 `cordis.patch.yml` 就**自动**在下次 `dsh` 启动时执行任意代码——可读写任意文件、读 env/凭据、外联。用户几乎没有机会发现：`dsh --dump-config` 会打印这行，但没人会在每次升级后逐行读 YAML；README 目前**完全没提** patch 会执行 JS（我 grep 过 `!!js`/`cordis.patch`/`bundledSkillDir`，README 零命中）。

**不要误判的两点**（避免过度报警）：
- 这不是"作者已经在做坏事"。0.1.0 是当前 npm 上的唯一版本，行为与代码一致。
- 但"插件本身是 JS"并不能让这个风险归零：`archify-dsh` 的 `lib/index.js` **从未被 import**（bundle patch 插入的是宿主包 `@deepseek-ai/dsh-skill-filesystem`，不是 `@tt-a1i/archify-dsh`；全 profile grep 无第二处引用）。也就是说，这行 `!!js` 是**唯一**会跑的作者可控代码——它把"配置审查"变成了"代码审查"，而这正是 SP12 要拦的东西。

### 3.4 不用 `!!js` 能做到同样效果吗？

**能，而且作者自己已经写好了那份代码。** `archify-dsh/lib/index.js` 全文：

```js
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const name = 'archify-dsh';
export const PACKAGE_NAME = '@tt-a1i/archify-dsh';

export function resolveArchifySkillRoot(profileBaseUrl) {
  if (!profileBaseUrl) throw new Error('archify-dsh: missing DSH profile baseUrl for package resolution');
  let manifestPath;
  try {
    manifestPath = createRequire(profileBaseUrl).resolve(`${PACKAGE_NAME}/package.json`);
  } catch (error) {
    throw new Error(`archify-dsh: cannot resolve ${PACKAGE_NAME}/package.json from the DSH profile`, { cause: error });
  }
  return join(dirname(manifestPath), 'skills');
}
```

`resolveArchifySkillRoot()` 就是第 10 行那串表达式的等价函数。作者本可以把 `lib/index.js` 变成一个真正的 Cordis 插件（`export function apply(ctx, config)`，内部调 `resolveArchifySkillRoot(ctx.baseUrl)` 并注册 skill provider），patch 里就只剩静态 `config`——**代码照样是代码（反正插件本来就以代码形式加载），但不再需要"配置即代码"求值器**。

宿主侧是否有"静态解析包内目录"的机制？**没有。**`dsh-skill-filesystem/lib/index.js:43` 的 `bundledSkillDir: z.string()`，在 `:85` 用 `resolve(bundledSkillDir)` 解析（相对 `process.cwd()`，不稳定）；唯一的"自动"来源是 `:84` 的 `process.env.DSH_BUNDLED_SKILL_DIR`，那是宿主给自己的 bundled skills 用的，不是按包维度的。全量 grep 两个 profile 的所有 patch，也**没有第二家**用静态方式插 `dsh-skill-filesystem`/`bundledSkillDir` 的先例可抄。

**用户侧替代（我已实测有效，见 §3.5）**：在 profile 自己的 `cordis.patch.yml` 里用静态绝对路径覆盖该行。patch 语义是**整值替换**（`cordis-plugin-include/lib/index.js:98-101` `target[key] = value`，不是深合并），且用户层在所有 bundle 层**之后**应用（`dsh/lib/profile-boot-Dk-7KqJc.js:242-248`：`[bundlePatches, profile.patches, homePatches, overlays]`）。所以覆盖必须**重述 `config` 的全部键**。

### 3.5 建议 + 可执行片段

**建议（推荐组合，两层）**

1. **pin 到精确版本 `0.1.0`** —— 这不是额外收紧，而是作者 README 自己写的安装方式：*"Use the prebuilt npm package with an exact version."* / `dsh plugin --profile web add @tt-a1i/archify-dsh@0.1.0`。`daily` 已经是精确 pin；`web` 目前是 `^0.1.0`，与作者指引不符。
2. **用 profile 静态覆盖，把 `!!js` 从"会被求值的树"里彻底移除**（实测：覆盖后合成树中 `__jsExpr` 出现次数 = 0，即表达式永不执行），功能完全不变（skill 目录照旧）。

**命令**

```bash
# daily 已是 "0.1.0"；web 需要收紧（在 profile 目录内执行）
cd ~/.dsh/profiles/web
pnpm add --save-exact @tt-a1i/archify-dsh@0.1.0
# 然后（不要手改 node_modules）确认 package.json 里是 "0.1.0" 而非 "^0.1.0"
```

**要加到 `~/.dsh/profiles/web/cordis.patch.yml`（以及同样加到 `daily` 的，若想要零求值）的片段**：

```yaml
# 静态覆盖 archify 的 !!js bundledSkillDir：让 bundle 层那行永不被求值。
# 注意 patch 是「整值替换」，config 三个键都要重述；升级 archify 换版本时路径不变（仍在 profile 的 node_modules 下）。
- id: archify-skill-filesystem
  config:
    providerName: archify-plugin
    includeDefaultRoots: false
    bundledSkillDir: /Users/waterfly/.dsh/profiles/web/node_modules/@tt-a1i/archify-dsh/skills
```

（`daily` 同理，把路径换成 `.../profiles/daily/node_modules/...`。绝对路径写死在 profile 里是可接受的，因为 profile 本身就是机器绑定的；唯一维护点是"如果 profile 目录搬家，这行要跟着改"。）

> 备选的最小动作：只做第 1 步（pin），不加覆盖。理由是现状良性、覆盖会引入一个手工维护的绝对路径。若 owner 只想要"别在升级时被静默执行代码"，pin 已经覆盖了主要风险；加覆盖则额外拿到"零求值"。

**另外建议**：向作者提 issue（草稿见 §5.1）——因为这不是本机特例，而是所有 `archify-dsh` 用户共同的升级期风险，且作者手上已有 `resolveArchifySkillRoot()`，改动很小。

---

## 4. 插件 B：`dsh-better-sidebar@0.18.1`

### 4.1 精确代码（逐字）

文件：`~/.dsh/profiles/{daily,web}/node_modules/dsh-better-sidebar/cordis.patch.yml`（sha256 见 §0）

全部 `!!js` 出现（共 2 处文本命中，**只有 1 处生效**）：

- 第 49 行（**生效**）：

```yaml
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
```

- 第 36 行：仅**注释**里提到 `!!js`（"The `!!js` disabled expression backs THIS row off…"），不求值。

纯表达式部分（逐字，注意原文是**双引号包起来的字符串**）：

```js
[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)
```

包内其余位置（`src/`、`lib/`、`scripts/`、两份 README）**无** `!!js`（README 只在正文里描述了"自动退让"这个**行为**，未披露实现是 boot 期执行 JS）。

### 4.2 它算什么、为什么这么写（含 API 真实签名）

**`ctx.loader.entries()` 是什么**：`Loader extends EntryTree`（`cordis-plugin-loader/lib/index.js:668`），`EntryTree.*entries()`（`:169-176`）按插入顺序（`store = Object.create(null)`，字符串 id 保持插入序）依次 `yield` 条目对象，并递归进子 group 的 subtree。每个条目对象有：

- `.options` —— 解析出来的原始 YAML 行（`{ id, name, config, disabled, ... }`）
- `.disabled` —— **getter**，不是普通字段（`get disabled()` 在 `:360-362`，`_disabled()` 在 `:363-372`），它计算"自身或任一祖先是否 disabled"，内部会走到 `disabledOf(options)`（`:377`），也就**会求值别的条目的 `!!js` disabled 表达式**。

**谓词实际在测什么**：只要存在**另一个**条目，满足
1. `options.name === 'dsh-better-sidebar'`（即同一插件包），且
2. `options.id !== 'better-sidebar'`（不是本行自己；比如聚合包 `@linxin666/dsh-web-ui-all` 用 `web-ui-better-sidebar` 这个 id 挂的同一包），且
3. `!e.disabled`（那个条目是启用状态）

→ 本行就 `disabled: true`，即**自己退让**。

**为什么需要**：`dsh-better-sidebar` 在 `src/index.ts:862` 注册了固定前缀路由 `/sidebar/api`。同一进程里挂两次 → 路由前缀重复 → 整个插件树 boot 失败（`duplicate prefix route`）。作者在 README 里也明确写了"0.13.x 起插件自身 bundle patch 会自动退让…无需手动处理"。

**可见性语义（我专门查了，作者文档是对的）**：`EntryGroup.update()`（`:86-103`）用 `Promise.allSettled(config.map((options) => this.create(options)))` 创建条目；`create()`（`:58-70`）里 `store[id] = new Entry(...)` 是**同步**发生的，之后才 `await entry.update(...)` 去求值 `disabled`。所以第 N 行求值时，`store` 里恰好只有第 1..N 行——**后插入的行看不见**。这正是 patch 注释里"aggregate bundle must precede this one"那条已知限制的成因，作者的说明与实现一致。

**本机实测（模拟三种条目布局）**：

```
空条目列表                    -> false
只有自己这一行                -> false   ← 本机当前的实际情况
聚合条目(不同 id)启用 + 自己   -> true    ← 自己退让
聚合条目(不同 id)已禁用 + 自己 -> false   ← 自己顶上
```

我在 `daily` 和 `web` 的全部已装 patch 里 grep 过 `better-sidebar`：**没有任何第三方包以别的 id 挂载它**。所以**本机该条件恒为 `false`，这行守卫目前是一个空操作**，插件是正常启用的。

### 4.3 威胁评估

**按现状：良性，且比 A 更"干净"。** 表达式是纯内存反射：遍历 loader 树、读三个字段、返回布尔。没有 `process`、没有 `env`、没有 `fs`、没有网络；连 `process.getBuiltinModule` 都没用。我逐字符核对过整条表达式，只有 `.some()` / 属性读取。

一个值得记下的**健壮性**细节（不是安全漏洞）：谓词里 `&&` 的短路顺序恰好让本行不去碰自己的 `e.disabled`（`options.id !== 'better-sidebar'` 在 `!e.disabled` 之前），从而避免了"求值 `disabled` → 又遍历 entries → 又求值自己"的无限递归。如果将来有人调换这两个条件的顺序，就会递归爆栈。这可以作为给作者的提醒之一，但不必当作安全问题汇报。

**它能够到什么**：与 A 完全相同的机制面（§1.4）。区别在于**动机上更难替代**：这个条件确实需要"读别的条目"的能力，静态 YAML 写不出来。

**最坏情况（未来版本被改）**：同样是一次静默的宿主内 RCE。加重因素：`web` 里声明为 `^0.18.1` 而 npm `latest` 已是 **0.19.1**——这个包更新很活跃，README 有 87KB 的更新日志，`pnpm-workspace.yaml` 里还专门为它开了 `minimumReleaseAgeExclude`（即**绕过发布冷却期**），也就是说它常常是"发布当天就装"。缓冲更薄。

**不要误判**：作者把这段写得很透明（patch 里 45 行注释解释了整个设计、README 明说了行为、还配了 `test:mount:aggregate` 回归测试）。这是"用了一个强大的宿主特性解决一个真实问题"，不是藏后门。真正的争议点是"用 `!!js` 而不是运行时单例守卫"，作者在注释里明确写了这是有意取舍（"no runtime singleton guard is added"）。

### 4.4 不用 `!!js` 能做到同样效果吗？

**静态配置：做不到。** `disabled` 是逐行字面量；要表达"当且仅当另一个条目存在且启用"这种跨条目条件，静态 YAML 没有等价能力。

**可行的替代（按代价排序）**：

1. **作者侧：运行时单例守卫。** 让插件在 `apply()` 里检测 `/sidebar/api` 是否已被注册，已注册就自行 no-op。这样可以彻底删掉 patch 里的 `!!js`——**但作者已在注释里明确拒绝**（"no runtime singleton guard is added"）。这是唯一能同时保住功能又去掉 `!!js` 的路子，属于设计变更，不是小补丁。
2. **用户侧：手工接管，即"我知道我不用聚合包"。** 在 profile 里把 `disabled` 静态写成 `false`（或 `true`），表达式即永不执行。**我已实测**：`- id: better-sidebar` + `disabled: <字面量>` 覆盖后，合成树里 `__jsExpr` 出现次数 = 0，且 `disabled` 变成字面量。
   - 代价：若将来装了聚合包（如 `@linxin666/dsh-web-ui-all`），**会**撞上 `duplicate prefix route` 整树启动失败，需要人工把自己那行静态禁用。本机目前没有聚合包，所以这个代价现在等于零。
3. **什么都不做，只 pin。** 功能不变，风险限定在"已验证的这个 0.18.1 artifact"。

### 4.5 建议 + 可执行片段

**建议：按现状接受（accept as-is with a note），并用精确 pin 把"接受"限定在这个已验证的版本上。**

理由：表达式可证明无副作用；它解决的问题（重复路由导致整树 boot 失败）是真实的；静态配置无法表达该条件；作者有意的取舍且文档透明；真要根治需要作者改设计。因此**不建议禁用、也不建议以"移除 `!!js`"为条件的施压**。

**命令（把 `web` 从 `^0.18.1` 收紧到已审计的 0.18.1）**

```bash
cd ~/.dsh/profiles/web
pnpm add --save-exact dsh-better-sidebar@0.18.1
# daily 已经是 "0.18.1"，无需改动
```

**同时建议加一段 profile 注释记录取舍**（写进 `~/.dsh/profiles/{daily,web}/cordis.patch.yml` 的注释块即可，不必改行为）：

```yaml
# [SP12 已知项] dsh-better-sidebar 的 bundle patch 用 !!js 求值 disabled 守卫
#   disabled: !!js "[...ctx.loader.entries()].some(...)"
# 已审计 0.18.1（patch sha256 d363aca...）：纯内存反射，无 fs/env/网络副作用。
# 本 profile 无聚合包以其它 id 挂载该包，故该条件恒为 false，插件正常启用。
# 已 pin 到 0.18.1；升级前请重新 diff 该 patch 文件。
# 若将来要用 !js 零求值，可加：
#   - id: better-sidebar
#     disabled: false
# （代价：会失去聚合双挂载自动退让，装聚合包时需手工禁用本行。）
```

**可选（若 owner 想要零 `!!js` 求值）**：加上 `- id: better-sidebar` + `disabled: false` 两行。我把它标为可选而非主建议，因为它用"未来会踩聚合包坑"换"现在少一个已证明良性的求值"。

---

## 5. 作者沟通草稿（**均为草稿，未发布；需 owner 批准**）

> 约束提醒：本任务禁止发布到 GitHub、禁止改任何 repo 源码。以下仅作文本草案。

### 5.1 `@tt-a1i/archify-dsh`（英文；该仓库 README 为英文）— **建议发出**

> **建议去处**：`https://github.com/tt-a1i/archify/issues`（新 issue），标题建议：
> `archify-dsh: bundle patch resolves the skill root with a !!js expression — could it move into lib/index.js?`

```markdown
Thanks for `@tt-a1i/archify-dsh` — the Skill-only bundle shape is a nice fit for DSH, and
the exact-version install guidance in the README is appreciated.

A local config scanner flagged one thing I wanted to raise, as a compatibility/hygiene
question rather than a bug report.

`cordis.patch.yml` line 10 uses the host's `!!js` YAML tag:

    bundledSkillDir: !!js process.getBuiltinModule('node:path').join(
      process.getBuiltinModule('node:path').dirname(
        process.getBuiltinModule('node:module')
          .createRequire(baseUrl).resolve('@tt-a1i/archify-dsh/package.json')),
      'skills')

In DSH 0.1.5-rc.1 that tag is not inert: `@deepseek-ai/cordis-plugin-loader` parses it into
`{ __jsExpr }` and evaluates it at entry activation with

    new Function("ctx", "expr", "with (ctx) { return eval(expr) }")

so it runs in the host process at boot, outside the agent sandbox, and it has access to
`process`, `process.env`, `node:fs`, `node:child_process` and `fetch` (verified by
importing the host's own exported `evaluate`). Your expression itself only does path
resolution, and I do not read anything malicious into it — the concern is that the
expression is the *only* author-controlled code this package executes
(`lib/index.js` is never imported: the patch mounts `@deepseek-ai/dsh-skill-filesystem`,
not `@tt-a1i/archify-dsh`), and it is evaluated from a config file, so it can change in a
patch release without anyone noticing on `dsh plugin add ...@latest`.

You already have the same logic as a normal function in `lib/index.js`
(`resolveArchifySkillRoot(profileBaseUrl)`). Would you consider turning that module into
the actual plugin entry — e.g. an `apply(ctx)` that calls
`resolveArchifySkillRoot(ctx.baseUrl)` and registers the skill root — so the patch only
carries a static `config`? Packages that scan `cordis.patch.yml` statically (dsh-security
SP12 is one) currently have to flag archify-dsh as an unread code-execution surface, and
that flag would go away.

If you would rather keep the patch as-is, that's a reasonable call too — it would help if
the README mentioned that the patch evaluates a JS expression at boot, since the current
README states the package does no network/credential handling and readers may take the
patch as declarative data.

(Workaround on my side for now: exact-pinning 0.1.0 and overriding
`archify-skill-filesystem.config.bundledSkillDir` with a static path in my profile patch,
which replaces the `!!js` node before the loader sees it.)
```

### 5.2 `dsh-better-sidebar`（中文；该仓库 `README.md` 为中文）— **可选，弱建议**

> 这条**不建议**要求作者删除 `!!js`（静态无法等价替代，作者也已在注释里说明取舍）。
> 只请求"在 README 里披露实现方式"，属于文档改进；若 owner 认为不值得打扰作者，可以完全不发。

```markdown
你好，一直用 `dsh-better-sidebar`，聚合双挂载那个自动退让的设计很实用，README 里也写清楚了行为。

想反馈一个**文档层面**的小建议，不是 bug。

`cordis.patch.yml` 第 49 行用的是宿主的 `!!js` YAML 标签：

    disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"

在 DSH 0.1.5-rc.1 里这个标签不是惰性的：`@deepseek-ai/cordis-plugin-loader` 把它解析成 `{ __jsExpr }`，并在条目激活时用
`new Function("ctx","expr","with (ctx) { return eval(expr) }")` 求值——也就是在宿主进程 boot 期执行，带着完整的
`process` / `process.env` / `node:fs` / `node:child_process` / `fetch` 能力（我用宿主导出的 `evaluate` 实测确认过）。

你的表达式本身只读 loader 条目列表、返回布尔，没有副作用，我没有任何"这里有恶意"的意思；而且这个跨条目条件确实没法用静态 YAML 表达，我理解你在注释里说明的取舍。

只是现在有一类静态扫描工具（比如 dsh-security 的 SP12）会把它标成"第三方 patch 在加载期执行任意 JavaScript"，而这个机制**只在 patch 的注释里**说明，README 第 109/472 行只描述了"自动退让"的行为。所以想请你考虑：在 README 里补一句"该守卫由 bundle patch 中的 `!!js` 表达式在 boot 时求值实现"，让用户升级前知道该文件值得看一眼。

另外两个小观察，供参考，不必回复：
1. 谓词里 `options.id !== 'better-sidebar'` 排在 `!e.disabled` 之前，恰好避免了对自己求值 `disabled` 造成递归；如果以后调整条件顺序，建议保留这个短路。
2. 本机没有聚合包时该条件恒为 false，插件正常启用——行为符合预期。

（我这边暂时的处置：pin 到已审计的 0.18.1，保留 `!!js` 不改。）
```

---

## 6. 未能验证 / 存疑事项（诚实清单）

1. **没有实际 boot 宿主来观察**：§4.2 的"求值时只有前面的行可见"是从源码（`EntryGroup.update`/`create` 的同步 `store` 写入顺序）推导的，**没有**起一个 `dsh --profile web` 实测。我刻意没有跑 `dsh --dump-config`/boot，以免触碰 `~/.dsh` 状态。**没有**验证：`e.disabled` getter 在条目尚未初始化时对祖先链的取值行为（`this.parent.ctx.fiber.entry` 在那种时刻可能为 `undefined`，`_disabled` 里用 `while (entry)` 保护，看起来是安全的，但未实测）。
2. **`!!js` 是否在"行被禁用"时仍被求值**未逐一实测。已知：`config` 的求值由 `internal/config` hook 触发（条目真正 import 时）；`disabled` 的求值在 `_disabled()` 中无条件发生。因此**对 better-sidebar 而言，即使有别的行被禁用，只要这个条目被处理过就会求值**——这一条我按源码判断，未跑运行时验证。
3. **npm registry 的发布日期/签名未查**（`web_fetch` 对本机 DNS 判定为非公网 IP 被拒）。`latest` 版本号是用本机 `npm view` 得到的（`dsh-better-sidebar` 0.19.1、`@tt-a1i/archify-dsh` 0.1.0），**发布时间、provenance/attestation 未核**。
4. **`archify-dsh` 的 `lib/index.js` 确实是死代码**：依据是"两个 profile 的全部已装 patch 中，`@tt-a1i/archify-dsh` 只出现在其自身 `package.json` 的 `dsh.bundle.patch` 声明里，没有任何条目以它作为 `name`"。这是静态 grep 结论，未做运行期模块加载追踪。
5. **未审查两个包的完整 `lib/`/`src/` 代码**（本任务范围只到 `!!js` 与 patch 文件）。本档案对"包是否还有其他恶意行为"**不做背书**——只说"这一行 `!!js` 按现状是良性的"。
6. `minimumReleaseAge`：`pnpm-workspace.yaml` 只有 `minimumReleaseAgeExclude`，**没有** `minimumReleaseAge` 键，`pnpm config get minimumReleaseAge` 返回 `undefined`。也就是说 web profile **没有生效的发布冷却门槛**（排除列表形同虚设）。这一条我按配置字面判断，未验证 pnpm 11 是否有其它来源的默认值。

---

## 7. 复现步骤（本次调查实际执行过的验证，全部只读）

```bash
# 1) 包身份与 patch 完整性
node -e "const fs=require('fs');for(const p of ['@tt-a1i/archify-dsh','dsh-better-sidebar']){const q='/Users/waterfly/.dsh/profiles/web/node_modules/'+p;console.log(p, fs.lstatSync(q).isSymbolicLink(), fs.realpathSync(q), require(q+'/package.json').version)}"
shasum -a 256 ~/.dsh/profiles/{web,daily}/node_modules/@tt-a1i/archify-dsh/cordis.patch.yml
shasum -a 256 ~/.dsh/profiles/{web,daily}/node_modules/dsh-better-sidebar/cordis.patch.yml

# 2) 求值器能力面（只读探针，不执行副作用）
node --input-type=module -e "
import { evaluate } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js';
const ctx = { baseUrl: 'file:///Users/waterfly/.dsh/profiles/daily/' };
for (const e of ['typeof process', 'Object.keys(process.env).length',
                 \"typeof process.getBuiltinModule('node:fs').readFileSync\",
                 \"typeof process.getBuiltinModule('node:child_process').execSync\", 'typeof fetch'])
  console.log(e, '=>', evaluate(ctx, e));
"

# 3) archify 表达式求值结果（纯路径）
#    见正文 §3.2；把 baseUrl 换成 daily/web 各跑一次

# 4) 用户侧覆盖是否真的消除求值（本次核心验证）
#    用宿主的 entryListSchema + applyEntryPatches + isJsExpr 复现 §3.5/§4.5 的合成结果：
#    基线 isJsExpr = true；用户层覆盖后 isJsExpr = false 且合成树中 __jsExpr 计数 = 0；
#    不相关的 patch 层则两处 __jsExpr 全部保留（计数 = 2）。脚本见 /tmp/sp12-verify.mjs。
node /tmp/sp12-verify.mjs
```

`/tmp/sp12-verify.mjs` 是我在 `/tmp` 下自建的验证脚本（**不是** repo 源码，未改动 `dsh-doctor/`、`dsh-security/` 或 `~/.dsh`）；`/tmp` 会被系统清理，若要长期保留请自行转存。

---

## 8. 一行总结给 owner

两个 `!!js` 都是**良性的、写法透明的便利手段**，不是后门；但它们确实是被 SP12 正确标出的"第三方 patch 在加载期执行任意代码"的面，且**当前实时宿主（`daily` 3080）就在加载它们**。最省事且不损失功能的处置是：**两个包都在 profile 里精确 pin**（archify 用 `0.1.0`、better-sidebar 用 `0.18.1`），archify 额外用 §3.5 的静态覆盖把求值彻底消掉（作者 README 本就要求精确版本，且他手里已有等价函数可改成正经插件），better-sidebar 保持现状并写注释、可选提一个文档层面的 issue。注意：**任何用户侧覆盖都不会让 SP12 闭嘴**（它是静态文件扫描）。
