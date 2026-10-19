# G26 — mock-server pairing page: the TS burn-in embed calls two API names that do not exist (`stats()`, `startMockServer`)

**Doc:** website `src/pages/docs/recipes/mock-server.mdx` L526–563 ("## Pairing
with crust pipelines", the `ts:` embed). Audit W525 (ts-half code half X),
code review group (e), 2026-10-19.

## Measured (page ts line vs the code, both read 2026-10-19)

Page line:

```ts
import { startMockServer } from "crust/mockServer";
const mock = await startMockServer({ swagger: "./openapi.yaml", port: 4000 });
await range(0, 9999).pipe(parallel(100, () => fetch("http://localhost:4000/pets"))).pipe(expectStage(200)).to(stats());
await mock.stop();
```

Neither of the two called names exists:

1. **`stats`** — a REMOVED sink. `src/sinks.ts` carries the tombstone:
   "The old `stats()` sink lived here; it hardcoded every latency to 0 and
   reported fabricated percentiles. `transforms.statsStage` is the real one."
   No export named `stats` anywhere in `src/`; it is NOT among the 21 injected
   globals (`src/config.ts` L69–90 — `statsStage` IS injected, bare `stats` is
   not). So `stats()` throws ReferenceError in BOTH a standalone TS file and a
   `.crust` script. The real surface is `statsStage(everySec?, out?)`
   (`src/transforms.ts` L619–621) — a STAGE, not a sink: it yields per-window
   and a final tagged summary item, so the terminal form is
   `.pipe(statsStage())` consumed by iteration. (Corollary: the page's `.to(…)`
   shape would be wrong for it anyway — `Pipeline.to` (pipeline.ts L140–142)
   resolves `sink(this)` and never consumes a returned pipeline; passing a
   stage there is a laziness trap.)
2. **`startMockServer`** — zero matches across `src/` and `tests/`;
   `src/mockServer/` has no `index.ts`, so the `crust/mockServer` subpath root
   is absent in-repo as well. The npm package has no exports map at all
   (G13 — the launcher ships a binary, not a library), so NO `crust/…`
   subpath import resolves for users regardless. The high-level boot the page
   wants does not exist under any name; the real in-repo surfaces are the
   file-level ones W485's embed names, and those DO exist (corroborated this
   unit: `loadSpec.ts` L49 `export async function loadSpec(source)`,
   `server.ts` L127 `export async function startServer(opts): Promise<RunningServer>`
   — closing those two is W485's row, not this gap's).

The rest of the line is sound in code (recorded on the W525 row this unit):
`range` returns `Pipeline<number>` (sources.ts L50), `parallel(100, fn)` calls
`fn(item)` per item so the zero-arg fetch fn is fine (transforms.ts L253/L277),
and `expectStage` is the crust-runtime global name for the module export
`expect` (transforms L211; config L83) — a standalone embed would import
`expect` instead.

## Impact

A user copying the "drive it with normal crust pipelines" TS embed gets a
ReferenceError on the first run (`stats`), after a failed module resolution
on the import (`crust/mockServer`) — i.e. the page's flagship pairing example
cannot run as written. Surviving instance of the 288b2d3 drift class (the
`stats` half is the sharpest: the API it names was deliberately removed as
fabricated-percentile-reporting, and the page resurrects it). The bash form of
the same example (the line directly above in the page) IS correct and is the
supported surface.

## Out of scope for this gap (cross-refs, NOT closed here)

- The import-surface/runtime items of the W525 probe plan (in-process
  builtin, `wait :4000/pets` vs `wait port:4000` semantics, the three-line
  switcher, the 10k×100 burn-in timing) stay in the (b) queue on the W525 row.
- The W485 embed's two names (`loadSpec`, `startServer`) and its "not on npm
  yet" release-state claim stay W485's row (still `?`; its two names are
  corroborated present in-repo by this unit's grep).
- The "library isn't on npm yet" / no-exports-map structural issue is G13.

## Fix

Website, `mock-server.mdx` L526–563 ts embed — replace the ghost API with the
real surface. Two acceptable shapes (pick one, keep it parseable by
`lint-examples.mjs`):

- **Prefer: drop the TS embed, keep the bash form.** The bash three-liner is
  the supported usage (in-process builtin + `wait` + pipeline). If a TS embed
  is kept for parity, it must be a `.crust`-script-style example on the
  injected globals (no imports): `range(0, 9999).pipe(parallel(100, () =>
  fetch(…))).pipe(expectStage(200)).pipe(statsStage())` consumed by
  `collect()`/iteration — and it must be RUN, not just parsed (the
  `--check`-only gates won't catch a ReferenceError at runtime).
- Or rewrite it against the real in-repo library surface
  (`loadSpec`/`startServer` from the file paths) with the "in-repo only — the
  library isn't on npm yet" caveat made explicit, i.e. merge it into the W485
  embed's shape so the page carries ONE honest TS story instead of two
  contradictory ones.

Verification: run the replacement example end-to-end (scratch spec + the
burn-in line) via `bun src/index.ts -c` / a scratch `.crust` script; website
`bun run build` + `bun scripts/lint-examples.mjs ../crust/bin/crust` +
`bun run check-links`.

## Commit

`fix(docs): the mock-server pairing embed named a removed sink and a function that does not exist (audit W525)` (website).
