# DSH 生态统一安全检查框架设计

> 设计日期：2026-08-18
> 状态：草案
> 作者：moonquake2004

---

## 1. 目标

为 DSH 生态建立统一的安全检查框架，覆盖插件全生命周期（发现→安装→运行→更新→退役），让任何工具都能贡献安全检查，让用户一键获得完整的安全态势感知。

## 2. 设计原则

1. **分层解耦**：协议层（Layer 0）定义标准，执行层（Layer 1-3）各自实现
2. **可组合**：任何工具都可以通过 plugin interface 注册检查
3. **向后兼容**：不破坏 dsh-doctor 现有 33 项检查，安全检查是新增
4. **渐进增强**：默认安全检查关闭（`--security`），用户显式开启
5. **severity 驱动**：退出码和用户通知由 severity 决定，非 ok/fail 二元

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                   DSH Security Framework                  │
├──────────────────────────────────────────────────────────┤
│  Layer 0: Check Protocol（统一协议）                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │ • 检查 ID 规范（SP/SR/SL + 编号）                   │  │
│  │ • Severity 枚举（CRITICAL/HIGH/MEDIUM/LOW/INFO）    │  │
│  │ • Check Phase 枚举（PRE/POST/RUNTIME/LIFECYCLE）    │  │
│  │ • v1 信封安全扩展字段                                │  │
│  │ • Plugin Interface（外部工具注册检查）                │  │
│  │ • Check Registry（检查注册与发现）                   │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  Layer 1: Static Checks（静态检查）                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 内置：SP1-SP6, SS1-SS3（dsh-doctor 实现）           │  │
│  │ 集成：poison-guard / sandbox-audit / npm audit      │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Runtime Checks（运行时检查）                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 内置：SR1-SR4（dsh-doctor --observe 扩展）          │  │
│  │ 集成：dsh-shelf / permission monitor                │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  Layer 3: Lifecycle Checks（生命周期检查）                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 内置：SL1-SL4（dsh-doctor + dsh-ecosystem 集成）    │  │
│  │ 集成：dsh-plugin-reducer / release-compat           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## 4. Layer 0: Check Protocol

### 4.1 检查 ID 规范

格式：`{category}{number}`

| 前缀 | 含义 | Layer |
|---|---|---|
| `SP{n}` | Security-Profile（配置安全） | Layer 1 |
| `SS{n}` | Security-Session（会话安全） | Layer 1 |
| `SR{n}` | Security-Runtime（运行时安全） | Layer 2 |
| `SL{n}` | Security-Lifecycle（生命周期安全） | Layer 3 |

### 4.2 Severity 枚举

```typescript
enum Severity {
  CRITICAL = "critical",  // 立即阻断：沙箱逃逸、远程代码执行
  HIGH     = "high",      // 必须修复：硬编码密钥、已知 CVE
  MEDIUM   = "medium",    // 建议修复：沙箱策略不一致、依赖过期
  LOW      = "low",       // 可选修复：信息泄露风险、最佳实践偏离
  INFO     = "info",      // 信息提示：安全建议、配置优化
}
```

### 4.3 Check Phase 枚举

```typescript
enum CheckPhase {
  PRE_INSTALL  = "pre-install",   // 安装前（静态分析）
  POST_INSTALL = "post-install",  // 安装后（配置审计）
  RUNTIME      = "runtime",       // 运行时（监控）
  LIFECYCLE    = "lifecycle",     // 生命周期（更新/退役）
}
```

### 4.4 v1 信封安全扩展

在现有 v1 信封基础上，安全检查输出额外字段：

```json
{
  "schema": "dsh-doctor/v1",
  "tool": "dsh-doctor",
  "generatedAt": "2026-08-18T12:00:00Z",
  "profile": "web",
  "exitCode": 1,
  "security": {
    "enabled": true,
    "summary": { "critical": 0, "high": 1, "medium": 3, "low": 5, "info": 2 },
    "phase": "post-install"
  },
  "summary": { "pass": 28, "warn": 3, "fail": 1, "skip": 1 },
  "ok": false,
  "checks": [
    {
      "section": "security-profile",
      "id": "SP2",
      "ok": false,
      "severity": "high",
      "phase": "post-install",
      "detail": "检测到硬编码密钥：cordis.patch.yml 第15行含疑似 API key",
      "fix": "将密钥移至环境变量或 1Password，从 cordis.patch.yml 中删除",
      "references": ["#962"],
      "src": "builtin"
    }
  ]
}
```

