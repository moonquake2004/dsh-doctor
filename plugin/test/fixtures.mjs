/**
 * fixtures.mjs —— dsh-doctor 检查语料库（生成器 + 回归运行器）
 *
 * 每个 fixture = 一个"好"或"坏"样例，对应一项内置检查：
 *   - 坏样例断言：目标检查必须失败（该响的响）
 *   - 好样例/隔离坏样例断言：除目标外其他检查全部通过（不该响的不响 = 无误报）
 *
 * 用途：
 *   1. 回归：改引擎/检查后跑一遍，确认 19 项结论仍成立
 *   2. dsh 升级后：对新版 harness 跑同一语料，漂移立刻暴露
 *   3. 层 C 验证回路：LLM 生成的候选检查用同一语料验证
 *
 * 运行：node --test plugin/test/fixtures.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, chmodSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const CLI = join(process.cwd(), 'plugin', 'dsh-doctor.mjs');

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-fix-'));
  // 目录检查 E8 需要 workspace-root workaround .npmrc（真实 profile 也有，fixture 保持一致）
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'web', '.npmrc'), 'ignore-workspace-root-check=true\n');
  return home;
}

/** 跑 CLI，返回 { checks: Map(id→ok), raw }；坏 fixture 的退出码为 1（工具约定），不断言退出码 */
function runCli({ home, args = [], env = {} }) {
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, ...env },
    timeout: 60000,
  });
  assert.ok(r.stdout, `CLI 无输出: ${r.stderr?.slice(0, 300)}`);
  const data = JSON.parse(r.stdout);
  return { map: new Map(data.checks.map((c) => [c.id, c.ok])), checks: data.checks, raw: data };
}

function profileFixture(home, name, { manifest, patch, nodeModules = {} }) {
  const dir = join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  for (const [rel, content] of Object.entries(nodeModules)) {
    // rel 是相对 node_modules 的文件路径（如 fake-bundle/package.json）：建父目录、写文件
    const filePath = join(dir, 'node_modules', rel);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

/**
 * 断言：指定检查必须失败，其余**不得有 error 级失败**（无误报；absent = 通过）。
 *
 * 2026-09 修正：契约是"除目标外没有**阻断性**失败"，而 warn 级失败不翻退出码、也不算误报
 * （典型：CI runner 上没有 pnpm → E1-pnpm=warn）。此前只看 ok 布尔，把 warn 也当误报，
 * 于是同一套件在本机全绿、在 CI 三红。改用 status（pass/warn/fail/skip）。
 */
function assertIsolated(home, args, mustFail, env = {}) {
  const { checks } = runCli({ home, args, env });
  for (const c of checks) {
    if (c.id === mustFail) {
      assert.notEqual(c.status, 'pass', `${c.id} 应该失败（fixture 目标），实为 ${c.status}`);
      continue;
    }
    assert.ok(c.status === 'pass' || c.status === 'warn' || c.status === 'skip',
      `${c.id} 不该有 error 级失败（误报）: fixture=${mustFail} status=${c.status}`);
  }
}

/* ---------- profile 检查 ---------- */

test('P 组：健康 profile 全绿', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web', dsh: { profile: {} } }, patch: '' });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5']) assert.notEqual(map.get(id), false, `${id} 在健康 profile 上误报`);
  rmSync(home, { recursive: true, force: true });
});

test('P1：悬空 bundle 条目 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web', dsh: { profile: { bundles: ['ghost-bundle-pkg'] } } } });
  assertIsolated(home, ['--profile', 'web'], 'P1');
  rmSync(home, { recursive: true, force: true });
});

test('P1：installAnchor 缺失时跳过宿主侧 bundle（不误报）', () => {
  const home = tempHome();
  // 一个在 profile node_modules 的 bundle + 一个不在的 ghost
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['real-bundle', 'ghost-host-bundle'] } } },
    patch: '',
    nodeModules: {
      'real-bundle/package.json': JSON.stringify({ name: 'real-bundle', dsh: { bundle: { patch: './patch.yml' } } }),
      'real-bundle/patch.yml': '',
    },
  });
  // 清掉 PATH 里的 node_modules/.bin/dsh 锚点 → installAnchor=null
  const cleanPath = (process.env.PATH || '').split(':').filter(p => !p.endsWith('node_modules/.bin')).join(':');
  const { map } = runCli({ home, args: ['--profile', 'web'], env: { PATH: cleanPath } });
  assert.notEqual(map.get('P1'), false, 'installAnchor 缺失时 P1 不应误报 ghost bundle');
  rmSync(home, { recursive: true, force: true });
});

test('P2：bundle 与用户 patch insert id 冲突 → 失败', () => {
  const home = tempHome();
  const bundlePatch = '- insert:\n    - id: dup-id\n      name: bundle-x\n';
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-bundle'] } } },
    patch: '- insert:\n    - id: dup-id\n      name: user-x\n',
    nodeModules: {
      'fake-bundle/package.json': JSON.stringify({ name: 'fake-bundle', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bundle/patch.yml': bundlePatch,
      // user-x 需可解析（有 main/index.js），否则 P3 也会触发（破坏隔离性）
      'user-x/package.json': JSON.stringify({ name: 'user-x', version: '1.0.0', main: 'index.js' }),
      'user-x/index.js': 'module.exports = 1;\n',
    },
  });
  assertIsolated(home, ['--profile', 'web'], 'P2');
  rmSync(home, { recursive: true, force: true });
});

test('P2：多个 bundle 注册相同 entry id → 失败（#2315 跨 bundle 冲突）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-bundle-a', 'fake-bundle-b'] } } },
    patch: '',
    nodeModules: {
      'fake-bundle-a/package.json': JSON.stringify({ name: 'fake-bundle-a', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bundle-a/patch.yml': '- insert:\n    - id: shared-entry\n      name: module-a\n',
      'fake-bundle-b/package.json': JSON.stringify({ name: 'fake-bundle-b', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bundle-b/patch.yml': '- insert:\n    - id: shared-entry\n      name: module-b\n',
      // shared-entry 需可解析
      'module-a/package.json': JSON.stringify({ name: 'module-a', version: '1.0.0', main: 'index.js' }),
      'module-a/index.js': 'module.exports = 1;\n',
      'module-b/package.json': JSON.stringify({ name: 'module-b', version: '1.0.0', main: 'index.js' }),
      'module-b/index.js': 'module.exports = 2;\n',
    },
  });
  assertIsolated(home, ['--profile', 'web'], 'P2');
  rmSync(home, { recursive: true, force: true });
});

test('P3：patch insert name 不可解析 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    patch: '- insert:\n    - id: x\n      name: ghost-module-xyz\n',
  });
  assertIsolated(home, ['--profile', 'web'], 'P3');
  rmSync(home, { recursive: true, force: true });
});

test('P4：悬空 file: 依赖 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web', dependencies: { '@local/x': 'file:./plugins/nonexistent' } } });
  assertIsolated(home, ['--profile', 'web'], 'P4');
  rmSync(home, { recursive: true, force: true });
});

test('P5：顶层 @deepseek-ai/* 重复 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    nodeModules: { '@deepseek-ai/dsh-base/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '1.0.0' }) },
  });
  assertIsolated(home, ['--profile', 'web'], 'P5');
  rmSync(home, { recursive: true, force: true });
});

test('P5：symlink 指向宿主同一份（#1697 link: workaround）→ 不误报', { skip: !process.env.PATH.split(':').some((p) => p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh'))) }, () => {
  // 找宿主 @deepseek-ai scope 里的一个 dsh-* 包，用 symlink 模拟 #1697 的 link: workaround
  const installNM = process.env.PATH.split(':').find((p) => p.endsWith('node_modules/.bin') && existsSync(join(p, 'dsh')));
  const hostScope = join(installNM, '@deepseek-ai');
  const hostPkg = existsSync(hostScope)
    ? readdirSync(hostScope).find((n) => n.startsWith('dsh-') && existsSync(join(hostScope, n, 'package.json')))
    : null;
  if (!hostPkg) return; // 无宿主可参照时跳过
  const home = tempHome();
  const dir = join(home, 'profiles', 'web');
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'web' }));
  symlinkSync(join(hostScope, hostPkg), join(dir, 'node_modules', '@deepseek-ai', hostPkg), 'dir');
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P5'), false, `指向宿主的 symlink（${hostPkg}）不应报 P5`);
  rmSync(home, { recursive: true, force: true });
});

