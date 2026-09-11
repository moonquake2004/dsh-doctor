# Reply draft — deepseek-harness #6085

Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/6085#discussioncomment-18401967.

Target: https://github.com/deepseek-ai/deepseek-harness/discussions/6085
(Community Session Doctor, `wsjwu58-cmd/dsh-session-doctor`)

---

## Comment body

Thanks — the payload-free design here is the part worth copying. Reading
`packages/runtime-diagnostics/session-doctor/src/types.ts`, `DiagnosisReportV1`
carries `version`, `subject`, `analysis`, `findings` and `limitationCodes`, and each
`DiagnosisFindingV1` keeps `id`, `detector{id,version}`, `category`, `impact`, `basis`
(`observed`/`heuristic`), bounded `evidence` (`seq` + `type`), scalar `metrics` and a
`recommendationCode`. Versioning the report and versioning each detector is more
discipline than most of us started with.

Where we overlap: other tools in this family emit a machine-readable report per run —
dsh-doctor and zoahdev/dsh-plugin-doctor already agree on a small shape,
`{"ok": bool, "checks": [{"name", "status", "detail"}]}`, with lowercase
`pass|warn|fail|skip`. CI and support scripts can already read those; today
`--profile doctor --json` gives them `findings` instead. The gap is mostly vocabulary:
`impact` is `info|warning|error` rather than `status`, and the finding's text is a
locale-owned `recommendationCode`, so nothing in the report reads as `detail`.

No new format needed — the projection is `detector.id` → `name`,
`impact` → `status` (`error`→`fail`, `warning`→`warn`, `info`→`pass`), a rendered
sentence → `detail`, plus a `tool` field for provenance. Worth considering: `basis:
"heuristic"` findings probably should not land on `fail`, since they are inferred
rather than observed. Happy to compare notes if that is useful.

---

## Evidence read (for our own records, not part of the post)

- `packages/runtime-diagnostics/session-doctor/src/types.ts` — `DiagnosisReportV1`,
  `DiagnosisFindingV1`, `DiagnosisClusterReportV1` (`version: 1`, `scope:
  'logical-session-findings'`, `sessionCount`, `clusters`), `SessionDoctorErrorCode`.
- `packages/runtime-diagnostics/session-doctor/src/detectors.ts` — detector ids:
  `provider-retry-storm`, `repeated-failed-tool-call`, `tool-error-burst`,
  `unchanged-failure-cycle`, `max-token-turn`, `sustained-context-growth`,
  `interrupted-execution` (each `version: 1`).
- `packages/bundle/doctor/src/renderer.ts` — human rendering only
  (`- [<impact>] <category> (basis; detector=<id>@<version>)` + `metrics:` /
  `evidence:` / `recommendation:` lines); no `status`/`detail` vocabulary.
- Discussion body #6085 (2026-09-10) — `--json` / `--cluster --json` / `--repair --json`;
  source-run only until upstream Host/API land, no npm publication yet.
- Not verified: an actual emitted JSON sample. The report shape above is read from the
  TypeScript interfaces in the repo, not from a run.
