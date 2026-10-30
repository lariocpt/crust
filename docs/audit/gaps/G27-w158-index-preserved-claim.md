# G27 — npm-packages page: "Throwing fails the pipeline … with the index preserved" — no such index exists

**Doc:** website `src/pages/docs/npm-packages.mdx` L212 (the "### Async,
errors, and the lifetime model" bullet list). Audit W158 (code half X),
code review group (f), 2026-10-19.

## Measured (page line vs the code, both read 2026-10-19)

Page line (verbatim):

> - **Throwing fails the pipeline** at the offending item, with the index
>   preserved. Downstream sinks (`stats`, `collect`) reject; non-terminal
>   stages propagate.

The throw path, end to end, carries no index:

1. **No index tracking in the pipeline.** `src/pipeline.ts` has no item
   counters in any arm: the pipe fn-arm (L75–83) does `yield await fn(item)`
   with no try/catch, map/filter/reduce forward the thrown error raw, and
   the file's only `throw` is the unsupported-source error (L58). A lambda
   that throws therefore rejects with the user's OWN error object, message
   unchanged.
2. **The line-failure format has no index slot.** The exec-path catch
   (`src/runLine.ts` L288–303) prints `crust: ${(err as Error).message}` and
   returns 1 (L301–302); the only other line-failure writer is the
   in-process builtin dispatch catch (L132–138), same format.
3. **The one index-bearing pipeline error is an `expect` mismatch, not a
   throw.** `ExpectError` (`src/transforms.ts` L187–196) formats
   `expect: item at index ${index} failed matcher ${String(matcher)}` (L193),
   thrown at L217 with that export's own counter `i` (initialized at
   L215, incremented L219) — a per-stage stream position over the items that
   SURVIVED upstream stages, not a preserved source index, and it fires only
   on an `expect` matcher mismatch. Clarified 2026-10-30: that export is
   the TS global `expectStage` (config.ts L83); the shell `expect` stage is
   the different `expectStatus` function (parser.ts L453–454), which
   reports N/M at drain and carries no index. So even the one index in the
   system is not the "preserved" one the page describes.

The rest of the page line IS code-true (recorded on the W158 row this
unit): a throw fails the line at the offending item (raw propagation into
the runLine catch, exit 1); `collect` (pipeline.ts L107–111) rejects when a
mid-iteration throw reaches its for-await; and the generator chain has no
local catch, so a non-terminal stage's throw propagates to the terminal
consumer.

## Impact

A user who throws `new Error("bad item")` in a handler and reads this page
expects the error to identify WHICH item failed. They get exactly `crust:
bad item` — no index — and the only recovery is to have put the index into
the thrown message themselves. The page documents an index-preservation
guarantee the runtime does not have (288b2d3 drift class: a documented API
behavior that does not exist). The twin page that got it right is the
Exit-codes page (W266: `crust: <message>`, exit 1 — confirmed verbatim by
the same read, group (f)); the two pages contradict each other and the code
sides with W266.

## Out of scope for this gap (cross-refs, NOT closed here)

- The W158 throw-on-item-2-of-5 verbatim-capture probe (runtime evidence
  for the exit code and message shape) stays in the (b) queue on the W158
  row; the code half is settled here.
- The W266 good/bad/good fail-fast probe + verbatim format capture stay in
  the (b) queue on the W266 row; its code half closed C the same unit.
- The `ExpectError` message format itself is correct as written — nothing to
  fix on the code side.

## Fix

Website, `npm-packages.mdx` L212 — rewrite the bullet so it describes the
actual contract:

- **Drop "with the index preserved"** and state the real behavior: a throw
  rejects the line with the thrown error's message verbatim (`crust:
  <message>`, exit 1); to identify the item, include it in what you throw
  (e.g. `throw new Error(\`items[${i}]: bad\`)`).
- Optional note, corrected in place 2026-10-30: the ONE index-bearing
  pipeline error is `expect: item at index <n> failed matcher <m>`
  (ExpectError, transforms.ts L187–196; counter `i` in the `expect` export,
  transforms.ts L210–222) — but that export is the TS global `expectStage`
  (config.ts L83), NOT the shell `expect` stage. The shell stage (parser.ts
  L453–454) is `expectStatus` (transforms.ts L424–452), which reports
  `expect <code>: N/M responses did not match` at drain — no index.
  Measured 2026-10-30: `range(0, 1) | (n => ({status: 500})) | expect 200`
  → items pass through, then `crust: expect 200: 2/2 responses did not
  match`, exit 1 (2 items generated). A page bullet should not name the
  index format without that attribution, or it repeats the same drift.

Verification: run a throwing handler through `bun src/index.ts -c`
(throw-on-item-2-of-5, capture the verbatim stderr line + exit code — the
same capture the (b) probe makes) and confirm the rewritten sentence matches
the captured output; website `bun run build` +
`bun scripts/lint-examples.mjs ../crust/bin/crust` + `bun run check-links`.

## Commit

`fix(docs): the throw bullet promised an index the runtime never carries (audit W158)` (website).
