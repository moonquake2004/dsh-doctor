/**
 * 论坛病例语料（R2 样本律的落地）：把**社区实际报告的问题**构造成回归用例。
 *
 * 目的：回答"最新版是否**实质性**解决了别人的问题"——而不是"看起来解决了"。
 * 每例都必须配一个**健康对照**，同时防两类错误：
 *   · 漏报（真实病例没被抓到）→ 病例断言 fail/warn；
 *   · 误报（健康形态被当成问题）→ 对照断言不得 fail。
 *
 * 每条用例的注释里写明出处（issue 号）与**证据边界**：哪些是我们复现过的，哪些复现不了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 自包含：fixtures.mjs 是测试脚本（导入它会连带执行它的用例），故这里自带最小 helper。
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-doctor.mjs');
const tempHome = () => mkdtempSync(join(tmpdir(), 'dsh-forum-'));
function profileFixture(home, name, { manifest, patch, nodeModules = {} }) {
  const dir = join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  for (const [rel, content] of Object.entries(nodeModules)) {
    const filePath = join(dir, 'node_modules', rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}
function sessionFixture(home, name, lines, { header = true } = {}) {
  const dir = join(home, 'sessions', name);
  mkdirSync(dir, { recursive: true });
  const rows = header
    ? [{ type: 'session', version: 3, id: name, createdAt: Date.now(), cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, ...lines]
    : lines;
  const f = join(dir, 'session.jsonl');
  writeFileSync(f, rows.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
function runCli({ home, args = [] }) {
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home, PATH: process.env.PATH }, timeout: 60000,
  });
  assert.ok(r.stdout, `CLI 无输出: ${(r.stderr || '').slice(0, 300)}`);
  const data = JSON.parse(r.stdout);
  return { checks: data.checks, raw: data };
}

const bootCheck = (home) => spawnSync(process.execPath, [CLI, '--boot-check', '--profile', 'web'], {
  encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 60000,
});
const plugin = (name, extra = {}) => JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'lib/index.js', ...extra });

/* ============ 病例 A（#6788）：bundle 在启动列表里却没声明 dsh.bundle ============ */
// 报告者：0.1.6-alpha.1 起 loader 严格要求 dsh.bundle.patch；dsh-computer-use 等包漏了该字段，
// 照文档 `dsh plugin add` 后 profile 立刻起不来。**我们复现了判据本身**（npm 元数据无 dsh 字段 + loader 侧强制）。

test('病例A（#6788）：缺 dsh.bundle → --boot-check 必须失败，且不得再给"全部可导入"假绿灯', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['computer-use'] } } },
    patch: '- insert:\n    - id: computer-use\n      name: computer-use\n',
    nodeModules: { 'computer-use/package.json': plugin('computer-use'), 'computer-use/lib/index.js': 'export default {};\n' },
  });
  const r = bootCheck(home);
  assert.notEqual(r.status, 0, '这一类会让整个 profile 起不来，必须失败');
  assert.match(r.stdout, /missing-bundle-manifest|dsh\.bundle/, '要点明缺的是 dsh.bundle');
  assert.ok(!/✓ 所有可探测 entry 均可导入/.test(r.stdout), '不得出现假绿灯');
  rmSync(home, { recursive: true, force: true });
});

test('病例A 对照：同样的包**声明了** dsh.bundle → 必须通过（防误报）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['good'] } } },
    patch: '- insert:\n    - id: good\n      name: good\n',
    nodeModules: {
      'good/package.json': plugin('good', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'good/cordis.patch.yml': '- insert:\n    - id: good\n      name: good\n',
      'good/lib/index.js': 'export default {};\n',
    },
  });
  const r = bootCheck(home);
  assert.equal(r.status, 0, `健康 bundle 不得被判失败：${r.stdout.slice(0, 200)}`);
  rmSync(home, { recursive: true, force: true });
});

/* ============ 病例 B（#6758）：profile 清单带 UTF-8 BOM ============ */
// 报告者实测：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写出的 BOM 让 DSH 硬失败。
// **我们复现了机制**（JSON.parse 遇 BOM 抛错），但**未复现 DSH 的启动失败本身**（需真实 dsh 启动）。

