/**
 * P26 / P26b：peer 依赖的**解析根**一致性（社区 #10149）。
 *
 * 为什么需要这一组用例：P19 只核对"peer 声明的版本区间 vs 实际提供的版本"，解析不到时它把该条
 * 记成 `unknown` 并**照常 pass**——于是 `@deepseek-ai/dsh-subprocess` 声明了 `@deepseek-ai/cordis` 与
 * `@deepseek-ai/dsh-http-proxy` 两个都没装时，P19 仍报"均可接受当前核心版本"（假绿灯，已实测复现）。
 * 那两条 peer 的**解析根**问题此前没有任何检查覆盖；P26 补的就是这个事实。
 *
 * 真实后果（#10149）：常驻服务由全局 CLI 启动、CLI 自己的 node_modules 兜住了这一层，所以看起来
 * 一切正常；但宿主私有 bootstrap 用裸 `node runner.js` 起子进程时没有那层兜底，import 阶段直接
 * ERR_MODULE_NOT_FOUND，父进程只看到 "subprocess scope exited before its bootstrap consumed the
 * launch request"，把矛头错误地指向 systemd scope。
 *
 * 这组用例刻意**用 CLI 子进程**而不是直接调函数：P26 的判定横跨 profile 遍历 + PATH 上的宿主树 +
 * 退出码/状态映射，只有端到端跑才对"最终给用户看的那一行"有约束力。
 *
 * 造环境的手法（关键，决定用例有没有区分度）：
 *   - profile 目录放在临时目录里，**祖先目录绝不含 node_modules**——否则 node 的解析会一路向上
 *     命中真实机器上的包，用例会"靠环境恰好通过"；
 *   - 宿主树用 fake 的 `<root>/lib/node_modules/@deepseek-ai/dsh/` + `<root>/bin/dsh` 造，
 *     PATH 只放这一个 bin 目录。dsh-doctor 的 hostInstallRoot() 正是按这个布局找的
 *     （见 dsh-doctor.mjs 的 hostInstallRoot：从 PATH 里的 dsh 反查 `<d>/@deepseek-ai/dsh`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-doctor.mjs');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 写一个最小包：只带 name/version + 可选 peerDependencies。
 *  extra.dsh 用来声明 `dsh.bundle.patch`（bundle 缺了它会被 P1 判为"静默禁用"，
 *  那会淹没本组用例真正要看的 P26 断言）。 */
function writePkg(dir, { name, version = '1.0.0', peers = {}, peerMeta = {}, dsh } = {}) {
  mkdirSync(dir, { recursive: true });
  const mf = { name, version, main: 'index.js' };
  if (Object.keys(peers).length) mf.peerDependencies = peers;
  if (Object.keys(peerMeta).length) mf.peerDependenciesMeta = peerMeta;
  if (dsh) mf.dsh = dsh;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(mf, null, 2));
  // 必须有可解析的入口：P26 用 node 自己的解析器（require.resolve），
  // 只有 package.json 的裸包在 node 眼里是 MODULE_NOT_FOUND —— 那会让用例测到错误的语义。
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
  if (dsh?.bundle?.patch) {
    const f = join(dir, dsh.bundle.patch);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '[]\n');
  }
}

/** bundles 里的包一律带上 dsh.bundle.patch —— 它们本来就该是 bundle（见 writePkg 注释）。 */
const AS_BUNDLE = { dsh: { bundle: { patch: './cordis.patch.yml' } } };

/**
 * 造一棵 fake 宿主树，返回 { root, binDir }；binDir 可直接放进 PATH。
 *
 * 布局必须**逐字照抄真实安装**（Hostbrew/npm 全局）：hostInstallRoot() 的实现是
 *   `PATH 里找到 <x>/dsh` → 取 `dirname(dirname(realpath(bin)))` 作为 `<root>` →
 *   再找 `<root>/@deepseek-ai/dsh/package.json` → 返回 `<root>/@deepseek-ai/dsh/node_modules`
 * 所以 fake 树必须是 `<root>/bin/dsh` + `<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`。
 * 第一版我把包装在 `<root>/lib/node_modules` 下，于是 hostInstallRoot 返回 null，
 * "只有宿主树有"的用例被误报成"哪儿都没有"（实测踩到，改这里的布局才对）。
 */
