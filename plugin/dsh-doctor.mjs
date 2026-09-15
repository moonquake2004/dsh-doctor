#!/usr/bin/env node
/**
 * dsh-doctor.mjs — DSH 离线诊断工具（"装前/启动前跑一次，把坑提前填上"）
 *
 * 整合社区讨论中可离线检测的故障类别：
 *   [profile]
 *     P1  bundle 条目无法解析（#917/#1377/#880：remove 残留、静默禁用、启动 fail-fast）
 *     P2  bundle patch 与用户 patch insert 的 id 冲突（#1404：duplicate loader entry id）
 *     P3  用户 patch 的 insert name 从 profile 锚点不可解析（#1197/#880）
 *     P4  file: 依赖指向不存在的目录（#1197：悬空 file: 链接）
 *     P5  profile 顶层 @deepseek-ai/* 与框架重复（#1486：双模块实例 → Symbol 不匹配）
 *     P7  cordis.patch.yml 结构 lint（#1724：~ insert: 是 YAML null → parsePatchList 崩溃 → UI 打不开；tab 缩进/缺冒号同族）
 *     P8  adapter provider 注册冲突（#1904②：两 bundle 抢注同一 provider → boot 时 DUPLICATE_ADAPTER 崩溃）
 *     P9  ctx.settings 未声明 inject: ['settings']（#1904⑤：先于 settings 就绪激活 → namespace not registered）
 *     P10 inject 引用客户端专属服务（#1947：@deepseek-ai/dsh-client-* 服务端永不提供 → Fiber 永久 PENDING → web boot 失败）
 *     P11 已装 bundle 的 main 入口产物缺失（#1965：市场装未构建源码树 → ERR_MODULE_NOT_FOUND → boot 崩）
 *     P13 client 端 provide 服务名抢注核心客户端服务 / 跨 bundle 同名（#2752：浏览器端 service already registered → UI 白屏，服务端日志无感知）
 *     P17 client 端 require 不在宿主模块表（#5719：warn 级，种子表自省自 web-frontend 产物）
 *     P16 命名导入的导出缺失（#5864：warn 级，静态自省已装包导出面）
 *     P14 declared bin 可执行性（#1846：打包成功但 bin 缺 shebang/产物 → 直接执行 ENOEXEC；与 P11 互补）
 *     P12 `installed_bundle`（#1719 v1.1 词汇：profile 内 bundle 版本 vs 运行 CLI 版本——web 面板/API 跑的是 profile 里装的 bundle，可与独立 CLI 版本不一致）
 *   [session]
 *     S1  孤儿 tool_call（#1363：assistant tool_calls 无对应 tool 结果 → INVALID_REQUEST）
 *     S2  未闭合 turn（#466/#1265：turn/start 无 turn/end → 会话永久"运行中"）
 *     S6  seq 不连续/空洞/重复（#1333/#1452/#1469：官方 seq==index 校验，chunk 行按 expandRow 展开）
 *     S7  end-seed 后重放已提交尾部（#1497：种子末尾之后出现更低 seq）
 *     S9  zstd 容器结构（#1043：单帧容器 → session.list 整体 500，侧边栏全消失）
 *     S10 sourceEventSeqs 悬空引用（#1469：压缩未重映射溯源 → history unavailable）
 *     S8  未知事件类型且无 ignorable（#1538：harness 读不了 → 整包拒绝；可读集 = 安装的 dsh-session 当前表 ∪ dsh-session-format-* 迁移包旧类型，0.1.5-rc.1 回退）
 *     S12 迁移拒载预检（#6045/#6328/#6311：规则自省自已装 dsh-session-format-* 迁移包）
 *     S11 全会话扫描（#1550：损坏会话 → 隔离建议；超大会话/工作区估算物化堆 → 冷启动风险警告；估算堆=解码MB×6+事件×200B，阈值默认 1GB，可设 DSH_DOCTOR_HEAP_MB）
 *   [env]
 *     E1  关键命令不在 PATH（#1270：node/pnpm/zstd）
 *     E2  .env 是目录而非文件（#71：failed to load .env: EISDIR）
 *     E3  node 版本 / --expose-internals 可及性（#113/#1313，headless/HMR 场景）
 *     E4  node-pty 原生模块完整性（#1219：pty.node 缺失 → dsh web 启动失败）
 *     E5  存储 JSON 文件合法性（#1357：并发写 workspace.json 乱码 → 工作区列表消失）
 *     E6  锚点元检查（tripwire：S6 的 v0 chunk 展开契约、S7 的 session/end-seed、S10 的 sourceEventSeqs 是否仍在安装的 dsh-session/迁移包中；定位覆盖 npx/全局/profile 三布局）
 *     E10 3080 Web 端口可用性（#1719：启动 dsh web 前检查；dsh web 自身占用=正常，其他程序占用=FAIL；DSH_DOCTOR_PORT 可覆盖）
 *     （P6 Windows 空格参数 lint，#1420 —— 待实现）
 *
 * 用法：
 *   node dsh-doctor.mjs                # 全部检查
 *   node dsh-doctor.mjs --profile web  # 仅 profile 检查（可多次/逗号分隔）
 *   node dsh-doctor.mjs --session <path>  # 仅会话检查（默认自动找最新会话）
 *   node dsh-doctor.mjs --env          # 仅环境检查
 *   node dsh-doctor.mjs --json         # 输出 JSON
 *   node dsh-doctor.mjs --no-catalog   # 不拉远程检查目录（只用内置副本）
 *
 * 远程检查目录（层 A，v0.2.0）：内置 19 项之外，追加执行仓库 checks.json 里的声明式规则
 * （规则是数据、不是代码；只读探测原语，引擎不执行远程代码）。每次运行尝试拉取
 * raw.githubusercontent（3s 超时）→ 失败回退缓存（TTL 6h）→ 内置副本；新检查最长 6h 自动生效。
 *
 * 退出码：0 = 全部通过；1 = 发现可修复问题（内置 + catalog severity=error）；warn 级失败不改退出码。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { basename, delimiter as PATH_DELIM, dirname, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const results = []; // { section, id, ok, detail, fix? }
const jsonOut = process.argv.includes('--json');
const securityOnly = process.argv.includes('--security-only');
const only = process.argv
  .filter((a) => a.startsWith('--profile') || a.startsWith('--session') || a === '--env')
  .map((a) => a.startsWith('--') ? a.slice(2) : a);
const wants = (s) => only.length === 0 || only.includes(s) || only.includes(s.charAt(0).toUpperCase() + s.slice(1));

// S8：官方 KNOWN_SESSION_EVENT_TYPES（回退表对齐 0.1.5-rc.1；优先从安装的 dsh-session 动态解析）
const KNOWN_SESSION_EVENT_TYPES_FALLBACK = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
  'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done',
  'command/run', 'compaction/end', 'compaction/prune', 'compaction/start',
  'compaction/summary', 'feedback/message-delete', 'feedback/message-put', 'feedback/record',
  'goal/change', 'hook/invoked', 'hook/result', 'llm/retry',
  'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode',
  'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'step/end', 'step/start', 'subagent/descriptor', 'subagent/model-selection-policy',
  'system/message', 'team/member', 'team/message/delivered', 'team/message/queued',
  'team/task', 'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start',
  'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch',
  'tool/ptc-dispatch-start', 'tool/result', 'turn/end', 'turn/start',
  'user/message', 'web/deepseek-search-llm-request'
]);
// 存储行类型与 header，不属于事件门禁
const STORAGE_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'session']);
/** 定位已安装的 dsh-session lib/index.js —— 覆盖三种安装形态（0.1.5 起 dsh 转全局安装，旧的 npx-only 查找会静默回退）：
 *  ① npx/pnpm：<root>/node_modules/.bin/dsh → <root>/node_modules/@deepseek-ai/dsh-session
 *  ② 全局 npm：<prefix>/bin/dsh → <prefix>/lib/node_modules/@deepseek-ai/dsh[/node_modules]/@deepseek-ai/dsh-session
 *  ③ profile：$DSH_HOME/profiles/<name>/node_modules/@deepseek-ai/dsh-session（含 .pnpm store）
 *  找不到返回 null —— 调用方回退内置假设并**声明**（不静默）。 */
function findSessionLibs() {
  const REL = join('@deepseek-ai', 'dsh-session', 'lib', 'index.js');
  const cands = [];
  for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
    if (!p || !existsSync(join(p, 'dsh'))) continue;
    cands.push(join(dirname(p), REL)); // ① npx/pnpm 布局
    let real = null;
    try { real = realpathSync(join(p, 'dsh')); } catch { /* 忽略 */ }
    if (real) {
      let d = dirname(real);
      for (let i = 0; i < 5; i++) {
        cands.push(join(d, 'node_modules', REL)); // ② <pkg>/node_modules/…
        cands.push(join(d, REL));                 // ② hoisted 到 <dir>/@deepseek-ai/
        const up = dirname(d);
        if (up === d) break;
        d = up;
      }
    }
  }
  const profiles = join(HOME, 'profiles'); // ③
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const nm = join(profiles, name, 'node_modules');
      cands.push(join(nm, REL));
      const store = join(nm, '.pnpm');
      if (existsSync(store)) {
        for (const d of readdirSync(store)) {
          if (d.startsWith('@deepseek-ai+dsh-session@')) cands.push(join(store, d, 'node_modules', REL));
        }
      }
    }
  }
  return [...new Set(cands.filter((c) => existsSync(c)))];
}

/** 机器上可能同时装着多份 dsh（全局 + 多个 npx checkout）——取版本最高的一份做"当前契约"，
 *  可读类型则取所有安装的并集（任一安装能读的旧类型都不该判"读不了"）。 */
function pickNewestSessionLib(libs) {
  let best = null; let bestV = null;
  for (const lib of libs) {
    let v = null;
    try { v = JSON.parse(readFileSync(join(dirname(dirname(lib)), 'package.json'), 'utf8')).version; } catch { /* 忽略 */ }
    if (!v) { if (!best) best = lib; continue; }
    const key = v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
    if (!bestV || key.some((n, i) => n !== (bestV[i] ?? 0) && n > (bestV[i] ?? 0) && bestV.slice(0, i).every((m, j) => m === key[j]))) { best = lib; bestV = key; }
    else if (!best) { best = lib; bestV = key; }
  }
  return best;
}

/** 单份安装的事件类型表（解析失败返回 null）。 */
function sessionTableFrom(lib) {
  try {
    const s = readFileSync(lib, 'utf8');
    const m = /const KNOWN_SESSION_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/.exec(s);
    if (!m) return null;
    const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    return items.length ? new Set(items) : null;
  } catch { return null; }
}

/** 某份安装同级的会话格式迁移包（v0→v1→v2→v3）所认的旧类型。 */
function migratorTypesFor(lib) {
  const out = [];
  const nm = lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session')));
  const libs = [];
  const scope = join(nm, '@deepseek-ai');
  if (existsSync(scope)) {
    for (const d of readdirSync(scope)) if (d.startsWith('dsh-session-format-')) libs.push(join(scope, d, 'lib', 'index.js'));
  }
  const store = join(nm, '.pnpm');
  if (existsSync(store)) {
    for (const d of readdirSync(store)) {
      if (!d.startsWith('@deepseek-ai+dsh-session-format-')) continue;
      const inner = join(store, d, 'node_modules', '@deepseek-ai');
      if (!existsSync(inner)) continue;
      for (const p of readdirSync(inner)) if (p.startsWith('dsh-session-format-')) libs.push(join(inner, p, 'lib', 'index.js'));
    }
  }
  for (const f of libs) {
    try {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/"([a-z][a-z0-9-]*\/[a-z0-9-]+)"/g)) out.push(m[1]);
    } catch { /* 忽略单个包 */ }
  }
  return out;
}

const SESSION_LIBS = findSessionLibs();
/** 定位安装的 dsh-session（新→旧取最高版本；找不到返回 null）。 */
function findSessionLib() { return pickNewestSessionLib(SESSION_LIBS) || null; }

function knownSessionEventTypes() {
  const lib = findSessionLib();
  if (lib) {
    const t = sessionTableFrom(lib);
    if (t) return t;
  }
  return KNOWN_SESSION_EVENT_TYPES_FALLBACK;
}

const KNOWN = knownSessionEventTypes();

/** 可读类型集 = 当前 KNOWN ∪ 已装 dsh-session-format-* 迁移包认的旧类型（0.1.5 起会话格式有 v0→v1→v2→v3 迁移链）。
 *  只比对当前表会把**可迁移的旧会话**误判为"harness 读不了"（#1538 的语义是"读不了"，迁移得了就不算）。
 *  旧类型在磁盘日志里真实存在（v0 日志含 assistant/chunk、tool/code-dispatch 等），迁移包负责转换。 */
function readableSessionEventTypes() {
  const set = new Set(KNOWN);
  for (const lib of SESSION_LIBS) {
    const t = sessionTableFrom(lib);
    if (t) for (const x of t) set.add(x);
    for (const x of migratorTypesFor(lib)) set.add(x);
  }
  return set;
}

const READABLE = readableSessionEventTypes();

/**
 * 是否存在值得诊断的 DSH 环境（真实用户机器有 sessions/ 或 settings.yaml；干净容器/仓库检出没有）。
 * 以传入的 home 为准：探针应当判断"它被告知的那个环境"，而不是进程全局的 HOME ——
 * 这样单测可以显式构造两种环境，fixture 也不会被真实 HOME 的状态污染。
 */
function hasDshEnvironment(home = HOME) {
  return existsSync(join(home, 'sessions')) || existsSync(join(home, 'settings.yaml'));
}

function report(section, id, ok, detail, fix, src) {
  results.push({ section, id, ok, detail, fix, src: src ?? 'builtin' });
}

/** skip 状态（v1 词汇表 r5：#1719）——"不适用"而非"通过"，必须带 reason（detail）。不计入 pass/fail，不翻退出码。 */
function reportSkip(section, id, detail, src) {
  results.push({ section, id, ok: true, skip: true, detail, src: src ?? 'builtin' });
}

/** 解析 --profile 参数：名字（如 web）→ $DSH_HOME/profiles/<name>；含路径分隔符/~/开头 → 直接当 profile 目录（契约 harness 传绝对路径）。 */
function resolveProfile(name) {
  if (!name) throw new Error('无效 profile 名');
  if (name.includes('/') || name.includes('\\') || name.startsWith('~') || name.startsWith('.')) {
    return name.startsWith('~') ? join(homedir(), name.slice(1)) : name;
  }
  return join(HOME, 'profiles', name);
}

/* ================= env ================= */
/** v1 词汇表 r5（#1719/#2259）node 语义：pass = 满足 ^22.19.0 || >=24.0.0，其余 warn——无民间 fail 阈值。
 *  注（2026-09 更正）：该范围来自 v1 词汇表对齐，**不是**从某个 package.json 读来的；
 *  已发布的 `@deepseek-ai/dsh@0.1.5-rc.1` **不含 engines 字段**，此前文案写"root package.json engines"属出处误引。 */
