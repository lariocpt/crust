# G18 — pipelines page: the "SQL placeholders survive untouched" sentence omits the script-positional rule

**Doc:** website `src/pages/docs/agent-skills/pipelines.mdx` L43–49
(audit T3, parity check 2026-10-18).

## Measured (site page vs `skills/crust-pipelines/SKILL.md`, both fully read 2026-10-18)

Site L49:

> SQL placeholders survive untouched: `$1` and `$2` inside a `sql "…"` string
> are safe, because a digit can't start an environment variable name.

SKILL.md L46–50 (the canonical skill):

> In a script, the **positional arguments** expand in those same positions —
> so `$1` inside a `sql "…"` string is the script's `$1`, not a SQL bind: the
> bound-parameter placeholder is `?`, and the trailing quoted args DO
> env-expand: `sql "… WHERE id = ?" "$MY_ID"`.

The canonical usage rows agree with SKILL.md: U8 (positionals expand in exactly
the env-var positions, incl. fn args), U9 (outside script mode positionals are
`""`, "never literal"), U10 ("fn args are positionals not SQL placeholders
(bound param is `?`)"), U57 ("a SQL query's `$1` is the script's, bound param
placeholder is `?`"). The site sentence's reasoning ("a digit can't start an
env-var name") confuses env-var expansion with positional expansion, and is
false in script context where `$1` IS the script's first argument.

## Out of scope for this gap (cross-ref, NOT closed here)

The same `$1`-as-bind example (`sql "SELECT … WHERE email = $1" "a@b.c"`)
appears in SKILL.md L90, the site's worked examples (W264(4)) and the
api-smoke recipe (W460(4), "the positional survives env-expansion per
W463(2)"). If the queued (b) probe (W260: "`a@b.c` must bind, not expand";
W264(4); W460(4)) shows `$1` expanding per U9, both the skill and the site
examples need the `?` form — that is a separate finding, owned by code-review
group (a) (sql builtin binding semantics).

## Fix

Website: in `agent-skills/pipelines.mdx`, replace the last sentence of the
"Where `$VAR` expands" section with the script-context rule, mirroring
SKILL.md L46–50: in a script, positionals expand in the same positions, so
`$1` in a `sql "…"` string is the script's — the bound-parameter placeholder
is `?` (`sql "… WHERE id = ?" "$MY_ID"`); outside scripts positionals are empty,
never literal.

Website commit + gates (`bun run build`, `bun scripts/lint-examples.mjs …`,
`bun run check-links`).

## Commit

`docs(agent-skills): pipelines page — script positionals in sql strings, mirroring the skill` (site).
