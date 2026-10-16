# 红队审计档案 · 0.8.8（E4 误报：真实环境差分）

**范围**：本版本只修 E4 的解析根（抽出 `hostInstallRoot()` 共用）+ 2 条回归用例，**未改任何判定语义**。
**证伪方式**：**真实环境差分** —— 在用户真机上重启宿主后重跑全套检查，把"工具说的"与"磁盘上的事实"逐项对照。
（`docs/redteam-brief.md` 允许这种形式，但必须如实说明它不是 fresh-context 子代理，且覆盖有限。）

---

## ① 真反例：E4 对**完好**安装报 fail

**工具说**：`E4 未找到 node-pty（dsh web 终端依赖它，#1219）`。

**磁盘上的事实**：

```
/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/node-pty
  prebuilds/darwin-arm64/pty.node   86904 bytes   ← 在位且非空
  prebuilds/{darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}/   ← 全平台预编译都在
```

**根因（两层，与 0.8.7 同病灶）**：

1. **解析根不全**：E4 只查两处 ——
   ① PATH 里**以 `node_modules/.bin` 结尾且含 `dsh`** 的目录的兄弟 `node-pty`；
   ② `$DSH_HOME/profiles/web/node_modules/node-pty`。
   而 Homebrew/全局安装把 `dsh` 放在 `<prefix>/bin`（**不**以 `node_modules/.bin` 结尾），
   依赖在 `<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules`。实测①的命中数 = **0**，②不存在。
2. **重复实现**：宿主根推导在 `--boot-check` 探针里已有一份（0.8.7 写的），E4 又各有一份 → 两边都漏。

**修法**：抽 `hostInstallRoot()`，**E4 与探针共用一份**（R5 唯一归属）。

## ② 对抗性验证（新增 2 例，fixtures 135 → 137）

| 用例 | 期望 | 结果 |
|---|---|---|
| PATH 派生的宿主树里**有** node-pty | E4 **pass** | ✓ |
| 三处都**没有** node-pty | E4 **fail**（不得静默 skip） | ✓ |

用例用 PATH 里的 `dsh` **符号链接**复刻真机布局（`<prefix>/bin/dsh` → `…/lib/bin.js`）——
因为真机的 PATH 分支**正是靠符号链接解析**才成立；造一个"看起来像"的普通目录会测到 fixture 的想象而非真机行为。

## ③ 同轮复查还发现（本轮**未修**，已记录）

| 项 | 状态 | 说明 |
|---|---|---|
| **P5 顶层实体副本** | **真问题，待决策** | `profiles/web/node_modules/@deepseek-ai/{cosmokit,schemastery}` 是实体目录（1.8.5 / 3.18.4），父层是符号链接（1.8.6-alpha.1 / 3.18.5-alpha.1）→ 社区插件拿旧版、宿主用新版 = 双实例。**不单方面修**：删掉后 `dsh-better-sidebar` 的 `^3.18.4` 在 semver 下不匹配预发布版 `3.18.5-alpha.1`，需用户确认并在停机状态下操作 |
| S1 孤儿 tool_call | 既有 | 会话日志历史问题，与插件兼容性无关 |
| S12 84/105 | 既有（从 13/94 恶化） | 宿主 0.2.x 迁移链拒旧会话 —— 版本差异，非插件缺陷 |
| P18 | 良性 | profile manifest 有 name 无 version |

## ④ 未能验证

- **`--json` 输出的偶发管道截断**：一次 `--json | python3` 报 `Unterminated string (char 8794)`，
  写文件后解析**合法**（92783 字节 / 46 检查）。无法判定是管道缓冲还是输出缺陷 → **未验证**，
  已记入交接清单待复现。
- **Desktop 应用形态**：宿主是 `/Applications/DeepSeek Harness.app`（自带宿主，**不监听 3080**），
  故 `E10` 端口检查在本形态下不适用（此前 `dsh web` 形态才适用）——**未有人验证该形态下的端口语义**。
- **P5 的实际运行影响**：未构造"双实例导致 Symbol 不匹配"的最小复现，仅按同类缺陷（#1486/#1697）推断。

## ⑤ 自证

**闸门在补本档案前是红的**（唯一失败项 = 缺 `docs/redteam-0.8.8.md`）—— 本档案即为满足该要求而写。
审计 7/7、变异 8 杀死 / 0 存活 / 1 等价、全套 **227 项**。
