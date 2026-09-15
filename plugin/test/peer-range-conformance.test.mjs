/**
 * P19 的版本判定：与参考实现的一致性回归。
 *
 * 规则来自 ciceroyang/dsh-doctor `docs/host-peer-declarations.md` 与其实现在
 * `scripts/range-difftest.mjs` 里的差分测试（外部验收）。2026-09-15 我们跑他的 harness：
 *   13 条边界语料 → 0 分歧；完整生态语料（1639 条声明 / 305 仓库）→ 0 分歧
 * （修复前是 58 处分歧，全部落在他点名的四个角落）。
 *
 * 本测试**直接从已发布源码里抽取函数**来跑，而不是重新实现一份 —— 否则测的是测试自己。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-doctor.mjs');

/** 从 CLI 源码中抽取版本判定这一段的实现（与外部差分测试用的是同一段代码）。 */
function loadPeerRangeState() {
  const src = readFileSync(CLI, 'utf8');
  const m = src.match(/function parseVer[\s\S]*?function peerRangeState[\s\S]*?\n}/);
  assert.ok(m, '未能从源码中抽取 peerRangeState（函数被改名或重构了？）');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${m[0]}\nreturn peerRangeState;`);
  return factory();
}

const peerRangeState = loadPeerRangeState();

/** 参考实现的边界语料与其判定（取自其 range-difftest.mjs 的 EDGE_CASES 语料）。 */
const EDGE_CASES = [
  ['>=0.1.0-rc.5 <0.2.0', '0.1.5-rc.2', 'satisfied'],
  ['>=0.1.0-rc.5 <0.1.0-rc.7', '0.1.5-rc.2', 'unsatisfied'],
  ['>=4.0.0', '4.1.0-rc.1', 'unknown'],
  ['>=4.0.0', '3.9.0', 'unsatisfied'],
  ['^1.2.3', '1.2.4-rc.1', 'unknown'],
  ['^1.2.3', '1.4.0', 'satisfied'],
  ['~1.2.3', '1.3.0', 'unsatisfied'],
  ['^0.0.1', '4.0.2', 'unsatisfied'],
  ['^0.0.1', '0.1.5-rc.2', 'unsatisfied'],
  ['>=0.1.0-rc.5 <1', '0.1.5-rc.2', 'satisfied'],
  ['>=4.0.1 <5', '4.0.2', 'satisfied'],
  ['>=1.0.0 <2.0.0 || >=3.0.0', '2.5.0', 'unsatisfied'],
  ['1.2.3', '1.2.3', 'satisfied'],
];

test('P19 判定：参考实现的 13 条边界语料全部一致（外部差分测试 0 分歧的那份）', () => {
  const bad = [];
  for (const [range, installed, want] of EDGE_CASES) {
    const got = peerRangeState(installed, range).state;
    if (got !== want) bad.push(`${range} vs ${installed}: got ${got}, want ${want}`);
  }
  assert.deepEqual(bad, [], `与参考实现不一致：\n  ${bad.join('\n  ')}`);
});

test('P19 判定：四个"角落"逐条钉住（我们曾在这里与参考实现分歧 58 次）', () => {
  // ① 预发布感知的组：数值判定才是对的（strict semver 会误报健康声明）
  assert.equal(peerRangeState('0.1.5-rc.2', '>=0.1.0-rc.5 <0.2.0').state, 'satisfied');
  // ② ^0.0.1 不得因预发布而降级为未知——它是真的越界
  assert.equal(peerRangeState('0.1.5-rc.2', '^0.0.1').state, 'unsatisfied');
  // ③ 纯 release 组面对预发布安装版本 → 未知（不猜）
  assert.equal(peerRangeState('4.1.0-rc.1', '>=4.0.0').state, 'unknown');
  // ④ 部分版本必须可解析（缺失段补 0）
  assert.equal(peerRangeState('0.1.5-rc.2', '>=0.1.0-rc.5 <1').state, 'satisfied');
  assert.equal(peerRangeState('4.0.2', '>=4.0.1 <5').state, 'satisfied');
});

test('P19 判定：未知的三种来源都不得折叠成确定态', () => {
  assert.equal(peerRangeState('1.0.0', '*').state, 'unknown', '通配 = 无信息');
  assert.equal(peerRangeState('1.0.0', 'not-a-range').state, 'unknown', '不可解析 = 未知');
  assert.equal(peerRangeState('1.2.4-rc.1', '^1.2.3').state, 'unknown', '数值满足但组非预发布感知 = 未知');
  // 反例：数值上不满足的预发布版本是真的越界，不得因为带预发布就降级为未知
  assert.equal(peerRangeState('1.0.0-rc.1', '^1.0.0').state, 'unsatisfied', '1.0.0-rc.1 数值上低于 1.0.0');
  assert.equal(peerRangeState('', '^1.0.0').state, 'unknown', '版本缺失 = 未知');
});
