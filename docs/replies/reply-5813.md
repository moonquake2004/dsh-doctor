# Reply draft — deepseek-harness #5813

Status: draft for user approval. Not posted.

---

Thanks — we can corroborate this independently, with the caveat that it is one machine and
one profile, not a registry-wide survey.

**Our measurement.** dsh-doctor 0.4.5 / `dsh-security` check SP8 (`dist-tag-health`), run on
this machine:

```
./dsh-doctor.sh --security --security-only --profile web
```

It scanned 8 installed `dsh`-gated plugin packages and the 31 unique `@deepseek-ai/dsh-*`
peer packages they declare. All 8 plugins were flagged: 53 plugin×peer pairs across 23
distinct peer packages, whose `latest` is `0.0.1-rc.1` (20 packages) or `0.0.1-rc.3` (3).
Every one of those 23 carries `next: 0.1.5-rc.2` / `alpha: 0.1.5-alpha.2`, so `latest` is
frozen, not merely behind.

Three rows, as measured:

| installed plugin | declared peer | `latest` | `next` |
|---|---|---|---|
| `@nanmicoder/dsh-agent-teams@0.1.15` | `@deepseek-ai/dsh-tools ^0.1.2-alpha.2` | `0.0.1-rc.1` | `0.1.5-rc.2` |
| `@zseven-w/dsh-noema@0.1.0-rc.3` | `@deepseek-ai/dsh-tools ^0.1.0-rc.6` | `0.0.1-rc.1` | `0.1.5-rc.2` |
| `dsh-better-sidebar@0.18.1` | `@deepseek-ai/dsh-client-locale ^0.1.2-rc.1` | `0.0.1-rc.1` | `0.1.5-rc.2` |

(The SP8 summary line prints the pair count, 53; the distinct-plugin count is 8.)

**Affected surface.** Confirmed in `@deepseek-ai/dsh@0.1.5-rc.1`: `dsh plugin` is a thin
forwarder that runs `pnpm <args...>` verbatim in the profile directory, so
`dsh plugin --profile <name> add <pkg>` is an unversioned `pnpm add` and resolves `latest` —
exactly the frozen tag.

**The CLI asymmetry holds.** `@deepseek-ai/dsh`: `latest=0.1.5-rc.1`, `next=0.1.5-rc.2`,
`alpha=0.1.5-alpha.2` — one rc behind `next`, but on the current train, never `0.0.1-rc.1`.
The plugin packages are the stale subset. The family is not uniformly frozen, though:
`@deepseek-ai/dsh-agent` still reports `latest=0.1.0-rc.6`.

**Workaround**, which is what SP8 recommends — pin explicitly, bypassing `latest`:

```
dsh plugin --profile web add @deepseek-ai/dsh-web-search-exa@0.1.5-rc.2
```

The affected set is read from local `node_modules` manifests with no network, so installed
plugins and their declared peer ranges can be listed offline and re-checked after an
install; only the dist-tag verdict itself needs the registry.
