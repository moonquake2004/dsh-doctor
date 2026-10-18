/**
 * regression-0.8.10.test.mjs —— S1 / E9 / E4 三条修复的**对抗性回归用例**
 *
 * 本项目纪律：没有测试的修复会消失。本文件把 0.8.10 修的三条缺陷各自钉死，
 * 并且**两个方向都测**（既防假阳、也防假阴），断言一律是「确切状态」，
 * 不写 `notEqual(status,'fail')` 这种装饰性守卫——那种写法在 skip 变成 fail、
 * 或 pass 变成 skip 时都不会红，等于没测。
 *
 * 三条缺陷（均为 0.8.9 及以前版本的实际行为，已在 /tmp 副本上实测复现）：
 *
 *   1. **S1 孤儿 tool_call 假阳性**：宿主 0.2.x 把工具结果写成**独立的 `tool/result` 行**，
 *      而旧实现只认 assistant 消息里内联的 `type:'tool-result'` 块 → 健康会话的每个
 *      tool_call 都被判成"孤儿"，还会建议"新建会话"（实测 35/35 假阳）。
 *      修复后：独立 `tool/result` 行（两种 id 形状都要认）→ S1 必须 **pass**；
 *      真正没有结果的历史 → S1 必须 **fail**（防止修成"永远 pass"的哑巴）。
 *
 *   2. **E9 查错路径**：E9 名为 storages 检查，却去查 `{home}/config/workspace.json`——
 *      该文件在真实 DSH 家目录里**根本不存在**（真实路径是 `{home}/storages/workspace.json`）。
 *      旧行为最坏的一面是：合成 HOME 里放一个**合法**的 storages/workspace.json，
 *      它因为查不到 config/ 而报 skip，detail 却写着"…为合法 JSON"——**缺文件却说合法**。
 *      修复后：合法 → pass；损坏 → **fail**；不存在 → 见下方 E9 决策注释。
 *
 *   3. **E4 无安装树判据**：E4 的判据曾是 `PATH 里找到 dsh 的 node_modules || profiles/web/node_modules 存在`。
 *      空目录 `profiles/web/node_modules` 于是被当成"有安装树"，接着找不到 node-pty 就报
 *      **fail**——合成 HOME / 干净容器里得到无意义的失败（CI 三次红都源于此类）。
 *      修复后：无安装树 → **skip**；有 node-pty 但缺原生二进制 → **fail**（不适用 ≠ 通过）。
 *
 * 运行：
 *   node --test plugin/test/regression-0.8.10.test.mjs
 *   （整目录：node --test plugin/test/ —— 注意本文件不比 fixtures.mjs 慢，它只跑 3 类场景）
 *
 * ⚠️ **受控 PATH（本文件的关键测试纪律）**
 *   E4 会通过 `hostInstallRoot()` 从 **PATH** 里找已安装的 dsh。本机 `/opt/homebrew/bin/dsh`
 *   是真实安装 → 任何继承真实 PATH 的合成 HOME 用例都会被它"救活"，空 node_modules 也报
 *   "node-pty 原生模块在位"。实测过：默认 PATH 下 E4 的三个变体**全部 pass**，用例全绿但毫无意义。
 *   所以本文件所有 CLI 调用都显式传 `CTRL_PATH`（只有 node 自身目录 + /usr/bin + /bin，含 node
 *   但**不含任何带 dsh 的目录**）。写新的 env 段用例时请照抄这一条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh-doctor.mjs');

/**
 * 受控 PATH：`node` 在（否则 E1-node 红、更糟的是 S11 等依赖 node 的路径行为漂移），
 * `dsh` **不在**（否则 E4 的 hostInstallRoot() 会捡起本机真实安装，把合成 HOME 的断言全部污染）。
 * 不用空 PATH：那会让 E1-node 变成 failed，而 `--session` 收窄不会跳过 env 段。
 */
const CTRL_PATH = [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);

/* ---------- harness（照 fixtures.mjs 的风格最小化自建） ---------- */

/** 合成 HOME：只有 profiles/web + .npmrc（P 组与 E8 需要），**不含**任何 node_modules / storages。 */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-doctor-reg-'));
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'web', '.npmrc'), 'ignore-workspace-root-check=true\n');
  return home;
}

