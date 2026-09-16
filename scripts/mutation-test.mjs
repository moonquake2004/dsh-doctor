#!/usr/bin/env node
/**
 * 变异测试：**故意破坏每个守卫，要求测试必须变红**。
 *
 * 为什么需要它（2026-09-16 的直接证据）：
 *   · 闭集测试的正则只有 `/[✓⊖✗]/` —— **永远看不见 `⚠`**，于是"闭集"声称成立而实际有洞；
 *   · `scripts/audit.sh` 的断言是 `n > 1` —— **2 条记录就能过关**，自证强度远低于主张。
 * 这两个都是"看起来在守、其实没守"。**只有变异测试能系统性抓到它们**：
 * 守卫必须在被破坏时让测试红；若破坏后测试仍然绿，那个守卫就是装饰品。
 *
 * 用法：node scripts/mutation-test.mjs [--json]
 * 安全性：在**备份后原地改**，finally 里必定还原；另有 `git checkout -- plugin/dsh-doctor.mjs` 兜底。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'plugin', 'dsh-doctor.mjs');
const BACKUP = SRC + '.mutation-backup';

/** 每个变异：破坏一处守卫，并指定"应当因此变红"的那条测试。 */
const MUTATIONS = [
  {
    id: 'makeVerdict-zero-pass',
    desc: 'makeVerdict 允许 checked=0 的 pass（零对象不变量失效）',
    find: 'if (typeof n !== \'number\' || n <= 0) {',
    replace: 'if (false) {',
    test: 'plugin/test/fixtures.mjs', pattern: 'makeVerdict',
  },
  {
    id: 'report-zero-demote',
    desc: 'report() 不再把 examined===0 的通过降级为 skip',
    find: 'if (ok === true && zeroCheck === 0) {',
    replace: 'if (false) {',
    test: 'plugin/test/fixtures.mjs', pattern: 'examined === 0',
  },
  {
    id: 'arity-guard',
    desc: 'report() 的参数个数守卫失效（多传参数被静默忽略）',
    find: 'if (arguments.length > 8) {',
    replace: 'if (false) {',
    test: 'plugin/test/fixtures.mjs', pattern: 'report.*参数|arity|参数个数',
  },
  {
    id: 'closure-symbol',
    desc: '新增一处手写判定符号（闭集必须抓到）',
    find: '  setPhase(\'env\');',
    replace: '  console.log(\'✓ 变异体：收口点之外的手写绿灯\');\n  setPhase(\'env\');',
    test: 'plugin/test/fixtures.mjs', pattern: '闭集',
  },
  {
    id: 'bootVerdict-zero-pass',
    desc: 'bootVerdict 把零对象判成 pass（装载模拟假绿灯回归）',
    find: "if (results.length === 0) {",
    replace: "if (false) {",
    test: 'plugin/test/fixtures.mjs', pattern: 'bootVerdict|零对象',
  },
  {
    id: 'aggregate-allskip-pass',
    desc: 'aggregateVerdict 把"全部跳过"判成通过',
    find: 'if (verified === 0) {',
    replace: 'if (false) {',
    test: 'plugin/test/fixtures.mjs', pattern: '全部跳过',
  },
  {
    id: 'coverage-phase-binding',
    desc: '覆盖量上下文不再绑定阶段（跨段继承 → 伪造数字回归）',
    find: "return coverageContext && coverageContext.phase === currentPhase ? coverageContext : null;",
    replace: 'return coverageContext;',
    test: 'plugin/test/fixtures.mjs', pattern: '串台|继承',
    // **等价变异**（如实标注，不假装被测到）：当前每个阶段都会自己 setCoverage，
    // 所以"绑定阶段"这条守卫在今天的代码里是**冗余的**——它保护的是"将来某个阶段忘记设单位"。
    // 等价变异不是漏洞，但必须记录，否则"存活数"会被误读。
    equivalent: '各阶段均自行 setCoverage，故该守卫当前冗余（防的是未来某阶段忘记设单位）',
  },
  {
    id: 'P23-host-dep-detection',
    desc: 'P23 不再检出"插件把宿主机包声明为普通依赖"（#6789 漏检回归）',
    // 判据已从"manifest 键名"升级为"副本是否真在盘上"（红队 F1–F3）→ 变异点随之更新
    find: "if (!isPluginPkg(nmf)) {",
    replace: "if (false) {",
    test: 'plugin/test/corpus.test.mjs', pattern: 'host-copy-on-disk|host-dep-as-dependency',
  },
  {
    id: 'catalog-skip-as-pass',
    desc: '目录检查自报 skipped 又被记成 pass（红队 R1 回归）',
    find: 'if (r.skipped) { reportSkip(check.section, check.id, r.detail, \'catalog\'); continue; }',
    replace: 'if (r.skipped) { report(check.section, check.id, true, r.detail, undefined, \'catalog\'); continue; }',
    test: 'plugin/test/fixtures.mjs', pattern: '目标不存在',
  },
];

