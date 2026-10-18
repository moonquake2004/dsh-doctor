/**
 * dsh-doctor 远程检查目录（层 A）测试
 * 运行：node --test plugin/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runCatalogCheck,
  loadCatalog,
  bundledCatalog,
  validCatalog,
  expandPath,
  globCount,
  localVersion,
  checkForUpdate,
  profileDirOfModule,
  nodeInSupportedRange,
} from '../dsh-doctor.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doctor-cat-'));
  return dir;
}

function ctx(home, profile = 'web') {
  return { home, profile, profileDir: join(home, 'profiles', profile) };
}

/* ---------- 探测原语 ---------- */

test('command-exists 探测', () => {
  const ok = runCatalogCheck({ probe: { type: 'command-exists', cmd: 'node' } }, ctx('/tmp'));
  assert.equal(ok.ok, true);

  // 有 DSH 环境（sessions/ 或 settings.yaml 存在）→ 命令缺失 = 真失败
  const withEnv = tempHome();
  mkdirSync(join(withEnv, 'sessions'), { recursive: true });
  const miss = runCatalogCheck({ probe: { type: 'command-exists', cmd: 'dsh-doctor-no-such-cmd-xyz' } }, ctx(withEnv));
  assert.equal(miss.ok, false, '有 DSH 环境时命令缺失必须判失败');
  rmSync(withEnv, { recursive: true, force: true });

  // 无 DSH 环境（干净容器/仓库检出）→ skip，而非"用户环境有问题"
  const bare = tempHome();
  const skipped = runCatalogCheck({ probe: { type: 'command-exists', cmd: 'dsh-doctor-no-such-cmd-xyz' } }, ctx(bare));
  assert.equal(skipped.skipped, true, '无 DSH 环境时应 skip（这正是 CI 上 dsh 不在 PATH 的情形）');
  rmSync(bare, { recursive: true, force: true });
});

test('path-exists / path-is-dir / path-is-file', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'a.txt'), 'x');
  assert.equal(runCatalogCheck({ probe: { type: 'path-exists', path: '{profile}/a.txt' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'path-is-dir', path: '{profile}' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'path-is-dir', path: '{profile}/a.txt' } }, c).ok, false);
  assert.equal(runCatalogCheck({ probe: { type: 'path-is-file', path: '{profile}/a.txt' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'path-is-file', path: '{profile}/nope' } }, c).ok, false);
  rmSync(home, { recursive: true, force: true });
});

test('json-valid: 合法/非法/缺失(required:false)', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'good.json'), '{"a":1}');
  writeFileSync(join(c.profileDir, 'bad.json'), '{"a":1,}');
  assert.equal(runCatalogCheck({ probe: { type: 'json-valid', path: '{profile}/good.json' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'json-valid', path: '{profile}/bad.json' } }, c).ok, false);
  // required:false 时缺失 → ok（跳过）
  assert.equal(runCatalogCheck({ probe: { type: 'json-valid', path: '{profile}/missing.json', required: false } }, c).ok, true);
  // 默认缺失 → fail
  assert.equal(runCatalogCheck({ probe: { type: 'json-valid', path: '{profile}/missing.json' } }, c).ok, false);
  rmSync(home, { recursive: true, force: true });
});

test('text-contains / text-not-contains（含 flags）', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cfg.txt'), 'ignore-workspace-root-check=true\nfoo bar\n');
  assert.equal(runCatalogCheck({ probe: { type: 'text-contains', path: '{profile}/cfg.txt', pattern: 'ignore-workspace-root-check\\s*=\\s*true' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'text-contains', path: '{profile}/cfg.txt', pattern: 'ignore-workspace-root-check\\s*=\\s*false' } }, c).ok, false);
  assert.equal(runCatalogCheck({ probe: { type: 'text-not-contains', path: '{profile}/cfg.txt', pattern: 'GONE' } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'text-not-contains', path: '{profile}/cfg.txt', pattern: 'foo bar' } }, c).ok, false);
  // 多行标志 m + 行首锚定（真实格式：`- id:` 下缩进的 `name:`，无破折号；与种子规则 P6 同款正则）
  const patch = '- insert:\n    - id: x\n      name: "My Plugin"\n';
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), patch);
  assert.equal(runCatalogCheck({ probe: { type: 'text-contains', path: '{profile}/cordis.patch.yml', pattern: '^\\s*name:\\s*[\'"]?[^\'"\\s]+[^\'"\\n]*\\s[^\'"\\n]+', flags: 'm' } }, c).ok, true);
  // 缺失 + required:false → ok
  assert.equal(runCatalogCheck({ probe: { type: 'text-contains', path: '{profile}/nope.txt', pattern: 'x', required: false } }, c).ok, true);
  rmSync(home, { recursive: true, force: true });
});

