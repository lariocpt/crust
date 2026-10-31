# G26 — mock-server pairing page: the TS burn-in embed calls two API names that do not exist (`stats()`, `startMockServer`)

**FIXED 2026-10-31** — site `27d1dcd` (one page: `src/pages/docs/recipes/mock-server.mdx` — the ghost-API ts embed is DROPPED; the CodeSwitcher became a plain bash fence carrying the two supported examples verbatim) · W525 `?` closes as **X** and is annotated — the ts-half ghost embed was the row's confirmed X (group (e)), now removed; the switcher-trio (b) item is mooted by the removal; the burn-in line was measured green at probe scale (`~/tmp/g26/`) · X-census entry annotated · audit (this commit) · KB (crust-agent submodule, local commit only — ingest is operator-controlled, `5e9ce50c`): `round-9-cli-contract.md` §6 gains the closure note (ts slots can resurrect REMOVED APIs, not just invent ones). **MCP reviewed — no overlap**: the fix is docs-only — one site page; no `crust_*` tool's behaviour or surface changed (the removed sink and the absent library surface are the binary's existing state, now no longer contradicted by the page), so `src/mcp/` and `skills/crust-mcp/SKILL.md` stay as-is (the standing order's display-only case, recorded not skipped).

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
   globals (`src/config.ts` — `statsStage` IS injected at L88, bare `stats` is
   not). So `stats()` throws ReferenceError in BOTH a standalone TS file and a
   `.crust` script. The real surface is `statsStage(everySec?, out?)`
   (`src/transforms.ts` L623–625 — as filed L619–621; refs drifted with the
   file's growth, corrected in place 2026-10-31) — a STAGE, not a sink: it
   yields per-window and a final tagged summary item, so the terminal form is
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
   file-level ones W485's embed names, and those DO exist (re-verified
   2026-10-31: `loadSpec.ts` L49 `export async function loadSpec(source)`,
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
  switcher, the 10k×100 burn-in timing) stay in the (b) queue on the W525 row
  — except as consumed by the G26 probe (see Measured): the switcher-trio item
  is MOOTED by the switcher's removal; the burn-in line is proven at probe
  scale; the full 10k×100 timing and the `wait` root-404 rationale stay queued.
- The W485 embed's two names (`loadSpec`, `startServer`) and its "not on npm
  yet" release-state claim stay W485's row (still `?`; its two names are
  corroborated present in-repo — re-verified 2026-10-31).
- The "library isn't on npm yet" / no-exports-map structural issue is G13.

## Measured (probed 2026-10-31, `~/tmp/g26/` — `probe.sh` → `probe.log`)

**A1 (red) — the embed's import line as written:**

```
error: Cannot find module 'crust/mockServer' from '/home/lario/tmp/g26/a1-import.ts'
A1_exit=1
```

The flagship example dies at resolution before anything runs (the G13 P5
signature — no exports map, binary-only package).

**A2 (red) — `stats()` with the real names imported (`a2-stats.ts`):**

```
range/parallel/expectStage/statsStage imported: function,function,function,function
typeof stats: undefined
stats() threw: stats is not defined
```

The removed sink exists in no reachable namespace; the honest names all
import fine.

**B (green) — the bash burn-in form at probe scale** (scratch `/pets` spec,
mock on :4751, port verified free):

```
wait :4751/pets  →  {"target":":4751/pets","ready":true,"ms":512,"attempts":2}  exit 0
range(0, 99) | parallel 10 | GET :4751/pets | expect 200 | stats
→ {"count":100,"wallMs":4,"rps":27569,"status":{"200":100},"p50":0.3,"p95":1.2,"p99":1.3,"meanMs":0.3}  exit 0
```

The surviving bash form runs end-to-end (the 10k×100 timing itself stays
queued on the row).

## The fix

Site `mock-server.mdx`, "Pairing with crust pipelines": the CodeSwitcher
(bash + ts slots) is replaced by a plain bash fence carrying the two
supported examples verbatim — the dossier's **preferred shape** ("drop the TS
embed, keep the bash form"). The CodeSwitcher component hardcodes both panes
(no single-slot mode), so a dropped ts slot means dropping the switcher; the
plain fence matches the page's own style (the conformance-gate section above
uses one). The section's prose already frames everything as `crust -c` lines,
so no prose change was needed. The page now carries ONE honest TS story — the
W485 embed's `loadSpec`/`startServer` shape with its in-repo caveat — instead
of two contradictory ones.

Site gates at `27d1dcd`: build 31 pages; lint-examples 362 checked / 0 failed
(the ts fence was never a crust example, so the count is unchanged);
check-links 1313 (41 with an anchor) / 0 dead — all at baseline. No crust code
changed — the binary was already right; the crust-side change is docs/audit
only.

## W525 resolution (this commit, `full-audit.md`)

- **W525** (L1222): the row's `?` closes as **X** (the W600/G16 precedent — the
  page as audited contained a confirmed X: the ghost-API embed) and the tail
  is annotated — fixed 2026-10-31 via site `27d1dcd` (embed dropped); the
  probe consumed the burn-in and switcher-trio (b) items (the latter mooted);
  the 10k×100 timing and the `wait` root-404 rationale stay queued on the row.
- **X census** (L123–129): `W525 ts-half code half (… → G26` ) annotated
  `FIXED 2026-10-31 via site \`27d1dcd\``.

## Commit

- site `27d1dcd` — `fix(docs): the mock-server pairing embed named a removed sink and a function that does not exist (audit W525)` (8 insertions / 27 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W525 row and X-census entry in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `5e9ce50c`) — `round-9-cli-contract.md` §6 gains the G26 closure note
