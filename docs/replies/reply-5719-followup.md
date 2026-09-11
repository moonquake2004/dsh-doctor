Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/5719#discussioncomment-18402193

---

Following up on this: P17 shipped today in `@moonquake2004/dsh-doctor@0.4.6` (current npm latest). It scans a plugin's client artifacts and resolves each `require("spec")` against three things: the platform seed table introspected from the installed `dsh-web-frontend` build, installed graph rows (`dsh.client` + `exports["./client"]`), and specifiers the package itself declares in `dsh.client.external`/`inject`. Anything left over warns.

```
npx @moonquake2004/dsh-doctor@0.4.6 --profile <name>
```

It is warn-only (comments are stripped first; only double-quoted requires are matched). A module the host genuinely provides can still warn if it is neither a seed nor a graph row — a false positive. If you hit one, reply with the specifier and your install tree.
