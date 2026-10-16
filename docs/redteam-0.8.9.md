# 红队审计档案 · 0.8.9（同名包混淆：结论修正）

**范围**：本版本改一条 peer 声明 + 一条回归用例；**核心产出是一次结论修正**。
**证伪方式**：**外部实物差分** —— 用宿主**自己的**判定实现（从 `dsh-app-boot` 抽取
`evaluatePluginCompatibility`）实测我们的包与截图里的包，而不是读代码推断。

---

## ① 真反例：我上一轮的结论是错的

**我上一轮说**：截图里的 `dsh-doctor@0.4.3 与 DSH 0.2.0-rc.2 不兼容` 是**我们的包**被 peer 范围拦下，
并据此提出"放宽 peer 到兼容 0.2.x"。

**实物对照推翻了它**：

| | 我们的 | 截图里的 |
|---|---|---|
| 包名 | `@moonquake2004/dsh-doctor` | `dsh-doctor`（**未加 scope**） |
| 作者 | moonquake2004 | **astra3294** |
| 描述 | Offline diagnostic for DeepSeek Harness… | Deterministic diagnostics and recovery for DeepSeek Harness（**与截图卡片逐字一致**） |
| peer | 仅 `@deepseek-ai/cordis` | cordis + 10 个 `@deepseek-ai/dsh-client-* ^0.1.0-rc.6`（**与截图要求逐字一致**） |

用宿主自己的判定实现实测（runtime `0.2.1-alpha.2`）：

```
✓ 兼容    我们的 @moonquake2004/dsh-doctor@0.8.8
✗ 不兼容  同名 dsh-doctor@0.4.3  未满足: {dsh-client-connection:^0.1.0-rc.6, …}  ← 与截图一致
```

**另有端到端证据**：把 0.8.8 装进一个临时 profile（基于 0.2.1-alpha.2）**安装成功**，
只有 pnpm 的 peer 告警，没有 `incompatible-version` 拒绝。

**教训**：我看到一张截图就断言"这是我们的包"，**没有先核对包身份**（author/repository/描述）。
这是本会话反复出现的那一类错误——**用推测替代对来源的核对**。

## ② 仍然值得修的一处（真问题，但不是"不兼容"）

`peerDependencies["@deepseek-ai/cordis"] = "^4.0.1"` vs 宿主 `4.0.5-alpha.1`：
严格 semver（pnpm 口径）不满足 → 安装时打印 `missing peer @deepseek-ai/cordis`。

| 范围 | 严格(pnpm) | 含预发布(宿主) |
|---|---|---|
| `^4.0.1`（旧） | ✗ | ✓ |
| **`^4.0.1 \|\| ^4.0.5-alpha.1`（新）** | **✓** | **✓** |
| `~4.0.5-alpha.2`（宿主自家惯例） | ✗ | ✗ |

## ③ 守卫自检：第一版是装饰性的

新回归用例第一版只断言 `notEqual(state, 'unsatisfied')`。而我们的 `peerRangeState` 对
"**release 组 vs 预发布版本**"返回 **`unknown`**（不猜）→ 把范围改回 `^4.0.1` 时用例**仍然全绿**。

改成**正面断言 `satisfied`** 后，对抗性自检（在仓库副本里把范围改回 `^4.0.1`）确认：**立刻变红** ✓。

> 这与之前"变异测试发现 8 个守卫里 4 个是装饰性的"是同一类问题：**断言的形式决定了守卫有没有牙**。

## ④ 未能验证

- **宿主判定的完整入口**：只抽取了 `evaluatePluginCompatibility`/`unmetRequirements` 等纯函数
  （跳过了用 `import.meta` 的 `getDshRuntimeVersion`，runtime 版本由外部传入）。**未**跑 GUI 安装全流程。
- **同名包是否会被市场优先展示**：只确认了它在 npm 上的存在与不兼容，**未**验证市场对同名词的排序规则。
- **dshmarket 的判定**与宿主判定口径不同（前者"低于下界/高于上界"才算风险），二者对同一包可能给出不同展示——未逐条对齐。

## ⑤ 自证

闸门在补本档案前为红（唯一失败项 = 缺本文件）。审计 7/7、变异 8 杀死 / 0 存活 / 1 等价、全套 **228 项**。
