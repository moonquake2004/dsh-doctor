# Findings actions — 2026-09-12

Author: dsh-doctor maintainer session (delegated). Scope: **read-only inspection** of the environment — the only
file written inside the workspace is this report, and all experiment output (decompressed logs, rewritten
copies, proof scripts) went to `/tmp/dsh-verify-11034/`. No GitHub post was made. `~/.dsh`,
`/opt/homebrew` and every repo source are byte-identical to their pre-session state (profile file hashes were
recorded before and after; see §A.2 and the close of §C.5).

Machine/build taken as the measurement baseline:

| Component | Version |
|---|---|
| `@deepseek-ai/dsh` (installed harness) | 0.1.5-rc.1 |
| profile asset | `/Users/waterfly/.dsh/profiles/web` (pnpm 12.3.4, `nodeLinker: hoisted`) |
| `@deepseek-ai/dsh-settings` | 0.1.5-rc.2 |
| `dsh-session-format-*` | 0.1.5-rc.2 (`format-catalog.currentVersion = 3`) |
| `dsh-at-file` | 0.6.8 (tarball `c37b0ed9…`) |
| `@zseven-w/dsh-noema` | 0.1.0-rc.3 |

Provenance of every claim is marked **MEASURED** (I ran it on this machine), **READ FROM SOURCE**
(installed file/line inspected), or **UNVERIFIED** (reasoning only, not executed). Since the remit forbids
writing to the profile or the session store, no fix was applied and no migration was executed in place.

---

## A — SP1 dependency finding: `js-yaml@4.3.1` (GHSA-2883-xcg3-v3hh, HIGH)

### A.1 Finding restated

`dsh-security` SP1 runs `pnpm audit --json` in `/Users/waterfly/.dsh/profiles/web` and reports
`js-yaml (high) — maxTotalMergeKeys does not limit CPU use for empty merge sources`, 250 dependencies scanned.

### A.2 Evidence gathered

**Advisory (MEASURED — GitHub Advisory API).**
`GHSA-2883-xcg3-v3hh` / `CVE-2026-84375`, severity **high**, CVSS 3.1 `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` (7.5,
availability-only). Published 2026-09-08.

Re-running the scanner on the same profile reproduces the finding exactly (MEASURED, `pnpm audit --json` in
`/Users/waterfly/.dsh/profiles/web`): one advisory, npm id `1193727`, `module_name: js-yaml`, `severity: high`,
same title. The dependency total this run reports is `243` rather than the 250 in the SP1 output — the count is
a moving number (pnpm reports the installed/audited set, and the profile has changed since), and it does not
affect the finding: still exactly one advisory, on js-yaml.

- npm `js-yaml`: vulnerable `>= 4.0.0, < 4.3.2` → **patched: 4.3.2**
- npm `js-yaml`: vulnerable `>= 3.0.0, < 3.15.2` → patched: 3.15.2 (not installed here)

Mechanism (advisory text, verbatim summary): `maxTotalMergeKeys` does not count **empty** mappings, so
`<<: *arr` repeated over a large array of `{}` costs `O(N*K)` while `totalMergeKeys` never rises. The advisory's
PoC table ends at N=20000 / ~500 KB / ~13 s of CPU.

**Dependency chain (MEASURED — `pnpm why js-yaml` run in the profile, plus lockfile read).**

```
$ cd /Users/waterfly/.dsh/profiles/web && pnpm why js-yaml
js-yaml@4.3.1
├─┬ dsh-plugin-doctor@1.16.0
│ └── dsh-profile-web (dependencies)
└─┬ dshmarket@1.45.1
  └── dsh-profile-web (dependencies)
Found 1 version of js-yaml
```

Exactly **two** independent chains, both direct dependencies of the profile, both accepting 4.3.2 already:

| Chain | Declared range | Lockfile / installed |
|---|---|---|
| `dsh-plugin-doctor` (`github:zoahdev/dsh-plugin-doctor`, commit `e9dfc92e…`) | `js-yaml: ^4.2.0` (`node_modules/dsh-plugin-doctor/package.json:53`) | `pnpm-lock.yaml:878`, `:2038` → `js-yaml@4.3.1` |
| `dshmarket@1.45.1` (registry) | `js-yaml: ^4.1.0` (`node_modules/dshmarket/package.json:39`) | `pnpm-lock.yaml:887`, `:2042` → `js-yaml@4.3.1` |

Single resolved copy: `node_modules/js-yaml/package.json` → `4.3.1` (hoisted; there is no `.pnpm` virtual store
in this profile — `node_modules/.pnpm/lock.yaml` is the only entry, `node_modules/.modules.yaml` records
`nodeLinker: hoisted`). `katex` and `dompurify` also *declare* `js-yaml` (as devDependencies of the published
packages) but do not consume it here; the lockfile's three package-graph references (`js-yaml@4.3.1:` and the two
dependents) are exhaustive.

**Fix availability (MEASURED — npm registry).**
`dist-tags`: `latest: 5.4.1`, `v4-legacy: 4.3.2`, `v3-legacy: 3.15.2`. `4.3.2` published 2026-08-26;
same sole dependency `argparse ^2.0.1`; no `engines` field, no `bin` change. A fixed version exists and is
inside both dependents' declared ranges.

**Reachability (READ FROM SOURCE).** Both call sites parse **local files**, not remote input:

- `dsh-plugin-doctor/lib/index.js:14` imports `load as parseYaml`; used at `:545-546` in `parsePatch(content)` for
  `cordis.patch.yml` content; `dsh-plugin-doctor/lib/audit.js:5` imports it, used at `:626` on the profile's own
  patch file (`readFileSync(patchPath)`).