function fakeHost({ withPackages = [] } = {}) {
  const root = tempDir('dsh-p26-host-');
  const binDir = join(root, 'bin');
  const cliNM = join(root, '@deepseek-ai', 'dsh', 'node_modules');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'dsh'), '#!/bin/sh\nexit 0\n');
  writePkg(join(root, '@deepseek-ai', 'dsh'), { name: '@deepseek-ai/dsh' });
  for (const p of withPackages) writePkg(join(cliNM, '@deepseek-ai', p), { name: `@deepseek-ai/${p}` });
  return { root, binDir };
}

/** 造一个 profile；返回 { home, profileDir }。home 里放 profiles/web。 */
function makeProfile({ bundles, withPeers = {}, peerMeta = {}, deps } = {}) {
  const home = tempDir('dsh-p26-home-');
  const profileDir = join(home, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'p26-profile', version: '1.0.0', private: true,
    dependencies: deps ?? Object.fromEntries(bundles.map((b) => [b, '1.0.0'])),
    dsh: { profile: { bundles } },
  }, null, 2));
  for (const b of bundles) {
    writePkg(join(profileDir, 'node_modules', b), { name: b, peers: withPeers[b] ?? {}, peerMeta: peerMeta[b] ?? {}, ...AS_BUNDLE });
  }
  return { home, profileDir };
}

function runCli({ home, binDir, profile = 'web' }) {
  // PATH **只放 fake 宿主 bin 目录**：否则这台 mac 上真实的 /opt/homebrew/bin/dsh 会在 PATH 里，
  // 而真实宿主树里真的装着 @deepseek-ai/dsh-session 等包 —— "完全没装"的用例会靠环境恰好变绿/变红。
  // （这一步之所以必要，是因为宿主兜底是 P26 判据的一部分；测试必须把它钉死。）
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', '--profile', profile], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, PATH: binDir },
    timeout: 120000,
  });
  assert.ok(r.stdout, `CLI 无输出（stderr: ${String(r.stderr).slice(0, 400)}）`);
  const parsed = JSON.parse(r.stdout);
  return { checks: parsed.checks, exitCode: r.status };
}

function checkOf(checks, id) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `检查 ${id} 未出现在输出里（实际有: ${checks.map((x) => x.id).join(', ')}）`);
  return c;
}

const PEER = '@deepseek-ai/dsh-session';

/* ================= 四条必测（任务要求 ②③④） + 三态的 fail 支 ================= */