test('P5：installAnchor 缺失时 symlink 不误报（#1697 workaround）', () => {
  const home = tempHome();
  const dir = join(home, 'profiles', 'web');
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'web' }));
  // 创建一个指向临时目录的 symlink（模拟 #1697 link: workaround）
  const fakeTarget = mkdtempSync(join(tmpdir(), 'p5-host-'));
  writeFileSync(join(fakeTarget, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cosmokit', version: '1.0.0' }));
  symlinkSync(fakeTarget, join(dir, 'node_modules', '@deepseek-ai', 'cosmokit'), 'dir');
  // 清掉 PATH 锚点 → installAnchor=null
  const cleanPath = (process.env.PATH || '').split(':').filter(p => !p.endsWith('node_modules/.bin')).join(':');
  const { map } = runCli({ home, args: ['--profile', 'web'], env: { PATH: cleanPath } });
  assert.notEqual(map.get('P5'), false, 'installAnchor 缺失时 symlink 不应报 P5');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- session 检查 ---------- */

const T = {
  user: (seq, turn, text = 'hi') => ({ type: 'user/message', seq, turn, data: { message: { content: [{ type: 'text', text }] } } }),
  turnStart: (seq, turn) => ({ type: 'turn/start', seq, turn }),
  turnEnd: (seq, turn) => ({ type: 'turn/end', seq, turn }),
  toolCall: (seq, turn, id) => ({ type: 'assistant/message', seq, turn, data: { message: { content: [{ type: 'tool-call', id, name: 'demo' }] } } }),
  toolResult: (seq, turn, id) => ({ type: 'tool/result', seq, turn, data: { message: { content: [{ type: 'tool-result', toolCallId: id }] } } }),
  seed: (seq) => ({ type: 'session/end-seed', seq }),
  unknown: (seq) => ({ type: 'future/event-type', seq }),
  sourceref: (seq, refs) => ({ type: 'compaction/summary', seq, sourceEventSeqs: refs }),
};

/**
 * 造会话日志。**默认写入真实的会话头**（#6651：首行必须是 {"type":"session"}，
 * 否则 harness 拒绝启动 dsh web，S13 也会正确地报出来）。此前 fixture 不带头，
 * 加 S13 后暴露为 5 个既有用例失败——那说明 fixture 本就不真实，而不是检查有误。
 * 需要测"头损坏"的用例显式传 { header: false }。
 */
/** zstd 是否可用（CI 与本机都装了；缺失时相关用例跳过而非失败） */
function hasZstd() {
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function sessionFixture(home, name, lines, { header = true } = {}) {
  const dir = join(home, 'sessions', name);
  mkdirSync(dir, { recursive: true });
  const rows = header
    ? [{ type: 'session', version: 3, id: name, createdAt: Date.now(), cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, ...lines]
    : lines;
  writeFileSync(join(dir, 'session.jsonl'), rows.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return join(dir, 'session.jsonl');
}

/** 健康会话：turn 闭合、无孤儿、seq 连续、无 end-seed 重放、类型全已知 */
const GOOD_SESSION = [
  T.user(0, 1), T.turnStart(1, 1), T.toolCall(2, 1, 'c1'), T.toolResult(3, 1, 'c1'), T.turnEnd(4, 1), T.seed(5),
];

test('S 组：健康会话全绿', () => {
  const home = tempHome();
  sessionFixture(home, 'good', GOOD_SESSION);
  const { map } = runCli({ home, args: ['--session', join(home, 'sessions', 'good', 'session.jsonl')] });
  for (const id of ['S1', 'S2', 'S6', 'S7', 'S8', 'S10']) assert.notEqual(map.get(id), false, `${id} 在健康会话上误报`);
  rmSync(home, { recursive: true, force: true });
});

test('S1：孤儿 tool_call → 失败', () => {
  const home = tempHome();
  // 孤儿必须严格早于尾部（seq < maxSeq-1），否则按"尾部 in-flight"处理为警告
  const f = sessionFixture(home, 's1', [
    T.user(0, 1), T.turnStart(1, 1), T.toolCall(2, 1, 'orphan1'), T.toolCall(3, 1, 'c2'), T.toolResult(4, 1, 'c2'), T.turnEnd(5, 1),
  ]);
  assertIsolated(home, ['--session', f], 'S1');
  rmSync(home, { recursive: true, force: true });
});

test('S2：历史未闭合 turn → 失败', () => {
  const home = tempHome();
  const f = sessionFixture(home, 's2', [
    T.user(0, 1), T.turnStart(1, 1), T.user(2, 2), T.turnStart(3, 2), T.turnEnd(4, 2),
  ]);
  assertIsolated(home, ['--session', f], 'S2');
  rmSync(home, { recursive: true, force: true });
});

test('S6：seq 空洞 → 失败', () => {
  const home = tempHome();
  const f = sessionFixture(home, 's6', [T.user(0, 1), T.turnStart(1, 1), T.user(3, 1)]);
  assertIsolated(home, ['--session', f], 'S6');
  rmSync(home, { recursive: true, force: true });
});

test('S7：end-seed 后重放 → 失败', () => {
  const home = tempHome();
  // 重放低 seq 尾部天然也破坏 seq==index（S6 会同时触发，属真实共发现象，故只断言 S7）
  const f = sessionFixture(home, 's7', [...GOOD_SESSION, T.user(3, 1)]);
  const { map } = runCli({ home, args: ['--session', f] });
  assert.equal(map.get('S7'), false, 'S7 应该失败');
  rmSync(home, { recursive: true, force: true });
});

test('S8：未知事件类型无 ignorable → 失败', () => {
  const home = tempHome();
  const f = sessionFixture(home, 's8', [T.user(0, 1), T.turnStart(1, 1), T.unknown(2), T.turnEnd(3, 1)]);
  assertIsolated(home, ['--session', f], 'S8');
  rmSync(home, { recursive: true, force: true });
});

test('S10：sourceEventSeqs 引用非早于自身 → 失败', () => {
  const home = tempHome();
  const f = sessionFixture(home, 's10', [T.user(0, 1), T.turnStart(1, 1), T.sourceref(2, [2]), T.turnEnd(3, 1)]);
  assertIsolated(home, ['--session', f], 'S10');
  rmSync(home, { recursive: true, force: true });
});

test('S9：单帧 zstd 容器 → 失败（zstd 可用时）', { skip: !existsSync('/opt/homebrew/bin/zstd') && spawnSync('which', ['zstd']).status !== 0 }, () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 's9');
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('zstd', ['-c'], { input: JSON.stringify(GOOD_SESSION.map((l) => JSON.stringify(l)).join('\n')) });
  writeFileSync(join(dir, 'session.jsonl.zstd'), r.stdout);
  const { map } = runCli({ home, args: ['--session', join(dir, 'session.jsonl.zstd')] });
  assert.equal(map.get('S9'), false, '单帧 zstd 应该报 S9');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- 会话日志定位：世代感知 v0/v3（规范 dsh-security/docs/session-shape-v3.md §1）
 * 背景：v3 上线后日志名为 session.v3.jsonl.zstd，旧定位器只认 session.jsonl[.zstd]，
 * 于是每次 S 检查都在分析 2 天前的旧世代日志。以下 fixture 覆盖规则 ①②③④⑤。 */

/** 真实 v3 事件形态（规范 §2/§3，**不得自造**）：
 *  - tool/call：工具参数在 data.arguments，是 **JSON 字符串**（旧世代才是 data.args 对象）
 *  - tool/result：callId 在 data.message.source.callId，结果文本在 data.message.content[].content[].text（嵌套两层）
 *  - turn/step 在 data 里，不在顶层 */
const V3 = {
  header: (id) => ({ type: 'session', version: 3, id, createdAt: 1, isSeeded: true, delegationDepth: 0 }),
  toolCall: (seq, turn, step, callId, name, args) => ({
    type: 'tool/call', seq, time: 1786756102077,
    data: { turn, step, callId, name, arguments: JSON.stringify(args) },
  }),
  toolResult: (seq, turn, step, callId, text) => ({
    type: 'tool/result', seq, time: 1786756102116,
    data: {
      turn, step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  }),
};

/** v3 健康会话（seq 连续：0 → 1） */
const GOOD_V3_SESSION = [
  V3.header('v3-good'),
  V3.toolCall(0, 1, 1, 'call_00_good', 'bash', { command: 'pwd && ls -la', description: '探测工作目录' }),
  V3.toolResult(1, 1, 1, 'call_00_good', '/Users/waterfly/收藏\n'),
];

/** v3 带 seq 空洞（S6 目标；0 → 2，缺 1） */
const V3_SESSION_HOLE = [
  V3.header('v3-hole'),
  V3.toolCall(0, 1, 1, 'call_00_hole', 'bash', { command: 'pwd', description: '探测工作目录' }),
  V3.toolResult(2, 1, 1, 'call_00_hole', '/tmp\n'),
];

/** v0 带 seq 空洞（S6 目标） */
const V0_SESSION_HOLE = [T.user(0, 1), T.turnStart(1, 1), T.user(3, 1)];

/** 写一个三层会话目录：sessions/<project>/<session-id>/<filename> */
function writeSessionDir(home, project, sessionId, filename, lines) {
  const dir = join(home, 'sessions', project, sessionId);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, filename);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

/** 固定 mtime，让"跨目录取最新"可确定地翻转 */
function setMtime(f, ms) { utimesSync(f, new Date(ms), new Date(ms)); }

const HAS_ZSTD = existsSync('/opt/homebrew/bin/zstd') || spawnSync('which', ['zstd']).status === 0;

test('定位器 fixture：v3 事件形态与规范一致（字段一漂移即红）', () => {
  const call = V3.toolCall(0, 1, 1, 'call_00_shape', 'bash', { command: 'pwd' });
  assert.equal(call.type, 'tool/call');
  assert.equal(typeof call.data.arguments, 'string', 'data.arguments 必须是 JSON 字符串（规范 §2）');
  assert.deepEqual(JSON.parse(call.data.arguments), { command: 'pwd' });
  assert.equal(call.data.turn, 1, 'turn 在 data 里（顶层恒 undefined）');
  assert.equal(call.data.step, 1);
  const res = V3.toolResult(1, 1, 1, 'call_00_shape', '/tmp\n');
  assert.equal(res.data.message.source.callId, 'call_00_shape', 'callId 在 data.message.source.callId（规范 §3）');
  assert.equal(res.data.message.content[0].content[0].text, '/tmp\n', '结果文本嵌套两层（旧代码只找扁平 output/result/text）');
  assert.equal(res.data.callId, undefined, 'v3 无 data.callId');
});

test('定位器：目录里只有 v0 日志 → 找到它（默认目标 = 最新会话）', () => {
  const home = tempHome();
  writeSessionDir(home, 'proj', 's-v0', 'session.jsonl', V0_SESSION_HOLE);
  // `--session` 不带值 = 只跑 session 段并走默认定位；S6 报空洞即证明选中了这份 v0 日志
  const { map } = runCli({ home, args: ['--session'] });
  assert.equal(map.get('S6'), false, 'v0-only fixture 必须被默认定位选中');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：保留两层散文件兼容（sessions/<user>/session.jsonl）', () => {
  const home = tempHome();
  sessionFixture(home, 'loose', V0_SESSION_HOLE); // 散文件直接放在用户目录下（旧布局）
  const { map } = runCli({ home, args: ['--session'] });
  assert.equal(map.get('S6'), false, '两层散文件布局仍应被"取最新会话"选中');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：同目录 v0 + v3 并存 → 取 v3（干净 v0 不掩盖 v3 的缺陷）', () => {
  const home = tempHome();
  writeSessionDir(home, 'proj', 's-both', 'session.jsonl', GOOD_SESSION);        // v0 干净
  writeSessionDir(home, 'proj', 's-both', 'session.v3.jsonl', V3_SESSION_HOLE);  // v3 有空洞
  const { map } = runCli({ home, args: ['--session'] });
  assert.equal(map.get('S6'), false, '同目录 v0+v3 应取最高世代 v3');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：同目录 v0 + v3 并存 → 反向对照（缺陷在 v0 时不报）', () => {
  const home = tempHome();
  writeSessionDir(home, 'proj', 's-both2', 'session.jsonl', V0_SESSION_HOLE);      // v0 有空洞
  writeSessionDir(home, 'proj', 's-both2', 'session.v3.jsonl', GOOD_V3_SESSION);   // v3 干净
  const { map } = runCli({ home, args: ['--session'] });
  assert.notEqual(map.get('S6'), false, 'v3 健康时不应报 S6（证明没在分析 v0）');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：跨目录按 mtime 取最新（可翻转）', () => {
  const home = tempHome();
  const hole = writeSessionDir(home, 'proj-a', 's-old', 'session.jsonl', V0_SESSION_HOLE);
  const clean = writeSessionDir(home, 'proj-b', 's-new', 'session.jsonl', GOOD_SESSION);
  const now = Date.now();
  setMtime(hole, now - 120000); setMtime(clean, now - 60000);   // clean 更新 → S6 pass
  let { map } = runCli({ home, args: ['--session'] });
  assert.notEqual(map.get('S6'), false, '应选 mtime 最新的干净会话');
  setMtime(clean, now - 120000); setMtime(hole, now - 60000);   // 翻转：hole 更新 → S6 fail
  ({ map } = runCli({ home, args: ['--session'] }));
  assert.equal(map.get('S6'), false, '翻转后应选 mtime 更新的空洞会话');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：最新日志在 _no-cwd 异名目录 → 仍能定位；session.lock 必须忽略', () => {
  const home = tempHome();
  const newer = writeSessionDir(home, 'proj', '_no-cwd', 'session.v3.jsonl', V3_SESSION_HOLE);
  writeFileSync(join(dirname(newer), 'session.lock'), ''); // 旧代码/朴素 glob 可能误取
  const older = writeSessionDir(home, 'proj', 'session-abc', 'session.jsonl', GOOD_SESSION);
  const now = Date.now();
  setMtime(older, now - 60000); setMtime(newer, now - 1000);
  const { map } = runCli({ home, args: ['--session'] });
  assert.equal(map.get('S6'), false, '_no-cwd 目录里的新 v3 日志应被选中');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：同世代 .zstd 与裸 jsonl 并存 → 优先 .zstd（沿用旧行为）', { skip: !HAS_ZSTD }, () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 's-enc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), GOOD_SESSION.map((l) => JSON.stringify(l)).join('\n') + '\n'); // 干净
  const z = spawnSync('zstd', ['-c'], { input: V0_SESSION_HOLE.map((l) => JSON.stringify(l)).join('\n') });
  writeFileSync(join(dir, 'session.jsonl.zstd'), z.stdout); // 同世代、有空洞
  const { map } = runCli({ home, args: ['--session'] });
  assert.equal(map.get('S6'), false, '同世代应优先 .zstd（与旧实现 existsSync(zstd) ? zstd : plain 一致）');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：世代优先于压缩（v3 裸 jsonl 胜过 v0 .zstd）', { skip: !HAS_ZSTD }, () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 's-gen-vs-enc');
  mkdirSync(dir, { recursive: true });
  const z = spawnSync('zstd', ['-c'], { input: V0_SESSION_HOLE.map((l) => JSON.stringify(l)).join('\n') });
  writeFileSync(join(dir, 'session.jsonl.zstd'), z.stdout);                        // v0（有空洞）
  writeFileSync(join(dir, 'session.v3.jsonl'), GOOD_V3_SESSION.map((l) => JSON.stringify(l)).join('\n') + '\n'); // v3（干净）
  const { map } = runCli({ home, args: ['--session'] });
  assert.notEqual(map.get('S6'), false, 'v3 裸文件应先于 v0 .zstd 被选中（世代 > 压缩）');
  rmSync(home, { recursive: true, force: true });
});

test('定位器：仅 v3（.zstd）→ 默认目标与 S11/S12 扫描都覆盖新世代', { skip: !HAS_ZSTD }, () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 's-v3-only');
  mkdirSync(dir, { recursive: true });
  const z = spawnSync('zstd', ['-c'], { input: GOOD_V3_SESSION.map((l) => JSON.stringify(l)).join('\n') });
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), z.stdout);
  const { map, raw } = runCli({ home, args: ['--session'] });
  assert.notEqual(map.get('S6'), false, 'v3-only 会话应被定位（seq 连续 → 不报 S6）');
  assert.equal(map.get('S0'), undefined, 'v3-only 会话应被定位（S0 只在"无会话日志"时出现）');
  // S11/S12 的全库扫描必须看到这份 v3 日志（否则 detail 会是"未发现会话日志"）
  for (const id of ['S11', 'S12']) {
    const c = raw.checks.find((x) => x.id === id);
    assert.ok(c, `应报告 ${id}`);
    assert.ok(!String(c.detail).includes('未发现会话日志'), `${id} 扫描应包含 v3 日志: ${c.detail}`);
  }
  rmSync(home, { recursive: true, force: true });
});