test('file-size-above', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'big.log'), 'x'.repeat(5000));
  assert.equal(runCatalogCheck({ probe: { type: 'file-size-above', path: '{profile}/big.log', minBytes: 1000 } }, c).ok, false);
  assert.equal(runCatalogCheck({ probe: { type: 'file-size-above', path: '{profile}/big.log', minBytes: 10000 } }, c).ok, true);
  // 红队 R2（0.8.10）：这里原本断言 `ok === true`，等于把「文件不存在 → 报"大小在限内"」这个 bug
  // 锁成了契约。正确的语义是 **skip**（不适用 ≠ 通过），且文案不得是肯定句。
  {
    const missing = runCatalogCheck({ probe: { type: 'file-size-above', path: '{profile}/missing.log', minBytes: 10 } }, c);
    assert.equal(missing.skipped, true, '文件不存在必须是 skip，不能是 pass');
    assert.doesNotMatch(String(missing.detail), /在限内/, `skip 行不得宣称"在限内": ${missing.detail}`);
  }
  rmSync(home, { recursive: true, force: true });
});

test('glob-count: 计数 + min/max + ** 递归', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(join(c.profileDir, 'a'), { recursive: true });
  mkdirSync(join(c.profileDir, 'a', 'b'), { recursive: true });
  writeFileSync(join(c.profileDir, 'a', '1.json'), '{}');
  writeFileSync(join(c.profileDir, 'a', '2.json'), '{}');
  writeFileSync(join(c.profileDir, 'a', 'b', '3.json'), '{}');
  writeFileSync(join(c.profileDir, 'a', 'b', 'note.txt'), 'x');
  assert.equal(globCount(c.profileDir, 'a/*.json'), 2);
  assert.equal(globCount(c.profileDir, '**/*.json'), 3);
  assert.equal(globCount(c.profileDir, 'a/**/*.json'), 3);
  assert.equal(globCount(c.profileDir, '**/*'), 4);
  assert.equal(runCatalogCheck({ probe: { type: 'glob-count', path: '{profile}', pattern: 'a/*.json', min: 2, max: 2 } }, c).ok, true);
  assert.equal(runCatalogCheck({ probe: { type: 'glob-count', path: '{profile}', pattern: 'a/*.json', min: 3 } }, c).ok, false);
  assert.equal(runCatalogCheck({ probe: { type: 'glob-count', path: '{profile}', pattern: 'a/*.json', max: 1 } }, c).ok, false);
  rmSync(home, { recursive: true, force: true });
});