function nodeInSupportedRange(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  if (!m) return false;
  const major = Number(m[1]); const minor = Number(m[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}
function checkEnv() {
  if (!wants('env')) return;
  const find = (cmd) => { for (const w of process.platform === 'win32' ? ['where'] : ['which']) { const r = spawnSync(w, [cmd]); if (r.status === 0) { const p = String(r.stdout).split(/\r?\n/)[0].trim(); if (p) return p; } } return null; };
  for (const cmd of ['node', 'pnpm', 'zstd']) {
    const p = find(cmd);
    report('env', `E1-${cmd}`, !!p, p ? `${cmd}: ${p}` : `${cmd} 不在 PATH（${cmd === 'node' ? '创建会话会失败 #1270' : cmd === 'pnpm' ? 'dsh plugin 不可用（corepack 可恢复：corepack enable pnpm）' : '会话日志解压不可用'}）`, p ? undefined : (cmd === 'pnpm' ? 'corepack enable pnpm 或安装 pnpm 后加入 PATH' : `安装 ${cmd} 或加入 PATH`));
  }
  const envFile = join(HOME, '.env');
  if (existsSync(envFile)) {
    const isDir = lstatSync(envFile).isDirectory();
    report('env', 'E2-env', !isDir, isDir ? `${envFile} 是目录，dsh 启动会报 failed to load .env: EISDIR（#71）` : `${envFile} 正常`, isDir ? '删除或改名该目录' : undefined);
  }
  const nv = spawnSync('node', ['-e', 'console.log(process.version)']);
  if (nv.status === 0) {
    const version = String(nv.stdout).trim();
    const supported = nodeInSupportedRange(version);
    report('env', 'E3-node', supported,
      supported ? `node ${version}（满足 v1 词汇表支持范围 ^22.19.0 || >=24.0.0；该版本未发布 engines 字段，#2259）` : `node ${version} 不在支持范围（^22.19.0 || >=24.0.0，v1 词汇表）——会话日志读取等能力受限`,
      supported ? undefined : '升级 node 到 ^22.19.0 或 >=24.0.0（v1 词汇表范围，见 #2259）');
  }

  // E12：运行时 zstd 稳定性（#6651 的运行时线索）
  // 锚点已核实：dsh-session-persistence-jsonl:15 直接 `import { zstdCompress, zstdDecompress,
  // zstdDecompressSync } from "node:zlib"`（用于 :1263 / :1287 / :1368）——会话日志的读写**依赖 Node 内置 zstd**。
  // 该 API 在部分 Node 版本上仍是实验性的；社区报告 #6651（Linux + Node 22.22.3）出现首帧损坏让
  // `dsh web` 无法启动，换到 Node 26 后正常，怀疑写入侧不稳。故这里如实报告运行时状态，不做因果断言。
  if (!hasDshEnvironment(HOME)) {
    reportSkip('env', 'E12', '未发现 DSH 环境，跳过运行时 zstd 稳定性检查');
  } else {
    const zstdFn = (() => { try { return createRequire(import.meta.url)('node:zlib').zstdDecompressSync; } catch { return null; } })();
    if (typeof zstdFn !== 'function') {
      report('env', 'E12', false,
        `当前 Node（${process.version}）没有 zlib.zstdDecompressSync——而会话持久化直接依赖它读写 .zstd 日志（#6651 同族风险）`,
        '升级 Node 到内置 zstd 的版本（22.15+/23.8+），否则该运行时的 .zstd 会话日志无法读写');
    } else {
      // 用子进程观察 Node 是否对该 API 发出实验性警告（版本无关的经验判据，避免硬编码版本表）
      let experimental = false; let probed = false;
      try {
        const r = spawnSync(process.execPath, ['-e', 'require("node:zlib").zstdDecompressSync(require("node:zlib").zstdCompressSync(Buffer.from("x")))'], { encoding: 'utf8', timeout: 10000 });
        probed = true;
        experimental = /ExperimentalWarning/.test(String(r.stderr || ''));
      } catch { /* 探测失败 → 下面按"未探明"处理 */ }
      if (!probed) reportSkip('env', 'E12', '运行时 zstd 实验性探测未能执行，跳过（不外推为通过）');
      else if (experimental) {
        report('env', 'E12', false,
          `当前 Node（${process.version}）的 zlib zstd 仍标记为**实验性**——会话持久化直接依赖它读写日志；社区报告 #6651 在同类运行时上出现首帧损坏并导致 dsh web 无法启动（换新版 Node 后正常，因果未定）`,
          '升级到 zstd 已稳定的 Node（本工具在 24.x 上实测无实验性警告）后再观察；同时建议先用 dsh-doctor 扫一遍会话库有无 S13 类损坏');
      } else {
        report('env', 'E12', true, `运行时 zstd 非实验性（Node ${process.version}）`, undefined);
      }
    }
  }

  // E4：node-pty 原生模块完整性（#1219：pty.node 缺失 → dsh web 启动失败）
  const ptyDirs = [];
  for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
    if (p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh'))) {
      ptyDirs.push(join(dirname(p), 'node-pty'));
      break;
    }
  }
  const profileNM = join(HOME, 'profiles', 'web', 'node_modules');
  ptyDirs.push(join(profileNM, 'node-pty'));
  const pnpmStore = join(profileNM, '.pnpm');
  if (existsSync(pnpmStore)) {
    for (const d of readdirSync(pnpmStore)) if (d.startsWith('node-pty@')) ptyDirs.push(join(pnpmStore, d, 'node_modules', 'node-pty'));
  }
  const plat = `${process.platform}-${process.arch}`;
  // 无对象可查时 skip 而非 fail（2026-09 修正）：E4 的判据是"**已安装的** dsh 里 node-pty 是否完整"，
  // 但此前在**没有任何 node_modules 的合成 HOME**（测试 fixture、全新环境）里也会报"未找到 node-pty" ——
  // 那不是"缺失"，而是"这里根本没有安装树可查"。据此报 fail 会让 fixture 全红、也会让 CI 在
  // 干净容器里得到无意义的 exit 2。与项目一贯纪律一致：不适用 ⇒ skip 且带 reason。
  // "有安装树可查" = PATH 里找到了 dsh 的 node_modules，**或**本 HOME 的 profile 里有 node_modules。
  // 二者皆无（合成 HOME、干净容器）→ 这里没有"已安装的 dsh"可言，报 fail 是无意义的。
  const fromPath = ptyDirs.length > 0 && existsSync(ptyDirs[0]);
  const hasInstall = fromPath || existsSync(profileNM);
  const ptyFound = ptyDirs.filter((d) => existsSync(d));
  let ptyBinary = null;
  for (const d of ptyFound) {
    for (const bin of [join(d, 'prebuilds', plat, 'pty.node'), join(d, 'build', 'Release', 'pty.node')]) {
      if (existsSync(bin) && statSync(bin).size > 0) { ptyBinary = bin; break; }
    }
    if (ptyBinary) break;
  }
  if (!hasInstall) reportSkip('env', 'E4', '未发现 DSH 安装树（无 profiles/node_modules 可查），跳过 node-pty 完整性检测');
  else if (ptyFound.length === 0) report('env', 'E4', false, '未找到 node-pty（dsh web 终端依赖它，#1219）', '重新安装 @deepseek-ai/dsh，确保 node-pty 装全');
  else if (ptyBinary) report('env', 'E4', true, `node-pty 原生模块在位（${plat}）`, undefined);
  else report('env', 'E4', false, `node-pty 存在但缺 ${plat} 原生二进制（#1219: dsh web 启动失败）`, '重装 node-pty（npm rebuild node-pty）或从源码构建');

  // E5：存储 JSON 文件合法性（#1357：并发写 workspace.json 乱码 → 工作区列表消失）
  const storages = join(HOME, 'storages');
  const badStorage = [];
  if (existsSync(storages)) {
    for (const f of readdirSync(storages)) {
      if (!f.endsWith('.json')) continue;
      const fp = join(storages, f);
      let buf;
      try { buf = readFileSync(fp); } catch { badStorage.push(`${f}（读取失败）`); continue; }
      let utf8ok = true;
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { utf8ok = false; }
      let jsonok = false;
      if (utf8ok) { try { JSON.parse(buf.toString('utf8')); jsonok = true; } catch { /* 非法 JSON */ } }
      if (!jsonok) badStorage.push(`${f}（UTF-8:${utf8ok ? 'OK' : 'BAD'}，JSON:${jsonok ? 'OK' : 'BAD'}）`);
    }
  }
  if (badStorage.length) report('env', 'E5', false, `存储文件损坏（#1357 并发写乱码类）: ${badStorage.join(', ')}`, '排查是否有多个 dsh 实例并发写同一 storages；修复或删除损坏文件');
  else report('env', 'E5', true, '存储 JSON 文件均合法', undefined);

  // E6：锚点元检查（tripwire）——我们 S6/S7/S10 依赖的契约是否仍在安装的 dsh-session 里
  // 上游改名/重构会让我们的离线结论静默腐烂（boyin111-1 的 --verify-anchors 同款思路）
  const sessionLib = findSessionLib();
  if (!sessionLib) {
    // r5 语义：锚点校验在此上下文"不适用"（找不到安装）——用 skip 而非静默 pass，理由写进 detail
    reportSkip('env', 'E6', '未定位到 dsh-session（npx/全局/profile 三种布局都没有）——锚点未校验，S6/S7/S10 结论回退内置假设', undefined);
  } else {
    const src = readFileSync(sessionLib, 'utf8');
    // 0.1.5 起 expandRow 从 dsh-session 移到会话格式迁移包（v0→v1→v2→v3），锚点随之迁移：
    // S6 读的是磁盘上的 v0/v1 日志，其 chunk 展开契约由迁移链承载。
    const migratorLib = (() => {
      const nm = sessionLib.slice(0, sessionLib.indexOf(join('@deepseek-ai', 'dsh-session')));
      const p = join(nm, '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js');
      return existsSync(p) ? p : null;
    })();
    const expandOk = /function expandRow[\s\S]*?row\.seq0/.test(src)
      || (migratorLib ? /"assistant\/chunk":\s*disposition\(/.test(readFileSync(migratorLib, 'utf8')) : false);
    const anchors = [
      ['v0 chunk 展开契约（S6 依赖；dsh-session 的 expandRow 或迁移包 disposition）', expandOk],
      ['session/end-seed 字面量（S7 依赖）', /"session\/end-seed"/.test(src)],
      ['sourceEventSeqs 字段（S10 依赖）', /sourceEventSeqs/.test(src)],
    ];
    const missing = anchors.filter(([, okFlag]) => !okFlag);
    if (missing.length) {
      report('env', 'E6', false, `锚点缺失（上游可能改了契约，S6/S7/S10 结论需人工复核）: ${missing.map(([n]) => n).join('; ')}（${sessionLib.slice(-60)}）`, '对照上游变更更新 dsh-doctor 的对应检查');
    } else {
      report('env', 'E6', true, `锚点齐全（${anchors.length}/3: v0 chunk 展开 / session/end-seed / sourceEventSeqs）`, undefined);
    }
  }
}

/* ================= E10：Web 端口可用性（#1719 提案；启动 dsh web 前检查，避免 address in use） =================
 * 本地 socket bind 探测（离线兼容）：端口空闲 → PASS；被 dsh web 实例占用 → PASS+提示
 * （宿主自身或另一实例，正常）；被其他程序占用 → FAIL。
 * 默认 3080，可用 DSH_DOCTOR_PORT 覆盖（测试/换端口）。
 */
function portOccupierInfo(port) {
  try {
    if (process.platform === 'win32') {
      const r = execFileSync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const m = new RegExp(`TCP\\s+[^\\s]+:${port}\\s+.*?LISTENING\\s+(\\d+)`).exec(r);
      if (!m) return null;
      return { pid: m[1], cmd: '', dsh: false };
    }
    const r = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const lines = r.trim().split('\n').slice(1).filter(Boolean);
    if (!lines.length) return null;
    const parts = lines[0].trim().split(/\s+/);
    const cmd = parts[0] || '';
    const pid = parts[1] || '';
    let dsh = /dsh|deepseek/.test(cmd);
    if (!dsh && pid) {
      try {
        dsh = /dsh web|deepseek-ai|harness/.test(execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }));
      } catch { /* ps 不可用（权限/平台）→ 走 lsof 兜底 */ }
      if (!dsh) {
        try {
          // 兜底：ps 命令串可能不含连续 "dsh web"（npx/pnpm 安装形态），改用 lsof 的 cwd/txt 路径识别 harness 安装。
          // 只认真实安装签名（npx 缓存 / @deepseek-ai 包目录），避免把任意含 "dsh" 路径段的工作目录误判为 dsh。
          const lsofP = execFileSync('lsof', ['-p', pid], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
          dsh = /\.npm\/_npx\/|node_modules\/@deepseek-ai\//.test(lsofP);
        } catch { /* 无法识别则按非 dsh 处理 */ }
      }
    }
    return { pid, cmd, dsh };
  } catch { return null; }
}

function checkPort3080() {
  return new Promise((resolve) => {
    if (!wants('env')) { resolve(); return; }
    const port = Number(process.env.DSH_DOCTOR_PORT || 3080);
    const srv = net.createServer();
    srv.unref();
    let done = false;
    const finish = (fn) => (...args) => { if (done) return; done = true; try { fn(...args); } catch { } resolve(); };
    srv.on('error', finish((e) => {
      if (e.code === 'EADDRINUSE') {
        const info = portOccupierInfo(port);
        if (info && info.dsh) report('env', 'E10-port-3080', true, `端口 ${port} 被 dsh web 实例占用（PID ${info.pid}）——宿主自身或另一实例，正常`, undefined);
        else if (info) report('env', 'E10-port-3080', false, `端口 ${port} 被其他程序占用（PID ${info.pid}: ${info.cmd}），dsh web 启动会 address in use（#1719）`, `关掉占用进程，或让 dsh web 用别的端口`);
        else report('env', 'E10-port-3080', true, `⚠ 端口 ${port} 被占用但无法识别占用者`, undefined);
      } else {
        report('env', 'E10-port-3080', false, `端口 ${port} 探测异常: ${e.message.slice(0, 60)}`, undefined);
      }
    }));
    srv.listen(port, '127.0.0.1', finish(() => { srv.close(); report('env', 'E10-port-3080', true, `端口 ${port} 空闲`, undefined); }));
  });
}

/* ================= profile ================= */
function checkProfile(name) {
  if (!wants('profile')) return;
  let dir;
  try { dir = resolveProfile(name); } catch (e) { report('profile', 'P0', false, e.message); return; }
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) { report('profile', 'P0', false, `profile 不存在: ${dir}`); return; }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const deps = manifest.dependencies ?? {};

  const installAnchor = (() => {
    // 从 PATH 找 dsh 的安装目录（node_modules），用于 bundle 双锚点解析
    for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
      if (p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh'))) return dirname(p);
    }
    return null;
  })();
  const findPkg = (pkgName) => {
    const cands = [
      installAnchor ? join(installAnchor, pkgName) : null,
      join(dir, 'node_modules', pkgName),
    ].filter(Boolean);
    return cands.find((c) => existsSync(join(c, 'package.json'))) ?? null;
  };
  const readInsertIds = (patchFile) => {
    const ids = new Set();
    if (!existsSync(patchFile)) return ids;
    const lines = readFileSync(patchFile, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)- insert:\s*$/);
      if (!m) continue;
      const base = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const indent = (l.match(/^\s*/) || [''])[0].length;
        if (indent <= base) break; // insert 块结束
        const im = l.match(/^\s*-\s*id:\s*['"]?([^'"\s]+)/);
        if (im) ids.add(im[1]);
      }
    }
    return ids;
  };
  const patchPath = join(dir, 'cordis.patch.yml');
  const userIds = readInsertIds(patchPath);
  const userNames = (() => {
    const out = new Set();
    if (!existsSync(patchPath)) return out;
    const text = readFileSync(patchPath, 'utf8');
    // 真实格式：`- id:` 下缩进的 `name:` 行（无破折号）——2026-08-15 fixtures 发现旧正则从未匹配
    for (const m of text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)/gm)) out.add(m[1]);
    return out;
  })();

  // P1 bundles 可解析性
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) {
      // installAnchor 为 null（web GUI/无 dsh 锚点）时，宿主侧 bundle 无法验证——
      // 跳过而非误报（#917 core bundles dsh-base/dsh-web-app 由宿主直接提供，
      // 不在 profile node_modules 里，installAnchor 缺失时 findPkg 找不到是正常的）
      if (!installAnchor) continue;
      report('profile', 'P1', false, `bundle 条目 ${b} 无法在安装目录或 profile node_modules 解析（#917/#1377/#880）`, `dsh plugin --profile ${name} add ${b} 或从 dsh.profile.bundles 移除`);
    } else {
      const pkg = JSON.parse(readFileSync(join(dir2, 'package.json'), 'utf8'));
      if (!pkg.dsh?.bundle?.patch) {
        report('profile', 'P1', false, `bundle 条目 ${b} 存在但未声明 dsh.bundle（#1377 静默禁用类）`, '检查该包版本或移除条目');
      }
    }
  }
  // P2 id 冲突（#1404 bundle↔user + #2315 bundle↔bundle）
  const bundleIdSources = new Map(); // id → Set<bundle name>
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) continue;
    const pkg = JSON.parse(readFileSync(join(dir2, 'package.json'), 'utf8'));
    const rel = pkg.dsh?.bundle?.patch;
    if (!rel) continue;
    for (const id of readInsertIds(join(dir2, rel))) {
      if (!bundleIdSources.has(id)) bundleIdSources.set(id, new Set());
      bundleIdSources.get(id).add(b);
    }
  }
  // 跨 bundle 冲突：多个 bundle 注册同一 entry id（#2315 dsh-tui↔dsh-web-app agent-presets）
  const crossBundleDup = [...bundleIdSources].filter(([, s]) => s.size > 1).map(([id, s]) => `${id}（${[...s].join(' + ')}）`);
  // bundle vs 用户 patch 冲突（#1404）
  const userBundleDup = [...bundleIdSources.keys()].filter((id) => userIds.has(id));
  const p2Issues = [];
  if (crossBundleDup.length) p2Issues.push(`多个 bundle 注册相同 entry id（启动必崩 duplicate loader entry id，#2315）: ${crossBundleDup.join('; ')}`);
  if (userBundleDup.length) p2Issues.push(`bundle 与用户 patch 的 id 冲突（启动必崩 duplicate loader entry id，#1404）: ${userBundleDup.join(', ')}`);
  if (p2Issues.length) {
    report('profile', 'P2', false, p2Issues.join(' | '), crossBundleDup.length ? '移除冲突 bundle 中的一个（如不兼容的 TUI/standalone 插件误装入 profile），或让上游协商唯一 entry id' : `备份后从 ${patchPath} 删除这些 insert（或运行 check-dsh-profile.mjs 查看详情）`);
  } else {
    report('profile', 'P2', true, '无 bundle/用户 patch id 冲突', undefined);
  }
  // P3 insert name 可解析性
  const req = (() => { try { return createRequire(join(dir, '_anchor.js')); } catch { return null; } })();
  // 判据（#1719 taltara 的正确性陷阱，2026-09-12 实测命中我们）：**不能以 require.resolve 为准** ——
  // ESM-only 包（exports 只声明 import 条件）会让 require.resolve 抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
  // 而 loader 能正常 import；用它判定会把健康 profile 报成 FAIL（比没有 doctor 更糟）。
  // 改为**存在性判据**：node_modules/<name>/package.json 存在即可（scoped 取两段），
  // 并向上找一层以覆盖 profile 根安装（~/.dsh/profiles/node_modules）。require.resolve 仅作正向加分。
  const nmRoots = [join(dir, 'node_modules'), join(dirname(dir), 'node_modules')];
  const pkgPresent = (n) => {
    if (n.startsWith('cordis:')) return true;                      // 宿主内置
    if (n.startsWith('.') || n.startsWith('/') || n.startsWith('~')) return true; // 相对/绝对路径
    const seg = String(n).split('/');
    const pkgName = n.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];        // scoped 需两段
    if (!pkgName) return true;
    return nmRoots.some((root) => existsSync(join(root, pkgName, 'package.json')));
  };
  const bad = [];
  for (const n of userNames) {
    if (n.startsWith('@local/') || n.startsWith('@liustack/')) {
      const fp = deps[n];
      if (fp && fp.startsWith('file:')) {
        const target = join(dir, fp.slice(5));
        if (!existsSync(target)) bad.push(`${n} (file: 目标不存在: ${fp})`);
        continue;
      }
    }
    let resolved = false;
    try { if (req) { req.resolve(n); resolved = true; } } catch { resolved = false; }
    if (!resolved && !pkgPresent(n)) bad.push(n);
  }
  if (bad.length) report('profile', 'P3', false, `用户 patch 中不可解析的 name（#1197/#880）: ${bad.join(', ')}`, `dsh plugin --profile ${name} add <包> 或修复 file: 依赖`);
  else report('profile', 'P3', true, '用户 patch insert 均可解析', undefined);
  // P18：profile manifest 的 version（#6667）
  // 锚点：dsh-plugin-package-inventory-deepseek/lib/index.js:34 —— identityFromManifest 会抛
  // `must declare non-empty name and version`；它虽有 allowAnonymous 容忍**缺 name**，但**不容忍缺 version**。
  // 而 harness 自己生成的 profile manifest 恰恰是「有 name、无 version」（本机 web/daily 皆如此）。
  // 触发条件：从 profile 根解析到**游离本地模块**时，最近的 manifest（即 profile 自身）会被当包处理 → 抛错 →
  // DeepSeek 请求以 REQUEST_EXTENSION 失败（#6667 报告的最小复现）。故这里按"条件性风险"报 warn，不报 fail。
  {
    let profManifest = null;
    try { profManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { profManifest = null; }
    if (!profManifest || !(profManifest.dsh && profManifest.dsh.profile)) {
      reportSkip('profile', 'P18', '未找到 profile manifest（无 dsh.profile），跳过 version 检查');
    } else if (typeof profManifest.version === 'string' && profManifest.version.length > 0) {
      report('profile', 'P18', true, `profile manifest 声明了 version（${profManifest.version}），不触发 #6667`);
    } else {
      report('profile', 'P18', false,
        `profile manifest 有 name（${profManifest.name}）但**没有 version**——与 #6667 的条件一致：package inventory 在解析**游离本地模块**时会把该 manifest 当包处理并抛 "must declare non-empty name and version"（dsh-plugin-package-inventory-deepseek:34；其 allowAnonymous 只容忍缺 name），表现为 DeepSeek 请求 REQUEST_EXTENSION 失败`,
        '上游修复前可先给 profile manifest 补一行 version（如 "version": "0.0.0"）作为绕过；若有游离 .mjs/.js 模块被加载，这是首要排查点');
    }
  }

  // P4 file: 依赖悬空（file: 目标可能是相对（file:./plugins/x）或绝对（file:/abs/path））
  const resolveFileSpec = (spec) => {
    const target = spec.slice(5);
    return /^[/\\]|^[A-Za-z]:/.test(target) ? target : join(dir, target);
  };
  const dangling = Object.entries(deps).filter(([, spec]) => spec.startsWith('file:')).filter(([, spec]) => !existsSync(resolveFileSpec(spec)));
  if (dangling.length) report('profile', 'P4', false, `悬空 file: 依赖（#1197）: ${dangling.map(([n, s]) => `${n} (${s})`).join(', ')}`, '恢复目录或移除依赖');
  else report('profile', 'P4', true, 'file: 依赖完整', undefined);
  // P5 顶层 @deepseek-ai/* 重复（#1486/#1697：hoisted 布局下同版本双实例 → 模块级 Symbol 不匹配）
  // symlink 指向宿主同一份（#1697 的 link: workaround / pnpm file: 正常形态）= 单实例，放行
  const topDup = [];
  const topDir = join(dir, 'node_modules', '@deepseek-ai');
  const hostScope = installAnchor ? join(installAnchor, '@deepseek-ai') : null;
  if (existsSync(topDir)) {
    for (const p of readdirSync(topDir)) {
      const fp = join(topDir, p);
      let st;
      try { st = lstatSync(fp); } catch { continue; }
      if (st.isSymbolicLink()) {
        if (!hostScope) continue; // installAnchor 缺失时无法验证 symlink 指向宿主——跳过（#1697 workaround 已知安全形态）
        try {
          const real = realpathSync(fp);
          const hostPkg = join(hostScope, p);
          if (existsSync(hostPkg) && realpathSync(hostPkg) === real) continue; // 宿主同一份
        } catch { /* 无法解析 → 按独立副本处理 */ }
      }
      if (existsSync(join(fp, 'package.json'))) topDup.push(p);
    }
  }
  if (topDup.length) report('profile', 'P5', false, `profile 顶层存在 @deepseek-ai/* 重复（#1486/#1697 双实例风险，hoisted 布局会让同版本工具包互相遮蔽导致 Symbol 不匹配）: ${topDup.join(', ')}`, '清理 profile 顶层 node_modules/@deepseek-ai 中与宿主同名的独立副本（真实目录）；指向宿主的 link: symlink 是安全的（#1697 workaround）');
  else report('profile', 'P5', true, '无顶层 @deepseek-ai 重复', undefined);

  // P7 patch YAML 结构 lint（#1724：~ insert: / 顶层映射+序列混排 / tab / 缺冒号 → parsePatchList 崩 → UI 打不开）
  // 离线、零依赖的保守检查，覆盖已实测的崩溃机制：
  //   1) ~ / null 等非法 insert 标记（~ 是 YAML null）
  //   2) 顶层映射(key: value)与顶层序列(- xxx)混排 → js-yaml "document separator expected"
  //   3) tab 缩进（YAML 硬错误）；4) insert 缺冒号
  const yamlProblems = [];
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  if (patchText) {
    const topLines = patchText.split('\n');
    let hasTopMapping = false, hasTopSeq = false;
    topLines.forEach((line, i) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      if (line.includes('\t')) yamlProblems.push(`第 ${i + 1} 行含制表符缩进（YAML 禁止 tab）`);
      if (/^\s*(~|null|Null|NULL)\s*insert\s*:/.test(line)) yamlProblems.push(`第 ${i + 1} 行 "${line.trim()}" —— ~ 是 YAML null 字面量，应为 "- insert:"（#1724）`);
      else if (/^\s*-\s*insert(\s|$)/.test(line) && !/^\s*-\s*insert\s*:/.test(line)) yamlProblems.push(`第 ${i + 1} 行 "${line.trim()}" —— "- insert" 缺冒号`);
      // 顶层混排检测：col 0 的映射键 vs col 0 的序列项
      if (!/^\s/.test(line)) {
        if (/^[^\s#-][^:]*:\s/.test(line)) hasTopMapping = true;
        if (/^-\s/.test(line)) hasTopSeq = true;
      }
    });
    if (hasTopMapping && hasTopSeq) yamlProblems.push('顶层同时存在 key: value 映射与 - xxx 序列（js-yaml 报 "stream or a document separator is expected"，#1724 实测）');
  }
  if (yamlProblems.length) report('profile', 'P7', false, `cordis.patch.yml 结构错误（boot 会崩，UI 打不开 #1724）: ${yamlProblems.join('; ')}`, 'patch 必须是顶层纯列表（只有 - insert: / - id: 条目）：删掉顶层 key: value 行；~ 是 YAML null；缩进用空格不用 tab');
  else report('profile', 'P7', true, 'cordis.patch.yml 结构正常（无 tab / 无 ~ insert / 无映射-序列混排）', undefined);

  // P8/P9 需要扫描 bundle 构建产物：收集目录下有限深度的 .js 文件（lib/dist/根 + main 入口，跳过 node_modules）

/** 从 fromDir 向上找 node_modules 里的裸包目录（也查 profile 与 CLI 安装）；找不到返回 null。 */
/** 用户 patch 中标记 `disabled: true` 的 entry id 集合（P16 用：区分"已禁用不会崩"与"启用即崩"）。 */
function disabledPatchIds() {
  const set = new Set();
  const f = join(HOME, 'profiles', 'web', 'cordis.patch.yml');
  if (!existsSync(f)) return set;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return set; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (/^\s*-?\s*id:/.test(lines[j])) break;
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) { set.add(m[1]); break; }
    }
  }
  return set;
}