/* ---------- env 检查 ---------- */

test('E2：.env 是目录 → 失败', () => {
  const home = tempHome();
  mkdirSync(join(home, '.env'));
  assertIsolated(home, ['--env'], 'E2-env', { DSH_DOCTOR_PORT: '31987' });
  rmSync(home, { recursive: true, force: true });
});

test('E5：storages JSON 损坏 → 失败', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '{"a":1,}');
  assertIsolated(home, ['--env'], 'E5', { DSH_DOCTOR_PORT: '31987' });
  rmSync(home, { recursive: true, force: true });
});

/* ---------- 目录检查（层 A）隔离性 ---------- */

test('目录 P6：patch name 含空格 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '- insert:\n    - id: x\n      name: "My Plugin"\n' });
  // 用 --no-catalog 保证测的是内置副本（远程目录可能滞后于推送）
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  // 发现 P6 问题 → 退出码 1（工具约定），不断言退出码
  assert.ok(r.stdout, `CLI 无输出: ${r.stderr?.slice(0, 300)}`);
  const data = JSON.parse(r.stdout);
  const p6 = data.checks.find((c) => c.id === 'P6-patch-name-space');
  assert.ok(p6, 'P6 目录检查应存在');
  assert.equal(p6.ok, false, '含空格 name 应报 P6');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- E10：端口可用性 ---------- */

test('E10-port：空闲端口 → PASS', () => {
  const home = tempHome();
  const { map } = runCli({ home, args: ['--env'], env: { DSH_DOCTOR_PORT: '31987' } });
  assert.notEqual(map.get('E10-port-3080'), false, '空闲端口不应报失败');
  rmSync(home, { recursive: true, force: true });
});

test('E10-port：被其他程序占用 → FAIL', async () => {
  const home = tempHome();
  // 起一个非 dsh 的 node server 占用端口
  const { spawn } = await import('node:child_process');
  const port = 31988;
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  // 等端口被监听
  for (let i = 0; i < 30; i++) {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    if (r.status === 0 && String(r.stdout).includes('LISTEN')) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  const { map } = runCli({ home, args: ['--env'], env: { DSH_DOCTOR_PORT: String(port) } });
  assert.equal(map.get('E10-port-3080'), false, '非 dsh 程序占用端口应报失败');
  child.kill();
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P7：patch YAML 结构 lint ---------- */

test('P7：~ insert:（YAML null 字面量，#1724）→ 失败', () => {
  const home = tempHome();
  // name 需可解析（加 node_modules 条目），否则 P3 也会触发（破坏隔离性）
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    patch: '# @linenxi-ctrl/dsh-vision\n~ insert:\n    - id: vision\n      name: x\n',
    nodeModules: { 'x/package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'index.js' }), 'x/index.js': 'module.exports = 1;\n' },
  });
  assertIsolated(home, ['--profile', 'web'], 'P7');
  rmSync(home, { recursive: true, force: true });
});

test('P7：tab 缩进 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '- insert:\n\t- id: x\n' });
  assertIsolated(home, ['--profile', 'web'], 'P7');
  rmSync(home, { recursive: true, force: true });
});

test('P7：- insert 缺冒号 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '- insert\n    - id: x\n' });
  assertIsolated(home, ['--profile', 'web'], 'P7');
  rmSync(home, { recursive: true, force: true });
});

test('P7：合法 patch → 通过', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '- insert:\n    - id: x\n      name: "@local/a"\n' });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P7'), false, '合法 patch 不应报 P7');
  rmSync(home, { recursive: true, force: true });
});