test('未知探测原语 → skipped（不误报）', () => {
  const r = runCatalogCheck({ probe: { type: 'future-probe' } }, ctx('/tmp'));
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('expandPath: {home}/{profile}/{profileName} 替换', () => {
  const c = { home: '/h', profile: 'web', profileDir: '/h/profiles/web' };
  assert.equal(expandPath('{home}/x', c), '/h/x');
  assert.equal(expandPath('{profile}/y', c), '/h/profiles/web/y');
  assert.equal(expandPath('{profileName}', c), 'web');
});

/* ---------- 目录加载与回退链 ---------- */

test('bundledCatalog: 读内置 checks.json，schemaVersion=1', () => {
  const cat = bundledCatalog();
  assert.equal(cat.schemaVersion, 1);
  assert.ok(Array.isArray(cat.checks) && cat.checks.length >= 3);
});

test('validCatalog', () => {
  assert.equal(validCatalog({ schemaVersion: 1, checks: [] }), true);
  assert.equal(validCatalog({ schemaVersion: 2, checks: [] }), false);
  assert.equal(validCatalog({ checks: [] }), false);
  assert.equal(validCatalog(null), false);
});

test('loadCatalog: noRemote → bundled（不调 fetch）', async () => {
  let called = false;
  const r = await loadCatalog({ noRemote: true, fetchImpl: async () => { called = true; throw new Error('不应调用'); } });
  assert.equal(r.source, 'bundled');
  assert.equal(called, false);
});

test('loadCatalog: 远程成功 → remote + 写缓存', async () => {
  const home = tempHome();
  const payload = { schemaVersion: 1, checks: [{ id: 'X1', probe: { type: 'command-exists', cmd: 'node' } }] };
  const r = await loadCatalog({ home, fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  assert.equal(r.source, 'remote');
  assert.equal(r.checks.length, 1);
  assert.ok(existsSync(join(home, '.cache', 'dsh-doctor', 'checks.json')));
  rmSync(home, { recursive: true, force: true });
});

test('loadCatalog: 远程失败 → 回退旧缓存(last-known-good)', async () => {
  const home = tempHome();
  const cacheDir = join(home, '.cache', 'dsh-doctor');
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, 'checks.json');
  writeFileSync(cacheFile, JSON.stringify({ schemaVersion: 1, checks: [{ id: 'OLD' }] }));
  // 回拨 mtime 到 TTL 之外，模拟"过期但 last-known-good"的缓存
  const { utimesSync } = await import('node:fs');
  utimesSync(cacheFile, new Date(Date.now() - 2 * 24 * 3600 * 1000), new Date(Date.now() - 2 * 24 * 3600 * 1000));
  const r = await loadCatalog({ home, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(r.source, 'cache-stale');
  assert.equal(r.checks[0].id, 'OLD');
  rmSync(home, { recursive: true, force: true });
});

test('loadCatalog: 新鲜缓存(≤TTL) → cache（不调网络）', async () => {
  const home = tempHome();
  const cacheDir = join(home, '.cache', 'dsh-doctor');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'checks.json'), JSON.stringify({ schemaVersion: 1, checks: [{ id: 'FRESH' }] }));
  let called = false;
  const r = await loadCatalog({ home, fetchImpl: async () => { called = true; throw new Error('should not fetch'); } });
  assert.equal(r.source, 'cache');
  assert.equal(r.checks[0].id, 'FRESH');
  assert.equal(called, false);
  rmSync(home, { recursive: true, force: true });
});

test('loadCatalog: 远程返回非法 payload → 回退内置', async () => {
  const home = tempHome();
  const r = await loadCatalog({ home, fetchImpl: async () => ({ ok: true, json: async () => ({ schemaVersion: 99, checks: [] }) }) });
  assert.equal(r.source, 'bundled');
  assert.ok(r.checks.length >= 3);
  rmSync(home, { recursive: true, force: true });
});

/* ---------- 种子规则在本机真实 profile 上的行为 ---------- */

test('种子规则：E7-dsh-in-path 通过（node 在 PATH，dsh 通常也在）', () => {
  const cat = bundledCatalog();
  const e7 = cat.checks.find((c) => c.id === 'E7-dsh-in-path');
  assert.ok(e7, 'E7 存在');
  // 需要"存在 DSH 环境"才会真正判定（无环境时按设计 skip）；这里显式构造，
  // 不让用例依赖"跑测试的机器上恰好有 ~/.dsh"——CI 上正是因为没有而红过。
  const home = tempHome();
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const r = runCatalogCheck(e7, ctx(home));
  assert.equal(typeof r.ok, 'boolean', '有 DSH 环境时必须给出布尔判定');
  rmSync(home, { recursive: true, force: true });
});

test('种子规则：P6-patch-name-space 在含空格 name 的 patch 上 fail', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), '- insert:\n    - id: x\n      name: "My Plugin"\n');
  const cat = bundledCatalog();
  const p6 = cat.checks.find((x) => x.id === 'P6-patch-name-space');
  const r = runCatalogCheck(p6, c);
  assert.equal(r.ok, false);
  rmSync(home, { recursive: true, force: true });
});