function resolveInstalledPackage(spec, fromDir) {
  const seg = spec.split('/');
  const name = spec.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];
  const cands = [];
  let d = fromDir;
  for (let i = 0; i < 6; i++) {
    cands.push(join(d, 'node_modules', name));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const profiles = join(HOME, 'profiles');
  if (existsSync(profiles)) for (const p of readdirSync(profiles)) cands.push(join(profiles, p, 'node_modules', name));
  for (const lib of SESSION_LIBS) {
    const nm = lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session')));
    cands.push(join(nm, name));
  }
  return cands.find((c) => existsSync(join(c, 'package.json'))) || null;
}

/** 包入口的命名导出集合；**静态不可确定时返回 null**（CJS 入口 / `export *` / 找不到入口）。 */
function packageNamedExports(pkgDir) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')); } catch { return null; }
  let rel = null;
  const pick = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? (pick(v.import) ?? pick(v.default) ?? pick(v.require) ?? null) : null));
  if (pkg.exports) rel = pick(typeof pkg.exports === 'object' && pkg.exports['.'] !== undefined ? pkg.exports['.'] : pkg.exports);
  if (!rel) rel = pick(pkg.module) ?? pick(pkg.main) ?? 'index.js';
  let code;
  try { code = readFileSync(join(pkgDir, rel), 'utf8'); } catch { return null; }
  if (/export\s*\*/.test(code)) return null;            // 星号再导出 → 导出面不确定
  const named = new Set();
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const x of m[1].split(',')) {
      const n = x.trim().replace(/^type[ \t]+/, '').split(/[ \t]+as[ \t]+/).pop().trim();
      if (n) named.add(n);
    }
  }
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) named.add(m[1]);
  if (/export\s+default/.test(code)) named.add('default');
  if (named.size === 0) return null;                      // 没有任何 ESM 导出语法 → 视为 CJS，不判
  return named;
}

  const bundleDirs = new Map(); // bundle 名 → 目录（可解析的）
  for (const b of bundles) {
    const d = findPkg(b);
    if (d) bundleDirs.set(b, d);
  }
  const collectJsFiles = (root, maxDepth = 3) => {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        // client/web 是浏览器端产物，不在宿主进程运行（避免 ctx.settings 误报）
        if (e.isDirectory() && (e.name === 'client' || e.name === 'web')) continue;
        const fp = join(dir, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (e.name.endsWith('.js') && e.name !== 'cordis.patch.yml') out.push(fp);
      }
    };
    walk(root, 0);
    // 主入口（main 指向的 .js）单独兜底
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (typeof pkg.main === 'string' && pkg.main.endsWith('.js')) {
        const mp = join(root, pkg.main);
        if (existsSync(mp) && !out.includes(mp)) out.push(mp);
      }
    } catch { /* 无 manifest */ }
    return out;
  };
  const readJs = (fp) => { try { return readFileSync(fp, 'utf8'); } catch { return ''; } };

  // P8：adapter provider 注册冲突（#1904②：两个 bundle 抢注同一 provider → boot 时 DUPLICATE_ADAPTER 崩溃）
  const providerRegs = new Map(); // provider → Set(bundle)
  for (const [b, d] of bundleDirs) {
    for (const f of collectJsFiles(d)) {
      const src = readJs(f);
      for (const m of src.matchAll(/registerAdapter\s*\(\s*\[([^\]]*)\]/g)) {
        for (const pm of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
          if (!providerRegs.has(pm[1])) providerRegs.set(pm[1], new Set());
          providerRegs.get(pm[1]).add(b);
        }
      }
    }
  }
  const adapterConflicts = [...providerRegs].filter(([, v]) => v.size > 1);
  if (adapterConflicts.length) {
    report('profile', 'P8', false, `adapter provider 注册冲突（#1904②：boot 时 DUPLICATE_ADAPTER 崩溃）: ${adapterConflicts.map(([p, v]) => `${p}（${[...v].join(' ↔ ')}}）`).join('; ')}`, '冲突 provider 只能注册一次：让第三方路由插件用 registerConfigurableProviders 或只注册新路由，移除抢注一方');
  } else {
    report('profile', 'P8', true, '无 adapter provider 注册冲突', undefined);
  }

  // 提取 bundle 构建产物里声明的全部 inject 依赖名（模块 inject + ctx.inject；bundle 可能混入内部模块的 inject）
  const bundleInjectDecls = (all) => {
    const declared = [];
    for (const m of all.matchAll(/inject\s*=\s*\[([^\]]*)\]/gs)) {
      declared.push(...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
    }
    for (const m of all.matchAll(/ctx\.inject\s*\(\s*\[([^\]]*)\]/g)) {
      declared.push(...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
    }
    return declared.filter((v, i) => declared.indexOf(v) === i);
  };

  // P9：ctx.settings/ctx.get('settings') 未声明 settings 依赖（#1904⑤：先于 settings 就绪激活 → namespace not registered）
  // 注意边界：sctx.settings 不算（sctx 是别的变量）；ctx.inject(["settings"], cb) 运行时声明算满足
  const injectIssues = [];
  for (const [b, d] of bundleDirs) {
    const files = collectJsFiles(d);
    const all = files.map(readJs).join('\n');
    const usesSettings = /(?<![A-Za-z0-9_$])ctx\.(?:get\(\s*['"]settings['"]\s*\)|settings\b)/.test(all);
    if (!usesSettings) continue;
    const uniq = bundleInjectDecls(all);
    if (!uniq.includes('settings')) {
      injectIssues.push(`${b}（用 ctx.settings 但 settings 依赖未声明${uniq.length ? `，全部 inject: [${uniq.join(', ')}]` : '，未找到任何 inject 声明'}）`);
    }
  }
  if (injectIssues.length) report('profile', 'P9', false, `插件用 ctx.settings 但未声明 settings 依赖（#1904⑤：激活时 settings 可能未就绪 → namespace not registered）: ${injectIssues.join('; ')}`, '在插件代码加 export const inject = ["settings"]（或对可选服务做 undefined 处理）');
  else report('profile', 'P9', true, 'bundle 的 ctx.settings 用法均声明了 settings 依赖（模块 inject 或 ctx.inject）', undefined);

  // P10：inject 引用客户端专属服务（@deepseek-ai/dsh-client-*）→ 服务端永不提供 → Fiber 永久 PENDING → web boot 失败（#1947）
  const clientInjectIssues = [];
  for (const [b, d] of bundleDirs) {
    const all = collectJsFiles(d).map(readJs).join('\n');
    const clientDeps = bundleInjectDecls(all).filter((n) => /^(@deepseek-ai\/)?dsh-client-/.test(n));
    if (clientDeps.length) clientInjectIssues.push(`${b}（inject 引用客户端专属服务: ${clientDeps.join(', ')}）`);
  }
  if (clientInjectIssues.length) report('profile', 'P10', false, `插件 inject 引用客户端专属服务（服务端 cordis 树永不提供 → Fiber 永久 PENDING → web boot 失败，#1947）: ${clientInjectIssues.join('; ')}`, '客户端服务不能作为服务端插件依赖：把相关功能移到插件 client 半（package.json 的 dsh.client.inject），或删除该 inject');
  else report('profile', 'P10', true, '无客户端专属服务注入', undefined);

  // P11：已装 bundle 的 main 入口产物缺失（#1965：市场把未构建源码树当插件装 → ERR_MODULE_NOT_FOUND → boot 崩）
  const entryIssues = [];
  for (const [b, d] of bundleDirs) {
    let main;
    try { main = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).main; } catch { continue; }
    if (typeof main !== 'string' || !main.endsWith('.js')) continue;
    if (!existsSync(join(d, main))) {
      entryIssues.push(`${b}（main=${main} 但产物缺失——未构建的源码树，或装错了仓库根而非 monorepo 子包）`);
    }
  }
  if (entryIssues.length) report('profile', 'P11', false, `已装 bundle 的 main 入口缺失（#1965：市场装源码不跑构建 → ERR_MODULE_NOT_FOUND → dsh web boot 崩溃）: ${entryIssues.join('; ')}`, '在插件目录跑构建（pnpm install && pnpm run build 产出 main 指向的文件），或改用打包好的 npm 包安装；monorepo 插件需装子包（dsh-market #18 同族）');
  else report('profile', 'P11', true, '已装 bundle 的 main 入口产物均在', undefined);

  // P13：client 端服务名抢注核心客户端服务（#2752：ctx.provide("chatFileMentions") 撞核心 dsh-client-ui-deliverables
  // → 浏览器端 service already registered → Web UI 白屏，服务端日志无感知、报错无冲突来源）
  // 与 P8（adapter provider 服务端冲突）互补：P8 跳过 client/web 产物，P13 专门只扫 client 侧——
  //   browser 端 provide 的服务名若与核心客户端服务（@deepseek-ai/dsh-client-*）重名，或两个 bundle 抢注同名，
  //   都会在 client-modules 加载期崩掉整个 UI（fail to load plugins / service has been registered）。
  // 核心名单来源：宿主 dsh 安装目录 + profile node_modules 里的 @deepseek-ai/dsh-client-* 包 client 产物实时收集，
  //   叠加内置种子名单兜底（宿主不可达时仍能查 #2752 的 chatFileMentions 等已知核心服务）。
  const coreClientServices = new Set([
    // 内置种子（核心客户端服务，随 dsh 版本演进，宿主不可达时兜底）
    'chatFileMentions', 'connection', 'sessions', 'workspaces', 'modules', 'locale',
  ]);
  const collectProvideNames = (fp) => {
    let src;
    try { src = readFileSync(fp, 'utf8'); } catch { return []; }
    const out = [];
    for (const m of src.matchAll(/\.provide\(\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    return out;
  };
  // client 产物位置：dsh.client 入口（package.json 的 dsh.client 指向的文件）+ client/ 目录下 js
  const collectClientJsFiles = (root) => {
    const out = [];
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const entry = pkg.dsh?.client;
      if (typeof entry === 'string' && entry.endsWith('.js')) {
        const ep = join(root, entry);
        if (existsSync(ep)) out.push(ep);
      } else if (entry && typeof entry === 'object' && typeof entry.entry === 'string' && entry.entry.endsWith('.js')) {
        const ep = join(root, entry.entry);
        if (existsSync(ep)) out.push(ep);
      }
    } catch { /* 无 manifest */ }
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fp = join(dir, e.name);
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (e.name.endsWith('.js')) out.push(fp);
      }
    };
    const cdir = join(root, 'client');
    if (existsSync(cdir)) walk(cdir, 0);
    return [...new Set(out)];
  };
  // 核心客户端服务名单实时收集（宿主 anchor + profile node_modules）
  if (installAnchor) {
    const coreScope = join(installAnchor, '@deepseek-ai');
    if (existsSync(coreScope)) {
      for (const p of readdirSync(coreScope)) {
        if (!/^dsh-client-/.test(p)) continue;
        for (const f of collectClientJsFiles(join(coreScope, p))) {
          for (const n of collectProvideNames(f)) coreClientServices.add(n);
        }
      }
    }
  }
  const clientProvideMap = new Map(); // 服务名 → Set(bundle)
  for (const [b, d] of bundleDirs) {
    for (const f of collectClientJsFiles(d)) {
      for (const n of collectProvideNames(f)) {
        if (!clientProvideMap.has(n)) clientProvideMap.set(n, new Set());
        clientProvideMap.get(n).add(b);
      }
    }
  }
  const coreHits = [...clientProvideMap].filter(([n]) => coreClientServices.has(n));
  const dupHits = [...clientProvideMap].filter(([, v]) => v.size > 1);
  const p13Issues = [];
  for (const [n, bs] of coreHits) {
    p13Issues.push(`服务名 ${n} ∈ 核心客户端服务（${[...bs].join(', ')} 抢注 → 浏览器端 service already registered，UI 白屏 #2752）`);
  }
  for (const [n, bs] of dupHits) {
    if (!coreClientServices.has(n)) p13Issues.push(`服务名 ${n} 被多个插件 client 同时提供（${[...bs].join(', ')} → 同名注册冲突，加载期崩）`);
  }
  if (p13Issues.length) {
    report('profile', 'P13', false, `client 端服务名冲突（#2752：浏览器端 provide 撞核心服务 → UI 白屏且服务端日志无感知）: ${p13Issues.join('; ')}`, '改名自有 client 服务（避开核心 dsh-client-* 已注册名），或让冲突双方协商唯一命名；冲突在应用侧降级为局部警告前仍需避名');
  } else {
    report('profile', 'P13', true, 'client 端 provide 服务名无冲突（未撞核心客户端服务、无跨 bundle 同名抢注）', undefined);
  }

  // P14：declared bin 可执行性（#1846 1052326311 贡献检查点②：dsh-instruction-audit v0.1.0 打包成功但 bin 缺 shebang
  // → 直接执行 ENOEXEC；安装/注册/schema 全过但 pnpm dlx 跑不起来）。与 P11（main 产物缺失）互补：
  // P11 查运行时入口，P14 查 CLI 入口。
  // 判定（2026-08-17 1052326311 实证修正，见 #1846 comment 18056208）：文本 bin 必须带 shebang——
  //   POSIX 上 executable bit 只授予执行权限，不标识文本文件的解释器；仅 exec bit 无 shebang，os.execve
  //   仍返回 ENOEXEC（errno 8）。故"shebang OR exec-bit"会误放行坏包（good/bad fixture 均 100755，只差 shebang）。
  //   离线静态改查"存在 + shebang"两个必要条件（bin 均为 JS 文本，shebang 是解释器声明的唯一可靠来源）。
  const binIssues = [];
  for (const [b, d] of bundleDirs) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); } catch { continue; }
    const bin = pkg.bin;
    if (!bin) continue;
    const bins = typeof bin === 'string' ? { [b.split('/').pop()]: bin } : bin;
    for (const [binName, rel] of Object.entries(bins)) {
      if (typeof rel !== 'string') continue;
      const fp = join(d, rel);
      if (!existsSync(fp)) {
        binIssues.push(`${b}: bin 声明 ${binName} → ${rel} 但产物缺失（发布后 pnpm dlx/直接执行会失败）`);
        continue;
      }
      let head;
      try { head = readFileSync(fp, 'utf8').slice(0, 2); } catch { head = ''; }
      const shebang = head === '#!';
      // execBit 仅作兜底提示（文本文件解释器识别靠 shebang），不作为通过条件
      if (!shebang) {
        binIssues.push(`${b}: bin ${binName}（${rel}）无 shebang——文本 bin 无解释器声明，直接执行 ENOEXEC（#1846 同型，exec bit 不识别解释器）`);
      }
    }
  }
  if (binIssues.length) {
    report('profile', 'P14', false, `declared bin 不可执行（#1846：安装/注册全过但 bin 跑不起来）: ${binIssues.join('; ')}`, '给 bin 入口补 `#!/usr/bin/env node`（或 chmod +x）；发布前用打包产物实测 `pnpm dlx <pkg>` / 直接执行一次（dsh-testkit 可代为跑真实宿主）');
  } else {
    report('profile', 'P14', true, 'declared bin 均在（存在 + shebang/可执行位）', undefined);
  }

  // P12 `installed_bundle`（#1719 v1.1 词汇条目）：profile 内 bundle 版本 vs 运行 CLI 版本
  // web 设置「诊断」面板与 /dsh-doctor/run API 跑的是 profile 里装的 bundle；独立 CLI（checkout/npx）是另一个副本——
  // Layer-B 自更新只比 npm latest vs 运行模块，profile 内 bundle 落后/超前都不报警（dsh-win32/bundle 同坑，sjh9714 先发现的）。
  // 语义（#1719 合稿，sjh9714 四态分析 + skip 修正）：pass/warn/skip 三态 + detail 注明条件——
  //   manifest 未声明 = skip（无对比对象，pass 会让 CI 误判"已同步"——git_bash 同形）；
  //   manifest 声明但 node_modules 缺失 = warn（manifest 撒谎，运行时从不加载）；
  //   已装且版本一致 = pass；已装但版本分歧 = warn（detail 含 age-gate 提示，升级可能被 pnpm-workspace.yaml 的
  //   minimumReleaseAgeExclude 年龄门暂缓一天，指令不再静默无效——sjh9714 实测）。
  // r6/v1.1 认领后：信封检查名从厂商本地 id `P12-bundle-version` 改为词汇名 `installed_bundle`（#1719 三家对齐，
  // sjh9714 同步改名 `dsh-win32/bundle`→`installed_bundle`，CI 可跨实现断言）。
  try {
    const selfName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name ?? '@moonquake2004/dsh-doctor';
    const listed = Object.keys(deps).some((k) => k === selfName || k === 'dsh-doctor');
    // 安装形态两种都找：npm scoped 名（@moonquake2004/dsh-doctor）与 file: 依赖的裸名（dsh-doctor）
    let bundlePkg = null;
    for (const cand of [selfName, 'dsh-doctor']) {
      const p = join(dir, 'node_modules', cand, 'package.json');
      if (existsSync(p)) { bundlePkg = p; break; }
    }
    if (!listed && !bundlePkg) {
      reportSkip('profile', 'installed_bundle', 'profile 未声明也未安装 dsh-doctor bundle——无对比对象（CLI 独立运行），skip 而非 pass（#1719 installed_bundle 合稿，sjh9714：pass 会让 CI 误判"已同步"）');
    } else if (listed && !bundlePkg) {
      report('profile', 'installed_bundle', false, `profile 的 package.json 声明了 ${selfName} 依赖，但 node_modules 里没有对应包（manifest 与运行时不一致，web 面板/API 实际加载不到）`, `dsh plugin --profile ${name} install ${selfName}（或先移除该依赖再重装）`);
    } else {
      const bundleVersion = JSON.parse(readFileSync(bundlePkg, 'utf8')).version;
      const cliVersion = localVersion();
      const same = bundleVersion === cliVersion;
      report('profile', 'installed_bundle', same,
        same ? `profile 内 bundle 版本 ${bundleVersion} 与运行 CLI ${cliVersion} 一致` : `profile 内 bundle 版本 ${bundleVersion} ≠ 运行 CLI ${cliVersion}（web 面板/API 跑的是 bundle，两边行为可能不一致；若刚发布过新版本，升级可能被 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 年龄门暂缓，可次日重试）`,
        same ? undefined : `同步安装版本：dsh plugin --profile ${name} update ${selfName}（或让 CLI 与 bundle 走同一安装方式）`);
    }
  } catch (e) {
    report('profile', 'installed_bundle', false, `bundle 版本对比异常: ${e.message.slice(0, 60)}`, undefined);
  }

  // P15：关键文件 BOM 检测（#5176：package.json 被意外加 BOM 头导致 JSON 解析失败）
  // UTF-8 BOM = EF BB BF = '\uFEFF'，pnpm/node 解析 JSON 时不认识 BOM → 报错
  const bomTargets = [
    join(dir, 'package.json'),
    join(dir, 'cordis.patch.yml'),
    join(dir, 'settings.yaml'),
  ];
  // 加上 config/*.json
  const configDir = join(dir, 'config');
  if (existsSync(configDir)) {
    try {
      for (const f of readdirSync(configDir)) {
        if (f.endsWith('.json')) bomTargets.push(join(configDir, f));
      }
    } catch { /* skip */ }
  }
  const bomFiles = [];
  for (const f of bomTargets) {
    if (!existsSync(f)) continue;
    try {
      const head = readFileSync(f, 'utf8').slice(0, 1);
      if (head === '\uFEFF') bomFiles.push(f.replace(dir + '/', ''));
    } catch { /* skip */ }
  }
  if (bomFiles.length > 0) {
    report('profile', 'P15', false, `检测到 BOM 头（#5176：JSON/YAML 解析将失败）: ${bomFiles.join(', ')}`, '用文本编辑器打开文件，删除首字符（BOM/U+FEFF）后保存；或运行: sed -i "" "1s/^\xEF\xBB\xBF//" <file>');
  } else {
    report('profile', 'P15', true, '关键文件无 BOM 头', undefined);
  }

  /* P16：插件命名导入的导出缺失检测（#5864：一个缺失导出 → 整棵插件树 boot 崩溃循环、
   * 启动器每 ~11s 重启一次）。静态校验 `import { A } from 'pkg'` 的 A 是否存在于已装 pkg 的命名导出。
   * **能不确定就不判**（本检查 warn 级，宁可漏报不误报）：解析不到包 / 入口含 `export *` / CJS 入口 /
   * 条件导出取不到 ESM 入口 / type-only 导入 / 非裸说明符 —— 全部跳过，且只在"确定不存在"时报。 */
  const exportIssues = [];
  const disabledIds = disabledPatchIds();
  for (const [b, d] of bundleDirs) {
    const seen = new Map(); // "pkg → 缺失符号" → 证据文件
    for (const f of collectJsFiles(d)) {
      const code = readJs(f);
      for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:import|export)[ \t]*\{([^}]*)\}[ \t]*from[ \t]*['"]([^'"]+)['"]/g)) {
        const names = m[1].split(',').map((x) => x.trim().replace(/^type[ \t]+/, '').split(/[ \t]+as[ \t]+/)[0].trim()).filter((x) => x && x !== 'default' && /^[A-Za-z_$][\w$]*$/.test(x));
        const spec = m[2];
        if (!names.length || !/^[@A-Za-z]/.test(spec) || spec.startsWith('node:')) continue; // 只查裸包说明符
        // 带子路径的说明符（pkg/sub、pkg/a/b）走各自的 exports 入口，静态判定不可靠 → 跳过（防误报）
        const segs = spec.split('/');
        if (spec.startsWith('@') ? segs.length > 2 : segs.length > 1) continue;
        const pkgDir = resolveInstalledPackage(spec, d);
        if (!pkgDir) continue; // 解析不到 → 不判
        const exports = packageNamedExports(pkgDir);
        if (!exports) continue; // 静态不可确定 → 不判
        const miss = names.filter((n) => !exports.has(n));
        if (miss.length) seen.set(`${spec} → ${miss.join(', ')}`, relative(d, f));
      }
    }
    if (seen.size) {
      // patch 的 id 可能是裸名（dsh-noema）而 bundle 名是 scoped（@zseven-w/dsh-noema）→ 去 scope 归一化比对
      const bare = (n) => (n.startsWith('@') ? n.split('/').slice(1).join('/') : n);
      const isDisabled = disabledIds.has(b) || disabledIds.has(bare(b));
      exportIssues.push(`${b}（${[...seen].map(([k, f]) => `${k} [${f}]`).join('; ')}）${isDisabled ? '〔当前已禁用，重新启用会 boot 失败〕' : '〔已启用 → boot 会失败〕'}`);
    }
  }
  if (exportIssues.length) {
    report('profile', 'P16', false, `插件导入了已装包未提供的导出（#5864：整棵插件树 boot 崩溃循环，启动器会反复重启）: ${exportIssues.join('; ')}`, '把该插件升到与所装 @deepseek-ai/* 版本匹配的版本（或降级/移除）；这类错误在 boot 期是硬失败，单条 entry 会拖垮整棵树');
  } else {
    report('profile', 'P16', true, '插件命名导入均在已装包的导出里（静态可判定的部分）', undefined);
  }

  /* P17：client 端 require 的 specifier 不在宿主模块表（#5719：dsh-client-modules 的 makeRequire 硬 throw
   * → 浏览器端 Failed to load plugins / 白屏，服务端 HTTP 200 且日志零感知）。
   * 可服务 ⟺ 平台种子 ∪ 图行（已装包同时有 dsh.client 与 exports["./client"]）∪ 该包声明的 external/inject。
   * 防误报（#5719 实测得出）：必须先剥注释（JSDoc 里的 require("picomatch") 示例会误报）、只认双引号形态、
   * 排除模板插值/相对路径/Node 内置、归一 /client 后缀、跳过自引用。warn 级（静态近似，宁可漏报不误报）。 */
  const p17Issues = [];
  const composedRows = new Set();
  {
    const roots = [];
    try { roots.push(join(resolveProfile(profileArg), 'node_modules')); } catch { /* 无 profile */ }
    for (const lib of SESSION_LIBS) roots.push(lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session'))));
    for (const nm of roots) {
      if (!existsSync(nm)) continue;
      const pkgs = [];
      for (const d of readdirSync(nm)) {
        if (d.startsWith('.')) continue;
        if (d.startsWith('@')) {                       // scoped：@scope/name 两层
          const scopeDir = join(nm, d);
          try { for (const n of readdirSync(scopeDir)) pkgs.push(join(scopeDir, n)); } catch { /* 忽略 */ }
        } else pkgs.push(join(nm, d));
      }
      for (const dir of pkgs) {
        const pj = join(dir, 'package.json');
        if (!existsSync(pj)) continue;
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'));
          if (pkg.name && pkg.dsh?.client && pkg.exports?.['./client']) { composedRows.add(pkg.name); composedRows.add(`${pkg.name}/client`); }
        } catch { /* 忽略 */ }
      }
    }
  }
  const stripClientSuffix = (s) => s.replace(/\/client$/, '');
  for (const [b, d] of bundleDirs) {
    const declared = new Set();
    try {
      const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      for (const k of ['external', 'inject']) {
        const v = pkg.dsh?.client?.[k];
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') declared.add(x);
      }
    } catch { /* 无 manifest */ }
    const misses = new Map();
    for (const f of collectClientJsFiles(d)) {
      let code = readJs(f);
      code = code.replace(/\/\*[\s\S]*?\*\//g, '');          // 块注释（JSDoc 示例会误报）
      code = code.replace(/(^|[^:])\/\/[^\n]*/g, '$1');       // 行注释（避开 https://）
      for (const m of code.matchAll(/require\(\s*"([^"]+)"\s*\)/g)) { // 打包产物用双引号；单引号多为文档示例
        const spec = m[1];
        if (!spec || spec.includes('${') || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        if (NODE_BUILTINS.has(spec)) continue;
        const id = stripClientSuffix(spec);
        if (CLIENT_SEEDS.has(spec) || CLIENT_SEEDS.has(id)) continue;
        if (composedRows.has(spec) || composedRows.has(id)) continue;
        if (declared.has(spec) || declared.has(id)) continue;
        if (id === b || spec === b) continue; // 自引用 → 打包内联
        misses.set(spec, relative(d, f));
      }
    }
    if (misses.size) p17Issues.push(`${b}（${[...misses].map(([s, f]) => `require("${s}") [${f}]`).join('; ')}）`);
  }
  if (p17Issues.length) {
    report('profile', 'P17', false, `client 端 require 的模块不在宿主模块表（#5719：makeRequire 硬 throw → 浏览器白屏且服务端无感知）: ${p17Issues.join('; ')}`, `改用宿主提供的模块名；若确由宿主提供，在本包 package.json 的 dsh.client.external/inject 里声明；平台种子当前 ${CLIENT_SEEDS.size} 项、已装图行 ${composedRows.size} 项`);
  } else {
    report('profile', 'P17', true, `client 端 require 的 specifier 均可服务（平台种子 ${CLIENT_SEEDS.size} 项 + 已装图行 ${composedRows.size} 项）`, undefined);
  }
}

/* ---- 会话日志定位（世代感知，规范见 dsh-security/docs/session-shape-v3.md §1） ----
 * 命名：^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$（与 dsh-session-format 的
 * CANONICAL_LOG_FILENAME 一致）；v0 = 无 .vN 的旧名，vN = 当前世代（本机为 v3）。
 * 规则：① 同一会话目录内取**最高世代**；② 跨目录按 **mtime** 取最新；
 *      ③ 忽略 session.lock（不匹配正则）；④ 目录名任意（含 _no-cwd / 无 session- 前缀）；
 *      ⑤ 同世代同时存在 .zstd 与裸 .jsonl 时**优先 .zstd**（与旧实现
 *         `existsSync(zstd) ? zstd : plain` 一致；真实 store 遇到两种编码并存会抛
 *         encodingMismatch，这里只是让诊断仍能看到日志）。
 * 旧实现只认 session.jsonl[.zstd]，v3 上线后每次 S 检查都在分析 2 天前的旧世代日志。 */
const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** 解析一个文件名 → { gen, zstd }；非会话日志（含 session.lock）→ null。 */
function parseSessionLogName(name) {
  const m = SESSION_LOG_RE.exec(name);
  if (!m) return null;
  return { gen: m[1] === undefined ? 0 : Number(m[1]), zstd: m[2] === '.zstd' };
}

/** 单个会话目录 → 该目录的权威日志（最高世代；同世代 .zstd 优先）；无 → null。 */
function pickSessionLogIn(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    const g = parseSessionLogName(n);
    if (!g) continue;
    if (!best || g.gen > best.gen || (g.gen === best.gen && g.zstd && !best.zstd)) best = { ...g, f: join(dir, n) };
  }
  return best ? { f: best.f, gen: best.gen } : null;
}

