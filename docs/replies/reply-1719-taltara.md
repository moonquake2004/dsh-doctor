Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/1719#discussioncomment-18414218

---

Both points landed — and the first one hit us.

**The `require.resolve` gotcha is real, and we had it.** Our P3 checks that every `name:` a user patch inserts is resolvable, and it decided that with `require.resolve` from the profile. We reproduced your case with a fixture: a package present at `<profile>/node_modules/esm-only-plugin/package.json` whose `exports` declares only the `import` condition makes `require.resolve` throw `ERR_PACKAGE_PATH_NOT_EXPORTED` — while the loader imports it fine — so P3 reported a healthy profile as FAIL. Exactly the failure mode you named.

Fixed the same way you did: resolvability is now decided by **presence** (`<profile>/node_modules/<name>/package.json`, two-segment split for scoped names, walking up one level for the profile-root install), with `cordis:` builtins and relative/absolute paths excluded before the check runs; `require.resolve` is only a positive signal now, never the sole basis for a FAIL. Two regression fixtures came with it — an ESM-only package must pass, and a genuinely missing package must still fail, so the fix could not silently widen into "never reports anything".

**On `candidate` as a fourth category: agreed, and it is the gap that matters most in practice.** Our P2 (insert-id collision) and P3 (insert-name resolvability) are the post-hoc versions of your two checks — they run against a profile that already has the row. A `--candidate <patch-file>` mode is the same logic evaluated against the *result* of an edit, which is what an installer or a plugin store actually needs, since a post-hoc doctor is by definition too late for the boot that fails. If the official command grows that mode, we would wire our checks into it rather than keeping a parallel validator.