test('P7：顶层映射+序列混排（#1724 真实机制）→ 失败', () => {
  const home = tempHome();
  // 复刻 #1724：someKey: someValue 后跟 - insert:（js-yaml 报 document separator expected）
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    patch: '# @linenxi-ctrl/dsh-vision\nsomeKey: someValue\n- insert:\n    - id: vision\n      name: "x"\n',
    nodeModules: { 'x/package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'index.js' }), 'x/index.js': 'module.exports = 1;\n' },
  });
  assertIsolated(home, ['--profile', 'web'], 'P7');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- v1 契约信封（--envelope） ---------- */

function runEnvelope({ home, args = [], env = {} }) {
  const r = spawnSync(process.execPath, [CLI, '--json', '--envelope', '--no-catalog', ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home, ...env }, timeout: 60000,
  });
  assert.ok(r.stdout, `CLI 无输出: ${r.stderr?.slice(0, 300)}`);
  const d = JSON.parse(r.stdout);
  return { d, code: r.status };
}

test('envelope：干净 profile → exit 0 / status pass / schema v1', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const { d, code } = runEnvelope({ home, args: ['--profile', 'web'] });
  assert.equal(d.schema, 'dsh-doctor/v1');
  assert.equal(code, 0);
  assert.equal(d.ok, true);
  assert.equal(d.exitCode, 0);
  assert.ok(d.summary.fail === 0);
  assert.ok(Number.isInteger(d.summary.skip), 'summary.skip 应常驻（r5 词汇表：#1719）');
  assert.ok(d.checks.every((c) => ['pass', 'warn', 'fail', 'skip'].includes(c.status)));
  rmSync(home, { recursive: true, force: true });
});

test('envelope：P2 冲突 fixture → exit 2 / status fail', () => {
  const home = tempHome();
  const bundlePatch = '- insert:\n    - id: dup-id\n      name: bundle-x\n';
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-bundle'] } } },
    patch: '- insert:\n    - id: dup-id\n      name: user-x\n',
    nodeModules: {
      'fake-bundle/package.json': JSON.stringify({ name: 'fake-bundle', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bundle/patch.yml': bundlePatch,
      'user-x/package.json': JSON.stringify({ name: 'user-x', version: '1.0.0', main: 'index.js' }),
      'user-x/index.js': 'module.exports = 1;\n',
    },
  });
  const { d, code } = runEnvelope({ home, args: ['--profile', 'web'] });
  assert.equal(code, 2, '有 FAIL 应 exit 2');
  assert.equal(d.exitCode, 2);
  assert.equal(d.ok, false);
  const p2 = d.checks.find((c) => c.name === 'P2');
  assert.equal(p2.status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

test('envelope：缺 .npmrc → E8 warn → exit 1', () => {
  const home = tempHome();
  // tempHome 默认带 .npmrc；删掉它让 E8（warn）失败
  rmSync(join(home, 'profiles', 'web', '.npmrc'));
  const { d, code } = runEnvelope({ home, args: ['--env'], env: { DSH_DOCTOR_PORT: '31987' } });
  assert.equal(code, 1, '只有 warn 应 exit 1');
  assert.equal(d.exitCode, 1);
  const e8 = d.checks.find((c) => c.name === 'E8-npmrc-workspace-flag');
  assert.equal(e8.status, 'warn');
  rmSync(home, { recursive: true, force: true });
});

test('envelope：--profile 传目录路径（契约 harness 形态）→ 可用', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const dir = join(home, 'profiles', 'web');
  const { d, code } = runEnvelope({ home, args: ['--profile', dir] });
  assert.equal(code, 0);
  assert.equal(d.profile, dir);
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P8/P9：bundle 产物扫描（#1904②⑤） ---------- */

function bundleFixture(home, name, bundleName, { mainJs, patchId = 'x1', patchName = 'x' }) {
  profileFixture(home, name, {
    manifest: { name, dsh: { profile: { bundles: [bundleName] } } },
    patch: '',
    nodeModules: {
      [`${bundleName}/package.json`]: JSON.stringify({ name: bundleName, version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      [`${bundleName}/patch.yml`]: `- insert:\n    - id: ${patchId}\n      name: ${patchName}\n`,
      [`${bundleName}/lib/index.js`]: mainJs,
    },
  });
}

test('P8：两个 bundle 抢注同一 adapter provider → 失败', () => {
  const home = tempHome();
  const m = { name: 'web', dsh: { profile: { bundles: ['fake-a', 'fake-b'] } } };
  profileFixture(home, 'web', {
    manifest: m, patch: '',
    nodeModules: {
      'fake-a/package.json': JSON.stringify({ name: 'fake-a', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-a/patch.yml': '- insert:\n    - id: a1\n      name: a\n',
      'fake-a/lib/index.js': "export const inject = ['tools'];\nexport function apply(ctx) { ctx.llm.registerAdapter(['dup-provider'], adapter); }\n",
      'fake-b/package.json': JSON.stringify({ name: 'fake-b', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-b/patch.yml': '- insert:\n    - id: b1\n      name: b\n',
      'fake-b/lib/index.js': "registerAdapter(['dup-provider'])\n",
    },
  });
  assertIsolated(home, ['--profile', 'web'], 'P8');
  rmSync(home, { recursive: true, force: true });
});

test('P8：不同 provider → 通过', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-a', { mainJs: "ctx.llm.registerAdapter(['alpha'], a);\n", patchId: 'a1' });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P8'), false, '不同 provider 不应报 P8');
  rmSync(home, { recursive: true, force: true });
});

test('P9：用 ctx.settings 但 inject 未声明 settings → 失败', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-c', {
    mainJs: "export const inject = ['tools'];\nexport function apply(ctx) { ctx.get('settings').register('ns', v); }\n",
  });
  assertIsolated(home, ['--profile', 'web'], 'P9');
  rmSync(home, { recursive: true, force: true });
});

test('P9：inject 含 settings → 通过', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-d', {
    mainJs: "export const inject = ['tools', 'settings'];\nexport function apply(ctx) { ctx.settings.register('ns', v); }\n",
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P9'), false, '声明了 settings inject 不应报 P9');
  rmSync(home, { recursive: true, force: true });
});

test('P9：内部模块 inject 在前 + 插件自身 inject 含 settings → 通过（回归：勿抓首个数组）', () => {
  const home = tempHome();
  // 模拟 bundle 产物：前面是内部模块的 inject（无 settings），后面才是插件自身的 inject（含 settings）
  bundleFixture(home, 'web', 'fake-e', {
    mainJs: "const inject = ['inputTriggers', 'sessions'];\n// ...内部模块...\nexport const inject = ['typert', 'settings', 'agents'];\nexport function apply(ctx) { ctx.settings.register('ns', v); }\n",
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P9'), false, '插件自身 inject 含 settings 不应报 P9');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P10：客户端专属服务注入（#1947） ---------- */

test('P10：inject 引用 @deepseek-ai/dsh-client-* → 失败', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-token', {
    mainJs: "export const inject = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'];\nexport function apply(ctx) {}\n",
  });
  assertIsolated(home, ['--profile', 'web'], 'P10');
  rmSync(home, { recursive: true, force: true });
});

test('P10：无客户端专属服务注入 → 通过', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-server', {
    mainJs: "export const inject = ['tools', 'settings'];\nexport function apply(ctx) {}\n",
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P10'), false, '服务端依赖不应报 P10');
  rmSync(home, { recursive: true, force: true });
});

test('envelope：不带 --remediation → 无该字段（r5 消费者字节稳定）', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const { d } = runEnvelope({ home, args: ['--profile', 'web'] });
  assert.equal('remediation' in d, false, '未传 flag 时不得出现 remediation 字段');
  rmSync(home, { recursive: true, force: true });
});

test('envelope：带 --remediation → [name] fix 有序数组，仅失败且有 fix 项', () => {
  const home = tempHome();
  const bundlePatch = '- insert:\n    - id: dup-id\n      name: bundle-x\n';
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-bundle'] } } },
    patch: '- insert:\n    - id: dup-id\n      name: user-x\n',
    nodeModules: {
      'fake-bundle/package.json': JSON.stringify({ name: 'fake-bundle', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bundle/patch.yml': bundlePatch,
      'user-x/package.json': JSON.stringify({ name: 'user-x', version: '1.0.0', main: 'index.js' }),
      'user-x/index.js': 'module.exports = 1;\n',
    },
  });
  const { d } = runEnvelope({ home, args: ['--profile', 'web', '--remediation'] });
  assert.ok(Array.isArray(d.remediation), 'remediation 必须是数组');
  const failed = new Set(d.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.name));
  for (const line of d.remediation) {
    const m = /^\[([^\]]+)\] /.exec(line);
    assert.ok(m, `格式必须是 [name] fix: ${line}`);
    assert.ok(failed.has(m[1]), `只应包含失败项: ${m[1]}`);
  }
  assert.ok(d.remediation.some((l) => l.startsWith('[P2] ')), 'P2 冲突应出现在 remediation');
  rmSync(home, { recursive: true, force: true });
});

