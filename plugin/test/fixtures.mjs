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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
function assertIsolated(home, args, mustFail) {
  const { map } = runCli({ home, args });
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
  assertIsolated(home, ['--env'], 'E2-env');
  rmSync(home, { recursive: true, force: true });
});

test('E5：storages JSON 损坏 → 失败', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '{"a":1,}');
  assertIsolated(home, ['--env'], 'E5');
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
