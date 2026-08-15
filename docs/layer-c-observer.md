# Layer C — 半自动 LLM 观察者（设计 + MVP 实现）

> Status：**设计文档（2026-08-16 重建）+ MVP 已实现**。
> ⚠️ 原设计写在 `交接清单.md` 旧版末尾，随旧版文件遗失（未提交、旧工作区无残留）——本文档按项目架构与论文主题重建，并落成可运行的 MVP。
> 相关文档：[check-lifecycle.md](./check-lifecycle.md)（检查即数据/自省/认证门禁/进化回路）、`docs/doctor-contract.md`（v1 信封）。

---

## 一、位置：三层架构的第三层

| 层 | 名字 | 做什么 | 状态 |
|---|---|---|---|
| **A** | 远程检查目录 | 检查=数据（只读探测原语），TTL 缓存 + 离线回退，新检查零发版分发 | ✅ 已上线（v0.2.0+，`plugin/checks.json`） |
| **B** | 自更新 | npm dist-tags 对比、`--update`、`DSH_DOCTOR_AUTO_UPDATE` | ✅ 已上线（v0.2.1+） |
| **C** | **半自动 LLM 观察者** | 观察现场信号 → 提出候选检查 → 人机补全/认证 → 进目录 | 🟢 设计重建 + MVP 实现（本文档） |

层 C 是 check-lifecycle「进化回路」的前端：*社区报告 → 候选检查 → fixture 认证 → 目录分发 → 自动更新* 这条链的第一段（观察与提案）原本全人工，层 C 用 LLM 半自动化它，认证门禁保持不变。

## 二、目标与边界

**目标**：把「现场出了什么错」到「目录里多一条合格检查」的时延，从人工逐条读报告，缩短为：跑一次诊断 → 观察器聚类 → LLM 起草 → 人确认 → 认证。B 档论文（precision/recall + 三家基线）也需要一个「症状 → 检查」标注管线，层 C 就是它的雏形。

**边界（安全不变量，任何实现不得突破）**：

1. **封闭探测词表**：观察器/LLM 只能提议词表内的只读探测原语（与引擎同表），LLM 输出永远是数据，永远不能成为代码。
2. **默认不告警**：候选检查默认 `severity: warn`——观察器提案不许直接制造 error 级告警。
3. **半自动 = 人最后把关**：任何提案不自动进目录。`--observe-apply` 只合并**校验通过**（探测参数完整）的提案，且写进本地覆盖层 `checks.local.json`（不随包分发）；认证通过后才人工合并进 `checks.json`。
4. **LLM 可降级**：LLM 未配置/超时/输出非法 → 静默保留确定性草稿，工具功能不依赖任何外部服务。

## 三、流水线

```
现场信号（诊断运行 JSON / 目录）
   │  ① observe：读入 + 抽取 fail/warn 检查
   ▼
聚类（② clusterSignals：按 section + 归一化 detail 分簇）
   ▼
确定性草稿（③ draftProposal：症状→探测词表提示映射，id/section/severity/骨架 probe）
   ▼
LLM 富化（④ 可选：--observe-llm <cmd>，stdin=prompt，stdout=JSON 回复）
   │  enrichDraft：只采纳词表内字段；任何解析/词表违规 → 回退草稿
   ▼
审查/补全（人类编辑 proposals.json：填全探测参数、定 severity、补 anchor）
   ▼
认证门禁（fixture 对 + 64 测试回归——沿用 check-lifecycle 属性 3，MVP 不重造）
   ▼
应用（⑤ --observe-apply：校验通过才合并 → checks.local.json 本地覆盖层）
   ▼
分发（层 A 目录 + 层 B 自更新——已上线，直接复用）
```

## 四、CLI 接口（MVP）

