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
 *   [session]
 *     S1  孤儿 tool_call（#1363：assistant tool_calls 无对应 tool 结果 → INVALID_REQUEST）
 *     S2  未闭合 turn（#466/#1265：turn/start 无 turn/end → 会话永久"运行中"）
 *     S6  seq 不连续/空洞/重复（#1333/#1452/#1469：官方 seq==index 校验，chunk 行按 expandRow 展开）
 *     S7  end-seed 后重放已提交尾部（#1497：种子末尾之后出现更低 seq）
 *     S9  zstd 容器结构（#1043：单帧容器 → session.list 整体 500，侧边栏全消失）
 *     S10 sourceEventSeqs 悬空引用（#1469：压缩未重映射溯源 → history unavailable）
 *     S8  未知事件类型且无 ignorable（#1538：插件写的事件 harness 读不了 → 整包拒绝；清单从安装的 dsh-session 解析，内置 0.1.0-rc.6 回退）
 *     S11 全会话扫描（#1550：损坏会话 → 隔离建议；超大会话/工作区估算物化堆 → 冷启动风险警告；估算堆=解码MB×6+事件×200B，阈值默认 1GB，可设 DSH_DOCTOR_HEAP_MB）
 *   [env]
 *     E1  关键命令不在 PATH（#1270：node/pnpm/zstd）
 *     E2  .env 是目录而非文件（#71：failed to load .env: EISDIR）
 *     E3  node 版本 / --expose-internals 可及性（#113/#1313，headless/HMR 场景）
 *     E4  node-pty 原生模块完整性（#1219：pty.node 缺失 → dsh web 启动失败）
 *     E5  存储 JSON 文件合法性（#1357：并发写 workspace.json 乱码 → 工作区列表消失）
 *     E6  锚点元检查（tripwire：S6 的 expandRow seq0+k、S7 的 session/end-seed、S10 的 sourceEventSeqs 是否仍在安装的 dsh-session 中）
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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter as PATH_DELIM, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const results = []; // { section, id, ok, detail, fix? }
const jsonOut = process.argv.includes('--json');
const only = process.argv
  .filter((a) => a.startsWith('--profile') || a.startsWith('--session') || a === '--env')
  .map((a) => a.startsWith('--') ? a.slice(2) : a);
const wants = (s) => only.length === 0 || only.includes(s) || only.includes(s.charAt(0).toUpperCase() + s.slice(1));

// S8：官方 KNOWN_SESSION_EVENT_TYPES（0.1.0-rc.6 内置回退；优先从安装的 dsh-session 解析）
const KNOWN_SESSION_EVENT_TYPES_FALLBACK = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/chunk', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
  'llm/retry', 'llm/retry-started', 'permission/preset', 'plan/mode', 'request/context', 'request/header',
  'sandbox/mode', 'schedule/change', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'step/end', 'step/start', 'subagent/descriptor', 'todo/write', 'tool-workflow/agent-end',
  'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call',
  'tool/code-dispatch', 'tool/code-dispatch-start', 'tool/result', 'turn/end', 'turn/start', 'user/message',
  'web/deepseek-search-llm-request'
]);
// 存储行类型与 header，不属于事件门禁
const STORAGE_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'session']);
function knownSessionEventTypes() {
  for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
    if (!p.endsWith('node_modules/.bin') || !existsSync(join(p, 'dsh'))) continue;
    try {
      const src = readFileSync(join(dirname(p), '@deepseek-ai', 'dsh-session', 'lib', 'index.js'), 'utf8');
      const m = /const KNOWN_SESSION_EVENT_TYPES = new Set\(\[(.*?)\]\);/.exec(src);
      if (m) {
        const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        if (items.length) return new Set(items);
      }
    } catch { /* 回退 */ }
    break;
  }
  return KNOWN_SESSION_EVENT_TYPES_FALLBACK;
}
const KNOWN = knownSessionEventTypes();

function report(section, id, ok, detail, fix, src) {
  results.push({ section, id, ok, detail, fix, src: src ?? 'builtin' });
}

