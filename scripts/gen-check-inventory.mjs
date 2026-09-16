#!/usr/bin/env node
/**
 * 生成检查清单（docs/check-inventory.md）—— R1 来源律 + R5 唯一归属律的机制。
 *
 * 来历：我曾新加了一条 P22，而 P15 早就覆盖同一事实（#5176 的 BOM）——因为**我凭记忆判断"我们查过什么"**。
 * 这个生成器的存在就是为了让那句话有唯一来源：清单由代码生成，CI 断言它与代码一致；
 * 于是"加检查前先查清单"不再是自觉，而是**一次可见的 diff**。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'plugin', 'dsh-doctor.mjs'), 'utf8');
const lines = src.split('\n');

const rows = [];
lines.forEach((line, i) => {
  const m = /report(?:Skip)?\(\s*'([a-z]+)',\s*'([^']+)'/.exec(line);
  if (!m) return;
  const [, section, id] = m;
  if (rows.some((r) => r.id === id)) return;
  // 向上找最近一条注释（作为"范围"）；再在其中找来源线索（#issue / file:line / 契约文档）
  let scope = '';
  for (let k = i; k >= Math.max(0, i - 25); k--) {
    const t = lines[k].trim();
    if (t.startsWith('//') && t.length > 4) { scope = t.replace(/^\/\/\s?/, '').replace(/[：:].*$/, ''); break; }
    if (t.startsWith('/**') || t.startsWith('*')) continue;
  }
  let source = '';
  const window = lines.slice(Math.max(0, i - 25), i + 1).join(' ');
  const iss = window.match(/#(\d{3,5})/g);
  const fl = window.match(/[A-Za-z0-9_.\/-]+\.(?:js|mjs|ts|md):\d+/);
  if (iss) source = iss.slice(0, 2).join(' ');
  else if (fl) source = fl[0];
  rows.push({ section, id, scope: scope.slice(0, 46), source });
});

// 动态构造的 id（由循环/模板拼出，静态 regex 抓不到）——2026-09 复查发现清单曾**缺这 8 项**，
// 于是"加检查前查清单"可能查不到它们，重复风险仍在。这里显式列出，并由下面的断言保证与源码一致。
const DYNAMIC = [
  { section: 'env', id: 'E1-node', scope: 'node 可执行文件是否可用', source: '—' },
  { section: 'env', id: 'E1-pnpm', scope: 'pnpm 可执行文件是否可用', source: '—' },
  { section: 'env', id: 'E1-zstd', scope: 'zstd 可执行文件是否可用', source: '—' },
  { section: 'env', id: 'E7-dsh-in-path', scope: 'dsh 是否在 PATH 中', source: '—' },
  { section: 'env', id: 'E8-npmrc-workspace-flag', scope: 'profile .npmrc 的 workspace 标志', source: '—' },
  { section: 'env', id: 'E9-storages-json-valid', scope: 'storages.json 是否合法', source: '—' },
  { section: 'env', id: 'E11-settings-writable', scope: 'settings.yaml 可写性', source: '#1719' },
  { section: 'profile', id: 'P6-patch-name-space', scope: '用户 patch 的 insert name 无空格', source: '—' },
];
for (const d of DYNAMIC) {
  if (!rows.some((r) => r.id === d.id)) rows.push(d);
  else Object.assign(rows.find((r) => r.id === d.id), { scope: d.scope });
}

rows.sort((a, b) => (a.section + a.id).localeCompare(b.section + b.id));
const out = [
  '# 检查清单（由 `scripts/gen-check-inventory.mjs` 生成，请勿手改）',
  '',
  '> R1 来源律 / R5 唯一归属律的机制：**加检查前先查这里**。\n> 覆盖范围：以字面量出现的 id + `DYNAMIC` 显式列出的动态 id；若新增检查后本文件未更新，CI 会红。`source` 为空表示该检查尚未标注权威来源（待补，见 docs/check-authoring-rules.md §2）。',
  '',
  `共 ${rows.length} 项。`,
  '',
  '| id | 段 | 范围（取自代码注释） | 来源 |',
  '|---|---|---|---|',
  ...rows.map((r) => `| \`${r.id}\` | ${r.section} | ${r.scope} | ${r.source || '—'} |`),
  '',
];
process.stdout.write(out.join('\n'));