/**
 * 跑 CLI（--json --no-catalog），返回 checks 数组。
 * 断言 CLI 有输出：否则一个 `JSON.parse(undefined)` 会伪装成"测试通过"。
 */
function runCli({ home, args = [], extraPathDirs = [] }) {
  const path = [...extraPathDirs, CTRL_PATH].join(delimiter);
  const r = spawnSync(process.execPath, [CLI, '--json', '--no-catalog', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, PATH: path },
    timeout: 60000,
  });
  assert.ok(r.stdout, `CLI 无输出（stderr: ${String(r.stderr).slice(0, 400)}）`);
  return JSON.parse(r.stdout).checks;
}

/** 取某条检查的 { id, status, detail }；缺失即测试失败（"检查没跑" 不能被当成通过）。 */
function checkOf(checks, id) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `检查 ${id} 未出现在输出里（实际有: ${checks.map((x) => x.id).join(', ')}）`);
  return c;
}

/** 造会话日志：首行**必须是真实会话头**（#6651），否则 S13 会正确报错、把用例的焦点搅乱。 */
function sessionFixture(home, name, lines) {
  const dir = join(home, 'sessions', name);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: 'session', version: 3, id: name, createdAt: Date.now(),
    cwd: '/tmp', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  };
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/* ---------- 会话行形状（照宿主 0.2.x 的真实写法） ---------- */

const R = {
  user: (seq, turn, text = 'hi') => ({ type: 'user/message', seq, turn, data: { message: { content: [{ type: 'text', text }] } } }),
  turnStart: (seq, turn) => ({ type: 'turn/start', seq, turn }),
  turnEnd: (seq, turn) => ({ type: 'turn/end', seq, turn }),
  assistantWithCall: (seq, turn, callId) => ({
    type: 'assistant/message', seq, turn,
    data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'demo', arguments: '{}' }] } },
  }),
  /** 形状 A：结果行同时带顶层 `data.toolCallId` 与 `data.message.source.callId`（宿主实际写法）。 */
  toolResultWithToolCallId: (seq, turn, callId) => ({
    type: 'tool/result', seq, turn,
    data: {
      turn, step: 1, toolCallId: callId,
      message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'ok' }] },
    },
  }),
  /** 形状 B：结果行**只**在 `data.message.source.callId` 上带 id（没有 data.toolCallId）。 */
  toolResultWithSourceCallId: (seq, turn, callId) => ({
    type: 'tool/result', seq, turn,
    data: {
      turn, step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] },
    },
  }),
  /** 独立 `tool/call` 行：宿主 0.2.x 在 assistant/message 之后另起一行记录同一个调用。 */
  toolCallRow: (seq, turn, callId) => ({
    type: 'tool/call', seq, turn,
    data: { turn, step: 1, callId, name: 'demo', arguments: '{}' },
  }),
  seed: (seq) => ({ type: 'session/end-seed', seq }),
};

/** 对某会话跑 S1 专项（--session 收窄），返回 S1 记录。 */
function s1Of(home, sessionFile) {
  return checkOf(runCli({ home, args: ['--session', sessionFile] }), 'S1');
}

/* ================= 1. S1：独立 tool/result 行 ================= */