### 4.5 Plugin Interface（外部工具注册检查）

任何工具都可以通过 JSON 文件注册安全检查：

```json
// ~/.dsh/security/checks.d/poison-guard.json
{
  "source": "dsh-poison-guard",
  "version": "0.2.0",
  "checks": [
    {
      "id": "EXT-PG-1",
      "name": "poison-scan",
      "severity": "high",
      "phase": "pre-install",
      "description": "AST 投毒扫描（JS-X-Ray + 反混淆）",
      "command": "dsh-poison-guard scan --json",
      "exitCodeMap": { "0": "pass", "1": "fail" }
    }
  ]
}
```

dsh-doctor 启动时扫描 `~/.dsh/security/checks.d/` 加载外部检查注册表，执行后合并到统一输出。

### 4.6 Check Registry

```typescript
interface SecurityCheck {
  id: string;                    // SP1, SR2, EXT-PG-1, etc.
  name: string;                  // 人类可读名称
  severity: Severity;            // 严重度
  phase: CheckPhase;             // 检查阶段
  description: string;           // 描述
  src: "builtin" | "external";   // 内置 or 外部
  source?: string;               // 外部工具名
  runner: () => Promise<SecurityCheckResult>;  // 执行函数
}

interface SecurityCheckResult {
  id: string;
  ok: boolean;
  severity: Severity;
  detail: string;
  fix?: string;
  references?: string[];
  evidence?: any;                // 原始证据（可选）
}
```

## 5. Layer 1: Static Checks（静态检查）

### 5.1 内置检查

| ID | 名称 | Severity | Phase | 描述 |
|---|---|---|---|---|
| **SP1** | dependency-audit | HIGH | POST_INSTALL | 依赖链漏洞扫描（npm audit / osv-scanner） |
| **SP2** | secret-scan | HIGH | POST_INSTALL | 配置文件硬编码密钥检测（cordis.patch.yml / package.json） |
| **SP3** | sandbox-consistency | MEDIUM | POST_INSTALL | 沙箱策略配置一致性审计（轻量版 sandbox-audit） |
| **SP4** | entry-poison | HIGH | POST_INSTALL | 恶意 entry 注入检测（已知恶意模式匹配） |
| **SP5** | permission-model | MEDIUM | POST_INSTALL | 插件权限声明验证（capability declarations） |
| **SP6** | vuln-match | HIGH | POST_INSTALL | 已知漏洞匹配（CVE/GHSA 数据库查询） |
| **SS1** | credential-leak | CRITICAL | POST_INSTALL | 会话日志凭据泄露检测（API key/token/私钥） |
| **SS2** | pii-exposure | MEDIUM | POST_INSTALL | PII 数据暴露检测（邮箱/电话/身份证） |
| **SS3** | sensitive-output | LOW | POST_INSTALL | 插件输出敏感数据检测 |

### 5.2 外部工具集成

| 工具 | 集成方式 | 覆盖检查 |
|---|---|---|
| dsh-poison-guard | Plugin Interface 注册 | EXT-PG-1（投毒扫描） |
| dsh-sandbox-audit | Plugin Interface 注册 | EXT-SA-1（沙箱策略审计） |
| npm audit | SP1 内部调用 | 依赖漏洞 |
| osv-scanner | SP1 内部调用 | 依赖漏洞（备选） |

### 5.3 SP1 依赖链审计设计

```
输入：profile node_modules 目录
流程：
  1. 执行 `npm audit --json --prefix <profile>` 获取漏洞列表
  2. 过滤 critical/high 级别漏洞
  3. 关联到具体插件（通过 package.json dependencies）
  4. 输出：每个漏洞的 插件名 + CVE ID + 严重度 + 修复建议
输出：SP1 check result
```

### 5.4 SP2 密钥扫描设计