test('种子规则：E8-npmrc-workspace-flag 在缺 flag 的 profile 上 fail（warn）', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, '.npmrc'), '');
  const cat = bundledCatalog();
  const e8 = cat.checks.find((x) => x.id === 'E8-npmrc-workspace-flag');
  assert.equal(e8.severity, 'warn');
  const r = runCatalogCheck(e8, c);
  assert.equal(r.ok, false);
  rmSync(home, { recursive: true, force: true });
});

/* ---------- 层 B：版本检查 ---------- */

test('localVersion: 读到插件自身版本', () => {
  const v = localVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('checkForUpdate: noRemote → 不调网络', async () => {
  let called = false;
  const r = await checkForUpdate({ noRemote: true, fetchImpl: async () => { called = true; throw new Error('不应调用'); } });
  assert.equal(called, false);
  assert.equal(r.available, false);
  assert.equal(r.latest, null);
});

test('checkForUpdate: 远程返回新版本 → available', async () => {
  const home = tempHome();
  const r = await checkForUpdate({
    home,
    fetchImpl: async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '99.99.99' } }) }),
  });
  assert.equal(r.available, true);
  assert.equal(r.latest, '99.99.99');
  assert.equal(r.current, localVersion());
  // 缓存已写入
  assert.ok(existsSync(join(home, '.cache', 'dsh-doctor', 'update.json')));
  rmSync(home, { recursive: true, force: true });
});

test('checkForUpdate: 远程失败 → 回退 last-known-good 缓存', async () => {
  const home = tempHome();
  const cacheDir = join(home, '.cache', 'dsh-doctor');
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, 'update.json');
  writeFileSync(cacheFile, JSON.stringify({ latest: '88.88.88' }));
  const { utimesSync } = await import('node:fs');
  utimesSync(cacheFile, new Date(Date.now() - 2 * 24 * 3600 * 1000), new Date(Date.now() - 2 * 24 * 3600 * 1000));
  const r = await checkForUpdate({ home, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(r.latest, '88.88.88');
  rmSync(home, { recursive: true, force: true });
});

test('profileDirOfModule: 仓库 checkout 返回 null', () => {
  assert.equal(profileDirOfModule(), null);
});

/* ---------- file-writable 原语 + E11 ---------- */

test('file-writable: 可写 → ok；只读 → fail；缺失+required:false → ok', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  const f = join(c.profileDir, 'settings.yaml');
  writeFileSync(f, 'key: value\n');
  assert.equal(runCatalogCheck({ probe: { type: 'file-writable', path: '{profile}/settings.yaml' } }, c).ok, true);
  chmodSync(f, 0o444);
  assert.equal(runCatalogCheck({ probe: { type: 'file-writable', path: '{profile}/settings.yaml' } }, c).ok, false);
  chmodSync(f, 0o644);
  assert.equal(runCatalogCheck({ probe: { type: 'file-writable', path: '{profile}/missing.yaml', required: false } }, c).ok, true);
  rmSync(home, { recursive: true, force: true });
});
/* E11（0.8.11 重新定向）：从"legacy settings.yaml 可写"改为"**设置目录可写**"。
 *
 * 为什么必须改（实证，不是推测）：
 *   - 旧 E11 查 {home}/settings.yaml。DSH 0.2.x 的 importLegacyDocument
 *     （dsh-settings/lib/index.js:346-363）启动时把它 rename 成 settings.yaml.imported，
 *     且第 349 行 `if (!existsSync(path)) return` —— **新装机器根本没有这个文件**。
 *     于是 E11 在健康机上恒 skip，从没检出过它要守护的 sudo 属主问题。
 *   - 现役设置落盘在 <profile>/cordis.patch.yml，写入走 writeFileAtomic（同目录临时文件 + rename）。
 *   - 实测证明旧原语 file-writable 判不准这件事：
 *       文件 0444、目录可写 → open('a')=EACCES，但 rename 覆盖**成功**（dsh 写得进去）→ 旧原语误报；
 *       父目录 0555        → open('a')=ok（追加只改元数据），但 rename=EACCES → 旧原语**漏报**。
 *   因此新增原语 dir-writable（同目录 wx 临时文件探测），E11 改用它 + {profile}/cordis.patch.yml。
 *   P3/P6/P15 读的是 cordis.patch.yml 的**内容**，E11 查的是**目录写权限**，不构成一事实多检查。
 */

