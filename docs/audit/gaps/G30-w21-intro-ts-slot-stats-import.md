# G30 — intro page TS slot: `stats()` (a removed sink) + a promised `import "crust"` that has no entry to resolve to

**FIXED 2026-10-31** — site `b9d6d85` (one page: `src/pages/docs/intro.mdx` — example 1's `.to(stats())` → `.pipe(statsStage()).collect()`) · W21 (filed X) annotated FIXED — its (b) queue item (name resolution under each runtime) ran as part of this unit · X-census entry annotated · audit (this commit) · KB (crust-agent submodule, local commit only — ingest is operator-controlled, `70a53bc1`): `round-9-cli-contract.md` §6 gains the second-specimen closure + the measured name-resolution table. **MCP reviewed — no overlap**: the fix is docs-only — one site page; no `crust_*` tool's behaviour or surface changed, so `src/mcp/` and the skill files stay as-is (the standing order's display-only case, recorded not skipped).

**As-filed claim 1 is STALE against the current page — corrected in place.** The
filed dossier quoted the L39–42 comment as promising "bun script.ts … globals
are auto-loaded when the script imports from 'crust'". That was true when the
row was filed (2026-10-21), but site `9b57e92` (2026-10-30, "a bare 'bun
script.ts' does not get crust's globals") had ALREADY rewritten the comment to
the real runtime before this unit ran:

> // The same pipelines as a .ts script — run it through crust:
> //   crust -c 'source ./script.ts'
> // crust installs its globals wherever IT starts its runtime (-c, the REPL,
> // stdin, .crust files, init.ts, any .ts/.js file crust loads); a plain
> // `bun script.ts` never starts crust, so it gets none of them.

Verified true this unit: `sourceBuiltin` (`src/builtins.ts` L347–351) matches
`/\.(ts|js|mjs)$/` and does a plain `await import(resolved)` INSIDE the crust
process — after `loadConfig` installed the globals — so `crust -c 'source
./script.ts'` is a real runtime for exactly these examples. The comment half
of this gap was therefore already shipped; this unit verified it (probe A1/A3
vs B1) rather than re-fixing it. What remained, and what `b9d6d85` fixes, is
claim 2 — the ghost sink inside the now-correct runtime.

## Measured (page vs `src/`, filed 2026-10-21; re-verified 2026-10-31)

1. **The import mechanism never existed** (the filed claim — mooted by
   `9b57e92`, but the underlying facts stand and were re-confirmed): plain
   `bun script.ts` / `bun repl` never enter `loadConfig`, so none of the bare
   names exist there; and `import "crust"` has nothing to resolve to (no
   exports/main/index in the staged package — G13 Q1 P5). As originally
   written, all five examples threw `ReferenceError` under both named runtimes.
2. **Example 1's `.to(stats())` calls a REMOVED sink in the wrong shape.**
   `stats` exists in no TS context: no `stats` export anywhere in `src/`
   (only `statsStage`, `src/transforms.ts` L623 — as filed L619; refs drifted
   with the file's growth, corrected in place 2026-10-31), and the injection
   map (`src/config.ts` — `statsStage` at L88, `expectStage = expect` at L83)
   carries no bare `stats` — it is a shell-only name (lexer `classifyStats`).
   The tombstone is on disk (G26, group (e)): the old `stats()` sink was
   deliberately removed (hardcoded-zero latencies, fabricated percentiles).
   And `.to(…)` would be wrong for the replacement too: `statsStage` is a
   STAGE — without `everySec` it "consumes the stream and yields ONE summary"
   (transforms.ts L619–622 comment) — and `Pipeline.to` (pipeline.ts L140–142)
   resolves `sink(this)` and never consumes a returned pipeline. Correct
   terminal form: `.pipe(statsStage())` consumed by iteration. Same drift,
   same fix shape, as G26.

Export-surface verdict for the row's six names (re-verified 2026-10-31):
`readAll` ✓ sources.ts L139 · `glob` ✓ sources.ts L81 · `POST` ✓
transforms.ts L180 · `statsStage` ✓ transforms.ts L623 · `expect` ✓
transforms.ts L211 (the export name — `expectStage` is NOT exported; it is
the map alias at config L83) · `stats` ✗ nowhere (shell-only; the tombstone
above). Examples 2–5 carry no other ghost names (fix item 3): the probe's
name table below resolves every bare name they use.

## Impact

The intro page is the first page a new user reads. Its comment half was fixed
mid-campaign (`9b57e92`), but example 1 still resurrected an API that was
deliberately removed for fabricating numbers — and it did so inside the very
command the corrected comment names, so even a user who followed the page
exactly died with `source: stats is not defined`.

## Measured (probed 2026-10-31, `~/tmp/g30/` — `probe.sh` → `probe.log`)

**A1 (red) — example 1 as written, plain bun:** `ReferenceError: range is not
defined` exit 1 — corroborates the current comment's warning (plain bun gets
none of the names).

**A2 (red) — example 1 as written, the runtime the comment names:**
`crust -c 'source ./a.ts'` → `source: stats is not defined` exit 1 — the
ghost sink dies inside the crust runtime, where every OTHER name resolves.

**A3 / B1 (the row's (b) queue item — "record which names resolve"):**

| name | plain bun | crust runtime (via `source`) |
|---|---|---|
| range / parallel / expectStage / statsStage / readAll / POST / glob / Pipeline | undefined | function |
| stats | undefined | **undefined** (removed sink — no namespace) |
| Bun.sql | function | function (genuine Bun global) |

**B2 (green) — the fixed example 1 end-to-end** (scratch `/pets` spec, mock
on :4761, port verified free):

```
crust -c 'source ./b.ts'
→ {"count":101,"wallMs":4,"rps":24182,"status":{"200":101},"p50":0,"p95":0,"p99":0,"meanMs":0}  exit 0
```

(`count` 101 = `range(0,100)` inclusive — the G22 data point, consistent.)

## Out of scope for this gap (cross-refs, NOT closed here)

- The no-exports-map structural issue is G13 (shipped) — the fix did NOT
  re-promise `import "crust"`, per the dossier's own constraint.
- W40 (npm-packages L44) is a separate page's instance of the same drift —
  not closed here.
- Examples 2–5 end-to-end execution (live server, fixtures, sqlite) — the
  (b) item asked which NAMES resolve, and that ran in full; the examples
  themselves were code-true at filing (fix item 3 verified).

## The fix

Website, `intro.mdx`, example 1 — the dossier's pinned shape (G26's
preferred form):

```ts
// 1.
const [summary] = await range(0, 10000)
  .pipe(parallel(100, () => fetch("http://localhost:3000/health")))
  .pipe(expectStage(200))
  .pipe(statsStage())
  .collect();
console.log(summary);
```

`statsStage()` yields ONE summary (transforms.ts L619–622 comment), so
`collect()` returns `[summary]`; destructuring + `console.log` mirrors the
bash slot's `| stats` observable behavior and the slot's own example-3 style.
The comment was left as `9b57e92` shipped it — verified accurate, not re-touched.

Site gates at `b9d6d85`: build 31 pages; lint-examples 362 checked / 0 failed
(the ts fence is not a crust example); check-links 1313 (41 with an anchor) /
0 dead — all at baseline. No crust code changed — the binary was already
right; the crust-side change is docs/audit only.

## W21 resolution (this commit, `full-audit.md`)

- **W21** (L624, filed X): tail annotated — FIXED 2026-10-31 via site
  `b9d6d85` (the statsStage half); the comment half already shipped at site
  `9b57e92` and was verified, not re-fixed; the (b) name-resolution item ran
  in full; statsStage ref drift (L619 → L623) recorded.
- **X census**: `W21 (intro.mdx L38–79 TS slot: … → G30` ) annotated
  `— FIXED 2026-10-31 via site \`b9d6d85\``.

## Commit

- site `b9d6d85` — `fix(docs): intro TS slot — use statsStage, the removed stats() sink is gone (audit W21)` (4 insertions / 2 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W21 row and X-census entry in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `70a53bc1`) — `round-9-cli-contract.md` §6 gains the second-specimen closure
