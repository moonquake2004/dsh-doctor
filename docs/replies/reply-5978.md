# Reply draft — deepseek-harness #5978

Status: **DRAFT — awaiting user approval. NOT posted.**

---

We reproduced the `permission/preset` root cause on the installed build, and we can add an independent store measurement.

**Mechanism, confirmed in the installed source.** On `@deepseek-ai/dsh` 0.1.5-rc.1 with session-format packages 0.1.5-rc.2, `dsh-session-format-v0-to-v1/lib/index.js:119` freezes the disposition for `permission/preset` as `disposition(["preset"])` — required `preset`, no optional members. During v0 row decode, `normalizeReleasedV0Event` (`:1918`) calls `assertReleasedEventPayload` (`:1579`), which at `:1590` hands that disposition to `assertReleasedV0Keys`. That helper builds `allowed` from required plus optional (`:258`), finds the first key outside it (`:259`) and throws at `:260`. `dsh-session-format/lib/index.js:251-254` wraps it as `… refuses this format v0 Session: permission/preset 0 data has unexpected member "origin"`.

Direction check: a minimal v0 artifact with `preset` alone is accepted, with `origin` added it is refused, and with any other unlisted member it is refused identically. The rule is the frozen inventory, not `origin` specifically — so the fix is to admit the historically released member, not to special-case this report.

**Store measurement.** We ran the real chain (`sessionFormatCatalog.createRestore(header, {validation: 'current', recovery: 'strict'})`, every row through `decodeRow`, then `finish()`) over all 52 `session.jsonl.zstd` logs under `~/.dsh/sessions`, every one at format v0: **39 restored, 13 refused — 10 on exactly this rule**, 3 on `subagent/descriptor … unsupported descriptor version 2`. The ten `origin` records were written 2026-08-21 20:34 through 2026-08-22 23:19, so `origin` was still being emitted on 8/22. This is not an edge case here: roughly one log in five is unreadable for this member alone, and `readHeader` still returns `migration-required`, which is why they list and then fail on open.

**The refusal is recoverable.** It is fail-closed and side-effect-free: after the run all 52 logs kept their bytes and mtimes and no `.v3` artifact appeared. Dropping the member in memory makes all ten restore, so relaxing the disposition — or rewriting the member — recovers every one of them losslessly.

**Offline detection.** Released `dsh-doctor` 0.4.5 S12 runs the installed chain in memory and lists affected logs before anything is opened: `npx @moonquake2004/dsh-doctor --session <path>`, or a full run for the store. On this machine it reports the same 13 of 52.