test('病例B（#6758）：manifest 带 BOM → P15 必须报出，且其余检查仍运行', () => {
  const home = tempHome();
  const dir = join(home, 'profiles', 'web');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(JSON.stringify({ name: 'web', version: '0.0.0', dsh: { profile: { bundles: [] } } })),
  ]));
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  const p15 = checks.find((c) => c.id === 'P15');
  assert.equal(p15.status, 'fail', 'BOM 必须报出（#5176/#6758 同一事实）');
  assert.ok(checks.length > 3, `早期失败不得掩盖其余检查（实际 ${checks.length} 项）`);
  rmSync(home, { recursive: true, force: true });
});

test('病例B 对照：无 BOM → P15 通过（防误报）', () => {
  const home = tempHome();
  profileFixture(home, 'web', { manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: [] } } }, patch: '' });
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(checks.find((c) => c.id === 'P15').status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

/* ============ 病例 C（#6686）：v0→v3 迁移后事件缺消息体 → 会话打不开 ============ */
// 报告者给出精确形态；**我们在已装 0.1.5-rc.2 上核实了两处穿透读取**，但**未能复现报告者的会话**
// （我们整库 52 个 v0 迁移后 0 个出现该形态）——所以这里测的是"形态能被离线检出"，不是"症状已复现"。

test('病例C（#6686）：assistant/message 缺 data.message → S14 报出', () => {
  const home = tempHome();
  sessionFixture(home, 'sess-legacy', [{ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1 } }]);
  const file = join(home, 'sessions', 'sess-legacy', 'session.jsonl');
  const { checks } = runCli({ home, args: ['--session', file] });
  assert.equal(checks.find((c) => c.id === 'S14').status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

test('病例C 对照：消息体完整 → S14 不得报错（防误报）', () => {
  const home = tempHome();
  sessionFixture(home, 'sess-ok', [
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [] } } },
    { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: { content: [], source: { callId: 'c1' } } } },
  ]);
  const file = join(home, 'sessions', 'sess-ok', 'session.jsonl');
  const { checks } = runCli({ home, args: ['--session', file] });
  assert.notEqual(checks.find((c) => c.id === 'S14').status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

/* ============ 病例 D/E（#6693）：第三方插件把整棵插件树拖垮 ============ */
// 报告者给出四条规则。规则 1（apply() 里读未声明的 inject 属性）**我们明确不做**——见下方 F。

test('病例D（#6693 规则2/4）：裸引用沙箱符号 harness/styles → P21 失败', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['bad'] } } },
    patch: '- insert:\n    - id: bad\n      name: bad\n',
    nodeModules: {
      'bad/package.json': plugin('bad', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'bad/cordis.patch.yml': '- insert:\n    - id: bad\n      name: bad\n',
      'bad/lib/index.js': 'export function apply(ctx) { return harness.handle; }\n',
      'bad/client/index.js': 'window.__ModuleLoader__.load({ id: "bad", factory: () => { styles.apply(); } });\n',
    },
  });
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(checks.find((c) => c.id === 'P21').status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

test('病例D 对照：同样的词出现在注释/字符串里 → P21 不得报错（误报回归）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['ok'] } } },
    patch: '- insert:\n    - id: ok\n      name: ok\n',
    nodeModules: {
      'ok/package.json': plugin('ok', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'ok/cordis.patch.yml': '- insert:\n    - id: ok\n      name: ok\n',
      'ok/lib/index.js': '//#region styles\nconst s = "deepseek-harness";\nexport function apply(ctx) { return 1; }\n',
    },
  });
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(checks.find((c) => c.id === 'P21').status, 'fail', '注释与字符串不是引用');
  rmSync(home, { recursive: true, force: true });
});

test('病例E（#6693 规则3）：client 产物写成裸 ESM → P20 报出', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['esm'] } } },
    patch: '- insert:\n    - id: esm\n      name: esm\n',
    nodeModules: {
      'esm/package.json': plugin('esm', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'esm/cordis.patch.yml': '- insert:\n    - id: esm\n      name: esm\n',
      'esm/lib/index.js': 'export default {};\n',
      'esm/client/index.js': 'export default function () { return 1; }\n', // 浏览器会抛 Unexpected token 'export'
    },
  });
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  assert.notEqual(checks.find((c) => c.id === 'P20').status, 'pass', '客户端工厂加载会失败，至少要有提示');
  rmSync(home, { recursive: true, force: true });
});

