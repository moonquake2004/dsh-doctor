/**
 * Layer C 观察者（plugin/observer.mjs）测试
 * 运行：node --test plugin/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROBE_VOCABULARY,
  extractChecks,
  checkStatus,
  checkSection,
  normalizeDetail,
  clusterSignals,
  slugOf,
  draftProposal,
  validateProposal,
  renderLLMPrompt,
  enrichDraft,
  runObserver,
  applyProposals,
  writeLocalOverlay,
  readLocalOverlay,
} from '../observer.mjs';
import { loadCatalog } from '../dsh-doctor.mjs';

function tempDir() { return mkdtempSync(join(tmpdir(), 'dsh-doctor-obs-')); }

const envelopeRun = {
  schema: 'dsh-doctor/v1',
  tool: 'dsh-doctor',
  checks: [
    { name: 'E1', status: 'pass', detail: 'node/pnpm/zstd 在位' },
    { name: 'P5', status: 'fail', detail: 'profile 顶层 @deepseek-ai/* 与框架重复，Symbol 不匹配' },
    { name: 'P5', status: 'fail', detail: 'profile 顶层 @deepseek-ai/* 与框架重复，Symbol 不匹配' },
    { name: 'S11', status: 'warn', detail: '会话超大（53 万事件），物化堆估算 1.2GB' },
    { name: 'E10', status: 'fail', detail: '3080 端口被其他进程占用' },
  ],
};

const plainRun = {
  ok: false,
  checks: [
    { section: 'env', id: 'E1', ok: true, detail: 'ok' },
    { section: 'session', id: 'S1', ok: false, detail: '孤儿 tool_call 无对应 tool 结果' },
  ],
};

/* ---------- 输入形态 ---------- */

test('extractChecks: envelope / plain / 裸数组', () => {
  assert.equal(extractChecks(envelopeRun).length, 5);
  assert.equal(extractChecks(plainRun).length, 2);
  assert.equal(extractChecks([{ id: 'x' }]).length, 1);
  assert.deepEqual(extractChecks({}), []);
  assert.deepEqual(extractChecks(null), []);
});

test('checkStatus / checkSection 双形态', () => {
  assert.equal(checkStatus({ status: 'fail' }), 'fail');
  assert.equal(checkStatus({ status: 'warn' }), 'warn');
  assert.equal(checkStatus({ ok: false }), 'fail');
  assert.equal(checkStatus({ ok: true }), 'pass');
  assert.equal(checkStatus({ status: 'weird' }), 'unknown');
  assert.equal(checkSection({ id: 'E7-x' }), 'env');
  assert.equal(checkSection({ id: 'P5-x' }), 'profile');
  assert.equal(checkSection({ id: 'S11-x' }), 'session');
  assert.equal(checkSection({ id: 'C0-x' }), 'catalog');
  assert.equal(checkSection({ id: 'X1' }), 'env'); // 无法推断 → 默认 env
});

/* ---------- 聚类 ---------- */

test('clusterSignals: 按 (section, 归一化 detail) 合簇，跳过 pass', () => {
  const clusters = clusterSignals(envelopeRun);
  assert.equal(clusters.length, 3); // P5(2 次) / S11(1) / E10(1)，E1 pass 不计
  const p5 = clusters.find((c) => c.section === 'profile');
  assert.equal(p5.count, 2);
  assert.ok(p5.signature.includes('symbol'));
  const s11 = clusters.find((c) => c.section === 'session');
  assert.deepEqual(s11.statuses, ['warn']);
  // plain 形态
  const plain = clusterSignals(plainRun);
  assert.equal(plain.length, 1);
  assert.equal(plain[0].section, 'session');
});

test('normalizeDetail: 小写/折叠空白/去尾标点', () => {
  assert.equal(normalizeDetail('  Port 3080 BUSY.  '), 'port 3080 busy');
  assert.equal(normalizeDetail('a\n\n b'), 'a b');
  assert.equal(normalizeDetail(''), '');
});

test('slugOf: 产出合法 kebab slug', () => {
  assert.equal(slugOf('port 3080 busy by other process'), 'port-3080-busy-by-other');
  assert.equal(slugOf(''), 'signal');
});

/* ---------- 确定性草稿 ---------- */

