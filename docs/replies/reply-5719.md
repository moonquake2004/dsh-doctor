# Reply draft — deepseek-harness #5719

Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/5719#discussioncomment-18401965

---

Confirmed — that message is a hard throw from the synchronous `require` handed to a
client bundle factory (`dsh-client-modules/lib/client.js:308`, reached via
`makeRequire`). Resolution tries exactly three branches, in order: the platform seed
table (`client.js:303`), the memoized module cache (`:305`), then a registered factory
(`:307`). A factory is only registered by `window.__ModuleLoader__.load({id, factory})`
as that row is arrived, and rows come from the host's boot manifest (`:207`) — so a
specifier is servable only if it is a platform seed, or a graph row for an installed
package carrying a `dsh.client` declaration plus `exports["./client"]`. Platform seeds
are a fixed nine-entry list: `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-dockkit`.

`@deepseek-ai/dsh-client-runtime/client` is on none of those three paths here. Its
last publish was `0.1.1-rc.2` (2026-08-21); nothing in the 0.1.5 tree declares it as a
dependency, and no installed bundle requires it. The 0.1.5 module table ships its
successor under a different name (`@deepseek-ai/dsh-cordis-client-runner`, currently
`0.1.5-rc.2`).

So this is not a host-side version drift — the host simply never provides that
specifier. What to check on your side:

1. Whether `@deepseek-ai/dsh-client-runtime` actually resolves inside your dsh install
   tree, and which version it resolves to.
2. Whether your served boot manifest has any row for it — `window.__DSH_BOOT__.entries`
   in DevTools at boot.
3. Whether `dsh-context-doctor`'s emitted client bundle still requires that path.

We're adding this as a pre-flight: collect a plugin's client-side `require`/import
specifiers, resolve each against the seed list plus the host's graph rows, and warn on
anything that resolves to neither (`P17`, warn-only).

_(Word count of posted body: 252)_