/** 会话库全量定位：三层 sessions/<project>/<session-id>/session*.jsonl*。
 *  loose=true 时额外接受两层散文件 sessions/<project>/session*.jsonl*——这是
 *  "取最新会话"（S 检查默认目标 / 安全层 SR/SS）旧有的兼容行为；S11/S12 的全库扫描
 *  旧实现只走三层，保持 loose=false，避免把散文件误当会话（那会引入误报）。
 *  返回 [{ f, gen, m }]（m = mtimeMs，按 mtime 降序）。 */
function listSessionLogs(root, { loose = false } = {}) {
  const out = [];
  let users;
  try { users = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const add = (hit) => {
    try { out.push({ f: hit.f, gen: hit.gen, m: statSync(hit.f).mtimeMs }); } catch { /* race */ }
  };
  for (const u of users) {
    if (!u.isDirectory()) continue; // root 下的散文件不在旧实现语义内，不扩权
    const sd = join(root, u.name);
    // 两层散文件（sessions/<user>/session.jsonl[.zstd]）
    if (loose) { const l = pickSessionLogIn(sd); if (l) add(l); }
    // 三层：sessions/<user>/<session-id>/session*.jsonl*
    let subs;
    try { subs = readdirSync(sd, { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const hit = pickSessionLogIn(join(sd, s.name));
      if (hit) add(hit);
    }
  }
  out.sort((a, b) => b.m - a.m);
  return out;
}

/** 最新会话日志路径（世代感知；含两层散文件兼容；无 → null）。 */
function latestSessionLog(root = join(HOME, 'sessions')) {
  const logs = listSessionLogs(root, { loose: true });
  return logs.length ? logs[0].f : null;
}

/* ================= session ================= */
function checkSession(targetPath) {
  if (!wants('session')) return;
  const target = targetPath || latestSessionLog();
  if (!target || !existsSync(target)) { report('session', 'S0', true, '无会话日志，跳过单会话检查（可用 --session <path> 指定）', undefined); return; }
  let text;
  try {
    text = target.endsWith('.zstd') ? execFileSync('zstd', ['-dc', target], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8') : readFileSync(target, 'utf8');
  } catch (e) { report('session', 'S0', false, `解压失败: ${e.message.slice(0, 80)}`); return; }

  // S9：zstd 容器结构（#1043：单帧容器会让 session.list 整体 500）
  if (target.endsWith('.zstd')) {
    try {
      const raw = readFileSync(target);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      let frames = 0;
      for (let i = 0; i <= raw.length - 4; i++) if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) frames++;
      if (frames === 0) report('session', 'S9', false, '不是有效的 zstd 容器（无帧 magic）', '该日志无法被 harness 读取');
      else if (frames === 1) report('session', 'S9', false, `单帧 zstd 容器（#1043：session.list 会整体 500，侧边栏全部消失）: ${frames} 帧`, '用多帧容器重写（正常日志每写批一帧），或删除该会话');
      else report('session', 'S9', true, `zstd 多帧容器正常（${frames} 帧）`, undefined);
    } catch (e) { report('session', 'S9', false, `帧扫描失败: ${e.message.slice(0, 60)}`); }
  } else {
    report('session', 'S9', true, '非 zstd 输入，跳过容器检查', undefined);
  }

  // S13：会话头完整性（#6651）——首行必须是 {"type":"session",...}
  // 实测：首行被写成事件时 dsh-doctor 的其余 S 检查**全部照常通过**（它们看的是事件流），
  // S11 甚至会报"均健康"；而 harness 侧会 `corrupt Zstandard session log` 直接拒绝启动 `dsh web`。
  {
    const firstLine = String(text).split('\n').find((l) => l.trim());
    let header = null;
    try { header = firstLine ? JSON.parse(firstLine) : null; } catch { header = null; }
    if (!header || header.type !== 'session') {
      report('session', 'S13', false,
        `日志首行不是会话头（type=${header && header.type ? JSON.stringify(header.type) : '缺失/无法解析'}）——#6651：此类损坏会让 \`dsh web\` **整体启动失败**（corrupt Zstandard session log: first frame is not exactly …），会话列表一并损坏`,
        '优先从备份恢复该日志；无备份时把整个会话目录**移出** sessions/（隔离，勿删）后重启 dsh，再用本工具复查');
    } else {
      // 更精确的判据：harness 的读取路径是 **Node 的 `zlib.zstdDecompressSync`**，它**只解第一个帧**，
      // 然后要求该帧明文恰好是一行（dsh-session-persistence-jsonl:1891/2185 的
      // `plaintext.indexOf(10) !== plaintext.length - 1`）。所以最忠实的做法不是自己扫 magic 猜帧边界，
      // 而是**用同一个解压器**复现同一个条件（2026-09 与 #6651 的运行时线索一致后再校准）。
      let frameNote = '';
      let frameBad = false;
      if (target.endsWith('.zstd')) {
        const zstdSync = (() => { try { return createRequire(import.meta.url)('node:zlib').zstdDecompressSync; } catch { return null; } })();
        if (typeof zstdSync !== 'function') {
          frameNote = '（本机 Node 无 zlib.zstdDecompressSync，未据此判定）';
        } else {
          try {
            const first = zstdSync(readFileSync(target)).toString('utf8');
            const exactlyOneLine = first.length > 0 && first.indexOf('\n') === first.length - 1;
            if (!exactlyOneLine) {
              frameBad = true;
              const n = first.split('\n').filter((l) => l.trim()).length;
              frameNote = `首帧明文含 ${n} 行（harness 要求恰好 1 行头）——帧边界错位/单帧容器都会触发 corrupt Zstandard session log`;
            }
          } catch (e) {
            frameBad = true;
            frameNote = `首帧无法解压（${String(e.code || e.message).slice(0, 40)}）——与 harness 读取路径一致，启动会被拒绝`;
          }
        }
      }
      if (frameBad) {
        report('session', 'S13', false,
          `会话头存在但**首帧边界不合规**：${frameNote}`,
          '优先从备份恢复；无备份时把整个会话目录移出 sessions/（隔离，勿删）后重启 dsh，再用本工具复查');
      } else {
        report('session', 'S13', true,
          `会话头完整（type=session, version=${header.version ?? '?'}, id=${String(header.id ?? '').slice(0, 12)}）${frameNote}`);
      }
    }
  }
  const calls = new Map(); const results2 = new Set(); let maxSeq = -1;
  const turnStarts = new Set(); const turnEnds = new Set();
  const positions = []; const endSeedSeqs = [];
  const expanded = []; const sesViolations = []; const s8Violations = []; let evIndex = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const seq = d.seq; if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq;
    // S8：未知事件类型且未标 ignorable（#1538：harness 整包拒绝）
    if (!STORAGE_ROW_TYPES.has(d.type) && !READABLE.has(d.type) && d.ignorable !== true) {
      s8Violations.push(`"${d.type}"`);
    }
    // S6（官方版）：按 decodeStorageRecord 语义展开 chunk 行，构建 seq==index 事件流
    const t = d.type;
    if (t === 'text-chunks' || t === 'reasoning-chunks' || t === 'tool-call-chunks') {
      const members = (d.data ?? {})[t === 'tool-call-chunks' ? 'args' : 'texts'];
      const base = typeof d.seq0 === 'number' ? d.seq0 : -1;
      for (let k = 0; k < (members?.length ?? 0); k++) {
        const eseq = base + k;
        expanded.push(eseq);
        if (eseq !== evIndex) sesViolations.push(`seq 空洞/重复 @${eseq}（期望 ${evIndex}）`);
        evIndex++;
      }
    } else if (typeof seq === 'number') {
      expanded.push(seq);
      if (seq !== evIndex) sesViolations.push(`seq 空洞/重复 @${seq}（期望 ${evIndex}）`);
      evIndex++;
    }
    // S10：sourceEventSeqs 悬空引用（#1469：必须引用早于自身的事件）
    if (typeof seq === 'number' && Array.isArray(d.sourceEventSeqs)) {
      for (const ref of d.sourceEventSeqs) {
        if (typeof ref === 'number' && ref >= seq) sesViolations.push(`sourceEventSeqs 引用 ${ref} >= 当前 seq ${seq}（${t}）`);
      }
    }
    // S6/S7：收集所有数值位置（seq 或 chunk 的 seq0），按文件序做单调/重复检测
    const pos = typeof seq === 'number' ? seq : (typeof d.seq0 === 'number' ? d.seq0 : null);
    if (pos !== null) positions.push({ pos, type: d.type, seq: seq ?? null });
    if (d.type === 'session/end-seed' && typeof seq === 'number') endSeedSeqs.push(seq);
    if (typeof d.turn === 'number') { if (d.type === 'turn/start') turnStarts.add(d.turn); if (d.type === 'turn/end') turnEnds.add(d.turn); }
    const msg = d.data?.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const blk of msg.content) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.type === 'tool-call' && typeof blk.id === 'string') calls.set(blk.id, { seq: d.seq, name: blk.name });
      else if (blk.type === 'tool-result' && typeof blk.toolCallId === 'string') results2.add(blk.toolCallId);
    }
  }
  const orphans = [...calls].filter(([id]) => !results2.has(id)).map(([id, v]) => ({ id, ...v }));
  const real = orphans.filter((o) => typeof o.seq === 'number' && o.seq < maxSeq - 1);
  const inflight = orphans.filter((o) => !real.includes(o));
  if (real.length) report('session', 'S1', false, `孤儿 tool_call（#1363，会 INVALID_REQUEST）: ${real.map((o) => o.id).join(', ')}`, '该会话历史不完整，建议新建会话');
  else report('session', 'S1', true, inflight.length ? `无真孤儿（仅尾部 in-flight: ${inflight.length} 个）` : '无孤儿 tool_call', undefined);
  const unclosed = [...turnStarts].filter((t) => !turnEnds.has(t));
  const realUnclosed = unclosed.filter((t) => t < Math.max(...turnStarts));
  const tailUnclosed = unclosed.filter((t) => !realUnclosed.includes(t));
  if (realUnclosed.length) report('session', 'S2', false, `未闭合 turn（#466/#1265，会话可能卡"运行中"）: ${realUnclosed.join(', ')}`, '重启 host 或删除该会话的残留状态');
  else report('session', 'S2', true, tailUnclosed.length ? `无历史未闭合 turn（尾部当前 turn 正常: ${tailUnclosed.join(', ')}）` : '所有 turn 均已闭合', undefined);

  // S6（官方版）：seq == index 连续性（#1333/#1452 重复段 + #1469 seq 空洞），chunk 行按 expandRow 展开
  const s6Violations = sesViolations.filter((v) => !v.startsWith('sourceEventSeqs'));
  if (s6Violations.length) {
    report('session', 'S6', false, `seq 不连续/空洞/重复（#1333/#1452/#1469）: ${s6Violations.slice(0, 5).join('; ')}${s6Violations.length > 5 ? ` 等 ${s6Violations.length} 处` : ''}`, '会话事件序列损坏（可能被强制压缩/并发写坏），建议用端种子恢复或新建会话');
  } else {
    report('session', 'S6', true, `seq==index 连续（展开 ${expanded.length} 个事件，max seq ${maxSeq}）`, undefined);
  }

  // S10：sourceEventSeqs 悬空引用（#1469：压缩未重映射溯源 → 历史永久无法加载）
  const s10 = sesViolations.filter((v) => v.startsWith('sourceEventSeqs'));
  if (s10.length) {
    report('session', 'S10', false, `sourceEventSeqs 悬空引用（#1469，history unavailable）: ${s10.slice(0, 5).join('; ')}${s10.length > 5 ? ` 等 ${s10.length} 处` : ''}`, '压缩写入路径未重映射溯源引用，需修复日志或回滚压缩');
  } else {
    report('session', 'S10', true, 'sourceEventSeqs 均引用早于自身的事件', undefined);
  }

  // S8：未知事件类型（#1538：不在 KNOWN_SESSION_EVENT_TYPES 且无 ignorable → 整包拒绝）
  if (s8Violations.length) {
    const seen = [...new Set(s8Violations)].slice(0, 5).join(', ');
    report('session', 'S8', false, `未知事件类型且无 ignorable 标记（#1538，harness 将整包拒绝）: ${seen}${new Set(s8Violations).size > 5 ? ` 等 ${new Set(s8Violations).size} 种` : ''}`, '该日志由更新版本/外部插件写入，当前 harness 无法读取；升级 harness 或标记 ignorable');
  } else {
    report('session', 'S8', true, `所有事件类型均可读（当前表 ${KNOWN.size} 种 + 迁移包旧类型，共 ${READABLE.size} 种）`, undefined);
  }

  // S7：end-seed 之后出现低于种子末尾 seq 的事件（#1497：已提交尾部被重放）
  if (endSeedSeqs.length) {
    const lastSeed = endSeedSeqs[endSeedSeqs.length - 1];
    // 只查文件序在最后一个 end-seed 之后的记录
    const lastSeedIdx = positions.map((p) => p.pos).lastIndexOf(lastSeed);
    const after = positions.slice(lastSeedIdx + 1);
    const replayed = after.filter((p) => p.pos < lastSeed);
    if (replayed.length) {
      const sample = replayed.slice(0, 5).map((p) => `${p.type}@${p.pos}`).join(', ');
      report('session', 'S7', false, `end-seed 后重放已提交尾部（#1497）: 种子末尾 seq=${lastSeed}，其后出现 ${replayed.length} 条更低 seq（${sample}...）`, '单进程异常退出重放，需丢弃 end-seed 后的重放段');
    } else {
      report('session', 'S7', true, `end-seed（末次 seq=${lastSeed}）之后无重放（其后 ${after.length} 条记录 seq 均更高）`, undefined);
    }
  } else {
    report('session', 'S7', true, '日志中无 session/end-seed（未做尾部重放检查）', undefined);
  }
}

