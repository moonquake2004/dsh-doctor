# arXiv 提交完整 Checklist — dsh-doctor 论文

> 目标论文：*Offline Diagnostics for Plugin-Based Agent Harnesses: Design, Check Lifecycle, and Field Experience with DeepSeek Harness*
> 提交源：`docs/paper/paper-offline-diagnostics.tex`（pandoc 管线生成，tectonic 本地编译验证通过）
> 状态：未提交（待执行）

---

## 1. 前置条件（账户与背书）

### 1.1 arXiv 账户
- [ ] 注册 arXiv 账户：https://arxiv.org/user（邮箱 + 密码，普通注册即可）
- [ ] **强烈建议**绑定 ORCID：账户设置 → ORCID（论文署名链接用，期刊后续也要求）

### 1.2 Endorsement（背书）——首投必需
arXiv 对新提交者/新领域采用背书机制，cs.SE 需要：

| 方式 | 说明 | 流程 |
|---|---|---|
| **A. 被已发表作者背书** | cs.SE 领域已发表论文的作者给你背书 | 提交时 arXiv 自动发送背书请求邮件给该作者；对方在 arXiv 账户里点确认 |
| **B. 管理员审核** | 无背书人时，arXiv 管理员人工审核你的提交质量 | 首次提交被拒风险高，建议优先 A |

**可背书人选**（本项目社区伙伴）：
- zoahdev（dsh-plugin-doctor 作者）
- worm-ai（dsh-diagnose 作者）
- 若他们都无 arXiv 论文，退回方案 B 或先投 workshop（研讨会通常不需要背书，审稿后引导至 arXiv）

### 1.3 提交前自检
- [ ] 本机编译通过（已验证：`tectonic paper-offline-diagnostics.tex` → PDF 正常，无错误）
- [ ] 无敏感信息（token/密钥/隐私路径——论文引用都是公开 GitHub 链接，安全）
- [ ] 标题、作者、摘要与元数据一致

---

## 2. 提交文件准备

### 2.1 用哪个源文件
**提交源：`docs/paper/paper-offline-diagnostics.tex`**（pandoc 生成 + TikZ/booktabs 手改，tectonic 验证可编译）。
`docs/paper/paper-arxiv.tex` 为手工精修版（保留作参考/备选，若 arXiv 编译主源失败可切换）。

### 2.2 上传内容
| 文件 | 必须？ | 说明 |
|---|---|---|
| `paper-offline-diagnostics.tex` | ✅ 必传 | arXiv 用自己的 TeX Live 编译此源 |
| 外部图片 | 否 | TikZ 图内联，无外部文件 |
| 参考文献 | 否 | 参考文献是手写 `thebibliography`（pandoc 生成），无 .bib 文件 |
| PDF 预览 | 可选 | 上传源后 arXiv 自动生成 PDF 预览；不需要手动传 PDF |

**注意**：arXiv 对提交源的要求是"可编译"——pandoc 模板依赖（article/tikz/booktabs/float/geometry/hyperref）全部在 TeX Live 标准集合内，兼容性已验证。

---

## 3. 元数据逐字段填写

arXiv 提交表单（Submission → New submission）按顺序：

| 步骤 | 字段 | 填写内容 |
|---|---|---|
| 1 | **Categories**（主类目） | `cs.SE`（Software Engineering） |
| 1 | **Categories**（副类目，可选） | `cs.PL`（Programming Languages） |
| 2 | **Title** | `Offline Diagnostics for Plugin-Based Agent Harnesses: Design, Check Lifecycle, and Field Experience with DeepSeek Harness` |
| 3 | **Authors** | `moonquake2004`（建议与 ORCID 绑定） |
| 3 | **Comments** | `8 pages, 2 figures, 2 tables. Working draft; feedback welcome.`（按实际编译页数改） |
| 4 | **Abstract** | 直接复制论文 `\begin{abstract}` 内文本（~200 词，arXiv 也会从源码自动提取，两处保持一致） |
| 5 | **Report number** | 留空 |
| 5 | **Journal reference** | 留空（预印本） |
| 5 | **DOI** | 留空 |
| 6 | **License** | 选 `arXiv` 默认（非独占，保留投稿权利）或明确选一个开源许可证 |
| 7 | **Comments to arXiv**（内部备注） | 留空 |

---

## 4. 上传与提交步骤

1. 登录 https://arxiv.org → **Submit** → **New submission**
2. 依次填写第 3 节各步（类别→标题→作者→摘要→许可）
3. **File upload** 步骤：
   - 选择 `paper-offline-diagnostics.tex` 上传
   - arXiv 自动检测文档类（TeX）并开始编译
4. **Preview** 步骤（关键）：
   - 等 arXiv 编译完成，**检查 PDF 预览**：封面/摘要/图表/编号是否正常
   - 若编译失败：查看错误日志 → 修正源文件 → 重新上传（常见问题见 §6）
5. **Agreement** 步骤：确认 arXiv 政策（非独占许可、可撤回）
6. 点 **Submit** → 进入 moderation 队列（通常几小时内出 arXiv ID）

---

## 5. 提交后

- [ ] 记录 **arXiv ID**（格式 `XXXX.XXXXX`），回填到：
  - 论文 References / 脚注（加 arXiv 链接）
  - 仓库 README（"Paper" 小节）
  - 社区主帖 [discussion #1534](https://github.com/deepseek-ai/deepseek-harness/discussions/1534)
- [ ] 在 #1846（check-lifecycle RFC）帖里同步"论文已发表，模型草案见 arXiv"
- [ ] 若 endorsement 未过：按 arXiv 邮件指引补充（找背书人或走管理员审核）

---

## 6. 常见问题排查

| 现象 | 处理 |
|---|---|
| arXiv 编译报错 `! LaTeX Error` | 本机先 `tectonic` 重编译确认；TeX Live 版本差异极少（我们用的都是标准包） |
| 编译通过但格式异常 | 下载 arXiv 生成的 PDF 与本地对比；差异大时改传 `paper-arxiv.tex`（手工版） |
| endorsement 未通过 | 邮件里 arXiv 会给指引；找 zoahdev/worm-ai 背书，或联系 arXiv 管理员说明研究来源 |
| 摘要与源码提取不一致 | arXiv 自动提取 `\begin{abstract}` 文本为元数据；保持表单手填与源码一致 |
| 想撤回/更新 | arXiv 支持同版本替换（提交新版本）与撤稿（注：不可完全删除，仅撤回到旧版） |

---

## 7. 备选路径（若 arXiv 受阻）

1. **先投 workshop**（ICSE-LLM4Code / FSE-SE4AI 类，通常接受预印本链接）——审稿意见回来再投 arXiv
2. **GitHub Release 发布 PDF**（即时可引用，无背书问题）——arXiv 后补
3. 社区渠道：#1534 主帖、公众号（lencx 类）同步

---

## 附：当前文件清单（docs/paper/）

| 文件 | 用途 |
|---|---|
| `paper-offline-diagnostics.tex` | **arXiv 提交源**（pandoc + TikZ/booktabs，tectonic 验证） |
| `paper-offline-diagnostics.pdf` | 本地编译预览（110KB，arXiv 版式：标题块+摘要开头，无封面/目录） |
| `paper-offline-diagnostics.md` | 规范可读版（GitHub 渲染，含全部图表的 markdown 形态） |
| `paper-arxiv.tex` / `.pdf` | 手工精修版（保留备选，编译通过） |