test('S1 回归：call + 独立 tool/result 行（data.toolCallId 形状）→ pass', () => {
  const home = tempHome();
  // call 在 seq2，结果在 seq3，turn 闭合于 seq4，种子 seq5 → call 绝非尾部 in-flight
  const f = sessionFixture(home, 's1-toolcallid', [
    R.user(0, 1), R.turnStart(1, 1),
    R.assistantWithCall(2, 1, 'call-A'),
    R.toolResultWithToolCallId(3, 1, 'call-A'),
    R.turnEnd(4, 1), R.seed(5),
  ]);
  const s1 = s1Of(home, f);
  // 确切状态：旧实现（只认内联 tool-result 块）在这里报 fail —— 这是本用例存在的理由
  assert.equal(s1.status, 'pass', `结果行在（data.toolCallId 形状），S1 不得报孤儿: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('S1 回归：call + 独立 tool/result 行（仅 data.message.source.callId 形状）→ pass', () => {
  const home = tempHome();
  const f = sessionFixture(home, 's1-source-callid', [
    R.user(0, 1), R.turnStart(1, 1),
    R.assistantWithCall(2, 1, 'call-B'),
    R.toolResultWithSourceCallId(3, 1, 'call-B'),
    R.turnEnd(4, 1), R.seed(5),
  ]);
  const s1 = s1Of(home, f);
  // 这一条单独成例：只认 data.toolCallId 的修复会在这种形状上退化成假阳
  assert.equal(s1.status, 'pass', `结果行在（仅 source.callId 形状），S1 不得报孤儿: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('S1 回归：真正缺结果的历史 → fail（且报出那个 call 的 id）', () => {
  const home = tempHome();
  // 两个 call：c1 有结果（走独立行）、orphan-X 没有任何结果 → 只应报 orphan-X
  const f = sessionFixture(home, 's1-orphan', [
    R.user(0, 1), R.turnStart(1, 1),
    R.assistantWithCall(2, 1, 'c1'),
    R.toolResultWithToolCallId(3, 1, 'c1'),
    R.assistantWithCall(4, 1, 'orphan-X'),   // ← 没有结果行
    R.turnEnd(5, 1), R.seed(6),
  ]);
  const s1 = s1Of(home, f);
  // 反向防假阴：修 S1 时最容易顺手把它改成"永不报 orphan"——那样这条会绿，是哑巴修复
  assert.equal(s1.status, 'fail', `缺结果必须仍然报孤儿: ${s1.detail}`);
  assert.match(s1.detail, /orphan-X/, `detail 应点名缺结果的 call: ${s1.detail}`);
  // 已有结果的 c1 不该被误报（确认不是"见到 tool/result 行就整体 pass"之外的另一种粗暴解除）
  assert.doesNotMatch(s1.detail, /\bc1\b/, `c1 有结果，不该出现在孤儿列表里: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('S1 回归：同一 call 被 inline 与独立行各记一次 → 仍判为孤儿（双重收集不得互相覆盖成"无孤儿"）', () => {
  const home = tempHome();
  // 宿主真实写法：assistant/message 内联 tool-call（seq 2），紧随其后一行独立 tool/call（seq 3），
  // 但**没有** result —— 两条收集路径都会记到同一个 id。
  //
  // 本用例锁定的是**双重收集不产生错误结论**（该报的孤儿照报、不该因被记两次就"消失"）。
  // 诚实标注：它**不**区分 "取最早 seq(min)" 与 "后写入覆盖" 两种实现——实测两者在真实行距下
  // 结论相同（阈值留有余量），我构造临界用例也跑不出差异。因此不要把它当作 min 逻辑的守卫。
  // 保留它的价值是防止以后的改动把双重收集写坏（例如 set 变成 push 导致重复 id 进孤儿列表）。
  const f = sessionFixture(home, 's1-double-collect', [
    R.user(0, 1), R.turnStart(1, 1),
    R.assistantWithCall(2, 1, 'dup-call'),
    R.toolCallRow(3, 1, 'dup-call'),          // ← 同一个 id 第二次被收集
    R.turnEnd(4, 1),
    R.user(5, 2), R.turnStart(6, 2),
    R.assistantWithCall(7, 2, 'late-call'),
    R.toolCallRow(8, 2, 'late-call'),
    R.turnEnd(9, 2), R.seed(10),
  ]);
  const s1 = s1Of(home, f);
  assert.equal(s1.status, 'fail', `两条 call 都没有结果，必须报孤儿: ${s1.detail}`);
  assert.match(s1.detail, /dup-call/, `早期的那条必须被判为真孤儿（不得因 seq 被推大而当成尾部 in-flight）: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

/* ---------- R1（红队 0.8.10）：独立 `tool/call` 行的收集（此前零覆盖） ----------
 *
 * 【红队的证据】在副本里把 `if (d.type === 'tool/call') { … }` 整段删掉，**全套 241 项仍全绿**。
 * 也就是说这段代码删了没人知道 —— 而上一条"双重收集"用例救不了它：那条里的 call
 * 同时还有 assistant 内联块，删掉独立行分支后内联块照样把 id 收进 calls，结论不变。
 *
 * 所以下面这两条**必须完全没有 assistant 内联 tool-call 块**，让 `tool/call` 行成为
 * 该 call 唯一的来源；否则删掉分支后依然绿，等于没测（这正是红队证明的失效模式）。
 */

test('R1 回归：只有独立 tool/call 行、没有 result → S1 必须 fail（删掉该分支就会漏报）', () => {
  const home = tempHome();
  // 注意 seq 布局：真孤儿判据是 `o.seq < maxSeq - 1`。
  // call 在 seq2、maxSeq=6 → 2 < 5 成立，才不会被当成"尾部 in-flight"而放过。
  const f = sessionFixture(home, 'r1-tool-call-only', [
    R.user(0, 1), R.turnStart(1, 1),
    R.toolCallRow(2, 1, 'solo-call'),        // ← 唯一来源：没有 assistant 内联块
    R.turnEnd(3, 1),
    R.user(4, 2), R.turnStart(5, 2),
    R.turnEnd(6, 2),
    R.seed(7),
  ]);
  const s1 = s1Of(home, f);
  assert.equal(s1.status, 'fail', `独立 tool/call 行也必须被收集，缺 result 即孤儿: ${s1.detail}`);
  assert.match(s1.detail, /solo-call/, `detail 必须点名那个 callId: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('R1 回归：只有独立 tool/call 行 + 对应 tool/result → S1 必须 pass（证明不是"一律 fail"）', () => {
  const home = tempHome();
  // 与上一条**只差**一条 result 行：若 S1 被改成"见到 tool/call 就 fail"，本用例即红。
  const f = sessionFixture(home, 'r1-tool-call-with-result', [
    R.user(0, 1), R.turnStart(1, 1),
    R.toolCallRow(2, 1, 'solo-call'),        // 唯一来源：没有 assistant 内联块
    R.toolResultWithToolCallId(3, 1, 'solo-call'),
    R.turnEnd(4, 1),
    R.user(5, 2), R.turnStart(6, 2),
    R.turnEnd(7, 2),
    R.seed(8),
  ]);
  const s1 = s1Of(home, f);
  assert.equal(s1.status, 'pass', `独立 tool/call 行有对应 result，不得报孤儿: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

/* ---------- R4（红队 0.8.10）：rememberCall 的 min 与"后写入覆盖"**有区分度** ----------
 *
 * 【为什么必须隔 3 个 seq】真孤儿判据是 `o.seq < maxSeq - 1`（见 dsh-doctor.mjs 的 real/inflight 分流）。
 * 这个构造是：
 *     内联 assistant 块 seq = 8
 *     独立 tool/call 行 seq = 11
 *     maxSeq            = 12   ⇒   阈值 = 12 - 1 = 11
 * 于是：
 *     取 min（现实现）    → calls.seq = 8  → 8 < 11 → **真孤儿 → fail**（正确，会报 #1363）
 *     后写入覆盖（错实现）→ calls.seq = 11 → 11 < 11 不成立 → 归"尾部 in-flight" → **pass（漏报！）**
 * 两者结论**不同**，所以本用例有区分度。
 *
 * ⚠️ 前车之鉴：Lead 先按"inline 与独立行相邻"（seq 差 1）构造过一版，回退成后写覆盖后**仍然绿**——
 * 因为 8 与 9 都 < 11，阈值余量把差异吃掉了。**不要把它改成相邻布局**，那样就退回成装饰性用例。
 *
 * 另一条「同一 call 被 inline 与独立行各记一次」只锁定"双重收集不产生错误结论"，**不**守 min；
 * 守 min 的是下面这一条。
 */

test('R4 回归：min 与后写覆盖有区分度 —— inline seq=8 / 独立行 seq=11 / maxSeq=12 → 必须 fail', () => {
  const home = tempHome();
  // seq 2..7 用无害的 user/message 填充，把两个记录点撑开到上面的布局（同时保持 seq==index 连续，S6 不受影响）
  const pad = [];
  for (let i = 2; i <= 7; i++) pad.push(R.user(i, 1, 'pad'));
  const f = sessionFixture(home, 'r4-min-vs-lastwrite', [
    R.user(0, 1), R.turnStart(1, 1),
    ...pad,
    R.assistantWithCall(8, 1, 'min-call'),   // 第一次收集：seq 8
    R.user(9, 1, 'pad'),
    R.user(10, 1, 'pad'),
    R.toolCallRow(11, 1, 'min-call'),        // 第二次收集：seq 11（后写覆盖会用它 → 漏报）
    R.turnEnd(12, 1),                        // maxSeq = 12，阈值 = 11
  ]);
  const s1 = s1Of(home, f);
  // 没有 result + 取 min(8) 落在阈值内 ⇒ 必须报真孤儿。
  // 若实现改成"后写入覆盖"(11)，本断言会失败（status 变 pass）——这正是我们要的区分度。
  assert.equal(s1.status, 'fail', `取 min 才能抓到该孤儿；若变 pass 说明退化成"后写覆盖"且漏报: ${s1.detail}`);
  assert.match(s1.detail, /min-call/, `detail 必须点名该 callId: ${s1.detail}`);
  rmSync(home, { recursive: true, force: true });
});

/* ================= 2. E9：storages/workspace.json ================= */

/*
 * E9 断言方法论（对抗自检的教训 + Lead 的去重决定，别退回去）：
 *   ① detail 是**目录里的固定文案**（detailOk/detailFail），无论实际读的是哪个路径都会印
 *      "storages/workspace.json"，所以 `assert.match(detail, /storages/)` 是**装饰性守卫**——
 *      第一版写了，回退路径后它照样绿。detail 只用来验「skip 不得说合法」这类**文案内容**。
 *   ② **损坏**场景不断言 E9（Lead 决定：E9 与 E5 查同一文件，E9 可能降为 warn 或整个删除），
 *      锚点放在 **E5 必须 fail** 上——那是 #1357 的权威检查，不随 E9 的去留漂移。
 *   ③ 路径正确性用**交叉污染**钉死：错路径 config/ 与对路径 storages/ 放不同内容，
 *      两个方向各测一次，E5 的判定只能跟 storages/ 走。
 */

test('E9 回归：storages/workspace.json 合法 → pass（不得因查错路径而 skip）', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ workspaces: [{ path: '/tmp' }] }));
  const e9 = checkOf(runCli({ home }), 'E9-storages-json-valid');
  // 旧实现：去查 {home}/config/workspace.json（不存在）→ skip，detail 却写「…为合法 JSON」。
  // 既漏报（真文件从没被解析）又说了假话。这里断言 pass = 它真的读到了 storages 那个文件。
  assert.equal(e9.status, 'pass', `storages/workspace.json 合法时必须 pass: ${e9.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('storages/workspace.json 损坏 → E5 必须 fail（E9 的去留不参与断言）', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '{oops');
  const checks = runCli({ home });
  // 锚点选 E5 而非 E9：E9 是 E5 的"定点版"，两者查同一个文件，
  // Lead 已让 fixer 评估去重（E9 可能降为 warn 或删除）。把断言压在 E9 的 fail 上，
  // 去重落地时这条会莫名其妙变红——那是测试绑定了正在变动的实现细节。
  const e5 = checkOf(checks, 'E5');
  assert.equal(e5.status, 'fail', `损坏的 storages 文件必须被 E5 抓到: ${e5.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('E9 去重回归：workspace.json 损坏时 E5 = fail、E9 = warn（防止 E9 被改回 error 重复报警）', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '{oops');
  const checks = runCli({ home });
  // 【来历】0.8.10 的 E9 曾是 severity:error，和内置 E5 查同一个文件 →
  // fixtures.mjs 的 `assertIsolated` 要求"除 E5 外不得有 error 级失败"，于是 E5 语料
  // 因 **E9 重复报警** 变红（实测：HEAD 纯 0.8.9 是 137 pass/0 fail，加了 E9 改动后 1 fail）。
  // 去重方案 A：E9 降为 warn（不翻退出码、不触发 error 级隔离判定），判定权归 E5。
  // 这条用例钉死"降级"这个决策本身——谁把 E9 改回 error，这里立刻红。
  const e5 = checkOf(checks, 'E5');
  assert.equal(e5.status, 'fail', `判定权归 E5，损坏必须 fail: ${e5.detail}`);
  const e9 = checkOf(checks, 'E9-storages-json-valid');
  // 状态层：warn 不是 fail。注意 warn/pass 的区分靠 severity——见下一条目录层断言。
  assert.equal(e9.status, 'warn', `E9 必须保持 warn 级（去重方案 A）: ${e9.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('交叉污染 A —— config/ 合法不能掩盖 storages/ 损坏：E5 fail 且 E9 = warn', () => {
  const home = tempHome();
  // 旧路径上放一个**合法**文件：若 E9 退回查 config/，它会读到合法内容而报 pass。
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'workspace.json'), JSON.stringify({ workspaces: 'legit' }));
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), '{oops');
  const checks = runCli({ home });
  // ① E5 是权威锚点：它直接读 storages/，损坏必须 fail
  const e5 = checkOf(checks, 'E5');
  assert.equal(e5.status, 'fail', `config/ 合法不能掩盖 storages/ 损坏: ${e5.detail}`);
  // ② E9 不得因为"config/ 那个文件是合法的"而报 pass —— 这是路径回退时唯一会露出的破绽。
  //    E9 未来若降为 warn/删除，本断言也应调整；它守的是"E9 不能看错文件"，不是"E9 必须 fail"。
  // 用 checkOf：E9 若被整体删除，这里会明确失败，而不是被 `if (e9)` 静默跳过。
  // 断言写成前向：E9 在这个场景下的确切状态是 warn（损坏）+ severity 已降级，
  // 若路径错查 config/（那个是合法的）→ 它会变成 pass，本条即红。
  const e9 = checkOf(checks, 'E9-storages-json-valid');
  assert.equal(e9.status, 'warn', `storages/ 损坏时 E9 应为 warn（若报 pass 说明它读了 config/ 的合法文件）: ${e9.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('交叉污染 B —— config/ 损坏不能带坏 storages/ 合法：E5 pass 且 E9 不得被带成 fail', () => {
  const home = tempHome();
  // 旧路径上放**损坏**文件：若 E9 退回查 config/，它会读坏内容而报 fail。
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'workspace.json'), '{oops');
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ workspaces: [] }));
  const checks = runCli({ home });
  const e5 = checkOf(checks, 'E5');
  assert.equal(e5.status, 'pass', `旧路径上的坏文件不该把 E5 带成 fail: ${e5.detail}`);
  // E9 若去看 config/，会把那个坏文件当 storages 判定 → fail（或 warn）。这里必须 pass。
  const e9 = checkOf(checks, 'E9-storages-json-valid');
  assert.equal(e9.status, 'pass', `storages/ 合法时 E9 必须 pass（不得读 config/）: ${e9.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('E9 回归：storages/workspace.json 不存在 → skip，且 detail 不得是"合法"这句肯定话', () => {
  const home = tempHome();
  mkdirSync(join(home, 'storages'), { recursive: true });   // 目录在、文件不在
  const e9 = checkOf(runCli({ home }), 'E9-storages-json-valid');
  // 【契约】required:false ⇒ 缺失 = **skip**（"不适用"而非"通过"，见 v1 词汇表 r5/#1719）。
  // 旧版最坏的形态：查的是 config/workspace.json（从不存在），于是**所有**情况下都 skip，
  // detail 却印着「config/workspace.json 为合法 JSON」——缺文件却说合法。
  // 所以这里除了状态，还要钉住"没说谎"：不得出现 detailOk 的肯定句。
  assert.equal(e9.status, 'skip', `required:false 下缺失应 skip: ${e9.detail}`);
  assert.doesNotMatch(e9.detail, /为合法/, `缺文件不得宣称合法（旧版 bug）: ${e9.detail}`);
  // skip 必须带 reason，而不是一句空话。用 detailSkip 的中性措辞做正向锚定
  // （Lead：缺文件时引擎不得再沿用 detailOk 的肯定句——这是"skip 却说合法"的真正修法）。
  assert.match(e9.detail, /无对象可查|跳过|不存在/, `skip 必须说明为何跳过: ${e9.detail}`);
  rmSync(home, { recursive: true, force: true });
});

/* ================= 3. E4：无安装树判据 ================= */

test('E4 回归：合成 HOME 有空的 profiles/web/node_modules、无 node-pty → skip（不是 fail）', () => {
  const home = tempHome();
  mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });  // 目录存在但为空
  const e4 = checkOf(runCli({ home }), 'E4');
  // 旧判据 existsSync(profileNM) 认了这个空目录 → hasInstall=true → 找不到 pty → fail。
  // 空目录不是安装树；这里没有"已安装的 dsh"可言，报 fail 无意义（也不该报 pass）。
  assert.equal(e4.status, 'skip', `空 node_modules 不是安装树，应 skip: ${e4.detail}`);
  assert.match(e4.detail, /未发现 DSH 安装树|不适用|跳过/, `skip 必须带 reason: ${e4.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('E4 回归（R3）：只有空的 node_modules/.bin 与 .pnpm，不得算作安装树 → skip', () => {
  const home = tempHome();
  // 【红队 R3】旧实现只排除"严格空目录"，于是 `.bin/`、`.pnpm/` 这类**空壳子目录**仍让
  // profileHasContent 成立 → 干净环境配 fail。新判据只数"真的装了包"的子目录。
  // 三种空壳各测一遍，任一失效都会让本用例红。
  mkdirSync(join(home, 'profiles', 'web', 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(home, 'profiles', 'web', 'node_modules', '.pnpm'), { recursive: true });
  const e4 = checkOf(runCli({ home }), 'E4');
  assert.equal(e4.status, 'skip', `空 .bin/ 空 .pnpm/ 不是安装树，应 skip: ${e4.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('E4 回归：有 node-pty 但缺原生二进制 → fail（skip 判据不得吞掉真问题）', () => {
  const home = tempHome();
  // 一个"像模像样"的 node-pty：有 package.json，但没有任何 pty.node
  const ptyDir = join(home, 'profiles', 'web', 'node_modules', 'node-pty');
  mkdirSync(ptyDir, { recursive: true });
  writeFileSync(join(ptyDir, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.0.0' }));
  const e4 = checkOf(runCli({ home }), 'E4');
  // 反向防假阴：把 hasInstall 一并放宽成"永远 skip"是最省事的"修复"，
  // 那样 pty.node 缺失这个 #1219 的真问题就再也没人报了。这条用例就是拦它的。
  assert.equal(e4.status, 'fail', `node-pty 在、pty.node 缺，必须 fail: ${e4.detail}`);
  assert.match(e4.detail, /原生二进制/, `detail 应指出缺原生二进制: ${e4.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('E4 回归：PATH 里有 dsh 但 profile 无 node-pty → fail（证明确实装了 dsh 就该报）', () => {
  const home = tempHome();
  // 造一个"PATH 里有 dsh"的最小安装：临时目录 + 一个可执行 dsh 文件。
  // 这是 hasInstall 的新判据之一（pathHasDsh）——它能证明"本机装了 dsh"，
  // 那么找不到 node-pty 就是真问题（#1219），必须 fail 而不是被 skip 吞掉。
  const binDir = mkdtempSync(join(tmpdir(), 'dsh-doctor-fakebin-'));
  writeFileSync(join(binDir, 'dsh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'dsh'), 0o755);
  // profile node_modules 空（没有 node-pty）
  mkdirSync(join(home, 'profiles', 'web', 'node_modules'), { recursive: true });
  const e4 = checkOf(runCli({ home, extraPathDirs: [binDir] }), 'E4');
  assert.equal(e4.status, 'fail', `PATH 有 dsh ⇒ 有安装树 ⇒ 缺 node-pty 必须 fail: ${e4.detail}`);
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

test('E4 回归：node-pty 原生二进制在位 → pass（正向锚点，证明上一条 fail 不是"一律 fail"）', () => {
  const home = tempHome();
  const plat = `${process.platform}-${process.arch}`;
  const prebuild = join(home, 'profiles', 'web', 'node_modules', 'node-pty', 'prebuilds', plat);
  mkdirSync(prebuild, { recursive: true });
  writeFileSync(join(prebuild, 'pty.node'), 'not-a-real-binary-but-non-empty');
  const e4 = checkOf(runCli({ home }), 'E4');
  // 这条不是可有可无的：没有它，E4 被改成"凡见到 node-pty 就 fail"也能让上一条绿
  assert.equal(e4.status, 'pass', `pty.node 在位应 pass: ${e4.detail}`);
  rmSync(home, { recursive: true, force: true });
});
