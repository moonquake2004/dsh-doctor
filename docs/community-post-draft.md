**dsh-doctor + dsh-security** — offline diagnostics and a unified security framework for the plugin ecosystem. Diagnose the profile before it bricks, and get a complete security posture in one pass.

**dsh-doctor + dsh-security** — 面向插件生态的离线诊断 + 统一安全检查框架。在 profile 崩掉之前诊断它，一次跑完拿到完整安全态势。

---

## 🔍 Why / 为什么需要

DSH's plugin tree is powerful and fragile at the same time: a duplicate entry id, a shadowed module instance, an unbuilt `main`, a hand-edited patch typo — any of them can brick the profile at boot or stall the whole web server, usually with an opaque error. And once plugins are installed, nothing tells you whether a session log is silently leaking credentials or whether half your plugins are running stale versions.

DSH 的插件树既强大又脆弱：重复 entry id、模块双实例遮蔽、未构建的 `main`、手改 patch 打错一个字符——任何一条都能让 profile 启动即崩或拖垮 web 服务，而且报错通常指不到点上。插件装完之后，也没人告诉你：会话日志是否在静默泄露凭据、有多少插件正跑着过时版本。

Both tools are **offline-first** (they run before boot, when dsh itself may be unusable) and **dependency-free** (single-file Node, no harness internals).

两个工具都是**离线优先**（dsh 起不来时也能跑）且**零依赖**（单文件 Node，无需 harness 内部接口）。

---

## 🩺 dsh-doctor — 34 offline checks

| Group | What it catches |
|---|---|
| **env** (7) | missing `node`/`pnpm`/`zstd`, `.env`-as-directory, node version, node-pty binary, storage JSON corruption, **anchor tripwires**, port 3080 contention |
| **profile** (14) | duplicate loader entry ids, unresolvable patch inserts, dangling `file:` links, **dual-instance shadowing**, patch YAML syntax, adapter conflicts, missing `settings` inject, client-service injects, unbuilt `main`, version drift, bin executability |
| **session** (8) | orphan tool calls, unclosed turns, `seq` gaps, post-`end-seed` replay, unknown event types, single-frame zstd, `sourceEventSeqs` drift, oversized-session heap risk |
| **catalog** (5) | declarative rules fetched remotely — new checks ship **without a release** |

Every check maps to a community failure report, and each has synthetic good/bad fixtures asserting isolation (the target check fails, nothing else does).

每条检查都对应一个社区故障报告，并配有合成的好/坏 fixture 断言隔离性（该响的响、不该响的不响）。

## 🔒 dsh-security — 26 security checks

| Layer | Checks | What it catches |
|---|---|---|
| **Static** | SP1-SP10, SS1-SS3 | hardcoded secrets, sandbox inconsistencies, malicious entries, credential leaks, PII exposure, poisoned patterns |
| **Runtime** | SR1-SR4 | sandbox escapes, privilege escalation, data exfiltration, isolation failures |
| **Lifecycle** | SL1-SL4 | supply-chain integrity, **version drift**, reputation signals, release compatibility |
| **External** | EXT-PG/SA/ECO/RED | integrates [dsh-poison-guard](https://github.com/zoahdev/dsh-poison-guard), [dsh-sandbox-audit](https://github.com/zoahdev/dsh-sandbox-audit), [dsh-ecosystem](https://github.com/zoahdev/dsh-ecosystem), [dsh-plugin-reducer](https://github.com/ArmyWas/dsh-plugin-reducer) |

### Real output from a live profile / 真实机器上的实测输出

```text
[SL1] version drift — 4 plugins behind registry latest:
      @openviking/dsh-memory-plugin  0.2.1  → registry 0.3.0   [medium]
      @xmanrui/dsh-im                1.3.0  → registry 3.1.1   [medium]
      dsh-at-file                    0.6.8  → registry 0.6.3
[SL4] major-behind / latest-is-prerelease signals, incl. platform binaries
[SS1] credential leak in session log — 4 × OpenAI API key (masked: sk-a***)
[SS2] PII exposure — 98 items (IPv4 38, phone 56, email 4)
      ↳ fix path: npx dsh-redact <session.jsonl> --out redacted.jsonl
```

Credential findings are printed **masked** (first/last chars only), and `skip`/severity thresholds let you tune what fails a run.

凭据类发现只打印**掩码**（首尾字符），并支持 `skip` 语义与 severity 阈值调节失败口径。

---

## ⚙️ Design notes / 设计要点

- **Check lifecycle**: checks are *data* (declarative read-only probes), distributed through a remote catalog with TTL cache; anchors verify the installed harness's contracts so checks fail loudly instead of rotting silently.
- **Interoperable output**: the `dsh-doctor/v1` envelope (`{schema, tool, exitCode, summary, checks:[{name,status,detail}]}`, lowercase pass/warn/fail, exit 0/1/2) is shared with other community diagnostics — scripts can consume any of them.
- **Two forms**: CLI (`npx @moonquake2004/dsh-doctor`) and a proper dsh plugin (Settings → Diagnostics panel + read-only JSON API).

- **检查生命周期**：检查是*数据*（声明式只读探测），经远程目录分发、带 TTL 缓存；锚点校验已装 harness 的契约——升级后响亮失效，而不是静默腐烂。
- **可互换输出**：`dsh-doctor/v1` 信封与社区其他诊断工具共用（小写 pass/warn/fail，退出码 0/1/2）。
- **两种形态**：CLI（`npx`）与标准 dsh 插件（设置→诊断面板 + 只读 JSON API）。

## 🚀 Quick start / 快速开始

```bash
# diagnostics
npx @moonquake2004/dsh-doctor --profile web

# security only
npx @moonquake2004/dsh-doctor --security --security-only --profile web

# machine-readable, contract envelope
npx @moonquake2004/dsh-doctor --json --envelope --security --profile web
```

## 🔗 Links

- dsh-doctor: https://github.com/moonquake2004/dsh-doctor · `@moonquake2004/dsh-doctor@0.4.4`
- dsh-security: https://github.com/moonquake2004/dsh-security · `@moonquake2004/dsh-security@0.1.6`
- Announcement threads: [#1534](https://github.com/deepseek-ai/deepseek-harness/discussions/1534) (doctor) · [#3247](https://github.com/deepseek-ai/deepseek-harness/discussions/3247) (security)
- Contract: [docs/doctor-contract.md](https://github.com/moonquake2004/dsh-doctor/blob/main/docs/doctor-contract.md) · Check lifecycle: [docs/check-lifecycle.md](https://github.com/moonquake2004/dsh-doctor/blob/main/docs/check-lifecycle.md)

MIT · 34 offline checks + 26 security checks · 100+ fixture-verified tests · feedback and false-positive reports very welcome.

MIT · 34 项离线检查 + 26 项安全检查 · 100+ fixture 验证测试 · 欢迎反馈与误报报告。