test('envelope：含 tool 字段（provenance，契约 v1）', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const { d } = runEnvelope({ home, args: ['--profile', 'web'] });
  assert.equal(d.tool, 'dsh-doctor');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P11：main 入口产物缺失（#1965） ---------- */

test('P11：bundle main 指向缺失的 lib/index.js → 失败', () => {
  const home = tempHome();
  // 模拟市场装源码树：package.json main=lib/index.js 但 lib/ 不存在
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-unbuilt'] } } },
    patch: '',
    nodeModules: {
      'fake-unbuilt/package.json': JSON.stringify({ name: 'fake-unbuilt', version: '0.1.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-unbuilt/patch.yml': '- insert:\n    - id: u1\n      name: u\n',
    },
  });
  assertIsolated(home, ['--profile', 'web'], 'P11');
  rmSync(home, { recursive: true, force: true });
});

test('P11：main 产物存在 → 通过', () => {
  const home = tempHome();
  bundleFixture(home, 'web', 'fake-built', { mainJs: "export function apply(ctx) {}\n", patchId: 'b1' });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P11'), false, 'main 产物存在不应报 P11');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P12：profile 内 bundle 版本 vs 运行 CLI（#1719 installed_bundle） ---------- */

test('P12：profile 内 bundle 版本 ≠ 运行 CLI → warn（envelope status=warn / exit 1）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    patch: '',
    nodeModules: {
      '@moonquake2004/dsh-doctor/package.json': JSON.stringify({ name: '@moonquake2004/dsh-doctor', version: '0.2.7' }),
    },
  });
  const { d, code } = runEnvelope({ home, args: ['--profile', 'web'] });
  const p12 = d.checks.find((c) => c.name === 'installed_bundle');
  assert.ok(p12, 'P12 应存在');
  assert.equal(p12.status, 'warn', '版本分歧应为 warn（v1.1 installed_bundle 语义，不翻成 fail）');
  assert.equal(code, 1, '只有 warn 应 exit 1（0/1/2 语义）');
  assert.equal(d.summary.warn >= 1, true);
  rmSync(home, { recursive: true, force: true });
});

test('P12：profile 内 bundle 版本 = 运行 CLI → 通过', () => {
  const home = tempHome();
  const localVersion = JSON.parse(readFileSync(join(process.cwd(), 'plugin', 'package.json'), 'utf8')).version;
  profileFixture(home, 'web', {
    manifest: { name: 'web' },
    patch: '',
    nodeModules: {
      '@moonquake2004/dsh-doctor/package.json': JSON.stringify({ name: '@moonquake2004/dsh-doctor', version: localVersion }),
    },
  });
  const { d, code } = runEnvelope({ home, args: ['--profile', 'web'] });
  const p12 = d.checks.find((c) => c.name === 'installed_bundle');
  assert.equal(p12.status, 'pass', '版本一致应通过');
  assert.equal(code, 0);
  rmSync(home, { recursive: true, force: true });
});

test('P12：profile 未安装 dsh-doctor bundle → 跳过（通过）', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const { d } = runEnvelope({ home, args: ['--profile', 'web'] });
  const p12 = d.checks.find((c) => c.name === 'installed_bundle');
  assert.equal(p12.status, 'skip', '未声明未安装 = skip（无对比对象，非 pass——sjh9714 合稿修正）');
  assert.ok(p12.detail.length > 20, 'skip 必须带 reason（r5 规则）');
  assert.equal(d.summary.skip >= 1, true, 'summary.skip 应计入');
  rmSync(home, { recursive: true, force: true });
});

test('P12：裸名 file: 安装（dsh-doctor）→ 版本一致通过 / 分歧 warn', () => {
  const home = tempHome();
  const localVersion = JSON.parse(readFileSync(join(process.cwd(), 'plugin', 'package.json'), 'utf8')).version;
  profileFixture(home, 'web', {
    manifest: { name: 'web', dependencies: { 'dsh-doctor': 'file:../plugin' } },
    patch: '',
    nodeModules: {
      'dsh-doctor/package.json': JSON.stringify({ name: 'dsh-doctor', version: localVersion }),
    },
  });
  const same = runEnvelope({ home, args: ['--profile', 'web'] });
  const p12same = same.d.checks.find((c) => c.name === 'installed_bundle');
  assert.equal(p12same.status, 'pass', '裸名安装且版本一致应通过');
  // 分歧场景
  const home2 = tempHome();
  profileFixture(home2, 'web', {
    manifest: { name: 'web', dependencies: { 'dsh-doctor': 'file:../plugin' } },
    patch: '',
    nodeModules: {
      'dsh-doctor/package.json': JSON.stringify({ name: 'dsh-doctor', version: '0.2.7' }),
    },
  });
  const div = runEnvelope({ home: home2, args: ['--profile', 'web'] });
  const p12div = div.d.checks.find((c) => c.name === 'installed_bundle');
  assert.equal(p12div.status, 'warn', '裸名安装且版本分歧应 warn');
  rmSync(home, { recursive: true, force: true });
  rmSync(home2, { recursive: true, force: true });
});

test('P12：manifest 声明但 node_modules 缺失（manifest 撒谎）→ warn', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dependencies: { 'dsh-doctor': 'file:../plugin' } },
    patch: '',
    // 注意：不提供 nodeModules——声明了依赖但实际没装
  });
  const { d } = runEnvelope({ home, args: ['--profile', 'web'] });
  const p12 = d.checks.find((c) => c.name === 'installed_bundle');
  assert.equal(p12.status, 'warn', 'manifest 声明但 node_modules 缺失应 warn（运行时从不加载）');
  assert.ok(p12.detail.includes('声明'), 'detail 应点名 manifest 与运行时不一致');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P13：client 端服务名冲突（#2752：浏览器端 provide 撞核心服务 → UI 白屏） ---------- */

function clientBundleFixture(home, name, bundleName, { clientJs, clientEntry } = {}) {
  profileFixture(home, name, {
    manifest: { name, dsh: { profile: { bundles: [bundleName] } } },
    patch: '',
    nodeModules: {
      [`${bundleName}/package.json`]: JSON.stringify({
        name: bundleName, version: '1.0.0', main: 'lib/index.js',
        dsh: { client: clientEntry ?? 'client/client.js' },
      }),
      [`${bundleName}/lib/index.js`]: '// server side, no provide\n',
      [`${bundleName}/client/client.js`]: clientJs ?? 'window.__ModuleLoader__.load({ id: "x", factory: () => {} });\n',
    },
  });
}