function resolveProfile(name) {
  if (!name || name.includes('/') || name.includes('\\')) throw new Error(`无效 profile 名: ${JSON.stringify(name)}`);
  return join(HOME, 'profiles', name);
}

/* ================= env ================= */
function checkEnv() {
  if (!wants('env')) return;
  const find = (cmd) => { for (const w of process.platform === 'win32' ? ['where'] : ['which']) { const r = spawnSync(w, [cmd]); if (r.status === 0) { const p = String(r.stdout).split(/\r?\n/)[0].trim(); if (p) return p; } } return null; };
  for (const cmd of ['node', 'pnpm', 'zstd']) {
    const p = find(cmd);
    report('env', `E1-${cmd}`, !!p, p ? `${cmd}: ${p}` : `${cmd} 不在 PATH（${cmd === 'node' ? '创建会话会失败 #1270' : cmd === 'pnpm' ? 'dsh plugin 不可用' : '会话日志解压不可用'}）`, p ? undefined : `安装 ${cmd} 或加入 PATH`);
  }
  const envFile = join(HOME, '.env');
  if (existsSync(envFile)) {
    const isDir = lstatSync(envFile).isDirectory();
    report('env', 'E2-env', !isDir, isDir ? `${envFile} 是目录，dsh 启动会报 failed to load .env: EISDIR（#71）` : `${envFile} 正常`, isDir ? '删除或改名该目录' : undefined);
  }
  const nv = spawnSync('node', ['-e', 'console.log(process.version)']);
  if (nv.status === 0) report('env', 'E3-node', true, `node ${String(nv.stdout).trim()}`, undefined);

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
  const ptyFound = ptyDirs.filter((d) => existsSync(d));
  let ptyBinary = null;
  for (const d of ptyFound) {
    for (const bin of [join(d, 'prebuilds', plat, 'pty.node'), join(d, 'build', 'Release', 'pty.node')]) {
      if (existsSync(bin) && statSync(bin).size > 0) { ptyBinary = bin; break; }
    }
    if (ptyBinary) break;
  }
  if (ptyFound.length === 0) report('env', 'E4', false, '未找到 node-pty（dsh web 终端依赖它，#1219）', '重新安装 @deepseek-ai/dsh，确保 node-pty 装全');
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
  let sessionLib = null;
  for (const p of (process.env.PATH || '').split(PATH_DELIM)) {
    if (p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh'))) {
      const lib = join(dirname(p), '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
      if (existsSync(lib)) { sessionLib = lib; break; }
    }
  }
  if (!sessionLib) {
    report('env', 'E6', true, '⚠ 未定位到 dsh-session，锚点未校验（回退内置假设：expandRow/end-seed/sourceEventSeqs）', '安装 dsh 后重跑可校验');
  } else {
    const src = readFileSync(sessionLib, 'utf8');
    const anchors = [
      ['expandRow 的 seq0+k 展开（S6 依赖）', /function expandRow[\s\S]*?row\.seq0/, src],
      ['session/end-seed 字面量（S7 依赖）', /"session\/end-seed"/, src],
      ['sourceEventSeqs 字段（S10 依赖）', /sourceEventSeqs/, src],
    ];
    const missing = anchors.filter(([, re]) => !re.test(src));
    if (missing.length) {
      report('env', 'E6', false, `锚点缺失（上游可能改了契约，S6/S7/S10 结论需人工复核）: ${missing.map(([n]) => n).join('; ')}（${sessionLib.slice(-60)}）`, '对照上游变更更新 dsh-doctor 的对应检查');
    } else {
      report('env', 'E6', true, `锚点齐全（${anchors.length}/3: seq0+k / session/end-seed / sourceEventSeqs）`, undefined);
    }
  }
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
    for (const m of text.matchAll(/^\s*-\s*name:\s*['"]?([^'"\s]+)/gm)) out.add(m[1]);
    return out;
  })();

  // P1 bundles 可解析性
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) {
      report('profile', 'P1', false, `bundle 条目 ${b} 无法在安装目录或 profile node_modules 解析（#917/#1377/#880）`, `dsh plugin --profile ${name} add ${b} 或从 dsh.profile.bundles 移除`);
    } else {
      const pkg = JSON.parse(readFileSync(join(dir2, 'package.json'), 'utf8'));
      if (!pkg.dsh?.bundle?.patch) {
        report('profile', 'P1', false, `bundle 条目 ${b} 存在但未声明 dsh.bundle（#1377 静默禁用类）`, '检查该包版本或移除条目');
      }
    }
  }
  // P2 id 冲突
  const bundleIds = new Set();
  for (const b of bundles) {
    const dir2 = findPkg(b);
    if (!dir2) continue;
    const pkg = JSON.parse(readFileSync(join(dir2, 'package.json'), 'utf8'));
    const rel = pkg.dsh?.bundle?.patch;
    if (!rel) continue;
    for (const id of readInsertIds(join(dir2, rel))) bundleIds.add(id);
  }
  const dup = [...bundleIds].filter((id) => userIds.has(id));
  if (dup.length) {
    report('profile', 'P2', false, `bundle 与用户 patch 的 id 冲突（启动必崩 duplicate loader entry id，#1404）: ${dup.join(', ')}`, `备份后从 ${patchPath} 删除这些 insert（或运行 check-dsh-profile.mjs 查看详情）`);
  } else {
    report('profile', 'P2', true, '无 bundle/用户 patch id 冲突', undefined);
  }
  // P3 insert name 可解析性
  const req = (() => { try { return createRequire(join(dir, '_anchor.js')); } catch { return null; } })();
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
    let ok = false;
    try { if (req) { req.resolve(n); ok = true; } } catch { ok = false; }
    if (!ok) bad.push(n);
  }
  if (bad.length) report('profile', 'P3', false, `用户 patch 中不可解析的 name（#1197/#880）: ${bad.join(', ')}`, `dsh plugin --profile ${name} add <包> 或修复 file: 依赖`);
  else report('profile', 'P3', true, '用户 patch insert 均可解析', undefined);
  // P4 file: 依赖悬空（file: 目标可能是相对（file:./plugins/x）或绝对（file:/abs/path））
  const resolveFileSpec = (spec) => {
    const target = spec.slice(5);
    return /^[/\\]|^[A-Za-z]:/.test(target) ? target : join(dir, target);
  };
  const dangling = Object.entries(deps).filter(([, spec]) => spec.startsWith('file:')).filter(([, spec]) => !existsSync(resolveFileSpec(spec)));
  if (dangling.length) report('profile', 'P4', false, `悬空 file: 依赖（#1197）: ${dangling.map(([n, s]) => `${n} (${s})`).join(', ')}`, '恢复目录或移除依赖');
  else report('profile', 'P4', true, 'file: 依赖完整', undefined);
  // P5 顶层 @deepseek-ai/* 重复
  const topDup = [];
  const topDir = join(dir, 'node_modules', '@deepseek-ai');
  if (existsSync(topDir)) {
    for (const p of readdirSync(topDir)) {
      const fp = join(topDir, p);
      if (existsSync(join(fp, 'package.json'))) topDup.push(p);
    }
  }
  if (topDup.length) report('profile', 'P5', false, `profile 顶层存在 @deepseek-ai/* 重复（#1486 双实例风险）: ${topDup.join(', ')}`, '清理 profile node_modules 中与框架版本相同的 @deepseek-ai 包（pnpm install 后会重建，需在 doctor 中提醒）');
  else report('profile', 'P5', true, '无顶层 @deepseek-ai 重复', undefined);
}

