# Reply — deepseek-harness #6305 (posted)

Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/6305#discussioncomment-18402305

---

这个症状很可能不是安装损坏，而是 **Node 版本**问题：`dsh` 的入口被 `if (import.meta.main) await runCli();` 门控，而 `import.meta.main` 只有 **Node v22.18+**（或 v24.2+）才有——旧版本上它恒为 `undefined`，于是**所有命令（含 `--version`）零输出、退出码 0**，装完看起来完全正常。

先跑这两条确认：

```bash
node -v                 # 是否 < 22.18（含 23.x）
dsh --version; echo $?  # 是否空输出且退出码 0
```

若是，升到 **Node 22.18+ / 24 LTS** 即可，不必重装 dsh。完整机制、Node 20/22/24 实测对照与上游建议（补 `engines`、入口不依赖 `import.meta.main`）见 **#6341**：https://github.com/deepseek-ai/deepseek-harness/discussions/6341

另外可以离线自查环境：`npx @moonquake2004/dsh-doctor --env --json`——其中 **E3-node** 会直接比对 PATH 上的 node 与 `^22.19.0 || >=24.0.0` 并最先报红。

若 `--version` 有输出但 `dsh web` 起不来，那是另一类问题（node-pty 原生二进制 / `.env` 被建成目录 / 端口占用 / bundle 与 patch），把 `dsh web --dump-config` 和 `dsh web --port 0` 的输出贴上来即可继续定位。