/* S12：迁移拒载预检（#6045/#6328/#6311）——升级/打开前列出会被"会话格式迁移链"拒绝的会话。
 * 规则不硬编码：从已装 dsh-session-format-* 迁移包自省（v0→v1 的 descriptor 版本门 + v2→v3 的 source.kind 白名单）；
 * 定位不到迁移包 → skip（不猜）。surface 事件集合照抄 v2→v3 的 assertSource 调用点（user/assistant/tool/inbox/title-llm-request）。 */
const SURFACE_SOURCE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'agent/inbox/spliced', 'session/title-llm-request']);

function findPkgLib(nm, name) {
  const a = join(nm, '@deepseek-ai', name, 'lib', 'index.js');
  if (existsSync(a)) return a;
  const store = join(nm, '.pnpm');
  if (existsSync(store)) {
    for (const d of readdirSync(store)) {
      if (!d.startsWith(`@deepseek-ai+${name}@`)) continue;
      const b = join(store, d, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js');
      if (existsSync(b)) return b;
    }
  }
  return null;
}

function migrationRules() {
  const out = { descriptorVersion: null, kinds: null, from: null };
  for (const lib of SESSION_LIBS) {
    const nm = lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session')));
    if (out.descriptorVersion === null) {
      const v0 = findPkgLib(nm, 'dsh-session-format-v0-to-v1');
      if (v0) {
        try {
          const m = /data\["version"\]\s*!==\s*(\d+)/.exec(readFileSync(v0, 'utf8'));
          if (m) { out.descriptorVersion = Number(m[1]); out.from = nm; }
        } catch { /* 忽略 */ }
      }
    }
    if (out.kinds === null) {
      const v3 = findPkgLib(nm, 'dsh-session-format-v2-to-v3');
      if (v3) {
        try {
          const m = /const SOURCE_KINDS = new Set\(\[(.*?)\]\);/s.exec(readFileSync(v3, 'utf8'));
          if (m) {
            const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
            if (items.length) { out.kinds = new Set(items); out.from = nm; }
          }
        } catch { /* 忽略 */ }
      }
    }
    if (out.descriptorVersion !== null && out.kinds !== null) break;
  }
  return out;
}
const MIGRATION_RULES = migrationRules();

/** 加载已装的会话格式目录（真实迁移链入口）。找不到/加载失败返回 null —— 调用方回退启发式规则或 skip。 */
function loadFormatCatalog() {
  for (const lib of SESSION_LIBS) {
    const nm = lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session')));
    const cands = [join(nm, '@deepseek-ai', 'dsh-session-format-catalog', 'lib', 'index.js')];
    const store = join(nm, '.pnpm');
    if (existsSync(store)) {
      for (const d of readdirSync(store)) {
        if (d.startsWith('@deepseek-ai+dsh-session-format-catalog@')) {
          cands.push(join(store, d, 'node_modules', '@deepseek-ai', 'dsh-session-format-catalog', 'lib', 'index.js'));
        }
      }
    }
    for (const c of cands) {
      if (!existsSync(c)) continue;
      try {
        const req = createRequire(c);
        const m = req(c);
        if (m?.sessionFormatCatalog?.createRestore) return m.sessionFormatCatalog;
      } catch { /* 试下一个 */ }
    }
  }
  return null;
}
const FORMAT_CATALOG = loadFormatCatalog();

/* P17：平台种子表 + Node 内置模块（#5719）
 * 种子 = 浏览器端 require 的"平台种子词"，由宿主 web-frontend 构建产物决定；自省失败回退常量。 */
const CLIENT_PLATFORM_SEEDS_FALLBACK = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]);
function clientPlatformSeeds() {
  for (const lib of SESSION_LIBS) {
    const nm = lib.slice(0, lib.indexOf(join('@deepseek-ai', 'dsh-session')));
    const assets = join(nm, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
    if (!existsSync(assets)) continue;
    for (const f of readdirSync(assets)) {
      if (!/^index-.*\.js$/.test(f) && !/\.js$/.test(f)) continue;
      try {
        const s = readFileSync(join(assets, f), 'utf8');
        const i = s.indexOf('dsh-client-ui-dockkit');
        if (i < 0) continue;
        const win = s.slice(Math.max(0, i - 1400), i + 60);
        const keys = [...win.matchAll(/["']?([A-Za-z@][^"':,{}]*)["']?\s*:\s*[A-Za-z_$][\w$]*/g)]
          .map((m) => m[1].trim()).filter((k) => /^(react|react-dom|@deepseek-ai\/)/.test(k));
        if (keys.length >= 8) return new Set(keys);
      } catch { /* 试下一个资产 */ }
    }
  }
  return CLIENT_PLATFORM_SEEDS_FALLBACK;
}
const CLIENT_SEEDS = clientPlatformSeeds();
const NODE_BUILTINS = new Set(['url','path','fs','util','events','stream','buffer','crypto','os','zlib','assert','worker_threads','perf_hooks','querystring','string_decoder','timers','tty','net','http','https','child_process','process','module','v8','vm','tls','dns','readline','repl','cluster','constants','domain','punycode','sys','timers/promises','fs/promises','stream/web','stream/promises','util/types','dns/promises']);


/** 用**真实迁移链**在内存里跑一遍：返回 null = 可恢复，否则返回拒载原因（截断）。
 *  比复刻规则更准（上游每条 fail-closed 规则都覆盖，且自动跟随版本变化）。 */
function realChainRefusal(text) {
  if (!FORMAT_CATALOG) return undefined; // undefined = 链不可用（区别于 null = 可恢复）
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  try {
    const header = JSON.parse(lines[0]);
    const r = FORMAT_CATALOG.createRestore(header, { validation: 'current', recovery: 'strict' });
    for (let i = 1; i < lines.length; i++) r.decodeRow(JSON.parse(lines[i]));
    r.finish();
    return null;
  } catch (e) {
    return String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 140);
  }
}


/** 单个会话文本 → 会被迁移链拒绝的理由（空数组 = 可读）。 */
function migrationRefusals(text) {
  const reasons = [];
  const { descriptorVersion, kinds } = MIGRATION_RULES;
  let version = null;
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    let d; try { d = JSON.parse(ln); } catch { continue; }
    if (version === null && d.type === 'session' && typeof d.version === 'number') { version = d.version; continue; }
    if (version === 0 && descriptorVersion !== null && d.type === 'subagent/descriptor' && d.data?.version !== descriptorVersion) {
      reasons.push(`subagent/descriptor version ${d.data?.version} 会被 v0→v1 拒载（该迁移只接受 version ${descriptorVersion}）`);
    }
    if (version === 2 && kinds && SURFACE_SOURCE_TYPES.has(d.type)) {
      const s = d.data?.source ?? d.data?.message?.source;
      if (s && typeof s.kind === 'string' && !kinds.has(s.kind)) reasons.push(`source.kind "${s.kind}" 会被 v2→v3 拒载（不在 ${kinds.size} 项白名单内）`);
    }
  }
  return [...new Set(reasons)];
}

/**
 * 全会话库迁移拒载预检（#6045：某真实库 321 个日志中 282 个中招；#6328：一个坏产物拖垮搜索索引）。
 * 在升级/打开前给出"哪些会话将会打不开"，避免列表里看着在、点开就报错。
 */