test('draftProposal: 骨架完整、默认 warn、探测参数为占位', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'session');
  const d = draftProposal(c, []);
  assert.equal(d.section, 'session');
  assert.equal(d.severity, 'warn'); // 安全不变量 2
  assert.equal(d.proposedBy, 'observer');
  assert.equal(d.probe.type, 'text-contains'); // 会话类默认文本模式
  assert.equal(d.probe.pattern, ''); // 参数不全 → 校验会拒绝（留给 LLM/人补全）
  assert.ok(d.id.startsWith('session-'));
});

test('draftProposal: id 与现有清单去重', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'env'); // 详情 "3080 端口被其他进程占用" → slug "3080"
  const d1 = draftProposal(c, ['env-3080-probe']);
  assert.equal(d1.id, 'env-3080-2-probe');
});

/* ---------- 校验 ---------- */

test('validateProposal: 完整合法提案通过', () => {
  const p = {
    id: 'env-test-1', section: 'env', severity: 'warn',
    probe: { type: 'text-contains', path: '{profile}/a', pattern: '^name:', flags: 'm', required: false },
  };
  assert.deepEqual(validateProposal(p, []), { ok: true, errors: [] });
});

test('validateProposal: 词表外 probe.type 拒绝', () => {
  const p = { id: 'x', section: 'env', severity: 'warn', probe: { type: 'exec-rm-rf' } };
  const v = validateProposal(p, []);
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].includes('词表'));
});

test('validateProposal: 缺必填探测参数拒绝（草稿不可直接应用）', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'env');
  const draft = draftProposal(c, []);
  const v = validateProposal(draft, []);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('pattern') || e.includes('path')));
});

test('validateProposal: severity 非法 / id 重复拒绝', () => {
  const p = { id: 'a', section: 'env', severity: 'critical', probe: { type: 'path-exists', path: '/x' } };
  assert.equal(validateProposal(p, []).ok, false);
  assert.equal(validateProposal({ ...p, severity: 'warn' }, ['a']).ok, false);
});

/* ---------- LLM 富化 ---------- */

test('renderLLMPrompt: 含词表与现有 id 防撞', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'env');
  const prompt = renderLLMPrompt(c, draftProposal(c, []), [{ id: 'E1' }]);
  assert.ok(prompt.includes('text-contains'));
  assert.ok(prompt.includes('E1'));
  assert.ok(prompt.includes('JSON'));
});

test('enrichDraft: 合法回复采纳词表内字段', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'session');
  const draft = draftProposal(c, []);
  const reply = JSON.stringify({
    title: '候选：超大会话物化堆', severity: 'warn',
    probe: { type: 'file-size-above', path: '{home}/sessions/x.jsonl.zst', min: 1e9 },
    detailFail: '会话文件过大', fix: '归档旧会话',
  });
  const out = enrichDraft(draft, reply);
  assert.equal(out.title, '候选：超大会话物化堆');
  assert.equal(out.probe.type, 'file-size-above');
  assert.equal(out.probe.min, 1e9);
  assert.equal(out.fix, '归档旧会话');
  assert.ok(!out.llm);
});

test('enrichDraft: 非 JSON / 词表外 probe / 非法 severity → 回退草稿', () => {
  const c = clusterSignals(envelopeRun).find((x) => x.section === 'env');
  const draft = draftProposal(c, []);
  assert.equal(draft.probe.type, 'path-exists'); // 端口信号 → path-exists 提示
  assert.ok(enrichDraft(draft, 'not json').llm.includes('非 JSON'));
  const badProbe = enrichDraft(draft, JSON.stringify({ probe: { type: 'exec' } }));
  assert.ok(badProbe.llm.includes('词表'));
  assert.equal(badProbe.probe.type, 'path-exists'); // 回退原草稿
  const badSev = enrichDraft(draft, JSON.stringify({ severity: 'fatal' }));
  assert.ok(badSev.llm.includes('severity'));
  assert.equal(badSev.severity, 'warn');
});

/* ---------- 观察入口 ---------- */

test('runObserver: 无 LLM → 确定性草稿 + prompt 数据', async () => {
  const res = await runObserver({ input: envelopeRun, existingChecks: [] });
  assert.equal(res.signals, 4);
  assert.equal(res.proposals.length, 3);
  assert.ok(res.proposals[0].prompt.includes('JSON'));
});