test('病例E 对照：合规的 CJS 工厂产物 → P20 通过（防误报）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['cjs'] } } },
    patch: '- insert:\n    - id: cjs\n      name: cjs\n',
    nodeModules: {
      'cjs/package.json': plugin('cjs', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'cjs/cordis.patch.yml': '- insert:\n    - id: cjs\n      name: cjs\n',
      'cjs/lib/index.js': 'export default {};\n',
      'cjs/client/index.js': 'window.__ModuleLoader__.load({ id: "cjs", factory: () => ({}) });\n',
    },
  });
  const { checks } = runCli({ home, args: ['--profile', 'web'] });
  assert.equal(checks.find((c) => c.id === 'P20').status, 'pass');
  rmSync(home, { recursive: true, force: true });
});

/* ============ 病例 F（#6693 规则1）：apply() 内抛错 —— **我们做不到**，如实记录 ============ */
// 报告者最致命的一条是"apply() 里读未在 inject 声明的服务属性 → cordis Proxy 抛错 → 整棵树死"。
// 我们的探测只到 import 层，**这类我们检不出**。这个用例的目的是把边界钉在测试里，
// 防止将来有人把"P20/P21 通过"误读成"这个插件一定能起来"。

test('病例F（#6693 规则1，**已知不能检出**）：apply() 期抛错 → 我们的判定仍是 loadable（边界用例）', () => {
  const home = tempHome();
  profileFixture(home, 'web', {
    manifest: { name: 'web', version: '0.0.0', dsh: { profile: { bundles: ['apply-throws'] } } },
    patch: '- insert:\n    - id: apply-throws\n      name: apply-throws\n',
    nodeModules: {
      'apply-throws/package.json': plugin('apply-throws', { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'apply-throws/cordis.patch.yml': '- insert:\n    - id: apply-throws\n      name: apply-throws\n',
      // import 阶段干净；真正抛错发生在宿主调用 apply() 时（我们没有 host 上下文，无法触发）
      'apply-throws/lib/index.js': 'export function apply(ctx) { return ctx.someUndeclaredService.x; }\n',
    },
  });
  const r = bootCheck(home);
  assert.equal(r.status, 0, '这是**已知边界**：import 干净 ⇒ 我们判 loadable。不是漏报，而是未覆盖的类别');
  rmSync(home, { recursive: true, force: true });
});

/* ============ 病例 G（#6739）：zstd 读取失败 —— 只验证得了"损坏"那一侧 ============ */
// 报告者的证据是"失败帧偏移每次不同"⇒ 读取路径不稳，而**不是**文件损坏。
// 我们能做的是区分两者；但**"间歇性"这一侧无法在测试里忠实复现**（需要真实的读路径抖动）。
// 所以这里只钉住：确定性损坏 ⇒ 判"损坏"（而不是误判成"读取不稳"）。

test('病例G（#6739，仅损坏一侧可验证）：损坏的 .zstd → 判为损坏，而非"读取间歇性失败"', () => {
  const home = tempHome();
  // 真实布局是三层：sessions/<项目>/<会话>/<日志>（R9：两层布局定位器找不到，
  // 第一次写这个用例时我就写成了两层，S11 于是报未发现会话日志——那是 fixture 失真，不是漏报）
  const dir = join(home, 'sessions', 'proj', 'sess-broken');
  mkdirSync(dir, { recursive: true });
  // 非 zstd 内容放进 .zstd 文件 → 每次解压都失败（确定性），应与"间歇性"区分开
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'not a zstd frame at all\n');
  const { checks } = runCli({ home, args: ['--session'] });
  const s11 = checks.find((c) => c.id === 'S11');
  assert.equal(s11.status, 'fail', '确定性损坏必须报损坏');
  assert.match(s11.detail, /损坏/, '要点明是损坏（区别于读取路径不稳）');
  rmSync(home, { recursive: true, force: true });
});