/* ================= session ================= */
function checkSession(targetPath) {
  if (!wants('session')) return;
  const target = targetPath || (() => {
    let best = null, bestM = -1;
    const root = join(HOME, 'sessions');
    if (!existsSync(root)) return null;
    for (const u of readdirSync(root)) {
      const sd = join(root, u);
      if (!existsSync(sd)) continue;
      for (const s of readdirSync(sd)) {
        const f = existsSync(join(sd, s, 'session.jsonl.zstd')) ? join(sd, s, 'session.jsonl.zstd') : join(sd, s, 'session.jsonl');
        if (!existsSync(f)) continue;
        const m = statSync(f).mtimeMs;
        if (m > bestM) { bestM = m; best = f; }
      }
    }
    return best;
  })();
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
  const calls = new Map(); const results2 = new Set(); let maxSeq = -1;
  const turnStarts = new Set(); const turnEnds = new Set();
  const positions = []; const endSeedSeqs = [];
  const expanded = []; const sesViolations = []; const s8Violations = []; let evIndex = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const seq = d.seq; if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq;
    // S8：未知事件类型且未标 ignorable（#1538：harness 整包拒绝）
    if (!STORAGE_ROW_TYPES.has(d.type) && !KNOWN.has(d.type) && d.ignorable !== true) {
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
    report('session', 'S8', true, `所有事件类型均在 KNOWN_SESSION_EVENT_TYPES 内（${KNOWN.size} 种）`, undefined);
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

/* S11：全会话扫描 —— 损坏 → 隔离建议；超大 → 冷打开物化风险（#1550：一个坏/超大会话拖垮整个服务器） */
function scanAllSessions() {
  if (!wants('session')) return;
  const root = join(HOME, 'sessions');
  if (!existsSync(root)) { report('session', 'S11', true, '无会话目录，跳过全会话扫描', undefined); return; }
  const files = [];
  for (const u of readdirSync(root)) {
    const sd = join(root, u);
    if (!existsSync(sd)) continue;
    for (const s of readdirSync(sd)) {
      const f = existsSync(join(sd, s, 'session.jsonl.zstd')) ? join(sd, s, 'session.jsonl.zstd') : join(sd, s, 'session.jsonl');
      if (existsSync(f)) files.push(f);
    }
  }
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
    let evIndex = 0, lastSeed = -1, seedIdx = -1, posList = [];
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li]; if (!ln.trim()) continue;
      let d; try { d = JSON.parse(ln); } catch { problems.push(`行 ${li + 1} 无法解析`); continue; }
      if (!STORAGE_ROW_TYPES.has(d.type) && !KNOWN.has(d.type) && d.ignorable !== true) problems.push(`未知类型 ${d.type}`);
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

function bundledCatalog() {
  const p = new URL('./checks.json', import.meta.url);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { schemaVersion: 1, checks: [] }; }
}

function validCatalog(data) {
  return !!data && data.schemaVersion === 1 && Array.isArray(data.checks);
}

/** 拉取目录：新鲜缓存(≤TTL) → 远程(raw.githubusercontent，3s 超时) → 旧缓存(last-known-good) → 内置副本。 */
async function loadCatalog({ noRemote = false, fetchImpl, home = HOME } = {}) {
  const bundled = bundledCatalog();
  if (noRemote || typeof fetchImpl !== 'function') return { checks: bundled.checks, source: 'bundled' };
  const cachePath = join(home, '.cache', 'dsh-doctor', 'checks.json');
  const readCache = () => { if (!existsSync(cachePath)) return null; try { const d = JSON.parse(readFileSync(cachePath, 'utf8')); return validCatalog(d) ? d : null; } catch { return null; } };
  try {
    const cached = readCache();
    if (cached && Date.now() - statSync(cachePath).mtimeMs < CATALOG_TTL_MS) return { checks: cached.checks, source: 'cache' };
  } catch { /* 回退 */ }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const res = await fetchImpl(REMOTE_CATALOG_URL, { signal: ac.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      const data = await res.json();
      if (validCatalog(data)) {
        try { mkdirSync(dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(data, null, 2)); } catch { /* 缓存写入失败不影响本次运行 */ }
        return { checks: data.checks, source: 'remote' };
      }
    }
  } catch { /* 离线/超时 → 回退 */ }
  const stale = readCache();
  if (stale) return { checks: stale.checks, source: 'cache-stale' };
  return { checks: bundled.checks, source: 'bundled' };
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
      return found ? { ok: true, detail: check.detailOk ?? `${probe.cmd} 在 PATH: ${found}` }
                   : { ok: false, detail: check.detailFail ?? `${probe.cmd} 不在 PATH` };
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
    default:
      return { ok: true, skipped: true, detail: `探测原语 ${probe.type} 本引擎不支持，已跳过（需更新插件）` };
  }
}

