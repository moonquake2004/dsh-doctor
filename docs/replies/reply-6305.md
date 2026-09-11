Status: **DRAFT — awaiting user approval. NOT posted.**

---

# Reply draft — deepseek-harness #6305

Target: https://github.com/deepseek-ai/deepseek-harness/discussions/6305
（线程为中文，故用中文回复）

---

截图里 `dsh --version` 同样没有任何输出，这点最关键：node-pty、`.env`、端口、bundle 等启动期故障都会报错或打堆栈，不会连 `--version` 都静默，所以先怀疑 CLI 入口根本没执行。

最可能的原因：入口 `lib/bin.js` 末尾是 `if (import.meta.main) await runCli();`，而 `import.meta.main` 只有 Node v22.18.0 起才存在（Node 20 全系、22.0–22.17、23.x 上是 `undefined`）→ 整个 CLI 静默退出、退出码 0、所有子命令都无输出；而发布包没有 `engines` 字段，npm 不会警告或拒绝安装。我用发布版 `lib/bin.js` 在本机实测复现：Node 20.20.2 与 22.17.0 下 `--version`、`--help` 均无输出、退出码 0；Node 24.20 正常。这只是分诊假设，需要你的 `node -v` 才能定论。

请按顺序跑，每条都产出证据：

1. `node -v` —— 小于 22.18 或为 23.x，就先升到 22.18+ / 24 LTS 再试。
2. `dsh --version`，紧接 `echo %ERRORLEVEL%`。
3. `npm root -g`，然后 `node "<该路径>\@deepseek-ai\dsh\lib\bin.js" --version` —— 绕过 `.cmd` shim，区分 shim 损坏与 Node 太旧。
4. `where dsh` —— 确认 PATH 上的 dsh 就是你刚装的，而非旧的 npx 缓存残留。
5. 若 `--version` 有输出但 `web` 没有：`dsh web --dump-config`（只打印配置树并退出，不起服务）与 `dsh web --port 0`。

对应我们的检查（dsh-doctor）：E3-node 比对你 PATH 上的 node 与 `^22.19.0 || >=24.0.0`，会最先红；E1-node 查 node 在 PATH，E7 查 dsh 在 PATH。若 `--version` 正常而 web 起不来，再看 E4（node-pty 原生二进制）、E2（`.env` 被建成目录）、E10（3080 端口占用）、P7（cordis.patch.yml 结构）、P1/P11（bundle 或 main 入口缺失）、E6（npx / 全局 / profile 三种布局定位）。

把这些贴回来就能定论：`node -v`、`npm -v`、`where dsh`、`npm root -g`、第 2 步的输出与退出码、第 3 步的输出，以及 `npx @moonquake2004/dsh-doctor --env --json` 的结果。
