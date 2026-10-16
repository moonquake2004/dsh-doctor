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

/**
 * 我们**自己**声明的 host peer 必须接受预发布宿主（2026-10-16）。
 *
 * 事故：`peerDependencies["@deepseek-ai/cordis"] = "^4.0.1"`，而宿主 0.2.1-alpha.2 提供
 * cordis `4.0.5-alpha.1`。按**严格 semver**（pnpm 的口径）不满足 → 安装时打出
 * `missing peer @deepseek-ai/cordis`；用户看到这行会以为插件不兼容。
 * （宿主自己的 `evaluatePluginCompatibility` 用 `includePrerelease: true`，且只核对
 *  `@deepseek-ai/dsh*` 命名空间，故 cordis 不在它的核对范围内 —— 但它仍会误导人。）
 *
 * 这里不从 package.json 之外引入 semver：直接用**本仓库那个经外部差分验证过的**
 * `peerRangeState`（与 P19 同一实现），断言"声明的范围必须同时满足
 *  ① 新宿主线（预发布）  ② 老宿主线（稳定）
 * "。若有人把范围改回 `^4.0.1`，本用例立刻变红。
 */
test('我们自己声明的 peer 必须接受预发布宿主（且不放弃老宿主）', () => {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  const range = pkg.peerDependencies?.['@deepseek-ai/cordis'];
  assert.ok(range, 'package.json 必须声明 @deepseek-ai/cordis 的 peer（它是我们唯一声明的 host 依赖）');
  // ① 新宿主线：0.2.1-alpha.2 提供的是 4.0.5-alpha.1，必须**正面判定为满足**。
  //   注意不能只断言"不是 unsatisfied" —— 我们的实现对"release 组 vs 预发布版本"返回
  //   `unknown`（不猜），于是 `notEqual(..., 'unsatisfied')` 对 `^4.0.1` 也会通过，
  //   守卫就成了摆设（实测：把范围改回 ^4.0.1，弱断言版本仍然全绿）。
  assert.equal(peerRangeState('4.0.5-alpha.1', range).state, 'satisfied',
    `声明的 ${range} 不能正面满足预发布宿主 cordis 4.0.5-alpha.1（安装时会报 missing peer）`);
  // ② 老宿主线：4.0.1（我们最初支持的版本）必须仍然被接受，否则等于把老用户踢掉
  assert.equal(peerRangeState('4.0.1', range).state, 'satisfied',
    `声明的 ${range} 不再接受 cordis 4.0.1 —— 放宽时不得丢掉老宿主`);
});