test('P26b ②：peer 只在全局/宿主树 → warn（常驻服务能用，子进程会崩）', () => {
  const host = fakeHost({ withPackages: ['dsh-session'] });
  // profile 里装了一个使用方包，它声明 dsh-session 但 profile 内没有该 peer
  const { home } = makeProfile({ bundles: ['@deepseek-ai/dsh-subprocess'], withPeers: { '@deepseek-ai/dsh-subprocess': { [PEER]: '^0.2.0' } } });
  const { checks } = runCli({ home, binDir: host.binDir });
  const p26b = checkOf(checks, 'P26b');
  assert.equal(p26b.status, 'warn', `只有宿主树有 → 必须 warn: ${p26b.detail}`);
  assert.match(p26b.detail, /dsh-session/, '文案必须点名是哪个 peer');
  assert.match(p26b.detail, /子进程|bootstrap|runner/, '文案必须说明"子进程会崩"这个后果');
  // ③ 的 fail 不得同时出现（三态互斥）
  assert.equal(checks.find((x) => x.id === 'P26'), undefined, '仅宿主树可解析时不应同时报 P26 fail');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 ③：peer 完全没装（宿主树也没有）→ fail', () => {
  const host = fakeHost({ withPackages: [] });
  const { home } = makeProfile({ bundles: ['@deepseek-ai/dsh-subprocess'], withPeers: { '@deepseek-ai/dsh-subprocess': { [PEER]: '^0.2.0' } } });
  const { checks, exitCode } = runCli({ home, binDir: host.binDir });
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'fail', `哪儿都没有 → 必须 fail: ${p26.detail}`);
  assert.match(p26.detail, /dsh-session/);
  assert.equal(exitCode, 1, 'error 级失败必须翻退出码（不能只是打印一行）');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 ①：peer 在包自身 node_modules → pass（最健康的情形，不得报）', () => {
  const host = fakeHost({ withPackages: [] });
  const { home, profileDir } = makeProfile({ bundles: ['@deepseek-ai/dsh-subprocess'], withPeers: { '@deepseek-ai/dsh-subprocess': { [PEER]: '^0.2.0' } } });
  // 依赖被装在使用方包自己的 node_modules 里（npm 嵌套布局）
  writePkg(join(profileDir, 'node_modules', '@deepseek-ai/dsh-subprocess', 'node_modules', ...PEER.split('/')), { name: PEER });
  const { checks, exitCode } = runCli({ home, binDir: host.binDir });
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'pass', `包自身可解析 → 必须 pass: ${p26.detail}`);
  assert.equal(checks.find((x) => x.id === 'P26b'), undefined, '可解析时不得报 warn');
  // 只看 P26 对退出码的贡献：其它检查（P5 顶层重复等）与本题无关，不得掩盖 P26 的判定
  assert.notEqual(p26.status, 'fail');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 ④：optional peer 缺失 → 不报（peerDependenciesMeta.optional）', () => {
  const host = fakeHost({ withPackages: [] });
  const { home } = makeProfile({
    bundles: ['@deepseek-ai/dsh-persist'],
    withPeers: { '@deepseek-ai/dsh-persist': { [PEER]: '*' } },
    peerMeta: { '@deepseek-ai/dsh-persist': { [PEER]: { optional: true } } },
  });
  const { checks, exitCode } = runCli({ home, binDir: host.binDir });
  // 全部 peer 都是 optional ⇒ 零对象 ⇒ skip（不是 pass，也不是 fail）
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'skip', `optional 缺失不应报问题: ${p26.detail}`);
  assert.equal(checks.find((x) => x.id === 'P26b'), undefined, 'optional 缺失不得报 warn');
  assert.notEqual(p26.status, 'fail', 'optional 缺失不得被判失败');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

/* ================= 对抗性用例：防止实现被"简化"回假绿灯 ================= */

