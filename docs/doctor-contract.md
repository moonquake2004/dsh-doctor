# dsh-doctor contract (v1) — interop spec for DSH diagnostic tools

Pinned here so every tool in the ecosystem (and its CI/support consumers) has one
place to check the shape. Status: living — updates tracked in
deepseek-ai/deepseek-harness discussions #1719 (doctor spec) and #1846 (RFC).
Vocabulary layer: **check-name vocabulary r5** (#1719, drafted by @ciceroyang,
reviewed by @sjh9714 and @moonquake2004); **v1.1 supplement** adds
`installed_bundle` (semantics settled in #1719, r6 sheet pending).

## Full envelope — `dsh-doctor/v1`

```json
{
  "schema": "dsh-doctor/v1",
  "tool": "<emitter id, e.g. dsh-doctor | dsh-plugin-doctor | dsh-diagnose>",
  "generatedAt": "ISO-8601",
  "profile": "<name or dir>",
  "exitCode": 0,
  "summary": { "pass": 2, "warn": 0, "fail": 0, "skip": 0 },
  "ok": true,
  "checks": [ { "name": "<check id>", "status": "pass", "detail": "..." } ]
}
```

- **status vocabulary**: lowercase `pass | warn | fail | skip` (r5 — `skip` means
  "does not apply" on this platform/context and **requires** a reason in `detail`;
  CI asserts "no `fail`" and treats `skip` as neither pass nor fail)
- **summary**: always carries `skip` (0 when unused) so consumers never need
  `summary.skip ?? 0`
- **exit codes**: `0` all pass · `1` any WARN · `2` any FAIL — scoped to a direct
  `doctor` invocation (embedded/library callers decide their own exit policy);
  adopting 0/1/2 is a breaking change for consumers, ship it in a minor bump with
  a release note
- `ok` = `exitCode === 0`
- `tool` (optional but recommended): emitter id for provenance — `name` stays the tool-local check id, no global id registry required
- `checks[].name` is the check id; `detail` is the human-readable verdict

## Check-name vocabulary (r5)

Core names shared across implementations; a check without an entry keeps its
tool-local (vendor-prefixed) name. Each entry = `{ name, semantic, status,
provenance }`; `semantic` is the ONLY thing a CI script may assert on (`detail`
is free text). Once a name is in the vocabulary, all implementations honor the
pinned semantics.

| name | semantic | status | provenance |
|---|---|---|---|
| node | Node against the repo-declared engines | pass = in `^22.19.0 || >=24.0.0`; warn = otherwise | root `package.json` (see #2259) |
| pnpm | pnpm availability | ok present; warn missing (corepack-recoverable) | - |
| dsh | dsh executable on PATH | ok; warn npx-only | - |
| ds_home | DSH_HOME + settings.yaml writable | ok; warn settings missing; fail not writable | #1027 |
| profiles | profile manifests parse | ok; fail corrupt entries | #964 |
| sessions | session logs enumerable | ok; warn missing/unreadable | - |
| log_health | zstd container structure + decodeability (multi-frame scan + decode) | ok; fail bad frames / decode failure | #1043 |
| dedupe | critical packages single-copy | ok; fail multi-copy | #1849 |
| port | default port availability | ok free; warn occupied | - |
| installed_bundle | the version of the bundle the profile actually has vs the running CLI | skip when the manifest lists no bundle (mandatory reason: CLI running standalone); warn when listed-but-absent or installed-and-diverged; pass when installed and equal | #1719 (v1.1) |

Mapping note: our E3-node ↔ `node`, E1-pnpm ↔ `pnpm` (warn severity since r5);
S9's frame/decode class maps to `log_health`; S11's integrity/quarantine/heap
scan is NOT covered by `log_health` and stays tool-local until its semantics are
aligned separately. **P12 emits the vocabulary name `installed_bundle` directly**
(r6/v1.1 nomination, #1719 — the other two implementations follow the same
mapping: dsh-win32's `dsh-win32/bundle` → `installed_bundle`, ciceroyang abstains
as it does not ship the check).

## Minimal compatible subset

A tool that only emits `{ "ok": boolean, "checks": [{ "name", "status", "detail" }] }`
(with lowercase status) is a **v1-compatible subset**: every consumer of the full
envelope can consume it (they read `checks` + `ok`). Missing `summary`/`exitCode`
can be derived from `checks`.

## Emitters today

| Tool | Mode | Shape |
|---|---|---|
| moonquake2004/dsh-doctor | `--json --envelope` | full envelope (v1, emits `tool`, summary.skip, vocabulary r5 node/pnpm + v1.1 `installed_bundle`) |
| zoahdev/dsh-plugin-doctor | v1.6.0 `--profile --json` | full envelope (v1) |
| worm-ai/dsh-diagnose | `--doctor-json` | subset — needs lowercase status to be v1-compatible |
| ciceroyang/dsh-doctor | v0.5.0+ | full envelope (r5, skip) |
| sjh9714/dsh-win32 | v0.8.x `doctor --json` | full envelope (r5, skip fires on non-Windows) |

## Interop rule

Consumers SHOULD accept both the full envelope and the subset; producers SHOULD
emit at minimum the subset with lowercase status, and PREFER the full envelope.
Do NOT invent per-tool status case (`PASS/WARN/FAIL` uppercase breaks the contract).