```bash
# 观察：输入=一次诊断运行 JSON（--json 或 --envelope 输出）或含多个 JSON 的目录
node dsh-doctor.mjs --observe run.json                     # 纯确定性：聚类 + 草稿 + prompt（不调 LLM）
node dsh-doctor.mjs --observe run.json --observe-llm "..." # LLM 富化（cmd 读 stdin 写 stdout）
node dsh-doctor.mjs --json > run.json && node dsh-doctor.mjs --observe run.json

# 应用：把人工补全并校验通过的提案并入本地覆盖层
node dsh-doctor.mjs --observe-apply proposals.json         # 写 plugin/checks.local.json
node --test plugin/test/                                   # 回归（64 + observer 新增）
```

- `--observe-llm` 未给时读 `DSH_DOCTOR_LLM_CMD` 环境变量；都未给 → 跳过 LLM 步。
- LLM 命令契约：`cmd` 从 stdin 收 prompt，stdout 返回纯 JSON（字段见 §五），失败/非法 → 回退草稿并记 `llm: 'ignored: …'`。

## 五、提案 schema（proposals.json 条目）

```json
{
  "id": "session-s2-orphan-probe",
  "section": "session",
  "severity": "warn",
  "title": "候选：孤儿调用残留",
  "discussion": null,
  "anchor": { "package": "@deepseek-ai/dsh-session", "symbol": null, "train": null },
  "probe": { "type": "text-contains", "path": "{profile}/…", "pattern": "…", "flags": "m", "required": false },
  "detailOk": "…",
  "detailFail": "…",
  "fix": "…",
  "proposedBy": "observer",
  "proposedAt": "2026-08-16T…"
}
```

- `probe.type` 必须 ∈ 词表（`command-exists / path-exists / path-is-dir / path-is-file / json-valid / text-contains / text-not-contains / file-size-above / glob-count / file-writable`）。
- 各探测类型的必填参数与引擎一致（`path-*` 要 `path`、`text-*` 要 `path`+`pattern`、`command-exists` 要 `cmd`、`glob-count` 要 `base`+`pattern`、`file-size-above` 要 `path`+`min`）。
- 缺必填参数 = 校验失败 → `--observe-apply` 拒绝合并（这就是「草稿必须被人/LLM 补全」的强制点）。
- `{home}`/`{profile}` 模板合法（运行时展开，与现有目录检查一致）。

## 六、实现文件

| 文件 | 内容 |
|---|---|
| `plugin/observer.mjs` | 纯函数模块：`PROBE_VOCABULARY`、`clusterSignals`、`draftProposal`、`validateProposal`、`renderLLMPrompt`、`enrichDraft`、`runObserver`、`applyProposals`（全部可单测，不碰引擎） |
| `plugin/dsh-doctor.mjs` | CLI 接线：`--observe` / `--observe-llm` / `--observe-apply`；`loadCatalog` 末尾合并本地覆盖层（`localPath` 可注入，默认 `plugin/checks.local.json`） |
| `plugin/test/observer.test.mjs` | 聚类 / 草稿 / 校验拒绝 / 合并去重 / LLM 富化（stub 命令）测试 |
| `docs/layer-c-observer.md` | 本文档 |

## 七、与 #1846 / 论文的关系

- 层 C 的提案 schema 直接复用 check-lifecycle §五 的检查条目 schema（probe/anchor/fixtures/certifiedOn），MVP 先落地 `probe` + 认证前置的合并门禁，`anchor`/`fixtures` 留给人工在审查步补。
- 论文「进化回路」一节（check-lifecycle 属性 4）现在有了引用实现的前端；B 档论文（precision/recall + 三家基线）可把 `--observe` 的聚类输出当标注数据集来源。
- 三家生态工具对齐 v1 信封后，`--observe` 可直接消费任何一家的 JSON 输出（envelope/plain 双形态兼容）。

## 八、待办 / 开放问题

- [ ] anchor/fixtures 半自动生成（LLM 从真实 good/bad 现场数据切 fixture 对）——MVP 未做
- [ ] 社区报告（#NNNN）自动分流进观察器（层 C 接 discussion feed）
- [ ] 共享 check 注册表（check-lifecycle 开放问题 1）落地后，层 C 提案直接 POST 到注册表草稿区
- [ ] 认证矩阵（latest rc only vs N-1）定稿后，把「认证通过→合并进 checks.json」做成 `--observe-certify` 半自动步骤
