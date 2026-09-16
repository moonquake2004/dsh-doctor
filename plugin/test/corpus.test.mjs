/**
 * 畸形/边界输入语料驱动器（R2 样本律 + R13 环境泛化律的制度化）。
 *
 * 语料在 `test/corpus/malformed-cases.json`，每条都必须给出**确定判定**：
 * 不崩、不静默通过、目标检查给出预期状态。
 *
 * 为什么要有它：这一轮所有**实质性**缺陷都来自外部输入（社区报告），而我的内省只发现元问题。
 * 既然"等别人报"不可靠，就把**外部形态**变成仓库内的常驻语料——每次改动都会重跑，
 * 而不是等下一次事故把它送回来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dsh-doctor.mjs');
const CASES = JSON.parse(readFileSync(join(HERE, '..', '..', 'test', 'corpus', 'malformed-cases.json'), 'utf8')).cases;

const tempHome = () => mkdtempSync(join(tmpdir(), 'dsh-corpus-'));

/** 按语料描述搭建 profile / 会话目录（三层：sessions/<项目>/<会话>/<文件> 才是真实布局）。 */
function build(home, c) {
  const s = c.setup ?? {};
  if (s.manifestIsDir) {
    mkdirSync(join(home, 'profiles', 'web', 'package.json'), { recursive: true });
  } else if (s.manifestRaw !== undefined || s.manifest !== undefined) {
    const dir = join(home, 'profiles', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), s.manifestRaw ?? JSON.stringify(s.manifest, null, 2));
    if (s.patchRaw !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), s.patchRaw);
  for (const [rel, content] of Object.entries(s.nodeModules ?? {})) {
      const f = join(dir, 'node_modules', rel);
      mkdirSync(dirname(f), { recursive: true });
      // 哨兵：表示"目录存在但没有 package.json"（中断安装的残留）——直接写 null 会让 writeFileSync 抛错
      if (content === '__EMPTY_DIR__') { mkdirSync(f, { recursive: true }); continue; }
      writeFileSync(f, content);
    }
  }
  // 宿主共享根：真实布局里宿主包在 `profiles/node_modules`（父层），是 bundle 的**祖先链**——
  // 判定"第二份实例"必须靠它；fixture 若只放嵌套副本，就测不到真实条件（红队第五轮指出）。
  for (const [rel, content] of Object.entries(s.hostLayer ?? {})) {
    const f = join(home, 'profiles', 'node_modules', rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  if (s.sessionName) {
    const dir = s.depth === 2
      ? join(home, 'sessions', s.sessionName)
      : join(home, 'sessions', 'proj', s.sessionName);
    mkdirSync(dir, { recursive: true });
    if (s.rawZstd !== undefined) writeFileSync(join(dir, 'session.v3.jsonl.zstd'), s.rawZstd);
    else if (s.rawPlain !== undefined) writeFileSync(join(dir, 'session.jsonl'), s.rawPlain);
    else {
      const rows = [{ type: 'session', version: 3, id: s.sessionName, createdAt: 1, cwd: '/tmp' }, ...(s.sessionRows ?? [])];
      const name = (s.sessionRows ?? []).length || s.depth === 2 ? 'session.jsonl' : 'session.v3.jsonl';
      writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  }
}

function runJson(home, args) {
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 60000,
  });
  let data = null;
  try { const i = r.stdout.indexOf('{'); if (i >= 0) data = JSON.parse(r.stdout.slice(i)); } catch { /* 解析失败留 null */ }
  return { r, data };
}
const runBoot = (home) => spawnSync(process.execPath, [CLI, '--boot-check', '--profile', 'web'], {
  encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 60000,
});
const statusOf = (data, id) => data?.checks?.find((c) => c.id === id)?.status;

for (const c of CASES) {
  test(`语料 ${c.id}（${c.source}）：${c.desc}`, () => {
    const home = tempHome();
    try {
      build(home, c);
      const e = c.expect ?? {};
      const needsChecks = Object.keys(e).some((k) => k !== 'mustNotCrash' && k !== 'exitIn');
      // 会话类语料必须走**不收窄**的运行：--profile 会把检查收窄到 profile 段，会话检查本就不跑
      // （写这批语料时我就踩了这个：以为 S14 漏报，其实是运行参数让它没跑）。
      const { r, data } = runJson(home, c.setup?.unNarrowed ? [] : ['--profile', 'web']);

      // 确定判定：输出必须是可解析的 JSON（不崩），退出码必须落在允许集合内
      if (e.mustNotCrash || needsChecks) {
        assert.ok(data, `输出不是可解析 JSON（崩了？）: stdout=${r.stdout.slice(0, 120)} stderr=${(r.stderr || '').slice(0, 160)}`);
      }
      if (e.exitIn) assert.ok(e.exitIn.includes(r.status), `退出码 ${r.status} 不在允许集合 ${e.exitIn}`);

      if (e.othersStillRun !== undefined) {
        assert.ok((data.checks?.length ?? 0) >= e.othersStillRun,
          `早期失败掐断了整段检查：只剩 ${data.checks?.length} 项`);
      }
      for (const [key, want] of Object.entries(e)) {
        if (!/^[A-Z]/.test(key)) continue; // 只处理以大写字母开头的检查 id
        const got = statusOf(data, key);
        if (want === 'fail') assert.equal(got, 'fail', `${key} 期望 fail，实际 ${got}`);
        else if (want === 'pass') assert.equal(got, 'pass', `${key} 期望 pass（防误报），实际 ${got}`);
        else if (want === 'notPass') assert.notEqual(got, 'pass', `${key} 不应为 pass（实际 pass）`);
        else if (want === 'skip') assert.equal(got, 'skip', `${key} 期望 skip，实际 ${got}`);
      }
      if (e.S11DetailHas) {
        const d = data.checks.find((x) => x.id === 'S11')?.detail ?? '';
        assert.match(d, new RegExp(e.S11DetailHas), `S11 详情应含「${e.S11DetailHas}」，实际: ${d.slice(0, 120)}`);
      }
      if (c.knownGap) {
        console.log(`      ⊘ 已知缺口 ${c.knownGap}`);
      }
      if (e.jsonOkImpliesVerified) {
        assert.ok(!data.ok || (data.verified ?? 0) > 0, `ok=true 必须蕴含 verified>0（实际 ok=${data.ok} verified=${data.verified}）`);
      }
      if (e.aggregateNotAllPass || e.bootCheckNotGreened) {
        const b = runBoot(home);
        assert.ok(!/✓ 所有可探测 entry 均可导入/.test(b.stdout), '零对象不得宣称"全部可导入"');
      }
      if (e.bootCheckFails) {
        const b = runBoot(home);
        assert.notEqual(b.status, 0, `--boot-check 应失败，实际退出码 ${b.status}`);
        if (e.notGreened) assert.ok(!/✓ 所有可探测 entry 均可导入/.test(b.stdout), '不得出现假绿灯');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