function scanMigrationRefusals() {
  if (!wants('session')) return;
  if (MIGRATION_RULES.descriptorVersion === null && !MIGRATION_RULES.kinds) {
    reportSkip('session', 'S12', '未定位到 dsh-session-format-* 迁移包，拒载规则不可自省——预检跳过（不猜）', undefined);
    return;
  }
  const root = join(HOME, 'sessions');
  if (!existsSync(root)) { reportSkip('session', 'S12', '无会话目录，迁移拒载预检不适用', undefined); return; }
  // 世代感知：每个会话目录只取权威世代（v3 优先于 v0），与 store 的会话列表对齐
  const files = listSessionLogs(root).map((x) => x.f);
  if (files.length === 0) { reportSkip('session', 'S12', '未发现会话日志', undefined); return; }
  const refused = [];
  let viaChain = 0;
  for (const f of files) {
    let text;
    try { text = f.endsWith('.zstd') ? execFileSync('zstd', ['-dc', f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8') : readFileSync(f, 'utf8'); }
    catch { continue; } // 解压失败由 S11 报，不在 S12 重复
    const chain = realChainRefusal(text);
    if (chain === undefined) {
      // 真实链不可用 → 回退启发式规则（覆盖子集，明确标注）
      const rs = migrationRefusals(text);
      if (rs.length) refused.push(`${basename(dirname(f))}（${rs[0]}）`);
    } else if (chain !== null) {
      viaChain++;
      refused.push(`${basename(dirname(f))}（${chain}）`);
    }
  }
  const rule = FORMAT_CATALOG
    ? `判定方式：真实迁移链（format-catalog ${FORMAT_CATALOG.currentVersion ? `v${FORMAT_CATALOG.currentVersion}` : ''}，内存试迁移）`
    : `判定方式：启发式规则（descriptor v${MIGRATION_RULES.descriptorVersion ?? '?'} / source.kind ${MIGRATION_RULES.kinds?.size ?? '?'} 项；真实链不可用，覆盖子集）`;
  if (refused.length) {
    report('session', 'S12', false,
      `迁移拒载预检：${refused.length}/${files.length} 个会话会被当前迁移链拒绝（#6045/#6328/#6311——列表里看着在、点开即报 cannot safely transform / unsupported descriptor version）: ${refused.slice(0, 5).join('; ')}${refused.length > 5 ? ` 等 ${refused.length} 个` : ''}`,
      `① 先备份这些会话目录（勿删）；② 等上游放宽版本门（#6045 已报）；③ 应急：把日志里 subagent/descriptor 的 version 改为 ${MIGRATION_RULES.descriptorVersion ?? 3} 再迁移（改前务必备份）`);
  } else {
    report('session', 'S12', true, `迁移拒载预检：${files.length} 个会话均可被当前迁移链读取（${rule}）`, undefined);
  }
}

/* S11：全会话扫描 —— 损坏 → 隔离建议；超大 → 冷打开物化风险（#1550：一个坏/超大会话拖垮整个服务器） */
function scanAllSessions() {
  if (!wants('session')) return;
  const root = join(HOME, 'sessions');
  if (!existsSync(root)) { report('session', 'S11', true, '无会话目录，跳过全会话扫描', undefined); return; }
  // 世代感知：每个会话目录只取权威世代（v3 优先于 v0），与 store 的会话列表对齐
  const files = listSessionLogs(root).map((x) => x.f);
  if (files.length === 0) { report('session', 'S11', true, '未发现会话日志', undefined); return; }
  const corrupt = []; const oversized = []; const clean = [];
  let totalDS = 0; let totalEvents = 0;
  for (const f of files) {
    const cs = statSync(f).size;
    let raw, frames = 0;
    try {
      raw = readFileSync(f);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      for (let i = 0; i <= raw.length - 4; i++) if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) frames++;
    } catch { corrupt.push({ id: basename(dirname(f)), problems: ['读取失败'] }); continue; }
    let text;
    try { text = f.endsWith('.zstd') ? execFileSync('zstd', ['-dc', f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8') : readFileSync(f, 'utf8'); }
    catch { corrupt.push({ id: basename(dirname(f)), problems: ['解压/读取失败'] }); continue; }
    const ds = Buffer.byteLength(text, 'utf8');
    totalDS += ds;
    // 轻量损坏扫描：seq==index + end-seed 重放 + 未知类型
    const problems = [];
    let firstRowSeen = false;
    let evIndex = 0, lastSeed = -1, seedIdx = -1, posList = [];
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li]; if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { problems.push(`行 ${li + 1} 无法解析`); continue; }
      // #6651：首行必须是会话头——否则 harness 拒绝启动 dsh web，而其余检查看不出问题
      if (!firstRowSeen) {
        firstRowSeen = true;
        if (d.type !== 'session') problems.push(`首行不是会话头（#6651 启动阻断，实际 type=${d.type}）`);
      }
      if (!STORAGE_ROW_TYPES.has(d.type) && !READABLE.has(d.type) && d.ignorable !== true) problems.push(`未知类型 ${d.type}`);
      if (d.type === 'session/end-seed' && typeof d.seq === 'number') { lastSeed = d.seq; seedIdx = posList.length; }
      const t = d.type;
      if (t === 'text-chunks' || t === 'reasoning-chunks' || t === 'tool-call-chunks') {
        const members = (d.data ?? {})[t === 'tool-call-chunks' ? 'args' : 'texts'];
        const base = typeof d.seq0 === 'number' ? d.seq0 : -1;
        for (let k = 0; k < (members?.length ?? 0); k++) {
          const eseq = base + k;
          if (eseq !== evIndex) problems.push(`seq 空洞 @${eseq}(期望 ${evIndex})`);
          posList.push(eseq); evIndex++;
        }
      } else if (typeof d.seq === 'number') {
        if (d.seq !== evIndex) problems.push(`seq 空洞 @${d.seq}(期望 ${evIndex})`);
        posList.push(d.seq); evIndex++;
      }
    }
    if (lastSeed >= 0) {
      const after = posList.slice(seedIdx + 1);
      if (after.some((p) => p < lastSeed)) problems.push('end-seed 后重放已提交尾部');
    }
    const id = basename(dirname(f));
    totalEvents += evIndex;
    const entry = { id, csMB: (cs / 1048576).toFixed(1), dsMB: (ds / 1048576).toFixed(1), frames, events: evIndex, problems };
    if (problems.length) corrupt.push(entry);
    else if (ds > 10 * 1048576 || frames > 10000) oversized.push(entry);
    else clean.push(entry);
  }
  const quars = corrupt.map((c) => `${c.id}（${c.problems.slice(0, 3).join('; ')}）`);
  const totalMB = Math.round(totalDS / 1048576);
  // 校准后的物化风险：估算堆 = 解码字节×6（字节主导放大）+ 事件数×200B（小事件堆成本）
  // 依据：#1550 7889545 场景 300-600MB 解码 → ~3GB 堆（5-10x）；警告线 1GB 提前留余量
  // 校准公式（实测 2026-08-14 本机 41.9 万小事件会话：对象图 259B/事件，×克隆2-3 → ~600B；大事件 5-10x 字节）
  const estHeapMB = Math.round(Math.max(totalEvents * 600, totalDS * 6) / 1048576);
  const heapLimit = Number(process.env.DSH_DOCTOR_HEAP_MB || 1024);
  const totalRisk = estHeapMB > heapLimit;
  if (quars.length) {
    report('session', 'S11', false, `全会话扫描：${corrupt.length} 个损坏会话（#1550：冷打开会拖垮服务器）: ${quars.join(' | ')}`, `隔离：把这些会话目录移出 ${join(HOME, 'sessions')}（如 mv 到备份目录）`);
  } else if (oversized.length || totalRisk) {
    const parts = [];
    if (oversized.length) parts.push(`${oversized.length} 个超大会话: ${oversized.map((o) => `${o.id}(${o.dsMB}MB/${o.events}事件)`).join(' | ')}`);
    if (totalRisk) parts.push(`工作区估算物化堆 ~${estHeapMB}MB（估算= max(${totalEvents}事件×600B, ${totalMB}MB×6)，跨 ${files.length} 会话累积，#1550 场景；阈值 ${heapLimit}MB，可设 DSH_DOCTOR_HEAP_MB）`);
    report('session', 'S11', true, `⚠ 全会话扫描：${parts.join('；')}（未损坏，可接受或归档）`, '冷启动会明显变慢；必要时压缩/归档历史会话');
  } else {
    report('session', 'S11', true, `全会话扫描：${clean.length} 个会话均健康（损坏 0 / 超大 0 / 估算物化堆 ${estHeapMB}MB）`, undefined);
  }
}

/* ================= 远程检查目录（层 A：规则是数据，不是代码） =================
 * 新检查 = 在 checks.json 追加一条 JSON，已装实例在缓存 TTL 内自动生效，无需重装插件。
 * 安全属性：目录内容只能声明"只读探测原语"，引擎不执行远程代码。
 */
const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/moonquake2004/dsh-doctor/main/plugin/checks.json';
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h：新检查最长 6h 内自动生效
const catalogSeverity = new Map(); // catalog 检查 id → severity（'error' | 'warn'）
// v1 词汇表 r5 对齐（#1719）：E1-pnpm 缺失=warn（corepack 可恢复）、E3-node 越界=warn（EBADENGINE 语义）、installed_bundle（P12）分歧=warn（v1.1 词汇条目）、P13 client 服务名冲突=warn（#2752：按帖子建议降级为局部警告而非白屏）、P14 bin 不可执行=warn（#1846：发布卫生问题，不影响已有 boot 但对新用户 pnpm dlx 失败）——均不翻退出码
catalogSeverity.set('E1-pnpm', 'warn');
catalogSeverity.set('E3-node', 'warn');
catalogSeverity.set('installed_bundle', 'warn');
catalogSeverity.set('P13', 'warn');
catalogSeverity.set('P14', 'warn');
catalogSeverity.set('P15', 'error');
catalogSeverity.set('P16', 'warn');
catalogSeverity.set('P17', 'warn');
catalogSeverity.set('P18', 'warn'); // #6667：条件性风险（需游离本地模块才触发），提示但不翻退出码

function bundledCatalog() {
  const p = new URL('./checks.json', import.meta.url);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { schemaVersion: 1, checks: [] }; }
}

/** 本地覆盖层（层 C 观察者 --observe-apply 写入）：合法则追加，非法/缺失 → []。 */
function localOverlay(path) {
  const p = path ?? fileURLToPath(new URL('./checks.local.json', import.meta.url));
  try { const d = JSON.parse(readFileSync(p, 'utf8')); return validCatalog(d) ? d.checks : []; } catch { return []; }
}

function validCatalog(data) {
  return !!data && data.schemaVersion === 1 && Array.isArray(data.checks);
}

/** 拉取目录：新鲜缓存(≤TTL) → 远程(raw.githubusercontent，3s 超时) → 旧缓存(last-known-good) → 内置副本；末尾合并本地覆盖层。 */
async function loadCatalog({ noRemote = false, fetchImpl, home = HOME, localPath } = {}) {
  const bundled = bundledCatalog();
  let base;
  if (noRemote || typeof fetchImpl !== 'function') {
    base = { checks: bundled.checks, source: 'bundled' };
  } else {
    const cachePath = join(home, '.cache', 'dsh-doctor', 'checks.json');
    const readCache = () => { if (!existsSync(cachePath)) return null; try { const d = JSON.parse(readFileSync(cachePath, 'utf8')); return validCatalog(d) ? d : null; } catch { return null; } };
    try {
      const cached = readCache();
      if (cached && Date.now() - statSync(cachePath).mtimeMs < CATALOG_TTL_MS) base = { checks: cached.checks, source: 'cache' };
    } catch { /* 回退 */ }
    if (!base) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3000);
        const res = await fetchImpl(REMOTE_CATALOG_URL, { signal: ac.signal });
        clearTimeout(timer);
        if (res && res.ok) {
          const data = await res.json();
          if (validCatalog(data)) {
            try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(data, null, 2)); } catch { /* 缓存写入失败不影响本次运行 */ }
            base = { checks: data.checks, source: 'remote' };
          }
        }
      } catch { /* 离线/超时 → 回退 */ }
    }
    if (!base) {
      const stale = readCache();
      base = stale ? { checks: stale.checks, source: 'cache-stale' } : { checks: bundled.checks, source: 'bundled' };
    }
  }
  const local = localOverlay(localPath);
  if (!local.length) return base;
  return { checks: [...base.checks, ...local], source: base.source === 'bundled' ? 'bundled+local' : `${base.source}+local` };
}

function expandPath(tpl, ctx) {
  return String(tpl)
    .replace(/\{home\}/g, ctx.home)
    .replace(/\{profile\}/g, ctx.profileDir ?? '{profile}')
    .replace(/\{profileName\}/g, ctx.profile);
}

function findCommand(cmd) {
  for (const w of process.platform === 'win32' ? ['where'] : ['which']) {
    const r = spawnSync(w, [cmd]);
    if (r.status === 0) { const p = String(r.stdout).split(/\r?\n/)[0].trim(); if (p) return p; }
  }
  return null;
}

function countRecursive(dir) {
  let n = 0;
  try { for (const e of readdirSync(dir, { withFileTypes: true })) { const fp = join(dir, e.name); if (e.isFile()) n++; else if (e.isDirectory()) n += countRecursive(fp); } } catch { /* 不可读目录跳过 */ }
  return n;
}

/** 极简 glob：`*` 匹配段内任意、`?` 单字符、`**` 递归目录；返回文件匹配数。 */
function globCount(base, pattern) {
  if (!existsSync(base)) return 0;
  const segs = String(pattern).split('/').filter(Boolean);
  if (segs.length === 0) return 0;
  let dirs = [base];
  let count = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next = [];
    if (seg === '**') {
      if (last) { for (const d of dirs) count += countRecursive(d); return count; }
      // `**` 匹配零层或多层目录：保留当前 dirs（零层）并追加所有递归子目录
      const all = [...dirs];
      const stack = [...dirs];
      while (stack.length) {
        const d = stack.pop();
        if (!existsSync(d)) continue;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const fp = join(d, e.name);
          all.push(fp);
          stack.push(fp);
        }
      }
      dirs = all;
      continue;
    }
    const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!re.test(e.name)) continue;
        const fp = join(d, e.name);
        if (last) { if (e.isFile()) count++; }
        else if (e.isDirectory()) next.push(fp);
      }
    }
    dirs = next;
  }
  return count;
}

/** 执行一条目录检查（只读探测原语）。返回 { ok, detail, skipped? }。 */
export function runCatalogCheck(check, ctx) {
  const probe = check.probe ?? {};
  const p = (tpl) => expandPath(tpl, ctx);
  switch (probe.type) {
    case 'command-exists': {
      const found = findCommand(probe.cmd);
      if (found) return { ok: true, detail: check.detailOk ?? `${probe.cmd} 在 PATH: ${found}` };
      // 无 DSH 环境可言时 skip（2026-09）：在干净容器/仓库检出里跑本工具时，dsh 当然不在 PATH ——
      // 那不是"用户环境有问题"，而是"这里没有被诊断的 DSH 环境"。据此报 error 会让 CI 与 fixture
      // 得到无意义的失败（CI 三次红都源于同类检查：E4 → E1-pnpm → E7）。
      if (!hasDshEnvironment(ctx?.home ?? HOME)) {
        return { skipped: true, detail: `未发现 DSH 环境（无 sessions/ 与 settings.yaml），跳过 ${probe.cmd} 的 PATH 检查` };
      }
      return { ok: false, detail: check.detailFail ?? `${probe.cmd} 不在 PATH` };
    }
    case 'path-exists':
    case 'path-is-dir':
    case 'path-is-file': {
      const fp = p(probe.path);
      let ok = existsSync(fp);
      if (ok && probe.type === 'path-is-dir') ok = lstatSync(fp).isDirectory();
      if (ok && probe.type === 'path-is-file') ok = lstatSync(fp).isFile();
      return ok ? { ok: true, detail: check.detailOk ?? `${fp} 存在` }
                : { ok: false, detail: check.detailFail ?? `${fp} 不存在/类型不符` };
    }
    case 'json-valid': {
      const fp = p(probe.path);
      if (!existsSync(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let utf8ok = true, jsonok = false;
      try { new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fp)); } catch { utf8ok = false; }
      if (utf8ok) { try { JSON.parse(readFileSync(fp, 'utf8')); jsonok = true; } catch { /* 非法 JSON */ } }
      return jsonok ? { ok: true, detail: check.detailOk ?? `${fp} 为合法 JSON` }
                    : { ok: false, detail: check.detailFail ?? `${fp} 不是合法 JSON（UTF-8:${utf8ok ? 'OK' : 'BAD'}）` };
    }
    case 'text-contains':
    case 'text-not-contains': {
      const fp = p(probe.path);
      if (!existsSync(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let re;
      try { re = new RegExp(probe.pattern, probe.flags ?? ''); } catch (e) { return { ok: false, detail: `目录规则正则非法: ${e.message.slice(0, 60)}` }; }
      const hit = re.test(readFileSync(fp, 'utf8'));
      const want = probe.type === 'text-contains';
      return hit === want ? { ok: true, detail: check.detailOk ?? `${fp} ${want ? '匹配' : '未匹配'} ${probe.pattern}` }
                          : { ok: false, detail: check.detailFail ?? `${fp} ${want ? '未匹配' : '意外匹配'} ${probe.pattern}` };
    }
    case 'file-size-above': {
      const fp = p(probe.path);
      if (!existsSync(fp)) return probe.required === true
        ? { ok: false, detail: check.detailFail ?? `${fp} 缺失` }
        : { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` };
      const size = statSync(fp).size;
      return size > probe.minBytes
        ? { ok: false, detail: check.detailFail ?? `${fp} 过大: ${size}B > ${probe.minBytes}B` }
        : { ok: true, detail: check.detailOk ?? `${fp} 大小 ${size}B 在限内` };
    }
    case 'glob-count': {
      const base = p(probe.base ?? probe.path);
      const count = globCount(base, probe.pattern);
      const min = probe.min ?? 1;
      const max = probe.max ?? Infinity;
      if (count < min) return { ok: false, detail: check.detailFail ?? `${probe.pattern} 匹配 ${count} 个（< ${min}）` };
      if (count > max) return { ok: false, detail: check.detailFail ?? `${probe.pattern} 匹配 ${count} 个（> ${max}）` };
      return { ok: true, detail: check.detailOk ?? `${probe.pattern} 匹配 ${count} 个（${min}..${max}）` };
    }
    case 'file-writable': {
      const fp = p(probe.path);
      if (!existsSync(fp)) return probe.required === false
        ? { ok: true, detail: check.detailOk ?? `${fp} 不存在（跳过）` }
        : { ok: false, detail: check.detailFail ?? `${fp} 缺失` };
      let writable = false;
      try { const fd = openSync(fp, 'a'); closeSync(fd); writable = true; } catch { /* 只读/属主问题 */ }
      return writable ? { ok: true, detail: check.detailOk ?? `${fp} 可写` }
                      : { ok: false, detail: check.detailFail ?? `${fp} 不可写（sudo 属主或只读权限，#1719）` };
    }
    default:
      return { ok: true, skipped: true, detail: `探测原语 ${probe.type} 本引擎不支持，已跳过（需更新插件）` };
  }
}

/** 逐条执行目录检查，汇入统一 results 管线（src='catalog'）。尊重 --profile/--env/--session 收窄。 */
function checkCatalog(ctx, catalog) {
  const platform = process.platform;
  for (const check of catalog.checks ?? []) {
    if (!wants(check.section)) continue; // 与内置检查一致的 section 收窄
    const when = check.when ?? {};
    if (Array.isArray(when.os) && !when.os.includes(platform)) continue;
    if (check.section === 'profile' && !ctx.profileDir) continue; // profile 无效时跳过 profile 段
    let r;
    try { r = runCatalogCheck(check, ctx); } catch (e) { r = { ok: false, detail: `catalog 检查异常: ${e.message.slice(0, 80)}` }; }
    if (r.skipped) { report(check.section, check.id, true, r.detail, undefined, 'catalog'); continue; }
    const severity = check.severity ?? 'error';
    catalogSeverity.set(check.id, severity);
    report(check.section, check.id, r.ok, r.detail, r.ok ? undefined : check.fix, 'catalog');
  }
}

/* ================= 层 B：版本检查与更新（v0.2.1） =================
 * 检查 npm dist-tags.latest 是否比本地版本新（TTL 6h 缓存 + 离线回退 last-known-good）。
 * 默认只提示；--update 手动执行更新；DSH_DOCTOR_AUTO_UPDATE=1 可用时自动更新。
 * 诚实边界：cordis 启动时加载插件，更新后需重启 dsh web 才生效。
 */
const UPDATE_URL = 'https://registry.npmjs.org/@moonquake2004%2Fdsh-doctor';
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

export function localVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

/** 返回 { current, latest, available }；latest=null 表示无法确认（离线且无缓存）。 */

/** 简易 semver 比较（支持 x.y.z-预发布）：a>b 返回 1，a<b 返回 -1，相等 0。
 *  用途：本地版本可能领先 npm（未发布的工作版本），只比"不相等"会误报"新版本可用"。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-');
    const nums = core.split('.').map((x) => parseInt(x, 10) || 0);
    return { nums, pre };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = A.nums[i] ?? 0; const y = B.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;   // 正式版 > 预发布
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

export async function checkForUpdate({ noRemote = false, fetchImpl, home = HOME } = {}) {
  const current = localVersion();
  if (noRemote || typeof fetchImpl !== 'function') return { current, latest: null, available: false };
  const cachePath = join(home, '.cache', 'dsh-doctor', 'update.json');
  const readCache = () => { try { const d = JSON.parse(readFileSync(cachePath, 'utf8')); return d && typeof d.latest === 'string' ? d : null; } catch { return null; } };
  try {
    const c = readCache();
    if (c && Date.now() - statSync(cachePath).mtimeMs < UPDATE_TTL_MS) return { current, latest: c.latest, available: c.latest !== current && compareVersions(c.latest, current) > 0 };
  } catch { /* 回退 */ }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const res = await fetchImpl(UPDATE_URL, { signal: ac.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      const data = await res.json();
      const latest = data?.['dist-tags']?.latest;
      if (typeof latest === 'string') {
        try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: new Date().toISOString() })); } catch { /* 缓存失败不影响 */ }
        return { current, latest, available: latest !== current && compareVersions(latest, current) > 0 };
      }
    }
  } catch { /* 离线/超时 → last-known-good */ }
  const stale = readCache();
  if (stale) return { current, latest: stale.latest, available: stale.latest !== current };
  return { current, latest: null, available: false };
}

