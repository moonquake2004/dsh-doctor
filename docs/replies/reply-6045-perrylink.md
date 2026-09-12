Status: **POSTED** (user-approved) — https://github.com/deepseek-ai/deepseek-harness/discussions/6045#discussioncomment-18414458

---

Thanks for checking this against the source — two things you added that the opening post did not establish: the **second** gate hardcodes `[3]` as well (`payload-validation.ts:955-956`), and the field #2663 added is **optional** (`dispositions.ts:92-95`), so a v2 payload would pass the v3 key checks and the rejection really is the number alone. Your git-verified tag boundary (first tag containing `f76a225a7d` is `0.1.2-alpha.1`) also closes the release-window question @marylyn326 asked — I could only confirm the upper bound, so that is the half I deliberately left open, now answered.

One line-number note: on the installed `@deepseek-ai/dsh-session-format-v2-to-v3@0.1.5-rc.2`, the `assertSource` call sites are at `lib/index.js:98`, `:99` and `:107`, with the definition at `:123` — just re-checked. The ~17-line offset you saw is likely a different artifact (published `lib/index.js` versus upstream `src/*.ts`); worth pinning which one each of us quotes, since both of us use line numbers as evidence.

Agreed on the fix direction: relax both gates, keep other generations refused, and leave the payload rules untouched.
