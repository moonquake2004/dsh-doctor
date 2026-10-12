# 红队审计档案 · 0.8.6（子路径导出缺失：一次交叉实测）

**范围**：本版本只加一条语料 + 一条覆盖边界记录，**没有改任何检查逻辑**。
**审计方式**：本轮没有起 fresh-context 子代理 —— 用的是另一种证伪：
**拿社区报告的真实形态，交叉实测我们自己的两条检查**，看它们结论是否一致。
（`docs/redteam-brief.md` 允许这种形式，但必须如实说明它是哪种证伪、覆盖到什么程度。）

---

## ① 真反例：社区 #6853 的形态，我们自己的两条检查结论相反

报告：更新 `dsh-zotero` 后重启失败：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry zotero (dsh-zotero): The requested module
'@deepseek-ai/dsh-commands/brand' does not provide an export named 'CommandDefinitionId'
```

这正是我们 `--boot-check` 的五类失败里的 `missing-export`。但**它有一个我们没专门验证过的特征**：
导入源是**子路径**（`@deepseek-ai/dsh-commands/brand`），不是根说明符。

## ② 交叉实测（作者自制 fixture，真实布局）

构造"宿主包可解析、但子路径不导出该名字"的形态，同时跑两条检查：

| 检查 | 结果 | 说明 |
|---|---|---|
| **`--boot-check`** | **✓ 报 `missing-export`**，附精确报错与修复方向，退出码 2 | 因为它真的去 import，Node 自己抛出"does not provide an export named" |
| **`P16`**（静态） | **✗ 报 pass** | 子路径说明符的导出面解析复杂，P16 按注释自陈的"能不确定就不判"**跳过** |

**反例成立，但性质是"已声明的设计边界"而非新 bug**（P16 宁肯漏报不误报）。但它有一个**真实后果**：
只看静态汇总的用户会以为"命名导入都核对过了"，而权威判定只能来自 `--boot-check`。

## ③ 为什么记为"发现"而不是"修掉"

要真正检出它，P16 得解析 exports 映射 + 区分 type-only 文件 + 处理条件导出 ——
复杂度与误报风险都不低，而 `--boot-check` **已经能可靠检出**（它不猜，直接 import）。
所以本轮选择：**不扩大静态判据**（那正是 R8"断言强度不得超过证据"要防的），
而是把边界**写清楚**（§5 D10）+ **用语料钉住**（新用例断言 --boot-check 必须归类为 missing-export）。

## ④ 已覆盖 / 未能验证

| 项 | 结论 |
|---|---|
| `--boot-check` 对该形态的检出与归类 | ✅ 实测 `missing-export`，退出码 2 |
| `--boot-check` 对"包根本没装"的归类 | ✅ 早前实测 `not-installed`（另一条正确路径） |
| P16 为何漏 | ✅ 读源码确认：子路径说明符不在其静态判定范围 |
| **P16 是否应该扩展到子路径** | **未验证/未决** —— 需要评估 exports 解析的误报面；本轮按"宁可不判"处理 |
| 本机真实插件是否有同类导入 | 未逐包扫描（本机 16 个 bundle 的 P16 全 pass，但那也可能是跳过） |

## ⑤ 待决策

- **D10**（新增）：P16 的子路径盲区 —— 要么补可见性（本轮已做），要么评估扩展到子路径导出面。

## ⑥ 自证

**闸门在补本档案前是红的**（唯一失败项 = 缺 `docs/redteam-0.8.6.md`）—— 本档案即为满足该要求而写。
审计 7/7、变异 8 杀死 / 0 存活 / 1 等价、全套 **225 项**。
