# dsh-doctor contract (v1) — interop spec for DSH diagnostic tools

Pinned here so every tool in the ecosystem (and its CI/support consumers) has one
place to check the shape. Status: living — updates tracked in
deepseek-ai/deepseek-harness discussions #1719 (doctor spec) and #1846 (RFC).

## Full envelope — `dsh-doctor/v1`

```json
{
  "schema": "dsh-doctor/v1",
  "tool": "<emitter id, e.g. dsh-doctor | dsh-plugin-doctor | dsh-diagnose>",
  "generatedAt": "ISO-8601",
  "profile": "<name or dir>",
  "exitCode": 0,
  "summary": { "pass": 2, "warn": 0, "fail": 0 },
  "ok": true,
  "checks": [ { "name": "<check id>", "status": "pass", "detail": "..." } ]
}
```

- **status vocabulary**: lowercase `pass | warn | fail`
- **exit codes**: `0` all pass · `1` any WARN · `2` any FAIL
- `ok` = `exitCode === 0`
- `tool` (optional but recommended): emitter id for provenance — `name` stays the tool-local check id, no global id registry required
- `checks[].name` is the check id; `detail` is the human-readable verdict

## Minimal compatible subset

A tool that only emits `{ "ok": boolean, "checks": [{ "name", "status", "detail" }] }`
(with lowercase status) is a **v1-compatible subset**: every consumer of the full
envelope can consume it (they read `checks` + `ok`). Missing `summary`/`exitCode`
can be derived from `checks`.

## Emitters today

| Tool | Mode | Shape |
|---|---|---|
| moonquake2004/dsh-doctor | `--json --envelope` | full envelope (v1, emits `tool`) |
| zoahdev/dsh-plugin-doctor | v1.6.0 `--profile --json` | full envelope (v1) |
| worm-ai/dsh-diagnose | `--doctor-json` | subset — needs lowercase status to be v1-compatible |

## Interop rule

Consumers SHOULD accept both the full envelope and the subset; producers SHOULD
emit at minimum the subset with lowercase status, and PREFER the full envelope.
Do NOT invent per-tool status case (`PASS/WARN/FAIL` uppercase breaks the contract).