/** 判断本模块是否安装在某个 profile 的 node_modules 下；返回 profile 目录或 null。 */
export function profileDirOfModule() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const m = here.match(/(\/\.dsh\/profiles\/[^/]+)\/node_modules\//);
  return m ? m[1] : null;
}

/** 执行更新（profile 内 pnpm install 刷新 file:/npm 依赖；可用 DSH_DOCTOR_UPDATE_CMD 覆盖命令）。 */
export function runUpdate() {
  const override = process.env.DSH_DOCTOR_UPDATE_CMD;
  if (override) {
    const r = spawnSync(override, { shell: true, stdio: 'inherit' });
    return r.status === 0 ? '更新命令执行完成，请重启 dsh web 生效' : `更新命令失败（exit ${r.status ?? r.error?.message}）`;
  }
  const profileDir = profileDirOfModule();
  if (profileDir) {
    const r = spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit' });
    return r.status === 0 ? `已更新 ${profileDir}，请重启 dsh web 使新版本生效` : `pnpm install 失败（exit ${r.status ?? r.error?.message}）`;
  }
  return '仓库 checkout 模式：请 git pull 后重新安装插件（file: 依赖指向仓库）';
}

/* ================= main ================= */
const flagValue = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const profileArg = (() => { const i = process.argv.indexOf('--profile'); return i >= 0 ? process.argv[i + 1] : 'web'; })();
const sessionArg = (() => { const i = process.argv.indexOf('--session'); return i >= 0 ? process.argv[i + 1] : undefined; })();


/* ================= 启动失败自救：装载模拟 + 隔离 =================
 * 场景（用户高频反馈）：装了个不兼容的插件、或 dsh 升级后与旧插件不兼容 → **dsh 根本起不来**，
 * 于是没法用 dsh 自己来诊断，只能借别的工具。本工具是独立 Node CLI（`npx @moonquake2004/dsh-doctor`），
 * **不需要 dsh 能启动**，所以这两个子命令正是为此设计：
 *   --boot-check         离线模拟插件树装载：逐条 entry 真去 import，报出到底哪一条炸、炸在哪
 *   --quarantine <包名>  把某个 bundle 从启动列表里摘掉（先备份），让 dsh 能先起来
 *   --unquarantine <包名> 撤销隔离
 * 注意：--boot-check 会**执行插件顶层代码**（这正是"启动"本身的语义），故为显式开关、非默认行为。
 */

/** 解析 profile 的启动列表与各 bundle 的 entry（含用户 patch 的 insert），跳过 disabled 与已隔离项。 */
function collectBootEntries(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const prof = manifest.dsh?.profile ?? {};
  const quarantined = new Set((prof._quarantined ?? []).map((q) => q.name));
  const bundles = (prof.bundles ?? []).filter((b) => !quarantined.has(b));
  const out = [];
  const parsePatch = (text, source) => {
    let cur = null;
    const flush = () => { if (cur) out.push(cur); cur = null; };
    for (const line of text.split('\n')) {
      const idM = /^\s*-?\s*id:\s*['"]?([\w@/.\-]+)['"]?\s*$/.exec(line);
      if (idM) { flush(); cur = { id: idM[1], bundle: source, name: null, disabled: false }; continue; }
      if (!cur) continue;
      const nameM = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (nameM) { cur.name = nameM[1]; continue; }
      if (/^\s*disabled:\s*true\s*$/.test(line)) cur.disabled = true;
    }
    flush();
  };
  for (const b of bundles) {
    const patchPath = join(profileDir, 'node_modules', b, 'cordis.patch.yml');
    if (!existsSync(patchPath)) continue;
    try { parsePatch(readFileSync(patchPath, 'utf8'), b); } catch { /* 读不了由 P1/P7 报 */ }
  }
  const userPatch = join(profileDir, 'cordis.patch.yml');
  if (existsSync(userPatch)) { try { parsePatch(readFileSync(userPatch, 'utf8'), '(user patch)'); } catch { /* 同上 */ } }
  return out.filter((e) => !e.disabled);
}

/** 归类 import 失败，给出人能照做的判断。 */
function classifyImportError(msg) {
  if (/does not provide an export named/.test(msg)) return { kind: 'missing-export', hint: '插件比所装的 @deepseek-ai/* 旧/新：把该插件升级到匹配版本（或降级核心）' };
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(msg)) return { kind: 'not-installed', hint: '依赖或包本身没装全：在该 profile 里重装该插件' };
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version|invalid ELF header|not a valid Win32/.test(msg)) return { kind: 'native-abi', hint: '原生模块与当前 Node ABI 不匹配：重装该插件（npm rebuild / 重新 pnpm add）' };
  if (/ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|require\(\) of ES Module/.test(msg)) return { kind: 'module-format', hint: '包导出/模块格式问题：升级该插件（多为上游未适配）' };
  if (/was killed|ETIMEDOUT|timed out/.test(msg)) return { kind: 'hang', hint: '顶层代码卡住：该插件在加载期做了阻塞操作，需上游修复' };
  return { kind: 'other', hint: '按上面的原始报错定位；确认后可先隔离该 bundle 让 dsh 起来' };
}


/* ---- 预检增强（2026-09）：快照对比 + 安全安装 ---- */

const SNAPSHOT_FILE = '.dsh-doctor-snapshot.json';

/** 采集"启动关键状态"：每个 bundle 的解析版本 + 每条 entry 的 spec。 */
function bootSnapshot(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const prof = manifest.dsh?.profile ?? {};
  const bundles = {};
  for (const b of prof.bundles ?? []) {
    let v = null;
    try { v = JSON.parse(readFileSync(join(profileDir, 'node_modules', b, 'package.json'), 'utf8')).version ?? null; } catch { /* 未装/不可读 */ }
    bundles[b] = v;
  }
  const entries = {};
  for (const e of collectBootEntries(profileDir)) if (e.name) entries[e.id] = `${e.bundle} → ${e.name}`;
  return { at: new Date().toISOString(), bundles, entries };
}

/** 与上次"已知良好"快照对比——这是"到底改了什么"的直接答案（dshmarket 自升级、手动 pnpm add 都算）。 */
function diffSnapshot(prev, cur) {
  if (!prev) return null;
  const out = { addedBundles: [], removedBundles: [], versionChanged: [], addedEntries: [], removedEntries: [] };
  for (const [k, v] of Object.entries(cur.bundles)) {
    if (!(k in prev.bundles)) out.addedBundles.push(k);
    else if (prev.bundles[k] !== v) out.versionChanged.push(`${k}: ${prev.bundles[k]} → ${v}`);
  }
  for (const k of Object.keys(prev.bundles)) if (!(k in cur.bundles)) out.removedBundles.push(k);
  for (const [k, v] of Object.entries(cur.entries)) {
    if (!(k in prev.entries)) out.addedEntries.push(`${k} (${v})`);
    else if (prev.entries[k] !== v) out.addedEntries.push(`${k}: ${prev.entries[k]} → ${v}`);
  }
  for (const k of Object.keys(prev.entries)) if (!(k in cur.entries)) out.removedEntries.push(k);
  return out;
}

function readSnapshot(profileDir) {
  try { return JSON.parse(readFileSync(join(profileDir, SNAPSHOT_FILE), 'utf8')); } catch { return null; }
}
function writeSnapshot(profileDir, snap) {
  try { writeFileSync(join(profileDir, SNAPSHOT_FILE), JSON.stringify(snap, null, 2) + '\n'); } catch { /* 写不了不致命 */ }
}

/**
 * --safe-add <pkg>：装完立即预检，坏了自动回滚。
 * 顺序：先备份 manifest → 调 `dsh plugin --profile <name> add <pkg>` → boot-check →
 *  通过：写"已知良好"快照；
 *  失败：先自动隔离出问题的那几个 bundle（若能就此恢复可启动，则保留安装并如实报告），
 *        若隔离后仍不可启动 → **整体回滚**到安装前的 manifest。
 * 这样"装了个不兼容的插件导致 dsh 起不来"在最坏情况下也只是一次无害的失败尝试。
 */
function safeAdd(profileArg, pkg) {
  const profDir = resolveProfile(profileArg || 'web');
  const manifestPath = join(profDir, 'package.json');
  const before = readFileSync(manifestPath, 'utf8');
  writeFileSync(`${manifestPath}.dsh-doctor.pre-add.${Date.now()}`, before);
  const install = spawnSync(process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
    ['plugin', '--profile', profileArg || 'web', 'add', pkg],
    { cwd: profDir, encoding: 'utf8', stdio: 'inherit', timeout: 15 * 60 * 1000 });
  if (install.status !== 0) {
    writeFileSync(manifestPath, before); // 安装本身失败：还原
    return { ok: false, stage: 'install', restored: true, exit: install.status };
  }
  const results = runBootCheckSync(profDir);
  const failed = results.filter((r) => r.status === 'failed');
  if (!failed.length) {
    writeSnapshot(profDir, bootSnapshot(profDir));
    return { ok: true, stage: 'verified', checked: results.length, failed: 0 };
  }
  // 自动隔离出问题的 bundle
  const quarantined = [];
  for (const name of new Set(failed.map((f) => f.bundle))) {
    if (name === '(user patch)') continue;
    try { const r = quarantineBundle(profDir, name, false); if (r.ok) quarantined.push(name); } catch { /* 忽略 */ }
  }
  const after = runBootCheckSync(profDir);
  const stillFailed = after.filter((r) => r.status === 'failed');
  if (stillFailed.length) {
    writeFileSync(manifestPath, before); // 隔离都救不回来 → 整体回滚
    return { ok: false, stage: 'verify', quarantined, restored: true, failures: failed.map((f) => `${f.bundle}/${f.id}: ${f.kind}`) };
  }
  writeSnapshot(profDir, bootSnapshot(profDir));
  return { ok: true, stage: 'quarantined', quarantined, failures: failed.map((f) => `${f.bundle}/${f.id}: ${f.kind} ${f.error}`) };
}

/** 同步版装载模拟（--safe-add 内部用；与 --boot-check 同一逻辑） */
function runBootCheckSync(profileDir) {
  const out = [];
  for (const e of collectBootEntries(profileDir)) {
    if (!e.name) continue;
    const spec = e.name;
    if (spec.startsWith('cordis:') || spec.startsWith('.') || spec.startsWith('/')) { out.push({ id: e.id, bundle: e.bundle, spec, status: 'skipped' }); continue; }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(spec)});`],
      { cwd: profileDir, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0) out.push({ id: e.id, bundle: e.bundle, spec, status: 'loadable' });
    else {
      const raw = String((r.stderr || '') + (r.stdout || ''));
      const cls = classifyImportError(raw);
      out.push({ id: e.id, bundle: e.bundle, spec, status: 'failed', kind: cls.kind, hint: cls.hint, error: (raw.split('\n').find((l) => /Error/.test(l)) || raw.slice(0, 160)).slice(0, 220) });
    }
  }
  return out;
}


/* ---- 升级前后基线（2026-09）：升级 dsh 前记一次，升级后自动复检 ---- */

const PRE_UPGRADE_FILE = '.dsh-doctor-pre-upgrade.json';

/** 取当前 dsh 核心版本：先问 CLI，再从 PATH 里 dsh 的安装树读 package.json。 */
function coreVersion() {
  try {
    const bin = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
    const m = String(r.stdout || '').trim().match(/\d+\.\d+\.\d+[-\w.]*/);
    if (m) return m[0];
  } catch { /* 落到安装树 */ }
  for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
    if (p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh'))) {
      try {
        const mf = join(dirname(p), '@deepseek-ai', 'dsh', 'package.json');
        return JSON.parse(readFileSync(mf, 'utf8')).version ?? null;
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 升级前基线：核心版本 + bundle 版本 + entry 列表 + manifest 原文（用于必要时人工比对）。 */
function writePreUpgrade(profileDir) {
  const snap = bootSnapshot(profileDir);
  const payload = {
    kind: 'pre-upgrade',
    at: snap.at,
    coreVersion: coreVersion(),
    bundles: snap.bundles,
    entries: snap.entries,
    bundleCount: Object.keys(snap.bundles).length,
  };
  writeFileSync(join(profileDir, PRE_UPGRADE_FILE), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

function readPreUpgrade(profileDir) {
  try { return JSON.parse(readFileSync(join(profileDir, PRE_UPGRADE_FILE), 'utf8')); } catch { return null; }
}

async function runBootCheck(profileDir) {
  const entries = collectBootEntries(profileDir);
  const targets = entries.filter((e) => e.name);
  const results = [];
  for (const e of targets) {
    const spec = e.name;
    // 宿主内置与相对路径不做 import 探测（前者由宿主提供，后者依赖运行上下文）
    if (spec.startsWith('cordis:') || spec.startsWith('.') || spec.startsWith('/')) {
      results.push({ id: e.id, bundle: e.bundle, spec, status: 'skipped', reason: '宿主内置或相对路径，不在本探测范围' });
      continue;
    }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(spec)});`],
      { cwd: profileDir, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0) { results.push({ id: e.id, bundle: e.bundle, spec, status: 'loadable' }); continue; }
    const raw = String((r.stderr || '') + (r.stdout || '')).trim();
    const first = raw.split('\n').find((l) => /Error|error/.test(l)) || raw.split('\n')[0] || '(无输出)';
    const cls = classifyImportError(raw);
    results.push({ id: e.id, bundle: e.bundle, spec, status: 'failed', kind: cls.kind, hint: cls.hint, error: first.slice(0, 220) });
  }
  return results;
}

