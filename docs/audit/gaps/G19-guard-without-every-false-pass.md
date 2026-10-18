# G19 — load gates: the site's guard-without-`--every` sentence inverts the short-circuit (no-op gate, false pass)

**Docs:** website `src/pages/docs/agent-skills/load-testing.mdx` L77 and
`src/pages/docs/recipes/ci-load-gates.mdx` L163
(audit T20, parity check 2026-10-18; cross-ref W543).

## Measured (site pages vs `skills/crust-load-testing/SKILL.md`, both fully read 2026-10-18)

Site (ci-load-gates.mdx L163, the longer of the two occurrences):

> Windows may be allowed a looser bound than the final cumulative number — a GC pause is a window-sized event, a slow *average* is a regression. Both guards are also correct without `--every` (the plain summary carries neither key, so the threshold applies unguarded).

Site (agent-skills/load-testing.mdx L77, the shorter occurrence):

> `!s.window ||` scopes a threshold to window objects, `!s.final ||` to the final summary. Both are also correct without `--every`.

SKILL.md L89–93 (the canonical skill):

> Guard `!s.window ||` scopes a threshold to window objects, `!s.final ||` to
> the final summary — and a guard needs the object it guards. Without `--every`
> the plain summary carries neither key, so `!s.window` is true and `||`
> short-circuits: the threshold never runs. `stats | assert (s => !s.window ||
> s.p95 < 0.1)` exits 0 with p95 at 4.2. Drop the guard when you drop `--every`.

The site sentence's stated mechanism is the inverse of what happens. Without
`--every`, `stats` emits one plain summary carrying neither `window` nor
`final`, so `!s.window` is `!undefined` = `true` and `||` short-circuits before
the threshold is ever evaluated: the assert is a no-op and the line exits 0 for
any measured p95. The parenthetical claims the opposite — "the threshold applies
unguarded", i.e. the threshold IS evaluated against the keyless summary. It is
not evaluated.

The sentence therefore recommends keeping the guarded form in non-windowed CI
gates — exactly the gates that must not be no-ops. A line like
`stats | assert (s => !s.window || s.p95 < 400)` without `--every` is a silent
false pass: a "gate" that measures nothing and exits 0, the failure class the
page's own "Honesty guarantees" section (and design rule 1, "crust must never
report a false pass") exists to prevent. SKILL.md's trap statement is plain JS
short-circuit semantics plus a measured example; no probe is needed to pick a
side. The live confirmation is already queued.

## Out of scope for this gap (cross-refs, NOT closed here)

- W543 (the audit row for the ci-load-gates recipe's "Gating a soak" section,
  L153–163) is still `?` with its confirming probe queued in (b): the W543(3)
  green line minus `--every 30` — the same two asserts over one plain summary —
  expect exit 0 at any p95, and capture the summary's key set (no `window`/
  `final`). SK44 carries the twin probe for the skill-side claim.
- W543's other claims (the `{window: k}`/`{final: true}` shapes, per-window
  gating, the degradation-mid-soak probe) are not part of this gap.

## Fix

Website: in BOTH pages, replace the guard-correctness sentence with the
SKILL.md trap, mirroring L89–93: a guard needs the object it guards; without
`--every` the plain summary carries neither key, so `!s.window` is true and
`||` short-circuits — the threshold never runs (`stats | assert (s =>
!s.window || s.p95 < 0.1)` exits 0 with p95 at 4.2); drop the guard when you
drop `--every`.

Website commit + gates (`bun run build`, `bun scripts/lint-examples.mjs …`,
`bun run check-links`).

## Commit

`docs(load gates): guard without --every is a no-op gate, mirroring the skill trap` (site).