test('P13：client 端 provide 撞核心客户端服务（chatFileMentions，#2752 场景）→ warn 而非 fail（降级局部警告）', () => {
  const home = tempHome();
  clientBundleFixture(home, 'web', 'fake-client-collide', {
    clientJs: 'window.__ModuleLoader__.load({ id: "x", factory: (require) => { ctx.provide("chatFileMentions", { forClosing() {} }); } });\n',
  });
  const { map, raw } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P13'), false, '撞核心客户端服务应报 P13');
  // 帖子建议：冲突应降级为局部警告而非白屏 → warning 语义，退出码 1（不翻 2）
  const p13 = raw.checks.find((c) => c.id === 'P13');
  assert.ok(p13 && p13.detail.includes('chatFileMentions'), 'detail 应点名冲突服务名');
  assert.ok(p13 && p13.detail.includes('核心'), 'detail 应点名是核心服务');
  rmSync(home, { recursive: true, force: true });
});

test('P13：两个 bundle 的 client 抢注同一服务名（非核心）→ warn', () => {
  const home = tempHome();
  const m = { name: 'web', dsh: { profile: { bundles: ['fake-x', 'fake-y'] } } };
  profileFixture(home, 'web', {
    manifest: m, patch: '',
    nodeModules: {
      'fake-x/package.json': JSON.stringify({ name: 'fake-x', version: '1.0.0', main: 'lib/index.js', dsh: { client: 'client/client.js' } }),
      'fake-x/lib/index.js': '// server\n',
      'fake-x/client/client.js': 'ctx.provide("my-svc", v);\n',
      'fake-y/package.json': JSON.stringify({ name: 'fake-y', version: '1.0.0', main: 'lib/index.js', dsh: { client: 'client/client.js' } }),
      'fake-y/lib/index.js': '// server\n',
      'fake-y/client/client.js': 'ctx.provide("my-svc", v);\n',
    },
  });
  const { map, raw } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P13'), false, '跨 bundle 同名抢注应报 P13');
  const p13 = raw.checks.find((c) => c.id === 'P13');
  assert.ok(p13 && p13.detail.includes('my-svc'), 'detail 应点名冲突服务名');
  rmSync(home, { recursive: true, force: true });
});

test('P13：client 端 provide 服务名无冲突（服务端 registerAdapter 不算）→ 通过', () => {
  const home = tempHome();
  // client 无冲突提供；服务端有 registerAdapter 是 P8 的领域，不该动 P13
  clientBundleFixture(home, 'web', 'fake-clean', {
    clientJs: 'window.__ModuleLoader__.load({ id: "x", factory: (require) => { ctx.provide("my-own-svc", v); } });\n',
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P13'), false, '自定义服务名未撞核心名单/无同名抢注不应报 P13');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P14：declared bin 可执行性（#1846：打包成功但 bin 缺 shebang → ENOEXEC） ---------- */

function binFixture(home, bundleName, { binEntry, binFile } = {}) {
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: [bundleName] } } },
    patch: '',
    nodeModules: {
      [`${bundleName}/package.json`]: JSON.stringify({ name: bundleName, version: '1.0.0', main: 'lib/index.js', bin: binEntry ?? { [bundleName]: 'bin/cli.js' }, dsh: { bundle: { patch: './patch.yml' } } }),
      [`${bundleName}/patch.yml`]: '- insert:\n    - id: x1\n      name: x\n',
      [`${bundleName}/lib/index.js`]: '// server\n',
      [`${bundleName}/bin/cli.js`]: binFile ?? '#!/usr/bin/env node\nconsole.log("hi");\n',
    },
  });
}

test('P14：bin 指向文件无 shebang → warn（#1846 ENOEXEC 同型）', () => {
  const home = tempHome();
  binFixture(home, 'fake-bin-nosheb', { binFile: 'console.log("hi");\n' }); // 无 shebang
  const { map, raw } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P14'), false, 'bin 无 shebang 应报 P14');
  const p14 = raw.checks.find((c) => c.id === 'P14');
  assert.ok(p14 && p14.detail.includes('ENOEXEC'), 'detail 应点名 ENOEXEC 风险');
  rmSync(home, { recursive: true, force: true });
});

test('P14：bin 有 exec bit（100755）但无 shebang → 仍 warn（#1846 1052326311 实证：exec bit 不识别文本解释器，os.execve 仍 ENOEXEC）', () => {
  const home = tempHome();
  // 精确复刻 1052326311 的 bad fixture：可执行位在、无 shebang → 之前"shebang OR exec-bit"会误放行，现应报 warn
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-bin-execbit'] } } },
    patch: '',
    nodeModules: {
      'fake-bin-execbit/package.json': JSON.stringify({ name: 'fake-bin-execbit', version: '1.0.0', main: 'lib/index.js', bin: { 'fake-bin-execbit': 'bin/cli.js' }, dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-bin-execbit/patch.yml': '- insert:\n    - id: x1\n      name: x\n',
      'fake-bin-execbit/lib/index.js': '// server\n',
      'fake-bin-execbit/bin/cli.js': 'console.log("hi");\n', // 无 shebang
    },
  });
  chmodSync(join(home, 'profiles', 'web', 'node_modules', 'fake-bin-execbit', 'bin', 'cli.js'), 0o755); // 100755 可执行位
  const { map, raw } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P14'), false, '有 exec bit 但无 shebang 仍应报 P14（文本解释器识别靠 shebang）');
  const p14 = raw.checks.find((c) => c.id === 'P14');
  assert.ok(p14 && p14.detail.includes('shebang'), 'detail 应点名缺 shebang');
  rmSync(home, { recursive: true, force: true });
});

test('P14：bin 目标文件产物缺失 → warn', () => {
  const home = tempHome();
  binFixture(home, 'fake-bin-missing', { binEntry: { 'fake-bin-missing': 'bin/not-there.js' } });
  const { map, raw } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P14'), false, 'bin 产物缺失应报 P14');
  const p14 = raw.checks.find((c) => c.id === 'P14');
  assert.ok(p14 && p14.detail.includes('缺失'), 'detail 应点名产物缺失');
  rmSync(home, { recursive: true, force: true });
});

test('P14：bin 有 shebang + 产物在位 → 通过', () => {
  const home = tempHome();
  binFixture(home, 'fake-bin-good'); // 默认 bin/cli.js 有 shebang
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P14'), false, 'bin 有 shebang 且产物在位不应报 P14');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- DSH 0.1.5 兼容：全局安装定位 / 迁移包旧类型 / 锚点 skip ---------- */

/** 本机是否装有会话格式迁移包（环境相关，用于决定旧类型断言是否可跑） */
function hasFormatMigrator() {
  for (const p of (process.env.PATH || '').split(':')) {
    if (!p || !existsSync(join(p, 'dsh'))) continue;
    let real;
    try { real = realpathSync(join(p, 'dsh')); } catch { continue; }
    let d = dirname(real);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(d, 'node_modules', '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js'))) return true;
      if (existsSync(join(d, '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js'))) return true;
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return false;
}

test('S8：真未知类型（当前表与迁移包都不认）→ 失败', () => {
  const home = tempHome();
  sessionFixture(home, 'bogus', [...GOOD_SESSION.slice(0, 5), { type: 'bogus/type', seq: 5, time: 1, data: {} }]);
  const { map } = runCli({ home, args: ['--session', join(home, 'sessions', 'bogus', 'session.jsonl')] });
  assert.equal(map.get('S8'), false, 'bogus/type 应判为不可读（#1538 语义）');
  rmSync(home, { recursive: true, force: true });
});

test('S8：v0 旧类型 assistant/chunk 有迁移路径时不误报', (t) => {
  if (!hasFormatMigrator()) return t.skip('本机无 dsh-session-format-* 迁移包');
  const home = tempHome();
  sessionFixture(home, 'legacy', [
    ...GOOD_SESSION.slice(0, 5),
    { type: 'assistant/chunk', seq: 5, time: 1, data: { turn: 1, step: 1, chunk: {} } },
    T.seed(6),
  ]);
  const { map } = runCli({ home, args: ['--session', join(home, 'sessions', 'legacy', 'session.jsonl')] });
  assert.notEqual(map.get('S8'), false, 'assistant/chunk 是 v0 旧类型，迁移链可读 → 不应判损坏');
  rmSync(home, { recursive: true, force: true });
});

test('E6：定位不到 dsh-session 时用 skip（不适用），不静默 pass', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web' }, patch: '' });
  const { d } = runEnvelope({ home, args: ['--env'], env: { PATH: '/nonexistent' } });
  const e6 = d.checks.find((c) => c.name === 'E6');
  assert.ok(e6, '应报告 E6');
  assert.equal(e6.status, 'skip', 'E6 无法定位安装时语义是"不适用"→ skip');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P16：命名导入的导出缺失（#5864 类） ---------- */

test('P16：插件导入已装包未提供的命名导出 → 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-p16'] } } },
    patch: '',
    nodeModules: {
      'fake-dep/package.json': JSON.stringify({ name: 'fake-dep', version: '1.0.0', type: 'module', main: 'lib/index.js' }),
      'fake-dep/lib/index.js': 'export { A };\n',
      'fake-p16/package.json': JSON.stringify({ name: 'fake-p16', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-p16/patch.yml': '- insert:\n    - id: p16-x\n      name: p16-x\n',
      'fake-p16/lib/index.js': "import { Missing } from 'fake-dep';\nexport function apply() {}\n",
    },
  });
  assertIsolated(home, ['--profile', 'web'], 'P16');
  rmSync(home, { recursive: true, force: true });
});

