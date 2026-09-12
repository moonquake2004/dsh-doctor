# 收录申请 — dsh-security（Blue-Whale-Harness catalog intake）

Status: **SUBMITTED** — https://github.com/leenkcool/Blue-Whale-Harness/issues/171
提交地址：https://github.com/leenkcool/Blue-Whale-Harness/issues/new?template=catalog-intake.yml

---

**repo**: `moonquake2004/dsh-security`

**category（dshCategory）**: `utility`

**is_dsh_plugin**: 否（集成 / 外部工具）—— 它是安全检查框架，不含自己的 cordis.patch.yml，通过 dsh-doctor 的 `--security` 层运行

**intent_zh**（≤280 字符）:
> DSH 生态的统一安全检查框架：28 项检查覆盖静态/运行时/生命周期——凭据泄露与 PII、投毒模式、`!!js` 配置即代码（加载期执行 JS）、第三方 patch 层静默改写沙箱/审批配置、依赖漏洞与 dist-tag 异常等。可作为 dsh-doctor 的 --security 层运行，也可独立调用。

**intent_en**（≤280 字符）:
> A unified security-check framework for the DSH ecosystem: 28 checks over static, runtime and lifecycle layers — credential/PII exposure, poison patterns, `!!js` config-as-code, third-party patches rewriting sandbox/approval rows, dependency CVEs, dist-tag drift.

**language**: JavaScript

**notes**:
> npm：`@moonquake2004/dsh-security`（最新 0.2.0）
> 集成 4 个社区安全工具（dsh-poison-guard、dsh-sandbox-audit、dsh-ecosystem、dsh-plugin-reducer），不可用时以带原因的 skip 呈现而非静默通过。
> 作者：moonquake2004
