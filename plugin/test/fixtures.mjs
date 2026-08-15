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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  return { map: new Map(data.checks.map((c) => [c.id, c.ok])), raw: data };
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

/** 断言：指定检查必须失败，其余全部通过（无误报；absent = 通过，因为部分检查只在失败时报告） */
function assertIsolated(home, args, mustFail, env = {}) {
  const { map } = runCli({ home, args, env });
  for (const [id, ok] of map) {
    if (id === mustFail) assert.equal(ok, false, `${id} 应该失败（fixture 目标）`);
    else assert.equal(ok, true, `${id} 不该失败（误报）: fixture=${mustFail}`);
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

function sessionFixture(home, name, lines) {
  const dir = join(home, 'sessions', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
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
  assert.ok(d.checks.every((c) => ['pass', 'warn', 'fail'].includes(c.status)));
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