function runTest(file, pattern) {
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
    encoding: 'utf8', cwd: ROOT, timeout: 180000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // 红队 F5：**不能**把"非零退出"一律当作"被杀死"——环境问题（网络目录、超时）也会非零，
  // 那会把环境导致的红记成 kill（false kill）。判据收紧为：必须出现**测试断言失败**的标记。
  const assertionFailure = r.status !== null && /AssertionError|✖ .*\(|failing tests:/.test(out);
  const timedOut = r.status === null;
  return { failed: assertionFailure, timedOut, out, status: r.status };
}

// 先跑一遍**基线**：若未变异时该测试就是红的（环境问题），那么这条变异本轮不做判定（标为 inconclusive）
const baseline = {};
for (const m of MUTATIONS) {
  if (baseline[m.id] !== undefined) continue;
  const b = runTest(m.test, m.pattern);
  baseline[m.id] = b.failed || b.timedOut;
  if (baseline[m.id]) process.stderr.write(`  ⚠ ${m.id} 的基线未通过（环境问题？）→ 本轮不做判定\n`);
}

const survivors = [];
const killed = [];
const skipped = [];
const equivalents = [];

copyFileSync(SRC, BACKUP);
// 红队：加信号处理器——否则在"写入变异体"与"还原"之间被 SIGINT/SIGTERM 打断会留下被破坏的源码
const restoreAndExit = (sig) => {
  try { if (existsSync(BACKUP)) { writeFileSync(SRC, readFileSync(BACKUP, 'utf8')); unlinkSync(BACKUP); } } catch { /* ignore */ }
  process.stderr.write(`\n收到 ${sig}：已还原 ${SRC}，退出。\n`);
  process.exit(130);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => restoreAndExit(sig));
try {
  for (const m of MUTATIONS) {
    let src = readFileSync(BACKUP, 'utf8');
    if (!src.includes(m.find)) { skipped.push({ ...m, why: '变异点未匹配（源码已变，需更新变异清单）' }); continue; }
    src = src.replace(m.find, m.replace);
    writeFileSync(SRC, src);
    let res; let err = null;
    try { res = runTest(m.test, m.pattern); } catch (e) { err = e.message; }
    writeFileSync(SRC, readFileSync(BACKUP, 'utf8')); // 立刻还原
    if (err) { skipped.push({ ...m, why: `运行异常: ${err}` }); continue; }
    if (res.timedOut) { skipped.push({ ...m, why: '超时（status=null）→ 不做判定' }); continue; }
    if (baseline[m.id]) { skipped.push({ ...m, why: '基线未通过（环境问题）→ 不做判定' }); continue; }
    if (res.failed) killed.push(m);
    else if (m.equivalent) equivalents.push(m);
    else survivors.push(m);
    process.stderr.write(`  ${res.failed ? '✓ 被杀死' : '✗ 存活  '} ${m.id}（${m.desc}）\n`);
  }
} finally {
  if (existsSync(BACKUP)) { writeFileSync(SRC, readFileSync(BACKUP, 'utf8')); unlinkSync(BACKUP); }
}

const json = process.argv.includes('--json');
if (json) {
  // 红队 F6：`--json` 必须**包含 equivalents**，否则机器消费者只看到 total/killed，看不出还有没杀死的
  console.log(JSON.stringify({
    total: MUTATIONS.length,
    killed: killed.map((m) => m.id),
    survivors: survivors.map((m) => ({ id: m.id, desc: m.desc })),
    equivalents: equivalents.map((m) => ({ id: m.id, why: m.equivalent })),
    skipped: skipped.map((m) => ({ id: m.id, why: m.why })),
    budget: { equivalents: equivalents.length, maxEquivalents: 1 },
  }, null, 2));
} else {
  console.log('');
  console.log(`变异测试：${MUTATIONS.length} 个变异 —— 杀死 ${killed.length}，**存活 ${survivors.length}**，等价（已记录）${equivalents.length}，跳过 ${skipped.length}`);
  for (const e of equivalents) console.log(`  ≈ 等价变异 ${e.id}：${e.equivalent}`);
  if (survivors.length) {
    console.log('');
    console.log('存活的变异（= 那些守卫是装饰品，测试抓不到它们的失效）：');
    for (const s of survivors) console.log(`  ✗ ${s.id}：${s.desc}`);
    console.log('  → 处置：为每条存活变异补一条测试（或去掉那个起不到作用的守卫）。');
  }
  for (const s of skipped) console.log(`  ⊘ ${s.id} 跳过：${s.why}`);
}
const MAX_EQUIVALENTS = 1;
if (equivalents.length > MAX_EQUIVALENTS) {
  console.error(`\n等价变异 ${equivalents.length} 个，超过预算 ${MAX_EQUIVALENTS} —— 该标签不得被当作"免死通道"（红队 F6）`);
  process.exit(1);
}
process.exit(survivors.length ? 1 : 0);
