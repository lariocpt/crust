# G29 — cli skill page: "(in 0.2.4 only `--check` has it)" — 0.2.4 had the preflight on neither path

**FIXED 2026-10-31** — site `6dee7d9` (one page: `src/pages/docs/agent-skills/cli.mdx` — the parenthetical now states the real history) · W218 `?` closes as **X** and is annotated — the row contained the confirmed X (group (h): the 0.2.4 clause); its (b) probe item was cross-consumed by G28's exec-twin capture and re-confirmed here · T38 closed C-PENDING → **C** (the site-vs-SKILL shape mismatch settled in SKILL's favor by G28's measured bytes + site fix; the clause this row quoted fixed here) · SK31 closed `?` → **C** (all three of its probe items measured across `~/tmp/g28/` + `~/tmp/g29/` — the bookkeeping T38's closure required) · X-census entry annotated · audit (this commit) · KB (crust-agent submodule, local commit only — ingest is operator-controlled, `ebce8620`): `round-9-cli-contract.md` §2 gains the history correction (release-history claims get checked against the tag, not the working tree). **MCP reviewed — no overlap**: the fix is docs-only — one site page; the skill files carry zero "0.2.4"/"PR #60" mentions (re-verified by grep this unit), so `src/mcp/` and the SKILL.md files stay as-is (the standing order's display-only case, recorded not skipped).

## Measured (page line vs the code, both read 2026-10-19)

Page line (verbatim):

> The runtime runs the same preflight before executing any stage of a
> **mixed** line (as of PR #60; in 0.2.4 only `--check` has it): a shell
> stage whose text does not parse exits 2 with the message above, and
> nothing has run.

The 0.2.4 half is false — v0.2.4 had the syntax preflight on NEITHER path:

1. **The v0.2.4 check path has no syntax preflight.** `git show
   v0.2.4:src/index.ts` — the `--check` loop runs `parse(line)(ctx)` (pure
   build: sources constructed, nothing spawned at build time) plus
   `checkBuiltinLine` (flag-spec validation for tool-builtin heads only).
   No shell text is parsed by anything.
2. **No preflight anywhere in the v0.2.4 tree.** `git grep
   'sh -n\|shellSyntax\|noexec' v0.2.4 -- src/` = ZERO matches. The
   preflight itself (`shellSyntaxPreflight`, current lexer.ts L354–365 —
   as filed L238–253; drift corrected in place 2026-10-31) does not exist
   as of v0.2.4.
3. **The preflight is PR #60's.** The check-path half landed in `ae82619`
   (2026-10-06, "--check now asks sh -n about shell stages"); the exec-path
   half in `95a1bbe` (2026-10-09, "fn --help answers at parse time; a bad
   mixed stage exits 2 before anything runs" — the F42+F19 commit). Both
   are ancestors of PR #60's merge `699986c` (merged 2026-10-14; in-PR
   order `ae82619` → `7a85aca` → `95a1bbe`).
4. **The dates make the clause impossible.** v0.2.4 = `49b271d` ("Merge pull
   request #5"), published 2026-08-25 — 50 days BEFORE PR #60 merged. npm
   `@lariocpt/crust` latest = 0.2.4 (gitHead `49b271d` — re-verified
   2026-10-31 via `npm view`), so every released "0.2.4" a user can install
   (binary from the GitHub release, launcher from npm) has the preflight on
   neither path.
5. **The misread that let it land.** The "only `--check` has it" state DID
   exist — only inside PR #60's branch history, between `ae82619` (check
   half) and `95a1bbe` (exec half), never in a release. Group (g) C'd the
   clause off the CURRENT index.ts comment ("The same preflight now guards
   the exec path too (src/runLine.ts, F19); check mode keeps its exit 1") —
   that comment describes the current dual-path state, not the 0.2.4 state.
   Group (h) amends the clause to X; W218's other four halves (mixed-only,
   exit 2, nothing-ran-structural, 127-invisible) stand unchanged.

The rest of the page's paragraph is code-true (recorded on the W218 row,
group (g)): the exec path runs the same `shellSyntaxPreflight` before the
pipeline is built for MIXED lines, exits 2 (runLine.ts L328) with the
W217/G28 format, and a pure-shell line skips the preflight by design (one
`sh -c` parses the whole line before executing anything, so sh's own stderr
stays the answer).

## Impact

A user reading the page while 0.2.4 is the release (it still is — npm
latest = 0.2.4) was told `--check` catches shell stages that do not parse.
On 0.2.4 it does not, on either path: `--check` validates tool-builtin flag
specs and builds sources, and a malformed shell stage only fails when the
line RUNS (at which point earlier stages have already run their side
effects — the pre-fix leak the F19 comment records). The clause documented a
distinction ("only `--check` has it") that never existed in any release; it
was an intra-PR state. 288b2d3 drift class: a documented behavior the
shipped binary does not have. The fix is a history correction, not a code
change — PR #60 is exactly where the preflight landed (check first,
exec second), and the "as of PR #60" half of the sentence was already right.

