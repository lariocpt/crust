# G20 — agent-skills mock-server page: the conformance-gate line omits the required `(r => r.json())` decode stage

**FIXED 2026-10-31** — site `93e3338` (one page:
`src/pages/docs/agent-skills/mock-server.mdx` — the gate line gains the
decode stage, and the "not optional" note now carries the measured message) ·
T26 `X` stands and is annotated — the omission confirmed by live probe (the
documented line can never pass; the fixed form is green, and the control
proves it is a real gate, `~/tmp/g20/`) · X-census entry annotated · the probe
also resolves the skill-side twin **SK65** (row `?` → **X** — its quoted
`predicate threw` message was refuted, and the warning at SKILL.md L124 was
corrected in place in the same commit, binary rebuilt) · audit (this commit) ·
KB (crust-agent submodule, local commit only — ingest is operator-controlled,
`b26d7891`): `round-8-false-pass-and-delete.md` gains §6 (a gate missing a
stage can never pass — the polarity twin of §5's no-op false pass — and a
documented error string must be measured, because the matcher form and the
pipeline-throw form look different). **MCP reviewed — no overlap**: the fix is
docs-only — one site page and the skill's warning prose; no `crust_*` tool's
behaviour or surface changed (the `__crust/violations` endpoint, the gate's
semantics and exit codes are untouched — the only change is compile-embedded
text), so `src/mcp/` and `skills/crust-mcp/SKILL.md` stay as-is (the standing
order's display-only case, recorded not skipped).

## The gap (as filed — site `src/pages/docs/agent-skills/mock-server.mdx` L76–78, audit T26, parity check 2026-10-18)

Site L77 (the page's "actual gate"):

```crust
GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)
```

SKILL.md L118–125 (the canonical skill — the line WITH the decode stage, plus
the warning):

```crust
GET :4747/__crust/violations | (r => r.json()) | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)
```

> The `(r => r.json())` stage is not optional: an HTTP stage hands you the
> response object, so reading `.violations` off it straight away is `undefined`
> and the gate dies with `crust: undefined is not an object (evaluating
> 'v.violations.filter')` — which looks like a broken assert rather than a
> missing decode. (As of the 2026-10-18 audit this quoted `predicate threw` —
> unmeasured; corrected in place 2026-10-31, see "All claims re-verified".)

The site's line is the skill's line with the decode stage removed — the exact
anti-pattern the skill warns about. `v` is the HTTP response object,
`v.violations` is `undefined`, `.filter` throws, and the line dies. The
failure is loud, not a false pass — but the page's recommended gate is one
that can never pass, and a user who hits the error sees a raw TypeError and is
pointed at the assert instead of the missing stage.

The site's own mock-server recipe page uses the decode stage in BOTH of its
findings examples — `recipes/mock-server.mdx` L482
(`GET :4000/__crust/violations | (r => r.json()) | (v => v.count + …)`) and
L521 (`crust -c 'GET :4000/__crust/violations | (r => r.json()) |
assert (v => v.count === 0)'`). The agent-skills page is the odd one out.

Why the site CI cannot catch this: the Grammar stage runs `crust --check`
(parse only, no execution). The line parses fine; only a live run produces the
throw. (The as-filed fix spec — "restore the stage + the one-line note,
verified by a live run against a scratch upstream, NOT by lint-examples" —
held and was followed exactly; the only delta is the note's message, below.)

All claims re-verified 2026-10-31 against the real repo state (the line refs
hold: site L77, skill L118–125; the recipes examples at L482/L521). One
correction, in place: the message the gate dies with. As filed (following the
skill's own warning) it said `predicate threw` — but that wording is the
**fixture-matcher** form (`src/fixtures.ts` L61/L116: `<predicate threw: …>`,
the subject of AGENTS.md design rule 1). A pipeline lambda throw never prints
it: `src/runLine.ts` L496 prints the raw `crust: <err.message>`, and the live
probe measured `crust: undefined is not an object (evaluating
'v.violations.filter')` (## Measured). Grep confirms the wrong wording
existed ONLY in SKILL.md L124 — nowhere else in crust, nowhere on the site —
so the as-filed fix's "mirror SKILL.md L118–125" would have propagated an
unmeasured message into a second surface; the warning is corrected in the
skill FIRST and the site mirrors the corrected text (## The fix).

## Out of scope for this gap (cross-refs, NOT closed here)

T26 also records the section's other omissions — `DELETE /__crust/violations`
clears between runs, `--report file.ndjson` appends NDJSON (requires `--proxy`),
the suite-base-URL workflow — all pure condensation carried by W522/W524 and
SK66 with probes queued. They are not part of this finding.

## Measured (probed 2026-10-31, `~/tmp/g20/` — `probe.sh` → `probe.log`; re-run against the G20-rebuilt binary)

Rig, per the dossier's pin: `spec.json` (a minimal `/pets` schema — `name`
required), a scratch Bun upstream (`upstream.mjs`) on :4748 that returns an
item missing the required `name` for `?bad=1`, and the mock
`crust -c 'mock-server ./spec.json -p4747 --proxy http://127.0.0.1:4748'`.
Both ports verified free before the run.

**A (red) — the line exactly as the page documents it (no decode stage):**

```
crust: undefined is not an object (evaluating 'v.violations.filter')
A_exit=1
```

Not `predicate threw` — that is the fixture-matcher form
(`src/fixtures.ts` L61/L116); a pipeline lambda throw prints the raw message
(`src/runLine.ts` L496). The skill's warning — and the as-filed text of this
dossier — quoted the wrong one.

**B (green) — the line WITH the decode stage (SKILL.md L119), conforming traffic:**

```
[]
B_exit=0
```

**C (control) — one `?bad=1` request through the proxy, then the SAME fixed line:**

```
crust: assert: item 1 failed (a => a.length === 0) — got [{"pointer":"/0/name","rule":"required","message":"missing required property 'name'",…,"direction":"response","location":"body","method":"GET","path":"/pets",…}]
C_exit=1
```

B's green is a real gate, not a no-op (honest-failure control convention).

The `--check` half (SK65's queued "the gate line's parse via `--check`"):
both forms parse — `ok: 1 line(s) parse`, exit 0 each. So the site's Grammar
stage (parse-only, no execution) cannot catch this in either form; only a
live run produces the throw.

## The fix

1. **`skills/crust-mock-server/SKILL.md` L122–125 (in place):** the "not
   optional" warning now quotes the MEASURED message — `crust: undefined is
   not an object (evaluating 'v.violations.filter')` — instead of
   `predicate threw`. Everything else in the warning stands (an HTTP stage
   hands you the response object; reading `.violations` off it is
   `undefined`; the death looks like a broken assert rather than a missing
   decode). The skill is embedded at compile time (`src/skillsData.ts`
   static text imports — compiled-binary-safe), so `bin/crust-bin` was
   rebuilt and the corrected text verified through the real consumer path
   (`skills install` in a scratch dir). No test pins the warning prose —
   `tests/skills.test.ts` classifies the fenced lines against the live
   grammar and checks frontmatter/description only — and the suite is at
   baseline after the rebuild.
2. **Site `agent-skills/mock-server.mdx`:** the gate line gains
   `| (r => r.json())` between `GET :4747/__crust/violations` and the filter
   (L77), and the one-line "not optional" note after the fence mirrors the
   CORRECTED skill verbatim — including the measured message.

Site gates at `93e3338`: build 31 pages; lint-examples 362 checked / 0
failed (the fixed line parses under the rebuilt binary's `--check`);
check-links 1313 (41 with an anchor) / 0 dead — all at baseline.

Crust gates at the audit commit: `bun test` 1404 pass / 2 skip / 0 fail
(1406 tests, 54 files); `tsc --noEmit` clean; biome 0 errors on a real temp
file under `src/` (negative control: a `debugger;` in the same file is
caught) — all at baseline.

## T26 + SK65 resolution (this commit, `full-audit.md`)

- **T26** (L1480): the **X** verdict stands and is annotated — the site's
  line is the skill's line minus the decode stage (the exact anti-pattern
  the skill warns about), and the site CI cannot catch it (`--check` is
  parse-only; both forms parse) — fixed 2026-10-31 via site `93e3338`. The
  row's quoted `predicate threw` stays as filed — it is SKILL.md's text as
  of the 2026-10-18 audit; the annotation records the measured message, the
  in-place skill correction (binary rebuilt), and the control.
- **SK65** (L535, the skill-side twin — the row whose quoted block the fix
  edits): its queued probe is exactly the one G20 ran, so the row's `?`
  closes as **X** — the distinctive claim is C (an HTTP stage hands you the
  response OBJECT: the decode-less line dies with a raw TypeError exit 1,
  the fixed line exits 0, and both forms pass `--check`), but the quoted
  `predicate threw` is refuted — the row's in-cell "C from design rule 1"
  misattributed the MATCHER rule to a pipeline throw (design rule 1 governs
  fixture matchers, `src/fixtures.ts` L61/L116; a pipeline lambda throw
  prints the raw `crust: <err.message>`, `src/runLine.ts` L496; measured:
  `crust: undefined is not an object (evaluating 'v.violations.filter')`).
  SKILL.md L124 — the only occurrence repo-wide — was corrected in place in
  this commit. The rest of the quoted block is C.
- **X census** (L107–108): `T26 (mock-server skill page: conformance-gate
  line missing the required decode stage → G20)` annotated
  `FIXED 2026-10-31 via site 93e3338`; SK65 gains a LATE entry (X, 2026-10-31,
  G20 close-out). The (e) G13+ listing and the (b) probe-capture section stay
  as filed — the standing convention (the listing's `predicate threw`
  phrasing is the gap's 2026-10-18 as-filed text).

## Commit

- site `93e3338` — `docs(agent-skills): mock-server gate line — restore the required r.json() decode stage` (3 insertions / 1 deletion)
- crust (this commit) — SKILL.md L122–125 (the warning quotes the measured message) + dossier + plan tick + FIX-PROGRESS ⑥ + the T26/SK65 rows and the X-census entries in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `b26d7891`) — `round-8-false-pass-and-delete.md` gains "## 6. A gate missing a stage can never pass — and a documented error string must be measured"