- `dshmarket/lib/check.js:31` imports `JSON_SCHEMA, Type, load`; `parsePatchText` (`:52-59`) parses entry-list
  patch text and `parsePatchFile` (`:62-69`) reads local patch files. `dshmarket/lib/routes.js:13` imports
  `load as loadYaml`, used at `:623` on a captured `pnpm-lock.yaml` snapshot read by `captureProfileLockfile()`.

No call site passes `maxTotalMergeKeys`; the exposure is the codec with the default limit, fed by files that are
either user-authored or, for the lockfile snapshot, read from the profile the user already controls. Neither
package downloads YAML from a third party and parses it. So this is a **real but low-reachability availability
bug in an installed path** — denial of service only, self-inflicted input — not a remotely triggerable defect in
this profile. `dsh-plugin-doctor` (`github:`) and `dshmarket` are runtime dependencies of the running profile,
not build-only.

### A.3 Recommended action (exact commands)

The vulnerable version is reached only through two transitive dependencies that both already allow the patch.
The minimal, safe fix is to re-resolve `js-yaml` to `4.3.2` and keep it pinned so it cannot drift back:

```bash
cd /Users/waterfly/.dsh/profiles/web
cp pnpm-lock.yaml pnpm-lock.yaml.bak.$(date +%Y%m%d%H%M%S)
cp package.json   package.json.bak.$(date +%Y%m%d%H%M%S)

# 1) re-resolve the single vulnerable package inside both dependents' existing ranges
pnpm update js-yaml@4.3.2

# 2) verify — must print 4.3.2 and no 4.3.1
grep -n "js-yaml" pnpm-lock.yaml
node -p "require('/Users/waterfly/.dsh/profiles/web/node_modules/js-yaml/package.json').version"
pnpm why js-yaml
pnpm audit --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('metadata',{}).get('vulnerabilities'))"

# 3) if (1) leaves 4.3.1 pinned, add a root override and install
#    (pnpm 12 reads overrides from pnpm-workspace.yaml's `overrides:` field)
#    pnpm-workspace.yaml:  overrides:\n#      js-yaml: 4.3.2
pnpm install --lockfile-only   # then: pnpm install --frozen-lockfile=false
```

Handling notes (MEASURED): `pnpm config get minimumReleaseAge` → `undefined`, so no release-age gate blocks
4.3.2. There is **no** `--dry-run` for `pnpm update`/`pnpm add` in pnpm 12.3.4 (`pnpm add --help` lists only
`--lockfile-only`); `pnpm install --lockfile-only` is the closest "change the lockfile without touching
`node_modules`" form. **UNVERIFIED: I did not run any of these commands** — the environment had to stay
read-only, so the command sequence above is derived from the lockfile graph and pnpm's documented flags, not
from an executed upgrade.

### A.4 Risk of the fix

- **Low.** `4.3.1 → 4.3.2` is a patch release, same dependency set, no engine/bin change, and both dependents
  already declare a range that includes it — no manifest edit is required for the update to be legal.
- The override variant pins every future resolution of `js-yaml` in this profile to the 4.x line; if any plugin
  ever requires js-yaml 5.x, that override would need revisiting. `latest` is 5.4.1, so the end state of the
  ecosystem may be 5.x.
- `dsh-plugin-doctor` is a `github:` tarball and `dshmarket` self-upgrades (`@latest`, per the profile patch
  comments), so either can re-introduce or re-resolve the dependency later; re-run `pnpm audit` after any
  plugin upgrade.
- Rollback: restore the two `.bak` files and re-run `pnpm install`.

### A.5 Ownership

The fix belongs to **the user, and it is available today** — this is not a "wait for the author" case. Both
authors declared ranges that already admit the patched release; only the frozen lockfile keeps 4.3.1. Patch the
profile now. The packages to watch (latest published versions checked against the advisory):

- `dsh-plugin-doctor` — `github:zoahdev/dsh-plugin-doctor` (installed 1.16.0); upstream range `^4.2.0` is fine,
  nothing to change upstream.
- `dshmarket` — 1.45.1 (installed = published); upstream range `^4.1.0` is fine, nothing to change upstream.

**Compensating mitigation if the owner prefers not to touch the lockfile:** none is strictly needed. The
vulnerable paths parse only local, owner-controlled YAML (`cordis.patch.yml`, entry-list patches, the profile's
own `pnpm-lock.yaml` snapshot); there is no remote attacker path in this profile, and the impact is CPU only.
If an upgrade is deferred, the guard to keep is "never feed a foreign `.yml` to `dsh-plugin-doctor`/`dshmarket`"
— but the version bump is a one-line, low-risk action, so deferring buys little.

---

## B — P16: two plugins import an export that does not exist

### B.1 Installed export surface of `@deepseek-ai/dsh-settings`