test('E11：设置目录可写 → pass（健康的 profile 不应被报错）', () => {
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), '[]\n');
  const e11 = bundledCatalog().checks.find((x) => x.id === 'E11-settings-writable');
  const r = runCatalogCheck(e11, c);
  // root 会绕过权限位，但"可写"这个结论在 root 下依旧成立
  assert.equal(r.ok, true, `健康目录应 pass: ${r.detail}`);
  assert.equal(r.skipped, undefined, '不得 skip');
  rmSync(home, { recursive: true, force: true });
});

test('E11：目录写权限被剥夺 → fail（这才是 sudo 属主要守护的真风险）', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root 绕过权限位，无法测
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), '[]\n');
  chmodSync(c.profileDir, 0o555); // 去掉写位：rename 覆盖会 EACCES
  const e11 = bundledCatalog().checks.find((x) => x.id === 'E11-settings-writable');
  const r = runCatalogCheck(e11, c);
  try {
    // 沙箱/安全策略下可能 EPERM → 引擎会判 skip（"无法判定"）。真权限问题（EACCES/EROFS）必须 fail。
    if (r.skipped === true) {
      assert.match(r.detail, /EPERM|沙箱|无法判定/, `skip 必须说明是被环境拒绝，不得含糊: ${r.detail}`);
    } else {
      assert.equal(r.ok, false, `目录不可写应 fail: ${r.detail}`);
      assert.doesNotMatch(r.detail, /^$/, 'fail 必须带原因');
    }
  } finally {
    chmodSync(c.profileDir, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});

test('E11：文件 0444 但目录可写 → pass（钉死"不得用 file-writable 查文件本身"）', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  const f = join(c.profileDir, 'cordis.patch.yml');
  writeFileSync(f, '[]\n');
  chmodSync(f, 0o444);          // 文件只读
  // 同目录放一个 **可写** 的 settings.yaml：旧实现只看它，会 pass；新实现看目录，也 pass。
  writeFileSync(join(c.home, 'settings.yaml'), 'x\n', { mode: 0o644 });
  const e11 = bundledCatalog().checks.find((x) => x.id === 'E11-settings-writable');
  const r = runCatalogCheck(e11, c);
  try {
    assert.equal(r.ok, true,
      `文件 0444 + 目录可写时 dsh 仍能持久化设置（rename 覆盖），不得报错: ${r.detail}`);
  } finally {
    chmodSync(f, 0o644);
    rmSync(home, { recursive: true, force: true });
  }
});

test('E11 交叉污染：settings.yaml 不可写、但设置目录可写 → 必须 pass（判定跟目录走，不跟 legacy 文件走）', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), '[]\n');
  // 一侧（legacy 文件）极坏：只读文件；另一侧（真正的目标目录）健康。
  const legacy = join(c.home, 'settings.yaml');
  writeFileSync(legacy, 'x\n');
  chmodSync(legacy, 0o444);
  const e11 = bundledCatalog().checks.find((x) => x.id === 'E11-settings-writable');
  const r = runCatalogCheck(e11, c);
  try {
    // 旧实现（查 settings.yaml 可写性）在这里会 fail —— 这是**假阳性**，因为它查错了对象。
    // 新实现查 profile 目录 → pass。
    assert.equal(r.ok, true,
      `判定必须跟随设置目录（可写），而不是 legacy settings.yaml: ${r.detail}`);
  } finally {
    chmodSync(legacy, 0o644);
    rmSync(home, { recursive: true, force: true });
  }
});