```
输入：cordis.patch.yml + package.json + 插件源码
流程：
  1. 正则扫描：sk-*, ghp_*, github_pat_*, AKIA*, -----BEGIN RSA PRIVATE KEY-----
  2. 环境变量引用检测：!!js process.env.XXX（安全）vs 硬编码值（不安全）
  3. 排除已知安全模式：${VAR}, $env:VAR, process.env.VAR
  4. 输出：每个发现的 文件 + 行号 + 密钥类型 + 严重度
输出：SP2 check result
```

### 5.5 SS1 凭据泄露检测设计

```
输入：session.jsonl（最近 N 条）
流程：
  1. 扫描 message content 中的敏感模式
  2. 匹配：API key pattern, token pattern, private key block
  3. 检查是否已通过 dsh-redact 脱敏
  4. 输出：泄露数量 + 类型分布 + 脱敏状态
输出：SS1 check result
```

## 6. Layer 2: Runtime Checks（运行时检查）

### 6.1 内置检查

| ID | 名称 | Severity | Phase | 描述 |
|---|---|---|---|---|
| **SR1** | sandbox-violation | CRITICAL | RUNTIME | 沙箱逃逸检测（syscall 监控） |
| **SR2** | privilege-escalation | HIGH | RUNTIME | 权限提升检测（privilege boundary monitoring） |
| **SR3** | data-exfiltration | HIGH | RUNTIME | 数据外泄检测（网络/文件流监控） |
| **SR4** | isolation-verify | MEDIUM | RUNTIME | 插件隔离验证（跨插件数据泄漏检测） |

### 6.2 实现方式

Layer 2 检查依赖 dsh-doctor 的 `--observe` 模式：

```
dsh-doctor --observe <session.jsonl> --security
```

`--observe` 已有的 LLM 富化能力可以扩展为安全事件检测：
- 从会话日志中提取工具调用序列
- 检测异常模式（如频繁文件写入、网络请求、权限变更）
- 关联到具体插件（通过 entry/service 归属）

### 6.3 SR1 沙箱逃逸检测

```
输入：session.jsonl 中的工具调用记录
检测模式：
  1. 写操作超出 workspace 范围（路径分析）
  2. 执行未经审批的危险命令（命令分析）
  3. 访问系统级资源（/etc, /proc, 环境变量）
  4. 与 #1769 已知逃逸模式匹配（mount remount 等）
输出：SR1 check result
```

## 7. Layer 3: Lifecycle Checks（生命周期检查）

### 7.1 内置检查

| ID | 名称 | Severity | Phase | 描述 |
|---|---|---|---|---|
| **SL1** | supply-chain-integrity | HIGH | LIFECYCLE | 供应链完整性验证（包签名/哈希） |
| **SL2** | update-integrity | MEDIUM | LIFECYCLE | 更新完整性检查（版本篡改检测） |
| **SL3** | reputation-score | LOW | LIFECYCLE | 插件信誉评分（维护者/社区信号） |
| **SL4** | release-compat | MEDIUM | LIFECYCLE | 发布兼容性验证（dist-tag 一致性） |

### 7.2 集成

| 工具 | 集成方式 | 覆盖检查 |
|---|---|---|
| dsh-ecosystem | SL4 数据源 | 发布兼容性报告 |
| dsh-plugin-reducer | 故障最小化 | 故障插件集识别 |
| npm registry | SL1 数据源 | 包签名/哈希验证 |

## 8. 退出码映射

```
安全检查 severity → 退出码：

  CRITICAL 存在 → exit 2（阻断）
  HIGH 存在     → exit 1（警告）
  仅 MEDIUM/LOW/INFO → exit 0（信息）
  无安全检查     → exit 0（未启用）
```

**关键**：安全检查的退出码独立于现有检查的退出码。如果现有检查 exit 0 但安全检查 exit 2，最终 exit 取 max。

## 9. 配置

