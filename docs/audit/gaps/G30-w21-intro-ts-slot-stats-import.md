# G30 — intro page TS slot: `stats()` (a removed sink) + a promised `import "crust"` that has no entry to resolve to

**Doc:** website `src/pages/docs/intro.mdx` L38–79 (the five "same
pipelines as a .ts script" examples, audit W21). Audit W21 (X), code review
group (l) subtopic (11), 2026-10-21.

## Measured (page vs `src/`, both read 2026-10-21)

The page's own comment (L39–42, verbatim):

> // The same pipelines as a .ts script — bun script.ts
> // (or pasted into `bun repl`; crust's globals are auto-loaded
> //  when the script imports from "crust").

Two distinct claims, both false:

1. **The import mechanism does not exist.** No import line appears anywhere
   above the five examples, and the two runtimes the comment names — plain
   `bun script.ts` and `bun repl` — never enter `loadConfig`, so none of the
   bare names (`range`, `parallel`, `expectStage`, `readAll`, `POST`,
   `glob`, `Pipeline`, …) exist there (W227 C, group (d): the L70–90 map
   runs only in the crust bootstrap; plain bun never calls it). The comment's
   escape hatch — "auto-loaded when the script imports from `crust`" — is
   equally empty: the staged npm package has NO exports/main/module/index
   (group (l) subtopic (10) on disk; G13 Q1, probe P5: `import("crust")` →
   `Cannot find package 'crust'`, byte-identical to the no-entry control
   `fakecrust`, distinct from the `left-pad` positive control). As written,
   all five examples throw `ReferenceError` under both named runtimes.
2. **Example 1's `.to(stats())` calls a REMOVED sink in the wrong shape.**
   `stats` exists in no TS context: the 2026-10-21 bounded `^export` grep
   across `src/{transforms,sinks,sources,pipeline,index}.ts` finds no
   `stats` export anywhere (only `statsStage`, transforms.ts L619), and the
   injection map (config.ts L75–90 re-verified this unit) carries no `stats`
   (`statsStage` at L88) — `stats` is a shell-only name (lexer
   `classifyStats`). The tombstone is on disk (G26, group (e)): the old
   `stats()` sink was deliberately removed (it hardcoded every latency to 0
   and reported fabricated percentiles). And the `.to(…)` shape would be
   wrong for the replacement too: `statsStage` is a STAGE (yields per-window
   + a final tagged summary), and `Pipeline.to` (pipeline.ts L140–142)
   resolves `sink(this)` and never consumes a returned pipeline — the
   correct terminal form is `.pipe(statsStage())` consumed by iteration.
   Same drift, same fix shape, as G26 (mock-server.mdx L526–563, W525).

Export-surface verdict for the row's six names (2026-10-21 grep):
`readAll` ✓ sources.ts L139 · `glob` ✓ sources.ts L81 · `POST` ✓
transforms.ts L180 · `statsStage` ✓ transforms.ts L619 · `expect` ✓
transforms.ts L211 (the export name — `expectStage` is NOT exported; it is
the map alias at config L83) · `stats` ✗ nowhere (shell-only; the tombstone
above). So a standalone-imports version of the examples would import
`expect`, not `expectStage` — one more reason the bare-name comment form is
the only form that works, and it only works inside the crust runtime.

Context: 288b2d3 (2026-10-06) already fixed this drift class on five pages
("a file run by plain bun never starts crust and gets none of them"); G24
(W144, npm-packages TS tour), W40 (npm-packages L44, X — trivial in-place
candidate carrying the same `.to(stats())` shape) and G26 (W525) are the
surviving instances on other pages. intro.mdx is the one G13's fix list
does not cover — its list stops at npm-packages/db-drivers/AGENTS.md.

## Impact

The intro page is the first page a new user reads, and its TS slot promises a
two-line story ("run it with bun; globals come from `import "crust"`) that
fails on line one of every example. Copying example 1 also resurrects an API
that was deliberately removed for fabricating numbers — the same defect
class this audit exists to catch.

## Out of scope for this gap (cross-refs, NOT closed here)

- The no-exports-map structural issue is G13. If G13's fix ever adds an
  importable entry, this gap's comment half may be restated in terms of it —
  until then the fix must NOT re-promise `import "crust"`.
- W40 (npm-packages L44) is a separate page's instance of the same drift
  (X on disk, trivial in-place candidate) — not closed here.
- W21's (b) queue item (run the five examples as written under plain bun and
  as a `crust file.crust` script; record which names resolve) stays in the
  probe queue — runtime corroboration, not needed for the fix.

## Fix

Website, `intro.mdx` L38–79:

1. **Example 1 (immediately actionable):** `.to(stats())` →
   `.pipe(statsStage())` consumed by iteration (e.g. `.collect()` or a
   `for await`), matching the bash slot's `| stats` semantics via the real
   stage (G26's preferred shape).
2. **The L39–42 comment:** reword to the real runtime — the examples run
   where crust starts its runtime (crust script mode / REPL / `source`), not
   under plain `bun script.ts` / `bun repl`; or convert the slot to explicit
   imports from the checkout (`import { Pipeline, range, …, expect,
   statsStage } from "../src/…"`, the U129 honest form), renaming
   `expectStage` → `expect`. Do NOT promise `import "crust"` (G13).
3. Verify examples 2–5 carry no other ghost names (2026-10-21 read: they do
   not — `readAll`/`POST`/`glob`/`Pipeline`/`Bun.sql` all resolve in the
   map; `Bun.sql` is a genuine Bun global).

Verification: run the fixed slot end-to-end under the runtime the comment
names (`bun src/index.ts` scratch script / `.crust` file) — `--check` and
`lint-examples` parse only and will NOT catch a ReferenceError; website
`bun run build` + `bun scripts/lint-examples.mjs ../crust/bin/crust` +
`bun run check-links`.

## Commit

`fix(docs): intro TS slot — name the real runtime and use statsStage (audit W21)` (website).