function quarantineBundle(profileDir, name, undo = false) {
  const manifestPath = join(profileDir, 'package.json');
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const prof = manifest.dsh.profile;
  prof.bundles = prof.bundles ?? [];
  prof._quarantined = prof._quarantined ?? [];
  if (undo) {
    const hit = prof._quarantined.find((q) => q.name === name);
    if (!hit) return { ok: false, error: `隔离列表里没有 ${name}` };
    prof._quarantined = prof._quarantined.filter((q) => q.name !== name);
    if (!prof.bundles.includes(name)) prof.bundles.push(name);
  } else {
    if (!prof.bundles.includes(name)) return { ok: false, error: `${name} 不在 dsh.profile.bundles 里（当前 ${prof.bundles.length} 项）` };
    writeFileSync(`${manifestPath}.bak.${Date.now()}`, raw); // 备份原始 manifest
    prof.bundles = prof.bundles.filter((b) => b !== name);
    prof._quarantined.push({ name, at: new Date().toISOString(), by: 'dsh-doctor --quarantine' });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { ok: true, bundles: prof.bundles.length, quarantined: prof._quarantined.map((q) => q.name) };
}

async function run() {
  // 启动失败自救子命令（不需要 dsh 能启动）
  const bootCheckArg = process.argv.includes('--boot-check');
  const quarantineArg = flagValue('--quarantine');
  const unquarantineArg = flagValue('--unquarantine');
  const safeAddArg = flagValue('--safe-add');
  const preUpgradeArg = process.argv.includes('--pre-upgrade');
  const postUpgradeArg = process.argv.includes('--post-upgrade');
  if (preUpgradeArg || postUpgradeArg) {
    const profDir = resolveProfile(profileArg || 'web');
    if (preUpgradeArg) {
      const base = writePreUpgrade(profDir);
      if (jsonOut) console.log(JSON.stringify({ ok: true, ...base }, null, 2));
      else {
        console.log(`✓ 已记录升级前基线（${profDir}）`);
        console.log(`  核心版本: ${base.coreVersion ?? '(未能确定)'} | bundle ${base.bundleCount} 个 | entry ${Object.keys(base.entries).length} 条`);
        console.log('  下一步：升级 dsh，然后运行');
        console.log(`    npx @moonquake2004/dsh-doctor --post-upgrade --profile ${profileArg || 'web'}`);
        console.log('  （--post-upgrade 会自动对比核心与插件变化、跑装载模拟，并给出修复/隔离命令）');
      }
      process.exit(0);
    }
    const base = readPreUpgrade(profDir);
    if (!base) {
      console.error(`✗ 没找到升级前基线（${join(profDir, PRE_UPGRADE_FILE)}）——请先在升级前运行 --pre-upgrade`);
      process.exit(1);
    }
    const nowCore = coreVersion();
    const nowSnap = bootSnapshot(profDir);
    const drift = diffSnapshot({ bundles: base.bundles, entries: base.entries }, nowSnap) ?? {};
    const results = runBootCheckSync(profDir);
    const failed = results.filter((r) => r.status === 'failed');
    const coreChanged = base.coreVersion !== nowCore;
    const lines = [];
    lines.push(`核心版本: ${base.coreVersion ?? '?'} → ${nowCore ?? '?'}${coreChanged ? '（已变化）' : '（未变化）'}`);
    if ((drift.addedBundles ?? []).length) lines.push(`新增 bundle: ${drift.addedBundles.join(', ')}`);
    if ((drift.removedBundles ?? []).length) lines.push(`移除 bundle: ${drift.removedBundles.join(', ')}`);
    if ((drift.versionChanged ?? []).length) lines.push(`插件版本变化: ${drift.versionChanged.join('; ')}`);
    if ((drift.addedEntries ?? []).length) lines.push(`新增/变更 entry: ${drift.addedEntries.join('; ')}`);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: failed.length === 0, profile: profDir, baselineAt: base.at, coreChanged, from: base.coreVersion, to: nowCore, drift, checked: results.length, failed: failed.length, results }, null, 2));
      process.exit(failed.length ? 2 : 0);
    }
    console.log(`升级后复检（基线取自 ${String(base.at).slice(0, 16)}）：`);
    for (const l of lines) console.log(`  · ${l}`);
    if (!failed.length) {
      console.log('  ✓ 装载模拟通过——升级未破坏任何可探测 entry');
      writeSnapshot(profDir, nowSnap);
    } else {
      console.log(`  ✗ 装载模拟失败 ${failed.length} 条（这就是"升级后起不来"的直接原因）：`);
      for (const f of failed) {
        console.log(`      [${f.bundle}] ${f.id} → ${f.spec}`);
        console.log(`        ${f.kind}: ${f.error}`);
        console.log(`        修复方向：${f.hint}`);
        console.log(`        先起来：npx @moonquake2004/dsh-doctor --quarantine ${f.bundle} --profile ${profileArg || 'web'}`);
      }
      if (process.argv.includes('--auto-quarantine')) {
        const q = [];
        for (const name of new Set(failed.map((f) => f.bundle))) {
          if (name === '(user patch)') continue;
          try { const r = quarantineBundle(profDir, name, false); if (r.ok) q.push(name); } catch { /* 忽略 */ }
        }
        if (q.length) console.log(`  → 已自动隔离: ${q.join(', ')}（重启 dsh 即可；用 --unquarantine 放回）`);
      }
    }
    process.exit(failed.length ? 2 : 0);
  }
  if (safeAddArg) {
    // 装完立即预检、坏了自动回滚——"装了个不兼容插件导致 dsh 起不来"的预防手段
    const profDir = resolveProfile(profileArg || 'web');
    const r = safeAdd(profileArg || 'web', safeAddArg);
    if (jsonOut) console.log(JSON.stringify(r, null, 2));
    else if (r.ok && r.stage === 'verified') console.log(`✓ 已安装并预检通过（${r.checked} 条 entry 均可导入）——重启 dsh 即可`);
    else if (r.ok && r.stage === 'quarantined') {
      console.log(`⚠ 已安装，但该插件的 entry 导入失败，已自动隔离以避免 dsh 起不来：`);
      for (const f of r.failures || []) console.log(`    ${f}`);
      console.log(`  隔离项：${r.quarantined.join(', ')}（用 --unquarantine <包名> 放回，修好版本后再重试）`);
      console.log(`  dsh 现在可以正常启动。`);
    } else if (r.stage === 'install') console.log(`✗ 安装命令本身失败（exit ${r.exit}），已还原 manifest`);
    else {
      console.log(`✗ 安装后无法启动，且隔离也救不回来 → 已整体回滚到安装前状态`);
      for (const f of r.failures || []) console.log(`    ${f}`);
    }
    process.exit(r.ok ? 0 : 2);
  }
  if (bootCheckArg || quarantineArg || unquarantineArg) {
    const profDir = resolveProfile(profileArg || 'web');
    try {
      if (quarantineArg || unquarantineArg) {
        const r = quarantineBundle(profDir, quarantineArg || unquarantineArg, !!unquarantineArg);
        if (!r.ok) { console.error(`✗ ${r.error}`); process.exit(1); }
        console.log(JSON.stringify({ ok: true, action: unquarantineArg ? 'unquarantine' : 'quarantine', ...r, next: '重启 dsh；随后用 --boot-check 复查，或用 --unquarantine 撤销' }, null, 2));
        process.exit(0);
      }
      const results = await runBootCheck(profDir);
      const failed = results.filter((r) => r.status === 'failed');
      const prevSnap = readSnapshot(profDir);
      const curSnap = bootSnapshot(profDir);
      const drift = diffSnapshot(prevSnap, curSnap);
      if (drift && !jsonOut) {
        const lines = [];
        if (drift.addedBundles.length) lines.push(`新增 bundle: ${drift.addedBundles.join(', ')}`);
        if (drift.versionChanged.length) lines.push(`版本变化: ${drift.versionChanged.join('; ')}`);
        if (drift.removedBundles.length) lines.push(`移除 bundle: ${drift.removedBundles.join(', ')}`);
        if (drift.addedEntries.length) lines.push(`新增/变更 entry: ${drift.addedEntries.join('; ')}`);
        if (drift.removedEntries.length) lines.push(`移除 entry: ${drift.removedEntries.join(', ')}`);
        if (lines.length) {
          console.log(`自上次预检通过以来（${String(prevSnap.at).slice(0, 16)}）：`);
          for (const l of lines) console.log(`  · ${l}`);
          console.log('  ——若本次启动失败，上面这些就是首要嫌疑。');
        }
      }
      if (!failed.length) writeSnapshot(profDir, curSnap); // 只有通过时才更新"已知良好"快照
      if (jsonOut) {
        console.log(JSON.stringify({ ok: failed.length === 0, profile: profDir, checked: results.length, failed: failed.length, drift, results }, null, 2));
      } else {
        console.log(`装载模拟（${profDir}）：检查 ${results.length} 条 entry，失败 ${failed.length} 条`);
        for (const r of results) {
          if (r.status === 'failed') console.log(`  ✗ [${r.bundle}] ${r.id} → ${r.spec}\n      ${r.kind}: ${r.error}\n      修复方向：${r.hint}\n      先起来：npx @moonquake2004/dsh-doctor --quarantine ${r.bundle}`);
          else if (r.status === 'skipped') console.log(`  ⊖ ${r.id}（${r.reason}）`);
        }
        if (!failed.length) console.log('  ✓ 所有可探测 entry 均可导入——启动失败若仍发生，问题多在配置合并或原生环境，请贴 --json 输出');
      }
      process.exit(failed.length ? 2 : 0);
    } catch (e) {
      console.error(`启动模拟失败: ${e.message}`);
      process.exit(1);
    }
  }

  // 层 C 观察者（--observe / --observe-apply）：独立子命令，跑完即退出，不执行常规检查
  const observeArg = flagValue('--observe');
  const observeApplyArg = flagValue('--observe-apply');
  const llmCmd = process.argv.includes('--observe-llm') ? flagValue('--observe-llm') : process.env.DSH_DOCTOR_LLM_CMD ?? null;
  if (observeArg || observeApplyArg) {
    const { runObserver, applyProposals, writeLocalOverlay, readLocalOverlay } = await import('./observer.mjs');
    try {
      if (observeApplyArg) {
        const raw = JSON.parse(readFileSync(resolve(observeApplyArg), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw.proposals ?? [];
        const overlayPath = join(dirname(fileURLToPath(import.meta.url)), 'checks.local.json');
        // 覆盖层只追加新提案（loadCatalog 会 base + local 合并），且对已存在覆盖层幂等
        const existing = readLocalOverlay(overlayPath);
        const { catalog: merged, applied, rejected } = applyProposals({ schemaVersion: 1, checks: existing }, list);
        if (applied.length) {
          writeLocalOverlay(overlayPath, {
            schemaVersion: 1,
            description: 'Layer C 观察者本地覆盖层——未认证提案，不随包分发；认证通过后请合并进 checks.json 并删除本文件。',
            checks: merged.checks,
          });
        }
        console.log(JSON.stringify({ ok: true, written: applied.length ? overlayPath : null, applied: applied.map((p) => p.id), rejected }, null, 2));
        process.exit(0);
      }
      const res = await runObserver({ path: observeArg, existingChecks: bundledCatalog().checks, llmCmd });
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    } catch (e) {
      console.error(`观察者失败: ${e.message}`);
      process.exit(1);
    }
  }
  // --security-only 跳过非安全检查
  if (!securityOnly) {
    try { checkEnv(); } catch (e) { report('env', 'E0', false, `env 检查异常: ${e.message.slice(0, 80)}`); }
    try { await checkPort3080(); } catch (e) { report('env', 'E10-port-3080', false, `端口检查异常: ${e.message.slice(0, 60)}`); }
    try { checkProfile(profileArg); } catch (e) { report('profile', 'P0', false, `profile 检查异常: ${e.message.slice(0, 100)}`); }
    try { checkSession(sessionArg); } catch (e) { report('session', 'S0', false, `session 检查异常: ${e.message.slice(0, 100)}`); }
    try { scanAllSessions(); } catch (e) { report('session', 'S11', false, `全会话扫描异常: ${e.message.slice(0, 100)}`); }
    try { scanMigrationRefusals(); } catch (e) { report('session', 'S12', false, `迁移拒载预检异常: ${e.message.slice(0, 100)}`); }
  }

  // 远程检查目录（层 A）：内置检查之后追加执行；--no-catalog 只走内置副本；--security-only 跳过
  let catalogMeta = { source: 'none', checks: 0 };
  if (!securityOnly) {
    try {
      const catalog = await loadCatalog({ noRemote: process.argv.includes('--no-catalog'), fetchImpl: typeof fetch === 'function' ? fetch : undefined });
      catalogMeta = { source: catalog.source, checks: catalog.checks.length };
      const profileDir = (() => { try { return resolveProfile(profileArg); } catch { return null; } })();
      if (catalog.checks.length && profileDir) checkCatalog({ home: HOME, profile: profileArg, profileDir }, catalog);
      else if (catalog.checks.length) report('catalog', 'C0', true, `profile 无效（${profileArg}），目录检查跳过（${catalog.source}）`, undefined, 'catalog');
    } catch (e) {
      catalogMeta = { source: 'error', checks: 0, error: e.message.slice(0, 80) };
    }
  }

  // 层 B：版本检查与更新（--no-catalog 同时禁用网络检查；--update 手动更新；DSH_DOCTOR_AUTO_UPDATE=1 自动；--security-only 跳过）
  const noRemote = process.argv.includes('--no-catalog');
  let updateInfo = { current: localVersion(), latest: null, available: false };
  if (!securityOnly) {
    try {
      updateInfo = await checkForUpdate({ noRemote, fetchImpl: typeof fetch === 'function' ? fetch : undefined });
    } catch (e) {
      updateInfo = { current: localVersion(), latest: null, available: false, error: e.message.slice(0, 60) };
    }
    if (process.argv.includes('--update') || (process.env.DSH_DOCTOR_AUTO_UPDATE === '1' && updateInfo.available)) {
      updateInfo.applied = runUpdate();
    }
  }

  // 安全检查（--security）：导入 dsh-security 运行安全检查，合并到 results
  // --security-only 隐含启用安全检查（复审修复：此前单独使用 = 静默空跑）
  const securityEnabled = process.argv.includes('--security') || securityOnly;
  let securityMeta = { enabled: false, summary: {} };
  if (securityEnabled) {
    try {
      // 尝试从 profile node_modules 或全局安装导入 dsh-security；
      // 开发调试可用 DSH_SECURITY_SRC 指向工作区源码（复审修复：移除硬编码个人路径）
      let secMod;
      const profileDir = (() => { try { return resolveProfile(profileArg); } catch { return null; } })();
      const secCandidates = [
        process.env.DSH_SECURITY_SRC,
        profileDir ? join(profileDir, 'node_modules', '@moonquake2004', 'dsh-security', 'src', 'index.mjs') : null,
        join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '@moonquake2004', 'dsh-security', 'src', 'index.mjs'),
      ].filter(Boolean);
      for (const candidate of secCandidates) {
        if (existsSync(candidate)) { secMod = await import(candidate); break; }
      }
      if (secMod) {
        const registry = await secMod.createDefaultRegistry();
        // 注入 ~/.dsh/security.json 配置（旧版 dsh-security 无此能力时静默跳过）
        try {
          if (secMod.loadConfig && typeof registry.setConfig === 'function') {
            registry.setConfig(secMod.loadConfig(HOME));
          }
        } catch { /* 配置损坏不影响检查 */ }
        // 获取最新会话文件（供 SR*/SS* 检查使用）
        // 世代感知定位（与 S11 同一规则）：三层 sessions/<user>/<session>/session*.jsonl*，
        // 目录内取最高世代（v0/v3 并存时取 v3），跨目录按 mtime 取最新，忽略 session.lock
        // 运行时检查（SR*/SS*）扫"最新会话"，而最新会话通常**就是当前正在写入的会话** ——
        // 那会把操作者自己的操作报成安全发现（2026-09 实测：SR1 报的 critical 全是本次会话里
        // 自己写的 `curl|bash` 测试串，SR2 的 `doas` 来自自己引用的规则文本）。
        // 故默认跳过"仍在写入"的会话：取 mtime 早于活跃窗口的最新会话；
        // 窗口可用 DSH_DOCTOR_LIVE_WINDOW_MS 调整（默认 120s，设 0 关闭该保护）。
        const LIVE_WINDOW_MS = (() => {
          const v = Number(process.env.DSH_DOCTOR_LIVE_WINDOW_MS);
          return Number.isFinite(v) && v >= 0 ? v : 120000;
        })();
        const findLatestSession = () => {
          if (sessionArg) return sessionArg; // 显式指定则始终尊重
          try {
            const root = join(HOME, 'sessions');
            const all = listSessionLogs(root); // 已按 mtime 降序
            if (!all.length) return null;
            if (LIVE_WINDOW_MS === 0) return all[0].f;
            const cutoff = Date.now() - LIVE_WINDOW_MS;
            const settled = all.find((x) => (x.m ?? 0) < cutoff);
            return (settled ?? all[0]).f;
          } catch { return null; }
        };
        const sessionIsLive = (() => {
          if (sessionArg || LIVE_WINDOW_MS === 0) return false;
          try {
            const all = listSessionLogs(join(HOME, 'sessions'));
            return all.length > 0 && (all[0].m ?? 0) >= Date.now() - LIVE_WINDOW_MS;
          } catch { return false; }
        })();

        const { results: secResults, exitCode: secExit, summary: secSummary } = await registry.runAll(
          (check) => {
            // SR*/SS* 运行时会话检查用会话文件
            if (check.id && (check.id.startsWith('SR') || check.id.startsWith('SS'))) {
              return findLatestSession();
            }
            // 其余（SP*/SL*/EXT-*）用 profile 目录
            return profileDir || profileArg;
          }
        );
        for (const r of secResults) {
          results.push({ section: 'security', id: r.id, ok: r.ok, detail: r.detail, fix: r.fix, severity: r.severity, skip: !!r.skipped });
        }
        securityMeta = { enabled: true, summary: secSummary, exitCode: secExit };
      } else {
        securityMeta = { enabled: true, error: 'dsh-security not found', summary: {} };
      }
    } catch (e) {
      securityMeta = { enabled: true, error: e.message.slice(0, 80), summary: {} };
    }
  }

  // 退出码只计内置失败 + catalog 中 severity=error 的失败；warn 失败提示但不改退出码
  // 安全检查走独立通道：secExit 由 dsh-security 按 severity 计算（CRITICAL→2, HIGH→1, 其余 0），
  // 不参与 bad[] 与信封 baseExit——复审修复：此前任何安全失败（哪怕 LOW 级关注点）都会把退出码抬到 1/2，
  // 违反 dsh-security 契约「MEDIUM 及以下不影响退出码」与本函数上方注释的声明。
  const bad = results.filter((r) => r.section !== 'security' && !r.ok && catalogSeverity.get(r.id) !== 'warn');
  const secExit = securityMeta.exitCode ?? 0;
  if (jsonOut && process.argv.includes('--envelope')) {
    // v1 契约信封（dsh doctor 规格，zoahdev/doctor 对齐）：status 小写 + 退出码 0/1/2
    const st = (r) => (r.skip ? 'skip' : (!r.ok ? (((r.section === 'security') ? r.severity !== 'critical' : catalogSeverity.get(r.id) === 'warn') ? 'warn' : 'fail') : 'pass'));
    const summary = { pass: 0, warn: 0, fail: 0, skip: 0 }; // skip 常驻（v1 词汇表 r5：#1719），r5 后 P12 会在未装 bundle 时实际触发
    const checks = results.map((r) => { summary[st(r)]++; return { name: r.id, status: st(r), detail: r.detail, ...(r.severity ? { severity: r.severity } : {}), ...(r.section === 'security' ? { section: 'security' } : {}) }; });
    // baseExit 只统计非安全项；安全项对退出码的贡献由 secExit 独立承载
    let baseFail = 0; let baseWarn = 0;
    for (const r of results) {
      if (r.section === 'security') continue;
      const s = st(r);
      if (s === 'fail') baseFail++;
      else if (s === 'warn') baseWarn++;
    }
    const baseExit = baseFail > 0 ? 2 : baseWarn > 0 ? 1 : 0;
    const exitCode = Math.max(baseExit, secExit);
    // v1.1 remediation（#1719 ADOPTED：ciceroyang 提名、两位 reviewer +1）：opt-in --remediation，
    // 顶层有序数组 ["[<checks[].name>] <fix>", ...]，仅失败且有 fix 的项；键名取到首个 ']'，']' 是唯一禁用字符。
    // 不带 --remediation 时字段不存在（r5 消费者字节稳定）。
    const remediation = process.argv.includes('--remediation')
      ? results.filter((r) => !r.ok && r.fix && !r.id.includes(']')).map((r) => `[${r.id}] ${r.fix}`)
      : null;
    const out = {
      schema: 'dsh-doctor/v1',
      tool: 'dsh-doctor',
      generatedAt: new Date().toISOString(),
      profile: profileArg,
      exitCode,
      summary,
      ok: exitCode === 0,
      checks,
      ...(remediation ? { remediation } : {}),
    };
    if (securityMeta.enabled) {
      out.security = { enabled: true, summary: securityMeta.summary, ...(securityMeta.error ? { error: securityMeta.error } : {}) };
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(exitCode);
  } else if (jsonOut) {
    // 每条检查带上 status（pass/warn/fail/skip，与 --envelope 同一词汇表）。
    // 2026-09：此前 --json 只给 ok 布尔，消费者（含我们自己的测试助手）无法区分
    // "warn 级失败"（如 CI 上无 pnpm → E1-pnpm warn，不翻退出码）与"error 级失败"，
    // 于是把 warn 当成误报。状态本就不该由消费者自行推导。
    const statusOf = (r) => (r.skip ? 'skip' : (!r.ok ? (((r.section === 'security') ? r.severity !== 'critical' : catalogSeverity.get(r.id) === 'warn') ? 'warn' : 'fail') : 'pass'));
    const checksWithStatus = results.map((r) => ({ ...r, status: statusOf(r) }));
    console.log(JSON.stringify({ ok: bad.length === 0 && secExit === 0, checks: checksWithStatus, catalog: catalogMeta, update: updateInfo, ...(securityMeta.enabled ? { security: securityMeta } : {}) }, null, 2));
  } else {
    const sectionOrder = { env: 0, profile: 1, session: 2, catalog: 3 };
    const ordered = [...results].sort((a, b) => (sectionOrder[a.section] ?? 9) - (sectionOrder[b.section] ?? 9));
    let lastSection = '';
    for (const r of ordered) {
      if (r.section !== lastSection) { console.log(`\n== ${r.section === 'security' ? '🔒 安全' : r.section.toUpperCase()} ==`); lastSection = r.section; }
      const sev = catalogSeverity.get(r.id);
      // 安全检查：skip 显示 ⊖；critical/high 失败 ✗；medium 及以下失败 ⚠（不影响退出码）
      const mark = r.skip ? '⊖'
        : (!r.ok ? (((r.section === 'security' && r.severity !== 'critical' && r.severity !== 'high') || sev === 'warn') ? '⚠' : '✗')
        : '✓');
      console.log(` ${mark} [${r.id}]${r.severity ? `（${r.severity}${r.skip ? '/skip' : ''}）` : ''} ${r.detail}${r.src === 'catalog' ? '  [目录]' : ''}`);
      if (!r.ok && r.fix) console.log(`     ↳ 修复: ${r.fix}`);
    }
    if (updateInfo.available && !updateInfo.applied) {
      console.log(`\n⚠ 新版本 ${updateInfo.latest} 可用（当前 ${updateInfo.current}）→ 运行 \`dsh-doctor --update\` 或 \`dsh plugin update\``);
    } else if (updateInfo.applied) {
      console.log(`\n✓ ${updateInfo.applied}`);
    }
    console.log(`\n${(bad.length === 0 && secExit === 0) ? '✓ 全部通过' : `✗ ${bad.length} 个内置问题${secExit > 0 ? ` + 安全 ${secExit === 2 ? 'CRITICAL' : 'HIGH'} 级失败` : ''}`}（profile=${profileArg}，目录=${catalogMeta.source}，${catalogMeta.checks} 条）`);
  }
  // 最终退出码：内置失败 → 1；安全 HIGH → 1、CRITICAL → 2（取 max）
  process.exit(Math.max(bad.length > 0 ? 1 : 0, secExit));
}

// 直接执行（CLI：根目录薄封装、plugin 本体、npm bin 均可）；被 import（测试/宿主）时不自动运行
if (process.argv[1] && /^dsh-doctor(\.mjs)?$/.test(basename(process.argv[1]))) run();

export { loadCatalog, bundledCatalog, validCatalog, expandPath, globCount, checkCatalog, nodeInSupportedRange };
