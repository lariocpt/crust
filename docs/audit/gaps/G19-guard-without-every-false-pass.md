# G19 — load gates: the site's guard-without-`--every` sentence inverts the short-circuit (no-op gate, false pass)

**FIXED 2026-10-31** — site `3e60047` (both pages) · W543 (b) probe ran as
pinned (line `?` → C; `~/tmp/g19/`) · T20 annotated · audit (this commit) ·
KB (crust-agent submodule, local commit only — ingest is operator-controlled,
`61c37ef7`): `round-8-false-pass-and-delete.md` gains the no-op-gate section.
**MCP reviewed — no overlap**: website-docs-only fix (the skill already stated
the truth); no functional usage changed, so the nine `crust_*` tools and
`skills/crust-mcp/SKILL.md` stay as-is (the standing order's display-only case,
recorded not skipped).

## The inversion (as filed — site pages vs `skills/crust-load-testing/SKILL.md`, both fully read 2026-10-18)

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

The sentence therefore recommended keeping the guarded form in non-windowed CI
gates — exactly the gates that must not be no-ops: a silent false pass, the
failure class the page's own "Honesty guarantees" section (and design rule 1,
"crust must never report a false pass") exists to prevent. SKILL.md's trap is
plain JS short-circuit semantics plus a measured example.

## The probe (2026-10-31, `~/tmp/g19/probe-g19.sh` — the W543 (b) bundle, part 1)

Server: 350ms rigged latency (measured p95 = 352 — passes 400, fails 200),
`bin/crust-bin` at crust `84cb17b`. The pinned green line (`load 10m 50/s
| parallel 25`) is pace-pinned to `load 3s 10/s | parallel 5` (W535's
duration-pin precedent — the claim under test is the guard's semantics on the
keyless summary, not the pacing); the scratch `:3000/health` target became
`:3799/`.

| case | line (abridged) | exit | measured |
| --- | --- | --- | --- |
| keyless shape | `… stats` + key-set lambda | 0 | `KEYS=[count,wallMs,rps,status,p50,p95,p99,meanMs]` — no `window`, no `final`; p95=352 |
| W543(3) green minus `--every 30` | the two guarded asserts over the one plain summary | **0** | p95=352 through BOTH guards — the no-op gate, live (it fails the 200 the form should have enforced) |
| pinned RED twin | `… assert (s => s.p95 < 200)` unguarded, same summary | **1** | `assert: item 1 failed` — the unguarded 200 catches what the guards skipped; the message JSON is keyless |
| the skill's `s.p95 < 0.1` instance | `… assert (s => !s.window \|\| s.p95 < 0.1)` | **0** | p95=352 (the skill's own measured 4.2, reproduced at 350) |
| `--every` control | `stats --every 2` + the 200 guard | **1** | window object `{"window":1,…,"p95":352}` → the threshold RUNS → `item 1 failed` — the guard gates when its object exists |

Every case did exactly what the pinned (b) spec predicts. The audit row's own
code half had already read C on all five sub-claims; its sub-claim (5) prose
repeated the page's inversion ("the 400/200 thresholds apply to the plain
summary unguarded (the tighter one decides) — 'correct without --every' is
exactly the keyless shape") and is corrected in place in this commit: the
keyless shape makes the guards INERT (neither threshold is evaluated, exit 0 at
any p95) — which is what the twin pair just measured.

## The probe, part 2 — the row's remaining exhibits (`~/tmp/g19/probe-w543.sh`)

Fast server (`:3800`, 0ms) + a completion-count-degrading server (`:3801`,
first 30 completions 0ms, then 350ms — completion-based so the degradation lands
on windows 2+ regardless of wall-clock skew):

- **window numbering + key set** — `load 5s 10/s | parallel 2 | … stats
  --every 2`: windows `1, 2, 3`, each `KEYS=[window,count,wallMs,rps,status,
  p50,p95,p99,meanMs]`;
- **the final object** — last item `KEYS=[final,count,wallMs,rps,status,p50,
  p95,p99,meanMs]` (`final` present, `window` ABSENT) with `count: 50` =
  21+20+9, the sum of the windows' counts (the cumulative's identity);
- **the healthy green N+1 run** — same line + both asserts: all windows + the
  final pass (`400` for windows, `200` for the final), exit 0;
- **the degradation-mid-soak red** — the degrading server: window 1 (p95=0.8)
  passes, the LATE window 2 (p95=352) fails with its `item N` number —
  `assert: item 2 failed` — exit 1. "Fails when it happens" is the delta
  design, confirmed with the item number.

All five probe exhibits the row lists (key sets, the green N+1 run, the
mid-soak red with its `item N` number, the keyless-summary twin pair) are now
captured. W543's `?` — which T20 held open "until the probe runs" — closes as
**C**.

## The fix

Both site pages now mirror SKILL.md L89–93 (site `3e60047`, the dossier's
given message):

- `agent-skills/load-testing.mdx` L77: `` `!s.window ||` scopes a threshold to window objects, `!s.final ||` to the final summary — and a guard needs the object it guards. Without `--every` the plain summary carries neither key, so `!s.window` is true and `||` short-circuits: the threshold never runs — `stats | assert (s => !s.window || s.p95 < 0.1)` exits 0 with p95 at 4.2. Drop the guard when you drop `--every`. ``
- `recipes/ci-load-gates.mdx` L163: the looser-window sentence stays; the inverse sentence becomes the trap — without `--every` the line emits one plain summary carrying neither `window` nor `final`, so both `!s.window` and `!s.final` are true, both `||`s short-circuit, and neither threshold ever runs — the line exits 0 at any p95 (a silent no-op gate, a false pass). Drop the guard when you drop `--every`.

Site gates at `3e60047`: build 31 pages, lint-examples 362 checked / 0 failed,
check-links 1313 (41 with an anchor) / 0 dead — all at baseline.

## W543 / T20 resolution (this commit, `full-audit.md`)

- **W543** (L1246): `?` → **C**. The (b) capture bundle is fully run (the
  keyless twin pair above, part 1; the four remaining exhibits, part 2); the
  code half was already C on all five sub-claims, with sub-claim (5) corrected
  in place — it had repeated the page's "applies unguarded / the tighter one
  decides / correct without --every" inversion, which the probe falsified.
- **T20** (L1463): the X verdict stands as filed (the site's closing sentence
  contradicts SKILL L89–93; the canonical-skill cross-ref settled the X —
  plain JS short-circuit semantics, no probe needed to pick a side); annotated
  that the queued (b) probe ran 2026-10-31 exactly as pinned (exit 0 at any
  p95 + the keyless key set + the unguarded twin's exit 1, `~/tmp/g19/`),
  closing W543's `?`.

## Commit

- site `3e60047` — `docs(load gates): guard without --every is a no-op gate, mirroring the skill trap` (both pages; 2 insertions / 2 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W543/T20 rows in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `61c37ef7`) — `round-8-false-pass-and-delete.md` gains "## 5. A guard without its object is a no-op gate", the false-pass family's home