test('P26 对抗：peer 在共享 hoisted 层（profiles/node_modules，指向 CLI 的软链）→ 必须 warn 而非 pass', () => {
  /* 这是 #10149 的**核心形态**，也是变异实验抓到过的一个真缺口：
   * 真实机器上 `<home>/profiles/node_modules` 是所有 profile 共享的 hoisted 层，里面每个
   * @deepseek-ai/* 都是指向全局 CLI 那份的软链。裸 node 从包目录向上走**会命中它**——
   * 所以只看"能不能解析"会把"只有常驻服务能用"误判成"包自己能解析"（假绿灯）。
   * 必须额外判"命中点是否在 profile 自己的 node_modules 之下"。
   * 本用例把 peer 放在 profile **外面**、共享层里，证明 insideProfile 这一判据确实在起作用。 */
  const host = fakeHost({ withPackages: [] });
  const { home, profileDir } = makeProfile({ bundles: ['@deepseek-ai/dsh-subprocess'], withPeers: { '@deepseek-ai/dsh-subprocess': { [PEER]: '^0.2.0' } } });
  // 共享 hoisted 层：<home>/profiles/node_modules/<peer>（模拟指向 CLI 的软链；这里直接写真目录）
  writePkg(join(dirname(profileDir), 'node_modules', ...PEER.split('/')), { name: PEER });
  const { checks } = runCli({ home, binDir: host.binDir });
  const p26b = checkOf(checks, 'P26b');
  assert.equal(p26b.status, 'warn', `共享层可解析≠包自身可解析，必须 warn: ${p26b.detail}`);
  assert.equal(checks.find((x) => x.id === 'P26'), undefined, '共享层有货时不是"哪儿都没有"，不得报 fail');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 对抗：optional 必须按 peerDependenciesMeta 逐条排除，而不能整包跳过', () => {
  const host = fakeHost({ withPackages: [] });
  // 同一个包：A 是 optional（缺失不该报）、B 是 required（缺失必须报）
  const { home } = makeProfile({
    bundles: ['@deepseek-ai/mixed'],
    withPeers: { '@deepseek-ai/mixed': { '@deepseek-ai/optional-a': '*', '@deepseek-ai/required-b': '*' } },
    peerMeta: { '@deepseek-ai/mixed': { '@deepseek-ai/optional-a': { optional: true } } },
  });
  const { checks } = runCli({ home, binDir: host.binDir });
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'fail');
  assert.match(p26.detail, /required-b/, 'required peer 必须被报出');
  assert.doesNotMatch(p26.detail, /optional-a/, 'optional peer 不得出现在问题列表里');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 对抗：非 @deepseek-ai/* 的 peer 不在本检查范围（react 等由 profile 自己管）', () => {
  const host = fakeHost({ withPackages: [] });
  const { home } = makeProfile({ bundles: ['@deepseek-ai/ui-thing'], withPeers: { '@deepseek-ai/ui-thing': { react: '^18.0.0' } } });
  const { checks } = runCli({ home, binDir: host.binDir });
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'skip', `只声明非 host peer 时无对象可查: ${p26.detail}`);
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 对抗：P19 对同一份缺失 peer 仍给 pass —— 这正是 P26 存在的理由', () => {
  const host = fakeHost({ withPackages: ['dsh-session'] });
  const { home } = makeProfile({ bundles: ['@deepseek-ai/dsh-subprocess'], withPeers: { '@deepseek-ai/dsh-subprocess': { [PEER]: '^0.2.0' } } });
  const { checks } = runCli({ home, binDir: host.binDir });
  const p19 = checkOf(checks, 'P19');
  const p26b = checkOf(checks, 'P26b');
  assert.equal(p19.status, 'pass', '锁住"P19 在这份输入上是假绿灯"这一前提，否则本组用例失去意义');
  assert.equal(p26b.status, 'warn', 'P26b 必须把 P19 判不出的那条事实说出来');
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});

test('P26 断链区分：共享层里指向不存在目标的软链 → 报"断链"，修法不是"补装 peer"', () => {
  // 本机实测：<home>/profiles/node_modules/@deepseek-ai/* 里有 14 条指向已被移除的宿主包的软链
  //（dsh 升级残留）。"看起来装了、其实链断了"与"根本没装"的修复动作完全不同——
  // 前者补装 peer 无效，要重建该层。不区分会让用户照着无效建议操作。
  const host = fakeHost({ withPackages: [] });
  const { home } = makeProfile({
    bundles: ['@deepseek-ai/ui-thing'],
    withPeers: { '@deepseek-ai/ui-thing': { '@deepseek-ai/gone-pkg': '^1.0.0' } },
  });
  // 在共享 hoisted 层造一条断链
  const shared = join(home, 'profiles', 'node_modules', '@deepseek-ai');
  mkdirSync(shared, { recursive: true });
  symlinkSync(join(home, 'definitely-not-here'), join(shared, 'gone-pkg'));
  const { checks } = runCli({ home, binDir: host.binDir });
  const p26 = checkOf(checks, 'P26');
  assert.equal(p26.status, 'fail', `断链也必须 fail: ${p26.status} ${p26.detail}`);
  assert.match(String(p26.detail), /断链/, `detail 必须点明是断链: ${p26.detail}`);
  assert.match(String(p26.fix ?? ''), /断链|失效软链/, `修复建议必须针对断链而不是笼统的"补装": ${p26.fix}`);
  rmSync(home, { recursive: true, force: true });
  rmSync(host.root, { recursive: true, force: true });
});