test('P16：导入的命名导出确实存在 → 不误报', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-p16b'] } } },
    patch: '',
    nodeModules: {
      'fake-dep2/package.json': JSON.stringify({ name: 'fake-dep2', version: '1.0.0', type: 'module', main: 'lib/index.js' }),
      'fake-dep2/lib/index.js': 'export { A, B };\nexport const C = 1;\n',
      'fake-p16b/package.json': JSON.stringify({ name: 'fake-p16b', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-p16b/patch.yml': '- insert:\n    - id: p16-y\n      name: p16-y\n',
      'fake-p16b/lib/index.js': "import { A, C } from 'fake-dep2';\nexport function apply() {}\n",
    },
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P16'), false, 'A/C 都在导出里，不应报 P16');
  rmSync(home, { recursive: true, force: true });
});

test('P16：带子路径的说明符与新核心移除的符号 → 跳过（防误报边界）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: ['fake-p16c'] } } },
    patch: '',
    nodeModules: {
      'fake-dep3/package.json': JSON.stringify({ name: 'fake-dep3', version: '1.0.0', type: 'module', main: 'lib/index.js' }),
      'fake-dep3/lib/index.js': 'export { A };\n',
      'fake-p16c/package.json': JSON.stringify({ name: 'fake-p16c', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      'fake-p16c/patch.yml': '- insert:\n    - id: p16-z\n      name: p16-z\n',
      // 子路径说明符 + 动态 import + type-only：都不该判
      'fake-p16c/lib/index.js': "import { NotThere } from 'fake-dep3/sub';\nimport type { T } from 'fake-dep3';\nconst x = await import('fake-dep3');\nexport function apply() {}\n",
    },
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P16'), false, '子路径/type-only/动态导入必须跳过（否则误报）');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- S12：迁移拒载预检（#6045/#6328/#6311） ---------- */

test('S12：v0 日志含 subagent/descriptor version 2 → 失败（会被迁移拒载）', (t) => {
  if (!hasFormatMigrator()) return t.skip('本机无 dsh-session-format-* 迁移包');
  const home = tempHome();
  // 真实会话库是三层：sessions/<工程>/<session-id>/session.jsonl（store 级扫描按此布局）
  const dir = join(home, 'sessions', 'proj', 'refused');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), [
    { type: 'session', version: 0, id: 's-refused', createdAt: 1 },
    ...GOOD_SESSION.slice(0, 5),
    { type: 'subagent/descriptor', seq: 5, time: 2, data: { version: 2, id: 'x' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const sessPath = join(dir, 'session.jsonl');
  const { map } = runCli({ home, args: ['--session', sessPath] });
  assert.equal(map.get('S12'), false, 'descriptor version 2 应判为会被 v0→v1 拒载');
  rmSync(home, { recursive: true, force: true });
});

test('S12：无 descriptor 的 v0 日志 → 通过（不误报）', (t) => {
  if (!hasFormatMigrator()) return t.skip('本机无 dsh-session-format-* 迁移包');
  const home = tempHome();
  sessionFixture(home, 'ok', [{ type: 'session', version: 0, id: 's-ok', createdAt: 1 }, ...GOOD_SESSION]);
  const { map } = runCli({ home, args: ['--session', join(home, 'sessions', 'ok', 'session.jsonl')] });
  assert.notEqual(map.get('S12'), false, '普通 v0 日志不该被判拒载');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P17：client 端 require 不在宿主模块表（#5719 类） ---------- */

test('P17：client 产物 require 未知模块 → 失败（warn 级）', () => {
  const home = tempHome();
  clientBundleFixture(home, 'web', 'p17-bad', {
    clientJs: 'const x = require("totally-unknown-pkg");\nwindow.__ModuleLoader__.load({ id: "p17-bad", factory: () => x });\n',
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P17'), false, '未知 specifier 应判为不在模块表');
  rmSync(home, { recursive: true, force: true });
});

test('P17：平台种子（react / @deepseek-ai/cordis）→ 不误报', () => {
  const home = tempHome();
  clientBundleFixture(home, 'web', 'p17-seed', {
    clientJs: 'const a = require("react");\nconst b = require("react-dom/client");\nconst c = require("@deepseek-ai/cordis");\nwindow.__ModuleLoader__.load({ id: "p17-seed", factory: () => [a, b, c] });\n',
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P17'), false, '平台种子不应被判缺失');
  rmSync(home, { recursive: true, force: true });
});

test('P17：已装图行（dsh.client + exports["./client"]）→ 不误报', () => {
  const home = tempHome();
  clientBundleFixture(home, 'web', 'p17-row', {
    clientJs: 'const d = require("@x/dep/client");\nwindow.__ModuleLoader__.load({ id: "p17-row", factory: () => d });\n',
  });
  // 追加一个"已装图行"包：有 dsh.client 且 exports["./client"]
  const nm = join(home, 'profiles', 'web', 'node_modules');
  mkdirSync(join(nm, '@x', 'dep'), { recursive: true });
  writeFileSync(join(nm, '@x', 'dep', 'package.json'), JSON.stringify({
    name: '@x/dep', version: '1.0.0', dsh: { client: 'client.js' }, exports: { './client': './client.js' },
  }));
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P17'), false, '有 dsh.client + exports["./client"] 的已装包是图行，应可服务');
  rmSync(home, { recursive: true, force: true });
});

test('P17：防误报边界（注释示例/单引号/模板插值/Node 内置/自引用）→ 不误报', () => {
  const home = tempHome();
  clientBundleFixture(home, 'web', 'p17-guards', {
    clientJs: [
      '// JSDoc-style example that must NOT be flagged:',
      '/**',
      ' * Usage: const pm = require("picomatch-example-not-real");',
      ' */',
      "const doc = require('single-quoted-doc-example');",
      'const tpl = require(`${dynamicName}`);',
      'const u = require("url");',
      'const self = require("p17-guards");',
      'window.__ModuleLoader__.load({ id: "p17-guards", factory: () => [doc, tpl, u, self] });',
    ].join('\n') + '\n',
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P17'), false, '注释/单引号/模板/内置/自引用都必须跳过（否则误报）');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P3：ESM-only 包不得因 require.resolve 失败而误判（#1719 taltara 的坑，2026-09-12 实测命中我们） ---------- */

test('P3：ESM-only 包（exports 只给 import）→ 不误报（存在性判据）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: [] } } },
    patch: '- insert:\n    - id: esm-only-plugin\n      name: esm-only-plugin\n',
    nodeModules: {
      // ESM-only：exports 只有 import 条件 → require.resolve 抛 ERR_PACKAGE_PATH_NOT_EXPORTED
      'esm-only-plugin/package.json': JSON.stringify({
        name: 'esm-only-plugin', version: '1.0.0', type: 'module',
        exports: { '.': { import: './index.js' } },
      }),
      'esm-only-plugin/index.js': 'export function apply() {}\n',
    },
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(map.get('P3'), false, 'ESM-only 包在 loader 里可正常 import，P3 不得判为不可解析');
  rmSync(home, { recursive: true, force: true });
});

test('P3：真正缺失的包仍必须报出（修复不得放宽）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', dsh: { profile: { bundles: [] } } },
    patch: '- insert:\n    - id: truly-missing\n      name: truly-missing-pkg\n',
    nodeModules: {},
  });
  const { map } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(map.get('P3'), false, '真的不存在时必须报出');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- S13：会话头完整性（#6651）——首行不是 {"type":"session"} 时 harness 拒绝启动 dsh web ---------- */

test('S13：首行不是会话头 → 失败（#6651 启动阻断）', () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 'sess-bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl'),
    JSON.stringify({ type: 'user/message', seq: 0, data: {} }) + '\n' +
    JSON.stringify({ type: 'assistant/message', seq: 1, data: {} }) + '\n');
  const { raw } = runCli({ home, args: ['--session'] });
  const s13 = raw.checks.find((c) => c.id === 'S13');
  assert.equal(s13.status, 'fail', '首行非会话头必须报出（其余 S 检查看不出这类损坏）');
  assert.ok(/dsh web/.test(s13.detail), 'detail 应点明会阻断 dsh web 启动');
  rmSync(home, { recursive: true, force: true });
});

test('S11：首行不是会话头的日志必须计入"损坏"，不得报健康（回归）', () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 'sess-bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl'),
    JSON.stringify({ type: 'user/message', seq: 0, data: {} }) + '\n');
  const { raw } = runCli({ home, args: ['--session'] });
  const s11 = raw.checks.find((c) => c.id === 'S11');
  assert.equal(s11.status, 'fail', 'S11 此前会把这情况报成"均健康"——正是本项目定义为漏洞的假阴性');
  rmSync(home, { recursive: true, force: true });
});

test('S13：正常会话头 → 通过', () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 'sess-ok');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v3.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'sess-ok', createdAt: Date.now(), cwd: '/tmp' }) + '\n' +
    JSON.stringify({ type: 'user/message', seq: 0, data: { content: [] } }) + '\n');
  const { raw } = runCli({ home, args: ['--session'] });
  const s13 = raw.checks.find((c) => c.id === 'S13');
  assert.notEqual(s13.status, 'fail', '正常会话头不得报错');
  rmSync(home, { recursive: true, force: true });
});

test('S13：会话头存在但首帧裹住多行（帧边界错位）→ 失败', { skip: !hasZstd() }, () => {
  const home = tempHome();
  const dir = join(home, 'sessions', 'proj', 'sess-frame');
  mkdirSync(dir, { recursive: true });
  const plain = JSON.stringify({ type: 'session', version: 3, id: 'x', createdAt: 1, cwd: '/tmp' }) + '\n'
    + JSON.stringify({ type: 'user/message', seq: 0, data: {} }) + '\n';
  const plainPath = join(dir, 'plain.jsonl');
  writeFileSync(plainPath, plain);
  execFileSync('zstd', ['-q', '-f', '-o', join(dir, 'session.v3.jsonl.zstd'), plainPath]);
  const { raw } = runCli({ home, args: ['--session', join(dir, 'session.v3.jsonl.zstd')] });
  const s13 = raw.checks.find((c) => c.id === 'S13');
  assert.equal(s13.status, 'fail', 'harness 要求首帧恰好一行；首帧裹住事件同样会 corrupt（dsh-session-persistence-jsonl:1891）');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- E12：运行时 zstd 稳定性（#6651 的运行时线索；锚点 dsh-session-persistence-jsonl:15） ---------- */

test('E12：有 DSH 环境时判定运行时 zstd 稳定性', () => {
  const home = tempHome();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const { raw } = runCli({ home, args: ['--env'] });
  const e12 = raw.checks.find((c) => c.id === 'E12');
  assert.ok(e12, 'E12 应存在');
  // 本机/CI 上 Node 要么有非实验性 zstd（pass），要么无 zstd（fail）——都必须是明确判定而非误报
  assert.notEqual(e12.status, 'skip', '有 DSH 环境时必须给出判定（此环境已被显式构造出来）');
  rmSync(home, { recursive: true, force: true });
});

test('E12：无 DSH 环境 → skip（与 E7 同一纪律：没有可诊断对象时不报失败）', () => {
  const home = tempHome();
  const { raw } = runCli({ home, args: ['--env'] });
  const e12 = raw.checks.find((c) => c.id === 'E12');
  assert.equal(e12.status, 'skip', '干净环境里不得因运行时差异报失败');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- P18：profile manifest 的 version（#6667）---------- */

test('P18：profile manifest 有 name 无 version → 失败（warn 级，#6667 条件）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }, // 无 version，同 harness 自己生成的形态
    patch: '',
  });
  const { raw } = runCli({ home, args: ['--profile', 'web'] });
  const p18 = raw.checks.find((c) => c.id === 'P18');
  assert.equal(p18.status, 'warn', '#6667 是条件性风险（需游离本地模块），故 warn 而不阻断');
  assert.ok(/6667|REQUEST_EXTENSION/.test(p18.detail));
  rmSync(home, { recursive: true, force: true });
});

test('P18：profile manifest 声明了 version → 通过', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'dsh-profile-web', version: '0.0.0', dsh: { profile: { bundles: [] } } },
    patch: '',
  });
  const { raw } = runCli({ home, args: ['--profile', 'web'] });
  const p18 = raw.checks.find((c) => c.id === 'P18');
  assert.equal(p18.status, 'pass');
  rmSync(home, { recursive: true, force: true });
});