The package resolves through `/Users/waterfly/.dsh/profiles/node_modules/@deepseek-ai/dsh-settings` →
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings`, version
**0.1.5-rc.2**.

MEASURED (real ESM import of the installed `lib/index.js`):

```
EXPORTS: SettingsConflictError, SettingsProvider, default, redactSecrets
has settingsNamespace: false
has redactSecrets: true      has redactSettings: false
```

So the doctor's prose "`{SettingsConflictError, SettingsProvider, redactSettings}`-style names" is directionally
right but the third name is `redactSecrets` (not `redactSettings`), and `default` is also exported
(`SettingsProvider as default`). The `lib/types/index.d.ts` declaration surface carries
`SettingsNamespace`/`SettingsScope`/`SettingsDescriptor` as **types only** — no runtime `settingsNamespace`
helper. Correction for the P16 wording: the absent name is `settingsNamespace`; the installed list is
`SettingsConflictError, SettingsProvider, default, redactSecrets`.

### B.2 Are the imports live? — yes, both, and they are static

**`dsh-at-file`** (READ FROM SOURCE + MEASURED).
`lib/index.js` is one bundled ESM file whose entry is the package `main`. It contains 7 top-level `import`
statements; one of them is at `:15862`:

```js
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
var AT_FILE_NAMESPACE = settingsNamespace("at-file");        // :15863 — top-level, runs on evaluation
...
return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });  // :15888
```

The import is static and top-level (not inside a function, not a dynamic `import()`, not behind a flag), and the
symbol it binds is consumed at module top level, so it is reachable the moment the entry module is imported.
Its client bundle (`lib/client.js`) does **not** import `@deepseek-ai/dsh-settings`; only the host-side entry is
affected.

**`@zseven-w/dsh-noema`** (READ FROM SOURCE + MEASURED).
`lib/index.js:2` statically imports `{ Config, installNoemaMemorySettings, resolveNoemaMemorySettings }` from
`./settings.js`; `lib/settings.js:2` statically imports `{ settingsNamespace }` from
`@deepseek-ai/dsh-settings` and uses it at `:27` (`export const NOEMA_MEMORY_SETTINGS_NS =
settingsNamespace(...)`), a top-level evaluation. `lib/index.js` re-exports that binding. Reachable on import,
no lazy path.

**MEASURED — the failure is a link-time `SyntaxError`, and the module never evaluates:**

```
$ node --input-type=module -e "await import('file:///Users/waterfly/.dsh/profiles/web/node_modules/dsh-at-file/lib/index.js')"
SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
    at file:///…/dsh-at-file/lib/index.js:15862
    at #asyncInstantiate (node:internal/modules/esm/module_job:455:21)

$ node --input-type=module -e "await import('file:///Users/waterfly/.dsh/profiles/web/node_modules/@zseven-w/dsh-noema/lib/index.js')"
SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
    at file:///…/@zseven-w/dsh-noema/lib/settings.js:2
    at #asyncInstantiate (node:internal/modules/esm/module_job:455:21)