test('runObserver: LLM stub 命令富化提案', async () => {
  const stub = 'node -e "process.stdin.resume();process.stdin.on(\'end\',()=>process.stdout.write(JSON.stringify({title:\'t\',severity:\'warn\',probe:{type:\'path-is-file\',path:\'{profile}/x\'}})))"';
  const res = await runObserver({ input: envelopeRun, existingChecks: [], llmCmd: stub });
  const p = res.proposals.find((x) => x.section === 'env');
  assert.equal(p.title, 't');
  assert.equal(p.probe.type, 'path-is-file');
  assert.ok(p.probe.path.includes('{profile}'));
});

test('runObserver: 目录输入聚合所有 JSON', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'a.json'), JSON.stringify(envelopeRun));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(plainRun));
  writeFileSync(join(dir, 'bad.json'), '{broken');
  const res = await runObserver({ path: dir, existingChecks: [] });
  assert.equal(res.signals, 5); // 4 + 1（b.json 的 S1）
  rmSync(dir, { recursive: true, force: true });
});

/* ---------- 应用合并 ---------- */

test('applyProposals: 只合并校验通过的提案，非法带原因拒绝', () => {
  const good = {
    id: 'env-g1', section: 'env', severity: 'warn',
    probe: { type: 'path-exists', path: '{profile}/a' },
  };
  const bad = {
    id: 'env-b1', section: 'env', severity: 'warn',
    probe: { type: 'text-contains', path: '', pattern: '' },
  };
  const { catalog, applied, rejected } = applyProposals({ schemaVersion: 1, checks: [{ id: 'E1' }] }, [good, bad]);
  assert.deepEqual(applied.map((p) => p.id), ['env-g1']);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].errors.some((e) => e.includes('pattern')));
  assert.equal(catalog.checks.length, 2);
});

test('applyProposals: id 与已合并提案去重', () => {
  const dup = { id: 'x', section: 'env', severity: 'warn', probe: { type: 'path-exists', path: '/a' } };
  const r1 = applyProposals({ checks: [] }, [dup]);
  const r2 = applyProposals({ checks: r1.catalog.checks }, [dup]);
  assert.equal(r2.applied.length, 0);
  assert.ok(r2.rejected[0].errors.some((e) => e.includes('重复')));
});

test('writeLocalOverlay / readLocalOverlay 往返', () => {
  const dir = tempDir();
  const p = join(dir, 'checks.local.json');
  const catalog = { schemaVersion: 1, checks: [{ id: 'z', section: 'env', severity: 'warn', probe: { type: 'path-exists', path: '/a' } }] };
  writeLocalOverlay(p, catalog);
  assert.equal(readLocalOverlay(p).length, 1);
  assert.deepEqual(readLocalOverlay(join(dir, 'nope.json')), []);
  rmSync(dir, { recursive: true, force: true });
});

/* ---------- loadCatalog 本地覆盖层合并 ---------- */

test('loadCatalog: 存在本地覆盖层时合并（bundled+local）', async () => {
  const dir = tempDir();
  const overlay = join(dir, 'checks.local.json');
  writeLocalOverlay(overlay, { schemaVersion: 1, checks: [{ id: 'LOCAL-1', section: 'env', severity: 'warn', probe: { type: 'path-exists', path: '/tmp' } }] });
  const res = await loadCatalog({ noRemote: true, localPath: overlay, home: join(dir, 'home') });
  assert.equal(res.source, 'bundled+local');
  assert.ok(res.checks.some((c) => c.id === 'LOCAL-1'));
  assert.ok(res.checks.some((c) => c.id === 'E7-dsh-in-path'));
  rmSync(dir, { recursive: true, force: true });
});

test('loadCatalog: 无本地覆盖层时行为不变', async () => {
  const res = await loadCatalog({ noRemote: true, localPath: join(tmpdir(), 'dsh-doctor-nonexist.json') });
  assert.equal(res.source, 'bundled');
});

test('PROBE_VOCABULARY: 覆盖引擎全部只读原语', () => {
  for (const t of ['command-exists', 'path-exists', 'path-is-dir', 'path-is-file', 'json-valid', 'text-contains', 'text-not-contains', 'file-size-above', 'glob-count', 'file-writable']) {
    assert.ok(PROBE_VOCABULARY[t], `缺少 ${t}`);
  }
});
