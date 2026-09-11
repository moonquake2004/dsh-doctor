# Reply draft — deepseek-harness #3801

Status: **DRAFT** — not posted; awaiting user approval.

Target: https://github.com/deepseek-ai/deepseek-harness/discussions/3801
(dsh-doctor-windows, `xianfanwindy/dsh-doctor-windows`)

---

## Comment body

The stable `checkId` set is the strongest part of this, and it is on Windows ground
nothing else covers — `windows.path.long`, `windows.path.network`,
`windows.path.sync-root`, `windows.dsh-home.readable`, `windows.link.broken`,
`windows.temp-capability`, `command.dsh.execution-policy`.

On interop, this is close. `src/model.ts` defines `DiagnosticReport` with
`schemaVersion`, `generatedAt`, `environment`, `target`, `summary`,
`findings`/`limitations`, and each `Finding` is `{checkId, severity, conclusion,
evidence?, remediation?}`. `renderJson` serializes that report as-is, and `severity`
is `BLOCKER|WARNING|INFO|PASS`. Compare with dsh-doctor and zoahdev/dsh-plugin-doctor,
which emit `{"ok": bool, "checks": [{"name", "status", "detail"}]}` with lowercase
`pass|warn|fail|skip`: consumer scripts can read those today, but have to case-match
`BLOCKER` and read `conclusion` to get anything usable from this one.

The additive step is small — keep the report, add the subset:
`checkId` → `name`, `severity` → lowercase `status` (`BLOCKER`→`fail`,
`WARNING`→`warn`, `PASS`→`pass`, `INFO`→`skip` with the reason in `detail`),
`conclusion` → `detail`, plus a top-level `ok` and a `tool` id for provenance. The
`summary` keys (`blocker`/`warning`/`info`/`pass`) rename to
`pass`/`warn`/`fail`/`skip` so `summary.skip` can be read without `?? 0`.

No change requested to the exit-code policy — just the JSON shape. Worth it, since a
support script could then read both doctors.

---

## Evidence read (for our own records, not part of the post)

- `src/model.ts` — `Severity = 'BLOCKER' | 'WARNING' | 'INFO' | 'PASS'`; `Finding`
  `{checkId, severity, conclusion, evidence?, remediation?}`; `Summary`
  `{blocker, warning, info, pass}`; `DiagnosticReport`
  `{schemaVersion: 1, generatedAt, environment, target{dshHome, profile?}, summary,
  findings, limitations}`.
- `src/redact.ts` — `SanitizedReport = DiagnosticReport & {...}`; `renderJson` in
  `src/render.ts` is `JSON.stringify(report, null, 2)`, so the emitted JSON is exactly
  `DiagnosticReport`.
- `src/checks/{runtime,windows,profile,commands}.ts` — checkIds listed above
  (`runtime.node.supported|unsupported|version-invalid`,
  `runtime.dsh.shim-target|installation-unknown`).
- `README.md` line 60 — "JSON reports include `schemaVersion` and stable `checkId`
  values for automation. Exit code `0` means no blocker, `1` means at least one blocker,
  and `2` means invalid arguments or doctor initialization failed."
- `src/cli.ts` — `main` returns `report.summary.blocker === 0 ? 0 : 1`, and returns `2`
  when `platform !== 'win32'`. Not raised in the comment: under the contract our
  `exitCode` is `0` pass / `1` warn / `2` fail, so `1`-on-blocker (rather than `2`) and
  `2`-on-wrong-platform are the two places the two exit-code policies differ.
- npm: `dsh-doctor-windows@0.1.0` published (confirmed via `npm view`); comment in the
  thread announces it.