```

Both throw **during module instantiation (linking)** — `ModuleJob` / `#asyncInstantiate` — which is before
`ModuleJob.run`, i.e. before any top-level statement of either plugin executes. Consequences: not a partial
mount, not a degraded feature; the entry module cannot be loaded at all, so `apply()` never runs, nothing the
plugin contributes is registered, and the loader sees a failed entry. (`dsh-at-file`'s client bundle would load
independently, but the host entry's death means the feature has no server side.)

### B.3 What enabling each plugin would produce

Both are currently held off by the profile patch (`~/.dsh/profiles/web/cordis.patch.yml`: `- id: dsh-at-file /
disabled: true`, `- id: dsh-noema / disabled: true`). MEASURED (READ FROM SOURCE,
`cordis-plugin-loader/lib/index.js:390-392`): `Entry.refresh()` returns immediately when
`this.disabled` is true, so a disabled entry never calls `init()` and its module is never imported — that is
precisely why the host still boots today.

Remove either `disabled: true` line and that entry's module is imported for the first time; the import rejects
with the `SyntaxError` above and the plugin does not mount. Whether the surrounding host treats one failed
entry as fatal-to-boot or as a failed-entry diagnostic was **not** exercised against this profile (that would
mean editing it, which was out of scope). Related prior evidence points the pessimistic way: in
`docs/replies/reply-5864.md` an identical name-mismatch failure was reproduced against a minimal two-entry tree
on the installed `@deepseek-ai/cordis-plugin-loader` and surfaced as
`failed to import loader entry <id> (<name>): …`, with the include group rolling back **healthy siblings** on
any single failure. So "only that one plugin fails" is optimistic here — **UNVERIFIED** for this profile. What
is certain is that neither plugin can mount on `@deepseek-ai/dsh-settings` 0.1.5-rc.2 as published.

Note also that `dsh-at-file` is not the only casualty of the same API change: it and `dsh-noema` are both
targeting a **removed API**, not a missing one. And for one of them the fix is already published — see §B.5.
MEASURED (npm registry tarballs, tail `export {…}` of `lib/index.js` per version):

| `@deepseek-ai/dsh-settings` | runtime exports (tail) |
|---|---|
| 0.1.0-rc.8 | `SettingsConflictError, SettingsProvider, default, deepEqualJson, installSettingsSection, redactSecrets, settingsNamespace` |
| 0.1.1-rc.2 | same as above |
| **0.1.2-rc.1** | `SettingsConflictError, SettingsProvider, default, redactSecrets` ← `settingsNamespace` and `installSettingsSection` gone |
| 0.1.5-rc.1 / **0.1.5-rc.2 (installed)** | same as 0.1.2-rc.1 |

Current `dist-tags`: `latest: 0.0.1-rc.1`, `alpha: 0.1.5-alpha.2`, `next: 0.1.5-rc.2`. The installed
0.1.5-rc.2 is the newest published build. The replacement API is visible in the package README (MEASURED):
`ctx.settings.register('ui-theme', ThemeSchema, { base })` returns a `SettingsScope`, and
`ctx.settings.installSection(owner, ns, schema, entry, hooks)` replaces `installSettingsSection` — the namespace
is now a plain string, checked by types in TS and at runtime, with no brand helper. Neither plugin's **installed
build** can be rescued by pinning `@deepseek-ai/dsh-settings` back to ≤0.1.1-rc.2 (that would fight the harness);
the fix is a plugin-side source update — and for `@zseven-w/dsh-noema` the author has already shipped one
(0.1.0-rc.4, §B.5), so only `dsh-at-file` still needs an upstream release.

**UNVERIFIED:** whether any *other* consumer in this profile also imports `settingsNamespace`/
`installSettingsSection` (P16 is scoped to the two reported plugins). A quick greppable check the owner can run:
`grep -rl "settingsNamespace\|installSettingsSection" ~/.dsh/profiles/web/node_modules --include=*.js`.

### B.4 Draft author notes — **DRAFT, for the owner to approve; nothing was posted**

Per the existing replies-directory convention these are marked `Status: **DRAFT — NOT POSTED**`. The
`dsh-at-file` repo is English (`AGENTS.md`, English README); `@zseven-w/dsh-noema` ships a Chinese README/comment
body, so that note is offered in Chinese with an English fallback.

**Only one note is actually needed.** `@zseven-w/dsh-noema` already fixed this upstream
(**§B.5**): 0.1.0-rc.4 no longer imports the removed helper. The Chinese/English noema notes in §B.4.2/B.4.3 are
therefore kept **downgraded to a context record**, not a report to send — they describe rc.3, the installed
build. Send the `dsh-at-file` note (§B.4.1) only.

#### B.4.1 Draft note — `dsh-at-file` (author: omdsh-dev) — English

> Status: **DRAFT — NOT POSTED** (owner approval required)
>
> **`dsh-at-file` 0.6.8 cannot mount on the current `@deepseek-ai/dsh-settings`: one removed export.**
>
> On `@deepseek-ai/dsh` 0.1.5-rc.1 with `@deepseek-ai/dsh-settings` **0.1.5-rc.2**, enabling the plugin fails at
> ESM link time with:
>
> ```
> SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
>     at …/dsh-at-file/lib/index.js:15862
> ```
>
> The installed package exports exactly `SettingsConflictError`, `SettingsProvider`, `default` and
> `redactSecrets` (verified by importing `@deepseek-ai/dsh-settings/lib/index.js`). `settingsNamespace` is not
> exported by 0.1.5-rc.2, nor by any release since **0.1.2-rc.1**; it existed through 0.1.1-rc.2 (verified from
> the published tarballs). `lib/index.js:15862-15863` imports it statically and calls it at module top level
> (`var AT_FILE_NAMESPACE = settingsNamespace("at-file")`), consumed at `:15888` in
> `ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, …)`. Because the binding is missing, the
> module never finishes instantiation and `apply()` never runs — the plugin does not mount at all, it does not
> partially degrade.
>
> The current API in 0.1.5-rc.2 takes the namespace as a plain string:
> `ctx.settings.register('at-file', AtFileSettingsSchema, { applies: 'live' })`. The brand helper was removed
> along with `deepEqualJson` and `installSettingsSection` (renamed to the provider's `installSection`). So this
> is a "targets an older settings API", not an installed-package bug: `settingsNamespace` is gone, not renamed.
> `peerDependencies` here declares `"@deepseek-ai/dsh-settings": "*"` **with `peerDependenciesMeta` marking every
> peer — settings included — `optional: true`**, which is what let the breaking removal through in the first
> place. A one-line change to the plain-string form
> (`ctx.settings.register('at-file', AtFileSettingsSchema, { applies: 'live' })`) plus a peer floor of
> `>=0.1.2-rc.1` would restore mounting. Happy to verify a build against 0.1.5-rc.2 if useful.

#### B.4.2 Context record (NOT for sending) — `@zseven-w/dsh-noema` rc.3 — Chinese

> Status: **DRAFT — NOT POSTED**（需作者确认后再发）— 但见 §B.5：rc.4 已自行修复，此条**无需发送**，仅作记录
>
> **`@zseven-w/dsh-noema` 0.1.0-rc.3 在当前 `@deepseek-ai/dsh-settings` 上无法挂载：缺少一个已被移除的导出。**
>
> 环境：`@deepseek-ai/dsh` 0.1.5-rc.1，`@deepseek-ai/dsh-settings` **0.1.5-rc.2**。启用插件后 ESM 链接阶段即失败：
>
> ```
> SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
>     at …/@zseven-w/dsh-noema/lib/settings.js:2
> ```
>
> 已实测（直接 import `@deepseek-ai/dsh-settings/lib/index.js`）：0.1.5-rc.2 的运行时导出只有
> `SettingsConflictError`、`SettingsProvider`、`default`、`redactSecrets`。`settingsNamespace` 自
> **0.1.2-rc.1** 起已从所有发布版本中消失（0.1.1-rc.2 及更早还有，已逐个核对已发布 tarball）。
> `lib/settings.js:2` 是顶层静态 import，`:27` 在模块顶层求值
> （`export const NOEMA_MEMORY_SETTINGS_NS = settingsNamespace(NOEMA_MEMORY_SETTINGS_NAMESPACE)`），
> 且被 `lib/index.js:2` 静态引入并再导出——不存在惰性/死代码路径。因此 `lib/index.js` 在实例化阶段即抛错，
> 插件的 `apply()` 完全不会执行，插件无法挂载。
>
> 现行 API 直接接受普通字符串命名空间：
> `ctx.settings.register('noema-memory', NOEMA_MEMORY_SETTINGS_SCHEMA, { base, applies })`，返回
> `SettingsScope`；`installSettingsSection` 也已改名为 provider 上的 `installSection`。也就是说这不是"装错版本"，
> 而是插件针对的是已被删除的旧 settings API（`settingsNamespace` 是移除，不是改名）。
> `peerDependencies` 里 `"@deepseek-ai/dsh-settings": "^0.1.0-rc.6"` 允许 0.1.5-rc.2，所以升级后才暴露出来。
> 若需要，我可以提供一个针对 0.1.5-rc.2 的验证环境来复核修复版本。

#### B.4.3 Context record (NOT for sending) — `@zseven-w/dsh-noema` rc.3 — English fallback

> Status: **DRAFT — NOT POSTED**; superseded by the author's own rc.4 fix — record only, do not send.
>
> `@zseven-w/dsh-noema` 0.1.0-rc.3 cannot mount on `@deepseek-ai/dsh-settings` 0.1.5-rc.2 (with
> `@deepseek-ai/dsh` 0.1.5-rc.1): the ESM link step fails with
> `SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'`
> at `lib/settings.js:2`. The installed runtime exports are exactly `SettingsConflictError`, `SettingsProvider`,
> `default`, `redactSecrets`; `settingsNamespace` has been absent from every release since **0.1.2-rc.1**
> (present through 0.1.1-rc.2 — checked against the published tarballs). The import is static and top-level,
> evaluated at `lib/settings.js:27` and re-exported from `lib/index.js:2`, so the module dies during
> instantiation and `apply()` never runs — no partial mount. The current API takes the namespace as a plain
> string (`ctx.settings.register('noema-memory', schema, { base, applies })`), and `installSettingsSection` is
> now the provider's `installSection`. This is a plugin-vs-removed-API mismatch rather than a wrong version:
> `settingsNamespace` was removed, not renamed. The declared peer range `^0.1.0-rc.6` admits 0.1.5-rc.2, which
> is why the breakage surfaced only on upgrade. I can verify a fixed build against 0.1.5-rc.2 if useful.

### B.5 Recommended action for the owner — one fix is already published

**`@zseven-w/dsh-noema`: fix the version, not the plugin.** MEASURED: `@zseven-w/dsh-noema` **0.1.0-rc.4** is
already on the registry (`latest` = `next` = `0.1.0-rc.4`), and its `lib/settings.js` no longer imports the
removed helper — it declares `export const NOEMA_MEMORY_SETTINGS_NS = NOEMA_MEMORY_SETTINGS_NAMESPACE;` (a plain
literal, with an in-source comment "Since DSH 0.1.5 the provider takes the plain literal and validates it
itself (the exported `settingsNamespace` brand helper was removed)"), registers with
`settings.register(NOEMA_MEMORY_SETTINGS_NS, NOEMA_MEMORY_SETTINGS_SCHEMA, {…})` (`lib/settings.js:31,106`), and
narrows the peer range to `"@deepseek-ai/dsh-settings": "^0.1.5-rc.1"` while moving the optional platform
packages to 0.1.0-rc.4. The installed rc.3 is the broken build and the authors have moved on. Bumping it is the
whole fix, but two constraints must be respected together:

```bash
# NOT run here (environment had to stay read-only). Requires an explicit owner decision:
#   pnpm add @zseven-w/dsh-noema@0.1.0-rc.4 @zseven-w/dsh-noema-darwin-arm64@0.1.0-rc.4
# then remove the `- id: dsh-noema / disabled: true` block from cordis.patch.yml and reboot.
```

The `@zseven-w/dsh-noema-darwin-arm64@0.1.0-rc.1` currently installed is *not* in rc.4's optional set
(it wants 0.1.0-rc.4), and the profile's own history records a past failure where the platform binary was missed
by pnpm's selective optional install (the 2026-08-16 entry in `dsh-doctor/交接清单.md`) — so bump both rows in
one command. **UNVERIFIED**: I did not install rc.4 (environment had to stay read-only), and the import of an
extracted rc.4 tarball could not be exercised outside the profile tree. The static evidence for "rc.4 targets the
current API" is conclusive (import gone, plain literal, peer `^0.1.5-rc.1`); the end-to-end mount is not.

**`dsh-at-file`: needs an author release; no user-side fix.** The pinned GitHub tarball (0.6.8) still imports
`settingsNamespace`, and so does the only registry release, `dsh-at-file@0.6.3` (`lib/index.js:15817-15818`, peer
`"@deepseek-ai/dsh-settings": "*"`). So no available build works. Keep it disabled, send §B.4.1, and watch for a
build whose `lib/index.js` no longer contains `settingsNamespace`. Note the profile consumes a pinned commit
tarball (`c37b0ed9…`), so a fixed release also requires editing the `dsh-at-file` specifier in
`~/.dsh/profiles/web/package.json`, not just a version bump.

**Do not un-disable either plugin while its current build is installed.** Neither can mount, and per §B.3 the
blast radius of an enabled-but-unloadable entry is not confined to that entry. Keep both `disabled: true` rows
until the fixed build is installed.

---

## C — S12: 13 session logs refuse migration — safe recovery runbook

### C.1 Finding restated

dsh-doctor S12 reports 13 of the store's authoritative session logs are refused by the installed migration
chain. Known split: 3 by the `subagent/descriptor` version gate, 10 by
`permission/preset … unexpected member "origin"`. Refusal is fail-closed and side-effect-free (the logs keep
their bytes and mtimes; no `.v3` artifact is produced).

Source material consulted: `dsh-security/docs/session-shape-v3.md` (event shapes; the migration-refusal split is
in `docs/upstream-compat-audit-2026-09.md` §R8 and `dsh-doctor/docs/replies/reply-5978.md`,
`reply-6045.md`). **Note:** `session-shape-v3.md` documents event shapes, not the refusal inventory, so the
refusal counts below were re-measured directly rather than taken from it.

### C.2 Evidence gathered (all MEASURED, read-only)

Store: `/Users/waterfly/.dsh/sessions` — 4 project dirs, **100** `session*.jsonl*` files; the generation-aware
authoritative set (highest generation per session directory) is **88** logs: **40** at v0 (`session.jsonl.zstd`)
and **48** at v3 (`session.v3.jsonl.zstd`). Running the real chain exactly as the product does —
`sessionFormatCatalog.createRestore(header, { validation: 'current', recovery: 'strict' })`, every row through
`decodeRow`, then `finish()` — gives **75 restored / 13 refused**, matching the finding:

| Rule | Count | All in |
|---|---|---|
| `@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: permission/preset 0 data has unexpected member "origin"` | **10** | `--Users-waterfly-dsh~5DE5~4F5C~533A--/session-{372075c7,731b43fd,7a410d4d,8d782108,94b50c1c,9f42a473,a6daf4d0,b17380c9,e01133ae,ff7acd38}-…` |
| `subagent/descriptor 0 uses unsupported descriptor version 2` | **3** | `--Users-waterfly-dsh~5DE5~4F5C~533A--/{423283e8-c812-4376-8a4b-94aa156ffd25, 755b7d4b-2d1a-45fb-b343-95697e2e8022, bdf193d4-563e-4ed5-aaee-48a81f56c048}` |

Every refused log is at generation v0, is a single directory with no newer companion generation, and is
self-consistent (no read/decompress failures). Root causes, READ FROM SOURCE:

- `permission/preset`: `dsh-session-format-v0-to-v1/lib/index.js:119` freezes
  `disposition(["preset"])` (required `preset`, **no** optional members); `assertReleasedV0Keys` (`:257-266`)
  throws on the first key outside `required ∪ optional`. Each affected log has exactly one such row — the
  session-opening `{"type":"permission/preset","seq":0,"data":{"preset":"workspace-write","origin":"default"}}`
  — so dropping `data.origin` satisfies the frozen inventory. The failing member is on row 2 of the
  decompressed file (row 1 is the `session` header) in all 10 logs, and in the two logs I counted in full it is
  the only `permission/preset` row (280 and 139 rows total).
- `subagent/descriptor`: `dsh-session-format-v0-to-v1/lib/index.js:1584` requires `data.version === 3` for a v0
  artifact (`SUBAGENT_DESCRIPTOR_VERSION = 3`, `dsh-subagent/lib/index.js:1300`); version 2 throws
  `SessionFormatUnsupportedMigrationError` (`:1586`). The three logs each carry exactly one descriptor, on row 2,
  with `{"version":2,"mode":"continuable","provider":"spawn","label":…,"agentProvider":…,"agentModel":…}` — a
  shape `subagentDescriptorValue` (`:1289-1310`) accepts at v3 for `mode: "continuable"` with paired
  agentProvider/agentModel.

**Recovery proven on copies (MEASURED — writes confined to `/tmp`; the originals were only read).** For all 13
refused logs I copied the `.jsonl.zstd`, decoded every frame, applied only the class edit, re-encoded with the
store's own frame options (`zstdCompressSync(..., { params: { [ZSTD_c_checksumFlag]: 1 } })`) and re-ran the
real chain on the copy: **13/13 restore**, with one edit each, no secondary refusals. Verification used
`validation: 'current'`, which runs the installed `Session.fromRestore` validator, so the rewritten logs also
satisfy current-format validation. Event counts after the rewrite (proof the bodies survived):
34, 34, 221, 152, 135, 398, 130, 74, 71, 448, 2479, 31, 46.

Two operational facts worth recording from that run:

1. **Read the container as multi-frame.** The store writes a concatenated-frame container (`scanZstdFrames`,
   `dsh-session-persistence-jsonl/lib/index.js:1280-1360`; `CHECKSUM_OPTIONS` at `:1289`; the frame counts in
   the affected logs are 117, 93, … up to 18129 for the 4.9 MB log). Node's one-shot
   `zlib.zstdDecompressSync` returns **only the first frame** (MEASURED: it recovered just the header line of a
   multi-frame log). The `zstd` CLI decodes all frames correctly (`zstd -dc`), which is what the doctor and the
   proof script use.
2. **Re-encoding as one checksummed frame is accepted.** A single-frame rewrite decodes with both `zstd -dc`
   and the product's decoder, restores through the real chain, and is smaller than the original per-batch
   container (e.g. 68,289 B → 43,781 B; 4,924,783 B → 1,631,180 B) because the store flushes one frame per
   event batch at default compression. A frame-preserving rewrite (one output frame per input frame) is
   possible but needs a correct frame walker — the store's own `scanZstdFrames` is the reference; my first
   hand-rolled framer was off by the 1-byte frame-header descriptor and produced a corrupt 0-frame file, which
   is exactly why the runbook below re-validates any output with `createRestore` before it goes near the store.

### C.3 Safety warning (read first)

**This runbook mutates session logs.** Session logs are the only durable record of past sessions; a bad rewrite
can make an already-unreadable log unrecoverable, and a partially written file is worse than a refused one. The
steps below are therefore: full backup → work on a copy → prove the copy restores → only then replace the
original, keeping the original bytes under a non-loggable name. **Do not run any of this on a live store while
`dsh` is running** (a session that is open can be appended to; the harness must be stopped), and **do not
delete or overwrite the originals** — the pre-edit bytes are the recovery of last resort if an upstream fix
landing later turns out to be the better path. Nothing in §C.4 has been executed against
`~/.dsh/sessions`; only the copy path in `/tmp` was executed.

### C.4 Runbook

Working variables used below:

```bash
STORE="$HOME/.dsh/sessions"
SES="--Users-waterfly-dsh~5DE5~4F5C~533A--"     # the project dir holding all 13
BK="$HOME/dsh-session-backup-$(date +%Y%m%d-%H%M%S)"
LOG="$STORE/$SES/session-ff7acd38-5263-42ca-adf8-d1d93503b9a4"   # example, class 2
```

**Step 0 — stop the harness, then back up the whole store (full copy, not just the 13).**

```bash
# confirm nothing is writing (no dsh process holds the store open)
pgrep -fl "dsh" || echo "no dsh process"
mkdir -p "$BK"
cp -Rp "$STORE" "$BK/sessions"
# integrity record: sha256 + size of every log, to prove the originals are untouched later
( cd "$STORE" && find . -name 'session*.jsonl*' -print0 | xargs -0 shasum -a 256 ) > "$BK/sha256-before.txt"
wc -l "$BK/sha256-before.txt"
```

**Step 1 — confirm the exact refusal set (unchanged from the finding) and that failure is side-effect-free.**
Run the doctor's S12 pre-check; it runs the installed chain **in memory** and writes nothing:

```bash
npx @moonquake2004/dsh-doctor --session    # or the local plugin: node ~/dsh工作区/dsh-doctor/plugin/dsh-doctor.mjs --session
( cd "$STORE" && find . -name 'session*.jsonl*' -print0 | xargs -0 shasum -a 256 ) > /tmp/sha256-after-scan.txt
diff "$BK/sha256-before.txt" /tmp/sha256-after-scan.txt && echo "scan touched nothing"
ls "$STORE/$SES"/*/session.v3.jsonl.zstd 2>/dev/null | wc -l   # must be unchanged after a scan
```

**Step 2 — for each refused log, work on a copy in a scratch tree (never in place).**

```bash
mkdir -p /tmp/s12-work
cp -p "$LOG/session.jsonl.zstd" /tmp/s12-work/ff7acd38.jsonl.zstd
shasum -a 256 "$LOG/session.jsonl.zstd" /tmp/s12-work/ff7acd38.jsonl.zstd   # must match
```

**Step 3 — apply the minimal class edit (this is the only content change).**
Decompress with the CLI (multi-frame!), edit exactly one row, re-encode as a checksummed frame with Node's zstd
(the store's own encoder options), then prove it on the copy.

```bash
cat > /tmp/s12-work/fix.mjs <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { zstdCompressSync, constants } from 'node:zlib';
const [src, dst] = process.argv.slice(2);
const plain = execFileSync('zstd', ['-dc', src], { maxBuffer: 1 << 30 }).toString('utf8');
const edits = [];
const rows = plain.split('\n');
const out = rows.map((line, i) => {
  if (!line.trim()) return line;
  let o; try { o = JSON.parse(line); } catch { return line; }   // header row parses like any other
  const notes = [];
  if (o?.type === 'permission/preset' && o.data && Object.hasOwn(o.data, 'origin')) {
    delete o.data.origin;                                       // class 2: member outside the frozen inventory
    notes.push('permission/preset: dropped data.origin');
  }
  if (o?.type === 'subagent/descriptor' && o.data?.version === 2) {
    o.data.version = 3;                                         // class 1: version gate wants 3
    notes.push('subagent/descriptor: data.version 2 -> 3');
  }
  if (notes.length) edits.push(`row ${i + 1} (${o.type} seq ${o.seq}): ${notes.join(', ')}`);
  return notes.length ? JSON.stringify(o) : line;
});
writeFileSync(dst, zstdCompressSync(Buffer.from(out.join('\n'), 'utf8'),
  { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
console.log(edits.join('\n') || '(no edit needed)');
EOF

node /tmp/s12-work/fix.mjs /tmp/s12-work/ff7acd38.jsonl.zstd /tmp/s12-work/ff7acd38.fixed.jsonl.zstd
# -> row 2 (permission/preset seq 0): permission/preset: dropped data.origin
```

**Step 4 — verify the rewritten copy with the real chain, before anything touches the store.**
`validation: 'current'` + `recovery: 'strict'` is the same call the product makes; `finish()` reaching the
artifact is the pass condition. (The 13-log proof in §C.2 used exactly this.)

```bash
cat > /tmp/s12-work/verify.mjs <<'EOF'
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const CAT = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js';
const { sessionFormatCatalog } = createRequire(CAT)(CAT);
const text = execFileSync('zstd', ['-dc', process.argv[2]], { maxBuffer: 1 << 30 }).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim());
const r = sessionFormatCatalog.createRestore(JSON.parse(lines[0]), { validation: 'current', recovery: 'strict' });
for (let i = 1; i < lines.length; i++) r.decodeRow(JSON.parse(lines[i]));
const a = r.finish();
console.log('RESTORES', 'version=' + a.header.version, 'events=' + a.events.length);
// byte-for-byte proof that only the intended field changed:
const before = execFileSync('zstd', ['-dc', process.argv[3]], { maxBuffer: 1 << 30 }).toString('utf8');
const b = before.split('\n'), f = text.split('\n');
let diff = 0;
for (let i = 0; i < Math.max(b.length, f.length); i++) if (b[i] !== f[i]) { diff++; console.log('changed row', i + 1); }
console.log('rows changed:', diff);
EOF

node /tmp/s12-work/verify.mjs /tmp/s12-work/ff7acd38.fixed.jsonl.zstd /tmp/s12-work/ff7acd38.jsonl.zstd
# expected: RESTORES version=3 events=46 ; rows changed: 1
```

Stop here and do not proceed for that log if `createRestore` throws, if more than one row changed, or if the
event count looks wrong relative to the original line count.

**Step 5 — swap the verified copy in, with a per-session byte backup next to it.**
Only after step 4 passes, and only with the harness stopped:

```bash
cd "$LOG"
cp -p session.jsonl.zstd "$BK/ff7acd38.session.jsonl.zstd.orig"    # 2nd copy, outside the store
cp -p /tmp/s12-work/ff7acd38.fixed.jsonl.zstd session.jsonl.zstd   # atomic-ish: same filesystem
shasum -a 256 session.jsonl.zstd /tmp/s12-work/ff7acd38.fixed.jsonl.zstd
```

Do **not** delete `session.jsonl.zstd` and do not create a bogus `session.v3.jsonl.zstd` by hand; let the
harness perform its own migration on first open, which is what produces the v3 generation legitimately.

**Step 6 — re-run S12, then open the recovered sessions one at a time.** S12 should drop from 13 refusals to 0.
Keep `$BK` until every recovered session has been opened and its content checked.

**Per-class minimal edit — exact definition (nothing else is required):**

| Class | Count | File | Exact minimal edit |
|---|---|---|---|
| `permission/preset … unexpected member "origin"` | 10 | `session.jsonl.zstd`, decompressed row 2 (`seq 0`, `type: permission/preset`) | delete the `data.origin` member, keep `data.preset` → `{"data":{"preset":"workspace-write"}}` |
| `subagent/descriptor … unsupported descriptor version 2` | 3 | `session.jsonl.zstd`, decompressed row 2 (`seq 0`, `type: subagent/descriptor`) | set `data.version` from `2` to `3`; all other members already satisfy the v3 shape |

### C.5 Risks of the runbook, and what is not verified

- **Data risk if the swap is done without step 4.** A syntactically valid but semantically wrong rewrite can
  turn a refused log into a log that opens with missing/extra events. Mitigated by the backup, the copy-first
  order, and the single-row diff check.
- **Frame-container risk.** The store's container is multi-frame and read by a frame scanner. The proven rewrite
  emits **one** checksummed frame; `zstd -dc` and the product's decoder both read it (all 13 proof logs
  restored), but **UNVERIFIED**: that the harness's own write-path/append path is happy to *append* to a
  single-frame file. The mutated logs are historical v0 logs; treat the recovered artifact as read-only and let
  the harness migrate it on open, or keep the original bytes for the append path. A frame-preserving rewrite
  would avoid this question; it is **UNVERIFIED** here (my hand-rolled walker was wrong, so the recipe above
  deliberately uses the tested single-frame encoder and validates output through the real chain instead).
- **Semantic risk of the version bump (class 1).** `2 → 3` is a *fabricated* descriptor version. The v0→v1
  validator requires exactly 3 and `data.version` is otherwise opaque to the chain, but
  **UNVERIFIED**: that no later consumer (e.g. subagent resume) branches on descriptor version 3 and then
  expects a field these three descriptors lack. The three payloads already carry every member
  `subagentDescriptorValue` checks for a continuable descriptor, so the shape fits; the behavioural
  consequence is not observed.
- **Concurrency risk.** Rewriting a log that a running harness has open can interleave with an append. Step 0
  stops the harness; do not skip it.
- **The better fix may be upstream.** The refusal is fail-closed, side-effect-free and already reported
  (`reply-5978.md`, `reply-6045.md`: the disposition is too strict for a historically released member, and the
  descriptor gate is too strict for the v2→v3 window). Recovering the 13 locally is a workaround for
  *availability now*; relaxing the frozen disposition / the literal `!== 3` gate upstream is the fix that keeps
  future readers honest. Do the local recovery only if the sessions are actually needed before an upstream
  release lands.
- **No side effects were produced.** MEASURED: the whole survey ran read-only (chain runs in memory, all
  rewrites in `/tmp`); the store's own bytes were never written. The final authority is the owner's re-run of
  step 1's hash comparison.

---

## Summary of unverified items

1. **A** — no fix command was executed (environment kept read-only). `pnpm update js-yaml@4.3.2` /
   override + `pnpm install --lockfile-only` are derived from the lockfile graph and pnpm 12.3.4's documented
   flags; the post-upgrade `pnpm audit` clean result is expected, not observed.
2. **B** — whether the host treats a failed entry import as fatal-to-boot, as a failed-entry diagnostic, or as
   an include-group rollback that also tears down healthy siblings when a plugin is enabled was not exercised
   against this profile (that requires editing the profile patch). The `SyntaxError`, the no-evaluation
   behaviour, and the loader's "disabled ⇒ never imported" rule are MEASURED; the boot-level blast radius in
   this profile is not.
3. **B** — whether other profile packages besides the two reported ones import the removed
   `settingsNamespace`/`installSettingsSection` was not swept.
4. **B** — the doctor's P16 prose says `redactSettings`; the installed name is `redactSecrets` (MEASURED).
5. **B** — `@zseven-w/dsh-noema@0.1.0-rc.4` was inspected statically as a published tarball, not installed and
   mounted, so "the rc.4 bump plus the rc.4 platform binary restores the plugin" is a strong static inference,
   not an observed boot.
6. **C** — the runbook was not executed against `~/.dsh/sessions`; only `/tmp` copies were rewritten. Frame
   appendability of a single-frame rewrite and the behavioural safety of the fabricated descriptor version
   (`2 → 3`) remain unverified.
7. **C** — `dsh-security/docs/session-shape-v3.md` is an event-shape spec, not the refusal inventory; the
   3/10 split was re-measured from the store rather than taken from that document.
8. **C — live store observation.** While this survey ran, the store was demonstrably live: many
   `session.v3.jsonl.zstd` files and their `session.lock` siblings carry mtimes after `2026-09-13 00:00`
   (i.e. the very session that produced this report was appending). None of the 13 v0 logs were among them, and
   no profile file's mtime changed. This is exactly why the runbook's step 0 stops the harness before any
   rewrite: a session that is open is being appended to, and rewriting it under a running loader can interleave
   with an append.

---

## Environment integrity (read-only proof)

SHA-256 of the files a fix would touch, taken after all inspection and experiment (unchanged from the start of
the session):

```
249a4cb6048e63893e2f0aa2460dd65e54cf46453340e1436829fa644eec1fd1  /Users/waterfly/.dsh/profiles/web/pnpm-lock.yaml
162d7ec48d537f84b87f200691707135655fbdd031bbf61e33dd8c756f112b9b  /Users/waterfly/.dsh/profiles/web/package.json
34da97c44ce9f476635fe2ad9d1f1f97e2139397a1ff2a2e6dd55dbf3faf1fef  /Users/waterfly/.dsh/profiles/web/cordis.patch.yml
8277f965c95d08b22d9062d8f5544c270db01c30999e38f2db3c0212dda628fc  /Users/waterfly/.dsh/profiles/web/pnpm-workspace.yaml
```

No new `.bak` files, no `node_modules` change, no file under `~/.dsh/sessions` written by this session (the
mtimes that moved there belong to the still-running host appending its own live sessions). The rewritten
session copies and the proof scripts remain under `/tmp/dsh-verify-11034/` for the owner to re-run or delete.
