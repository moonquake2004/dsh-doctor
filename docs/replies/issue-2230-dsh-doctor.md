# 收录申请 — dsh-doctor（Blue-Whale-Harness catalog intake）

Status: **DRAFT — awaiting user approval. NOT submitted.**
提交地址：https://github.com/leenkcool/Blue-Whale-Harness/issues/new?template=catalog-intake.yml

---

**repo**: `moonquake2004/dsh-doctor`

**category（dshCategory）**: `utility`

**is_dsh_plugin**: 是（含 cordis.patch.yml）

**intent_zh**（≤280 字符）:
> DeepSeek Harness 离线诊断工具：37 项检查覆盖环境/配置/会话三大类——重复 entry id、模块双实例、patch 语法、会话迁移拒载、缺失导出等"装完就崩"的根因，启动前即可定位。附带安全检查层（--security）与远程检查目录，新检查无需发版即可生效。

**intent_en**（≤280 字符）:
> Offline diagnostics for DeepSeek Harness: 37 checks across environment, profile and session (duplicate entry ids, dual module instances, patch syntax, migration refusals, missing exports) to catch boot-breaking problems before you start dsh.

**language**: JavaScript

**notes**:
> npm：`@moonquake2004/dsh-doctor`（最新 0.4.6）
> 诊断契约文档：https://github.com/moonquake2004/dsh-doctor/blob/main/docs/doctor-contract.md
> 与生态内其它诊断工具共用 `dsh-doctor/v1` 信封（工具名/状态/退出码），便于 CI 与支持脚本统一消费。
> 作者：moonquake2004
