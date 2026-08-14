# dsh-doctor

Offline diagnostic for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — run it **before** boot or before installing plugins, and it tells you which of the failure classes this community has been reporting will bite.

Zero npm dependencies. One file. Runs anywhere `node` exists (`zstd` needed only for `.zstd` session logs; E1 checks for it).

## Why

dsh's plugin tree is "fragile by install": a dangling reference, a broken `file:` link, a duplicate entry id, or a corrupted session log can brick the profile at boot or stall the whole web server — and `--dump-config` never mounts the loader, so it passes on broken setups. This class of failure was consolidated in [dsh discussion #1496](https://github.com/deepseek-ai/deepseek-harness/discussions/1496) (Advisory: plugin-install path needs guardrails). `dsh-doctor` is the offline check that advisory calls for — 19 checks mapped to 18 community reports, each verified with synthetic negative fixtures.

## Usage

```bash
node dsh-doctor.mjs                      # everything (env + profile + session)
node dsh-doctor.mjs --profile web        # profile checks only
node dsh-doctor.mjs --session <path>     # session checks (default: latest session)
node dsh-doctor.mjs --env                # env checks
node dsh-doctor.mjs --json               # machine-readable output
```

Exit codes: `0` = all pass · `1` = problems found · `2` = usage/environment error.

## Checks (19)

### env
| ID | Checks | Discussion |
|---|---|---|
| E1 | `node`/`pnpm`/`zstd` on PATH | [#1270](https://github.com/deepseek-ai/deepseek-harness/discussions/1270) |
| E2 | `.env` is a file, not a directory | [#71](https://github.com/deepseek-ai/deepseek-harness/discussions/71) |
| E3 | node version / `--expose-internals` reachability | [#113](https://github.com/deepseek-ai/deepseek-harness/discussions/113), [#1313](https://github.com/deepseek-ai/deepseek-harness/discussions/1313) |
| E4 | node-pty native binary present (`prebuilds/<platform>-<arch>/pty.node`) | [#1219](https://github.com/deepseek-ai/deepseek-harness/discussions/1219) |
| E5 | storage JSON files valid (strict UTF-8 + parse) | [#1357](https://github.com/deepseek-ai/deepseek-harness/discussions/1357) |
| E6 | anchor tripwire: our S6/S7/S10 contracts still in installed `dsh-session` | [anti-rot idea](https://github.com/deepseek-ai/deepseek-harness/discussions/1534) |

### profile
| ID | Checks | Discussion |
|---|---|---|
| P2 | bundle-layer vs user-patch insert id collisions (boot crash) | [#1404](https://github.com/deepseek-ai/deepseek-harness/discussions/1404) |
| P3 | user-patch insert `name:` resolvable from the profile anchor | [#1197](https://github.com/deepseek-ai/deepseek-harness/discussions/1197), [#880](https://github.com/deepseek-ai/deepseek-harness/discussions/880) |
| P4 | `file:` dependencies intact | [#1197](https://github.com/deepseek-ai/deepseek-harness/discussions/1197) |
| P5 | no top-level `@deepseek-ai/*` duplication (dual module instances) | [#1486](https://github.com/deepseek-ai/deepseek-harness/discussions/1486) |

### session
| ID | Checks | Discussion |
|---|---|---|
| S1 | orphan `tool_call` (no matching tool result) | [#1363](https://github.com/deepseek-ai/deepseek-harness/discussions/1363), [#1544](https://github.com/deepseek-ai/deepseek-harness/discussions/1544) |
| S2 | unclosed turns (session stuck "running") | [#466](https://github.com/deepseek-ai/deepseek-harness/discussions/466), [#1265](https://github.com/deepseek-ai/deepseek-harness/discussions/1265) |
| S6 | `seq == index` contiguity (official semantics, chunk rows expanded like `expandRow`) | [#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333), [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452), [#1469](https://github.com/deepseek-ai/deepseek-harness/discussions/1469) |
| S7 | post-`end-seed` replay (replayed committed tail) | [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497) |
| S8 | unknown event types without `ignorable` (wholesale refusal) | [#1538](https://github.com/deepseek-ai/deepseek-harness/discussions/1538) |
| S9 | zstd container frame count (single-frame logs → `session.list` 500) | [#1043](https://github.com/deepseek-ai/deepseek-harness/discussions/1043) |
| S10 | `sourceEventSeqs` referencing non-earlier events | [#1469](https://github.com/deepseek-ai/deepseek-harness/discussions/1469) |
| S11 | whole-session scan: corrupt → quarantine suggestion; oversized → cold-open stall risk | [#1550](https://github.com/deepseek-ai/deepseek-harness/discussions/1550) |

## Notes

- The S-class checks replicate the harness's own validation (e.g. `SessionLogScanner`'s `seq == events.length` with `expandRow` chunk expansion), so offline verdicts match what boot/resume would do.
- `$DSH_HOME` is honored (default `~/.dsh`), so you can dry-run against a temp home without touching your real data.
- In-flight tool calls in the current active turn are reported as warnings, not errors, so scanning a live session never false-positives.
- Sibling implementation with the same scope: [boyin111-1/dsh-doctor](https://github.com/boyin111-1/dsh-doctor) — the two tools cross-verified against the same broken fixtures.

## License

MIT