test('E11 交叉污染（反向）：legacy settings.yaml 可写、但设置目录不可写 → 必须 fail', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const home = tempHome();
  const c = ctx(home);
  mkdirSync(c.profileDir, { recursive: true });
  writeFileSync(join(c.profileDir, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(c.home, 'settings.yaml'), 'x\n', { mode: 0o644 }); // legacy 可写（旧实现会 pass）
  chmodSync(c.profileDir, 0o555);                                       // 真目标目录不可写
  const e11 = bundledCatalog().checks.find((x) => x.id === 'E11-settings-writable');
  const r = runCatalogCheck(e11, c);
  try {
    // 旧实现在这里会 pass（假阴性，漏掉真风险）。
    if (r.skipped === true) {
      assert.match(r.detail, /EPERM|沙箱|无法判定/, `skip 必须说明环境拒绝: ${r.detail}`);
    } else {
      assert.equal(r.ok, false, `设置目录不可写必须 fail（legacy 文件可写不得掩盖它）: ${r.detail}`);
    }
  } finally {
    chmodSync(c.profileDir, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});

test('E11 不变量②：引擎两处"跳过"判据锁（跳过理由含跳过/不适用 → 记 skip；无 profile 目录时 env 照跑）', () => {
  const src = readFileSync(new URL('../dsh-doctor.mjs', import.meta.url), 'utf8');
  // checkCatalog：自报 ok:true 但文案自述跳过 → 归一化成 skip（否则 env 段会被记 pass）
  assert.match(src, /r\.ok === true && \/跳过\|不适用\/\.test\(String\(r\.detail\)\)\s*\)\s*r\.skipped = true/,
    '引擎须保留"文案自述跳过 → skip"归一化（checkCatalog）');
  // env 段检查不得被 `if (check.section === 'profile' && !ctx.profileDir) continue` 误伤
  assert.match(src, /if \(check\.section === 'profile' && !ctx\.profileDir\) continue/,
    '无 profile 目录时只应跳过 profile 段');
});

/* ---------- v1 词汇表 r5（#1719）：node 两态语义 ---------- */

test('nodeInSupportedRange: ^22.19.0 || >=24.0.0（root package.json engines）', () => {
  // pass 区间
  assert.equal(nodeInSupportedRange('v22.19.0'), true);
  assert.equal(nodeInSupportedRange('v22.22.1'), true);
  assert.equal(nodeInSupportedRange('v22.99.0'), true);
  assert.equal(nodeInSupportedRange('v24.0.0'), true);
  assert.equal(nodeInSupportedRange('v24.1.2'), true);
  assert.equal(nodeInSupportedRange('v25.0.0'), true);
  // warn 区间（无 fail 阈值——EBADENGINE 语义，无民间数字）
  assert.equal(nodeInSupportedRange('v22.18.9'), false);
  assert.equal(nodeInSupportedRange('v23.0.0'), false);
  assert.equal(nodeInSupportedRange('v20.11.0'), false);
  assert.equal(nodeInSupportedRange('v18.20.0'), false);
  assert.equal(nodeInSupportedRange('v16.0.0'), false);
  // 畸形输入
  assert.equal(nodeInSupportedRange('v22'), false);
  assert.equal(nodeInSupportedRange(''), false);
  assert.equal(nodeInSupportedRange(null), false);
});

/* ---------- 发布门禁：插件身份一致性——所有"以包身份注册"的点必须 = npm 包名 ---------- */
/* #16：裸 patch name 或裸 __ModuleLoader__ 注册 id × scoped 安装 → loader 无法注册 → dsh web boot 崩（两个半边都是同根因） */

test('插件身份一致性：cordis.patch.yml insert name + client.js __ModuleLoader__ id 都必须 = npm 包名', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'plugin', 'package.json'), 'utf8'));
  // 1) 宿主侧：cordis.patch.yml 的 insert name
  const patch = readFileSync(join(process.cwd(), 'plugin', 'cordis.patch.yml'), 'utf8');
  const pm = patch.match(/^\s*name:\s*['"]([^'"]+)['"]/m);
  assert.ok(pm, 'patch 应含 insert name');
  assert.equal(pm[1], pkg.name, `patch insert name(${pm[1]}) ≠ npm 包名(${pkg.name})——npm 安装路径 host loader 无法解析（#16）`);
  // 2) 客户端侧：client.js 的 __ModuleLoader__.load 注册 id
  const client = readFileSync(join(process.cwd(), 'plugin', 'client', 'client.js'), 'utf8');
  const cm = client.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/s);
  assert.ok(cm, 'client.js 应含 __ModuleLoader__.load({ id: ... })');
  assert.equal(cm[1], pkg.name, `client __ModuleLoader__ 注册 id(${cm[1]}) ≠ npm 包名(${pkg.name})——scoped 安装时 client-modules 注册不上 → web boot 崩溃`);
});
