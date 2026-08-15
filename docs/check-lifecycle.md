# Check lifecycle — a working draft for #1846

Status: working draft. Discussion context:
[deepseek-ai/deepseek-harness#1846](https://github.com/deepseek-ai/deepseek-harness/discussions/1846)
(RFC: registry contract + `dsh plugin check` + `dsh doctor`).

**Thesis.** The RFC standardizes the *tools* (registry contract, publish gate,
doctor command). This document standardizes the *checks themselves*: how a check
is born, proven correct, distributed, and kept honest across harness upgrades.
Every item below has a running reference implementation in
[moonquake2004/dsh-doctor](https://github.com/moonquake2004/dsh-doctor) — this is
not aspirational.

## Why this is needed

**Checks rot.** Every check encodes assumptions about harness internals
(event-type tables, seq semantics, patch grammar, file layout, module symbols).
Every harness release can silently invalidate them. Evidence:

- #1697 / #1415 — dual-module-instance crashes that no static list caught early;
- our own E6 exists *precisely* because of this: it re-verifies at runtime that
  the contracts S6/S7/S10 rely on still exist in the installed `dsh-session`;
- our own P3 shipped silently dead for months (a wrong regex matched nothing, so
  it always "passed") until fixture testing found it.

**Checks false-positive.** Static checks without semantic boundaries misfire
(`npm run` substring in #1702, `DatabaseSync.exec` ≠ `child_process.exec` in
#1929, three rounds of P9 false positives). Without a certification gate, a
noisy check poisons the whole tool's credibility.

## The four properties

### 1. Checks are data, not code

Each check = a read-only probe definition + its target contract anchor + a
good/bad fixture pair + the release train it was certified on. Distributed
through a **check registry** (not a plugin registry) with TTL cache + offline
fallback.

Reference: our Layer-A catalog (`plugin/checks.json`, live since v0.2.0) — 5
catalog checks shipped to every installed instance with **zero releases**; the
engine executes only declarative, read-only probes (`command-exists`,
`path-*`, `json-valid`, `text-*`, `file-size-above`, `glob-count`,
`file-writable`), so remote payloads can never run code.

### 2. Introspection instead of hardcoding

Read the **installed** harness's contracts (event-type table, module symbols,
patch grammar) to derive or validate expectations, rather than baking them in.
Upgrade → either the anchor passes (check still valid) or the tripwire fails
loudly (no silent rot).

Reference: our S8 (parses the installed `KNOWN_SESSION_EVENT_TYPES` with a
fallback) and E6 (verifies `expandRow` / `session/end-seed` / `sourceEventSeqs`
contracts still exist in the installed `dsh-session`).

### 3. Certification gate

A check enters the ecosystem only if its fixture pair proves "good doesn't
false-positive, bad gets caught" on the declared train. This upgrades the
doctor-contract-check idea from certifying *output shape* to certifying *check
correctness*.

Reference: our 64-test regression corpus (25 built-in + 5 catalog checks; each
fixture asserts isolation — the target check fails while every other check
passes). It has already caught real bugs: P3 silent no-op, P6 regex overmatch,
and the three P9 false-positive classes.

### 4. Evolution loop

Community report → candidate check → fixture certification → catalog
distribution → auto-update. The diagnostic layer itself "evolves on the fly" —
the paper's theme, applied to the diagnostics.

Reference: our Layer-B self-update (npm version check + `--update` +
`DSH_DOCTOR_AUTO_UPDATE`) plus the catalog TTL mechanism.

## Proposed schema for a check entry

```json
{
  "id": "E11-settings-writable",
  "section": "env",
  "severity": "error",
  "probe": { "type": "file-writable", "path": "{home}/settings.yaml", "required": false },
  "anchor": { "package": "@deepseek-ai/dsh-settings", "symbol": null, "train": "0.1.0-rc.6" },
  "fixtures": { "good": "path/or-inline", "bad": "path/or-inline" },
  "certifiedOn": "0.1.0-rc.6"
}
```

- `probe` — declarative, read-only (the only thing the engine executes)
- `anchor` — which installed-harness contract this check assumes; checked by
  introspection, and any mismatch fails the check loudly (or marks it
  "needs re-certification")
- `fixtures` — the good/bad pair that must pass on `certifiedOn`

## Interaction with the #1846 RFC

- `dsh doctor`'s check inventory becomes a *list of data entries* (property 1)
  instead of a hardcoded table, and each entry carries its own certification
  record (property 3).
- `dsh plugin check` can reuse the same probe vocabulary and fixture gate for
  pre-publish checks.
- The `dsh-doctor/v1` envelope stays the output contract; checks-as-data is the
  *input* contract this document adds.

## Open questions

1. Who hosts the check registry — the same marketplace registry, or a
   dedicated `dsh-checks` catalog? (We currently serve from the repo's
   `plugin/checks.json`; a shared registry is a natural next step.)
2. Certification runs on which train matrix (latest rc only, or N-1 too)?
3. Should catalog rules be signable, or is pinned-repo + read-only-probes
   sufficient?
