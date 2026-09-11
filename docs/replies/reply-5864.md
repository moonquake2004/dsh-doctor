# Reply draft — deepseek-harness #5864

Status: draft for user approval. Not posted.

---

Thanks for the precise trace — the mechanism reproduces exactly as described, and it is
load-time, not call-time.

**Mechanism confirmed.** Against the published artifacts, `RemoteError` is a *newer* name,
not an older one: `@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6` has zero occurrences and its
bundled `lib/index.js` exports `Remote`, `RemoteScope`, `TypertLookupFailure`,
`TypertRemoteService`, `bindTypertRemote`, `isTypertRemoteSegment`, `remoteMethods` —
no `RemoteError`. `0.1.2-rc.1` adds `RemoteError` and `remoteErrorOf` (7 occurrences). The
current dist-tags still show this split: `latest` = `0.1.0-rc.6`, `next` = `0.1.5-rc.2`,
`alpha` = `0.1.5-alpha.2` — so the stale-`latest` cliff is unchanged.

I reproduced the failure shape with a minimal two-entry tree against the installed
`@deepseek-ai/cordis-plugin-loader`: an entry importing a non-existent named export from a
sibling package dies at instantiation with
`SyntaxError: The requested module '…' does not provide an export named 'RemoteError'`,
surfaced by the loader as
`failed to import loader entry <id> (<name>): …`.

**Blast radius.** That error is not contained to the offending row. The include group
applies its entries together and, on any single failure, rolls the group back — so healthy
siblings that had already started are disposed with it, and the failure propagates out of
the tree. In my fixture, a valid sibling entry was created first and torn down again when
the broken entry was applied. "One bad row" is structurally the whole tree.

This is the loader hard-throw we raised in #2088 alongside the kernel-guard proposal:
entry-level isolation (log and isolate the failing entry instead of aborting boot), plus
boot-time identity pre-validation, would have turned this into one red row plus a named
diagnostic rather than a restart loop.

**On the offline side:** a pre-flight that statically collects a bundle's named imports and
`export … from` names and checks them against the *installed* package that the profile
actually resolves — reporting a warning, not a failure — is landing in dsh-doctor
(`P16`). It catches exactly this mismatch before boot, without needing the host to fail.