```json
// ~/.dsh/security.json（可选）
{
  "enabled": true,
  "checks": {
    "SP1": { "enabled": true, "severity": "high" },
    "SP2": { "enabled": true, "severity": "high" },
    "SP3": { "enabled": true, "severity": "medium" },
    "SS1": { "enabled": true, "severity": "critical" },
    "SR1": { "enabled": false, "severity": "critical" }
  },
  "external": {
    "poison-guard": { "enabled": true, "path": "dsh-poison-guard" },
    "sandbox-audit": { "enabled": true, "path": "dsh-sandbox-audit" }
  },
  "severityThreshold": "medium",  // 低于此 severity 的不报告
  "autoRedact": true              // 输出前自动脱敏
}
```

## 10. 用户界面

### 10.1 CLI

```bash
# 运行安全检查（profile 模式）
dsh-doctor --profile web --security

# 运行安全检查（env 模式）
dsh-doctor --env --security

# 运行安全检查（session 模式）
dsh-doctor --session <file> --security --observe

# 只运行安全检查（跳过现有检查）
dsh-doctor --profile web --security-only

# JSON 输出（集成用）
dsh-doctor --profile web --security --json
```

### 10.2 Web GUI

在设置→诊断面板中，安全检查结果以独立区域显示：

```
🔒 Security Checks
  ✅ SP1: 依赖链无已知漏洞
  ❌ SP2: 检测到硬编码密钥（HIGH）
     → cordis.patch.yml 第15行：疑似 API key
  ⚠️ SP3: 沙箱策略不一致（MEDIUM）
     → tool-fs 使用 bare fs-local backend
  ✅ SS1: 会话日志无凭据泄露
```

## 11. 实现路线图

### Phase 1: 基础框架 + Layer 1 内置检查（2 周）

- [ ] Layer 0: Check Protocol 实现
  - [ ] Severity/CheckPhase 枚举
  - [ ] v1 信封安全扩展
  - [ ] SecurityCheck 接口
  - [ ] `--security` CLI 标志
- [ ] Layer 1: SP2（密钥扫描）— 最高价值，立即可用
- [ ] Layer 1: SS1（凭据泄露检测）— 最高价值
- [ ] 测试：10+ fixture

### Phase 2: Layer 1 完整 + 外部集成（2 周）

- [ ] Layer 1: SP1（依赖链审计）
- [ ] Layer 1: SP3（沙箱策略一致性）
- [ ] Layer 1: SP6（已知漏洞匹配）
- [ ] Plugin Interface 实现
- [ ] dsh-poison-guard 集成
- [ ] dsh-sandbox-audit 集成
- [ ] 测试：20+ fixture

### Phase 3: Layer 2 运行时检查（3 周）

- [ ] --observe 安全事件检测扩展
- [ ] SR1（沙箱逃逸检测）
- [ ] SR3（数据外泄检测）
- [ ] 测试：15+ fixture

### Phase 4: Layer 3 + 生态集成（2 周）

- [ ] SL1（供应链完整性）
- [ ] SL4（发布兼容性）
- [ ] dsh-ecosystem 集成
- [ ] dsh-plugin-reducer 集成
- [ ] 测试：10+ fixture

## 12. 非目标

- **不做**运行时沙箱本身（那是上游的责任）
- **不做**入侵检测系统（IDS）（太重，超出 dsh-doctor 范围）
- **不做**插件行为分析（需要 LLM，成本太高）
- **不做**商业安全服务集成（保持开源）

## 13. 与现有工具的关系

```
dsh-doctor          ← 主执行者，Layer 1-3 内置检查
dsh-poison-guard    ← Layer 1 外部集成（投毒扫描）
dsh-sandbox-audit   ← Layer 1 外部集成（沙箱审计）
dsh-redact          ← Layer 1 SS1 的脱敏后端
dsh-shelf           ← Layer 2 会话数据源
dsh-plugin-reducer  ← Layer 3 故障最小化
dsh-ecosystem       ← Layer 3 发布兼容性数据源
```

## 14. 开放问题

1. **Severity 阈值**：是否应该允许用户自定义每个检查的 severity？（设计中已支持）
2. **自动修复**：SP2 检测到密钥后，是否提供一键修复（替换为环境变量引用）？
3. **性能**：SP1 依赖链审计可能很慢（npm audit 需要网络），是否需要异步/缓存？
4. **隐私**：SS1 扫描会话日志内容，是否需要用户明确同意？