/** 逐条执行目录检查，汇入统一 results 管线（src='catalog'）。 */
function checkCatalog(ctx, catalog) {
  const platform = process.platform;
  for (const check of catalog.checks ?? []) {
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

/* ================= main ================= */
const profileArg = (() => { const i = process.argv.indexOf('--profile'); return i >= 0 ? process.argv[i + 1] : 'web'; })();
const sessionArg = (() => { const i = process.argv.indexOf('--session'); return i >= 0 ? process.argv[i + 1] : undefined; })();

async function run() {
  try { checkEnv(); } catch (e) { report('env', 'E0', false, `env 检查异常: ${e.message.slice(0, 80)}`); }
  try { checkProfile(profileArg); } catch (e) { report('profile', 'P0', false, `profile 检查异常: ${e.message.slice(0, 100)}`); }
  try { checkSession(sessionArg); } catch (e) { report('session', 'S0', false, `session 检查异常: ${e.message.slice(0, 100)}`); }
  try { scanAllSessions(); } catch (e) { report('session', 'S11', false, `全会话扫描异常: ${e.message.slice(0, 100)}`); }

  // 远程检查目录（层 A）：内置检查之后追加执行；--no-catalog 只走内置副本
  let catalogMeta = { source: 'none', checks: 0 };
  try {
    const catalog = await loadCatalog({ noRemote: process.argv.includes('--no-catalog'), fetchImpl: typeof fetch === 'function' ? fetch : undefined });
    catalogMeta = { source: catalog.source, checks: catalog.checks.length };
    const profileDir = (() => { try { return resolveProfile(profileArg); } catch { return null; } })();
    if (catalog.checks.length && profileDir) checkCatalog({ home: HOME, profile: profileArg, profileDir }, catalog);
    else if (catalog.checks.length) report('catalog', 'C0', true, `profile 无效（${profileArg}），目录检查跳过（${catalog.source}）`, undefined, 'catalog');
  } catch (e) {
    catalogMeta = { source: 'error', checks: 0, error: e.message.slice(0, 80) };
  }

  // 退出码只计内置失败 + catalog 中 severity=error 的失败；warn 失败提示但不改退出码
  const bad = results.filter((r) => !r.ok && catalogSeverity.get(r.id) !== 'warn');
  if (jsonOut) {
    console.log(JSON.stringify({ ok: bad.length === 0, checks: results, catalog: catalogMeta }, null, 2));
  } else {
    const sectionOrder = { env: 0, profile: 1, session: 2, catalog: 3 };
    const ordered = [...results].sort((a, b) => (sectionOrder[a.section] ?? 9) - (sectionOrder[b.section] ?? 9));
    let lastSection = '';
    for (const r of ordered) {
      if (r.section !== lastSection) { console.log(`\n== ${r.section.toUpperCase()} ==`); lastSection = r.section; }
      const sev = catalogSeverity.get(r.id);
      const mark = !r.ok && sev === 'warn' ? '⚠' : (r.ok ? '✓' : '✗');
      console.log(` ${mark} [${r.id}] ${r.detail}${r.src === 'catalog' ? '  [目录]' : ''}`);
      if (!r.ok && r.fix) console.log(`     ↳ 修复: ${r.fix}`);
    }
    console.log(`\n${bad.length === 0 ? '✓ 全部通过' : `✗ ${bad.length} 个问题`}（profile=${profileArg}，目录=${catalogMeta.source}，${catalogMeta.checks} 条）`);
  }
  process.exit(bad.length === 0 ? 0 : 1);
}

// 直接执行（CLI：根目录薄封装或 plugin 本体均可）；被 import（测试/宿主）时不自动运行
if (process.argv[1] && basename(process.argv[1]) === 'dsh-doctor.mjs') run();

export { loadCatalog, bundledCatalog, validCatalog, expandPath, globCount, checkCatalog };