## Measured (probed 2026-10-31, `~/tmp/g29/` — `probe.sh` → `probe.log`)

**A (red) — the v0.2.4 check loop:** `git show v0.2.4:src/index.ts` shows
only `checkBuiltinLine` (L160) + `parse(line)(ctx)` (L172);
`git grep 'sh -n\|shellSyntax\|noexec' v0.2.4 -- src/` = **0** matches. The
clause's premise (a 0.2.4 `--check` that had the preflight) is refuted.

**A2 (red) — the real history:** `49b271d` Tue 2026-08-25 (v0.2.4) ·
`ae82619` Tue 2026-10-06 (check half) · `95a1bbe` Fri 2026-10-09 (exec half)
· `699986c` Wed 2026-10-14 (PR #60 merge); `--is-ancestor` YES for both
commits; `npm view @lariocpt/crust` → version 0.2.4, gitHead `49b271d`.

**B (green) — the current binary matches the corrected sentence:**
`--check 'range(1,3) | head -('` → exit 1 + the named-stage message;
`crust -c 'touch f | base64 | head -('` → exit 2, `f` ABSENT;
`--check 'range(1,3)'` → `ok: 1 line(s) parse` exit 0. (The last item also
settles SK31's remaining (b) probe item.)

## Out of scope for this gap (cross-refs, NOT closed here)

- The W218 (b) probe (exec twin) was cross-consumed by G28 (`~/tmp/g28/` B)
  and re-confirmed here; recorded on the row's tail.
- Cross-check row T38 quoted the same clause and closed with this fix (see
  the W218/T38/SK31 annotations in `full-audit.md`). The skills SKILL.md
  files contain zero "0.2.4"/"PR #60" mentions — the fix is site-only.
- W217's G28 (the failure-format block's shape) was the separate defect in
  the same paragraph family; shipped first, at `a184bab`.

## The fix

Website, `cli.mdx` — the parenthetical rewritten to state the actual history,
exactly the dossier's pinned shape:

> The runtime runs the same preflight before executing any stage of a
> **mixed** line (as of PR #60, which gave `--check` the preflight first and
> the exec path second; the 0.2.4 release had it on neither): a shell stage
> whose text does not parse exits 2 with the message above, and nothing has
> run.

The page's other "0.2.4 and earlier" mentions (L34, L300) and the exit-code
table's "as of PR #60" (L46) are separate claims on other rows — untouched.

Site gates at `6dee7d9`: build 31 pages; lint-examples 362 checked / 0 failed
(the sentence carries no code fence); check-links 1313 (41 with an anchor) /
0 dead — all at baseline. No crust code changed — the binary was already
right; the crust-side change is docs/audit only.

## W218 resolution (this commit, `full-audit.md`)

- **W218** (L865): the row's `?` closes as **X** (the row contained the
  confirmed X — group (h)'s 0.2.4 clause) and the tail is annotated — fixed
  2026-10-31 via site `6dee7d9`; the (b) probe ran (exec twin exit 2 + file
  absent, cross-consumed from G28, re-confirmed in `~/tmp/g29/`); the
  git-history halves re-verified at probe time.
- **X census** (L144): `W218 (… → G29)` annotated
  `— FIXED 2026-10-31 via site \`6dee7d9\``.
- **T38** (L1515): C-PENDING → **C** — the shape mismatch resolved in
  SKILL's favor (G28's measured bytes match SKILL's inline-append shape;
  site corrected by G28), the quoted clause corrected by G29.
- **SK31** (L486): `?` → **C** — all three probe items measured across
  `~/tmp/g28/` + `~/tmp/g29/`; nothing to fix on the skill side.

## Commit

- site `6dee7d9` — `fix(docs): the 0.2.4 preflight clause described a state that never shipped (audit W218)` (2 insertions / 1 deletion)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W218 row, X-census entry, T38 and SK31 rows in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `ebce8620`) — `round-9-cli-contract.md` §2 gains the history correction
