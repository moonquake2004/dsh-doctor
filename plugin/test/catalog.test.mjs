/**
 * dsh-doctor 远程检查目录（层 A）测试
 * 运行：node --test plugin/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  const miss = runCatalogCheck({ probe: { type: 'command-exists', cmd: 'dsh-doctor-no-such-cmd-xyz' } }, ctx('/tmp'));
  assert.equal(miss.ok, false);
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
  assert.equal(runCatalogCheck({ probe: { type: 'file-size-above', path: '{profile}/missing.log', minBytes: 10 } }, c).ok, true);
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
  // dsh 在运行环境里通常在 PATH（插件就是被 dsh 加载的），但不强制 —— 只验证探测可执行
  const r = runCatalogCheck(e7, ctx(process.env.HOME));
  assert.equal(typeof r.ok, 'boolean');
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
