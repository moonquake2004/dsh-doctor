Thanks — the analysis holds on the installed build, and we can add a second, much smaller store to it.

**Independent measurement.** Different store, this machine, not the 321 or 124 above. 52 `session.jsonl.zstd` logs under `~/.dsh/sessions`, every one at format `version: 0`. Scan: for each log, `zstd -dc <file>`, JSON-parse every line, track the header generation and each `subagent/descriptor`'s `data.version`. Result: **3 logs** carry a version-2 descriptor and none has a v3 companion.

We then ran the actual installed chain instead of pattern-matching. Feeding each log through `sessionFormatCatalog.createRestore` (session-format packages 0.1.5-rc.2, harness `@deepseek-ai/dsh` 0.1.5-rc.1) with `validation: "current"` and `recovery: "strict"` gives 39 restored, 13 refused, 0 other — and exactly those 3 fail with `subagent/descriptor 0 uses unsupported descriptor version 2`. The static scan and the real restore agree.

Two additions.

**The refusal is genuinely side-effect-free.** After the in-memory run, all three artifacts still carry their original bytes and mtimes, and no `.v3` or temp file appeared. `readHeader` returns `migration-required` with a `cwd`, which is precisely why they list and then fail on open.

**The v2→v3 source-kind whitelist is not what stops them, and it does not cover `session/title`.** `assertSource` is called at only three sites: `user/message` (line 98), `assistant/message`/`tool/result` (line 99), and the message arrays of `agent/inbox/spliced`/`session/title-llm-request` (line 107). A `session/title` event's own `source` never reaches it. Our store has 49 logs with `session/title` source kind `fallback` and 22 with `provider` — neither is among the 15 `SOURCE_KINDS` — and 36 of those logs restore cleanly. So title sources are not refused; that seems worth stating before #6311 gets read into #6045.

One caution for anyone scanning their own store: on ours the descriptor gate was not the only refusal. 10 of the 13 are `permission/preset 0 data has unexpected member "origin"` (the #5978 shape) — a separate fail-closed rule in the same chain.

This whole class is offline-detectable before anything is opened, which is why we're landing S12 in dsh-doctor: it reads the refusal rules out of the installed migration packages and reports affected logs up front — `dsh-doctor --session <path>` for one log, a full run for the store.
