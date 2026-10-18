# G22 — api-smoke-tests recipe: "Using the `sql` builtin directly" claims the upstream item is *not* auto-bound; the code binds it as the first parameter

**Doc:** website `src/pages/docs/recipes/api-smoke-tests.mdx` L335 (the "Using
the `sql` builtin directly" section). Audit W477, code review group (a),
2026-10-18.

## Measured (page vs `src/builtinFns/sql.ts`, both read 2026-10-18)

Page L335: "As a transform, the static args become `(query, ...params)`; the
upstream item is *not* auto-bound, so reach for a lambda when you need to
inject a value from the stream."

`src/builtinFns/sql.ts` L66–74 (`sqlStage`):

```ts
const [query, ...declared] = args;
// Bind the piped item as the first parameter when the line declares none.
// It used to be dropped on the floor, so `range(1,1) | sql "… WHERE id = ?"`
// ran with zero params and returned [] — indistinguishable from "no rows
// matched". An explicitly declared parameter still wins.
const params = declared.length === 0 && item !== undefined && item !== null ? [item] : declared;
return runQuery(queryOf(query), params);
```

When the line declares NO params, the piped item IS bound as the first
parameter — the opposite of the page's sentence. The code comment documents
the flip: the item "used to be dropped on the floor", i.e. the page's wording
describes the pre-fix behavior. The advice after the claim ("reach for a
lambda") is still sound for EXPLICIT binding, but the factual premise is
stale.

## Corroboration (the pair agrees on the other side)

`skills/crust-builtins/SKILL.md` L54 (item-meaning table, `sql` row): "the
query stays the one you wrote; the item **binds as the first parameter** when
the line declares none" — the current contract, matching the code. The two
website surfaces (api-smoke-tests L335 vs agent-skills/builtins.mdx
item-meaning table, audit W241) contradict each other; the code sides with
the SKILL/builtins side.

## Out of scope for this gap (cross-refs, NOT closed here)

The rest of W477's probe plan (runtime against a scratch DB: what
`range(0,0)` yields, source-mode one-row-per-item streaming, the TS-half
`collect()` flattening, the direct-`Bun.sql` escape) stays in the (b) queue
on the W477 row. The open `$1`-as-bind question (SKILL L65's worked example
uses `?`, the page L345 uses `$1`; whether Bun's `unsafe` binds one form,
the other, or both) is a (b) probe question, not settled here.

## Fix

Website: rewrite the api-smoke-tests.mdx L335 sentence to the current
contract, e.g. "As a transform, the static args become `(query, ...params)`;
when the line declares no params, the upstream item binds as the first
parameter (an explicitly declared parameter still wins) — use a lambda to
control the value you inject." Align with the builtins page item-meaning
table (W241) and SKILL L54 wording.

Verification: the three surfaces agree (agent-skills builtins table,
crust-builtins SKILL, api-smoke-tests prose); re-run the (b) sql probes
(the live `range(1,1) | sql "… WHERE id = $1"`-shape run) and confirm the
bound item reaches the query; website gates (`bun run build`,
`bun scripts/lint-examples.mjs ../crust/bin/crust`, `bun run check-links`).

## Commit

`docs(recipes): api-smoke-tests sql section — item binds as first param when none declared (audit W477)` (site).