/* ---------- 启动失败自救：--boot-check / --quarantine（dsh 起不来时用，不依赖 dsh 启动） ---------- */

/** 造一个装了两个 bundle 的 profile：good 可导入，broken 导入一个不存在的导出 */
function bootFixture() {
  const home = tempHome();
  const p = join(home, 'profiles', 'web');
  mkdirSync(join(p, 'node_modules', 'broken-plugin'), { recursive: true });
  mkdirSync(join(p, 'node_modules', 'good-plugin'), { recursive: true });
  mkdirSync(join(p, 'node_modules', '@deepseek-ai', 'dsh-settings'), { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', dsh: { profile: { bundles: ['broken-plugin', 'good-plugin'] } },
  }));
  writeFileSync(join(p, 'node_modules', 'broken-plugin', 'package.json'), JSON.stringify({ name: 'broken-plugin', version: '1.0.0', type: 'module', main: 'index.js' }));
  writeFileSync(join(p, 'node_modules', 'broken-plugin', 'index.js'), 'import { nope } from "@deepseek-ai/dsh-settings"; export default {};\n');
  writeFileSync(join(p, 'node_modules', 'broken-plugin', 'cordis.patch.yml'), '- insert:\n    - id: broken-plugin\n      name: broken-plugin\n');
  writeFileSync(join(p, 'node_modules', 'good-plugin', 'package.json'), JSON.stringify({ name: 'good-plugin', version: '1.0.0', type: 'module', main: 'index.js' }));
  writeFileSync(join(p, 'node_modules', 'good-plugin', 'index.js'), 'export default {};\n');
  writeFileSync(join(p, 'node_modules', 'good-plugin', 'cordis.patch.yml'), '- insert:\n    - id: good-plugin\n      name: good-plugin\n');
  writeFileSync(join(p, 'node_modules', '@deepseek-ai', 'dsh-settings', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', version: '0.1.5-rc.2', type: 'module', exports: { '.': './index.js' } }));
  writeFileSync(join(p, 'node_modules', '@deepseek-ai', 'dsh-settings', 'index.js'), 'export const SettingsProvider = 1;\n');
  return home;
}

test('--boot-check：点名导入失败的 entry（缺导出），并给出错误类别与隔离命令', () => {
  const home = bootFixture();
  const r = spawnSync(process.execPath, [CLI, '--boot-check', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  assert.equal(r.status, 2, '有 entry 导入失败时应以非零退出（dsh 起不来的直接原因）');
  assert.match(r.stdout, /broken-plugin/);
  assert.match(r.stdout, /missing-export/);
  assert.match(r.stdout, /does not provide an export named/);
  assert.match(r.stdout, /--quarantine broken-plugin/, '应给出可照做的下一步');
  assert.doesNotMatch(r.stdout, /✗ \[good-plugin\]/, '健康的 bundle 不得被误报');
  rmSync(home, { recursive: true, force: true });
});

test('--quarantine：摘掉坏 bundle 并备份 manifest；复查后装载模拟通过', () => {
  const home = bootFixture();
  const p = join(home, 'profiles', 'web', 'package.json');
  const before = readFileSync(p, 'utf8');
  const q = spawnSync(process.execPath, [CLI, '--quarantine', 'broken-plugin', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  assert.equal(q.status, 0, q.stderr);
  const after = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(!after.dsh.profile.bundles.includes('broken-plugin'), '坏 bundle 应被移出启动列表');
  assert.ok(after.dsh.profile._quarantined.some((x) => x.name === 'broken-plugin'), '应记录隔离以便撤销');
  const backups = readdirSync(join(home, 'profiles', 'web')).filter((f) => f.startsWith('package.json.bak.'));
  assert.equal(backups.length, 1, '必须先备份原 manifest');
  assert.equal(readFileSync(join(home, 'profiles', 'web', backups[0]), 'utf8'), before, '备份内容应与原文件一致');

  const check = spawnSync(process.execPath, [CLI, '--boot-check', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  assert.equal(check.status, 0, '隔离后装载模拟应通过（这就是"让 dsh 先起来"）');
  rmSync(home, { recursive: true, force: true });
});

test('--unquarantine：撤销隔离，坏 bundle 回到启动列表', () => {
  const home = bootFixture();
  spawnSync(process.execPath, [CLI, '--quarantine', 'broken-plugin', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  const u = spawnSync(process.execPath, [CLI, '--unquarantine', 'broken-plugin', '--profile', 'web'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } });
  assert.equal(u.status, 0, u.stderr);
  const after = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'));
  assert.ok(after.dsh.profile.bundles.includes('broken-plugin'));
  assert.ok(!after.dsh.profile._quarantined.some((x) => x.name === 'broken-plugin'));
  rmSync(home, { recursive: true, force: true });
});
