# G29 — cli skill page: "(in 0.2.4 only `--check` has it)" — 0.2.4 had the preflight on neither path

**Doc:** website `src/pages/docs/agent-skills/cli.mdx` L135 (the runtime
preflight paragraph, W218). Audit W218 (the 0.2.4 clause, X), code review
group (h) amendment, 2026-10-19.

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
   preflight itself (`shellSyntaxPreflight`, current lexer.ts L238–253) does
   not exist as of v0.2.4.
3. **The preflight is PR #60's.** The check-path half landed in `ae82619`;
   the exec-path half in `95a1bbe` (2026-10-09, "fn --help answers at parse
   time; a bad mixed stage exits 2 before anything runs" — the F42+F19
   commit; the F19 comment at current lexer.ts L223–237 records the pre-fix
   leak verbatim). Both are ancestors of PR #60's merge `699986c`
   (merged 2026-10-14; in-PR order `ae82619` → `7a85aca` → `95a1bbe`).
4. **The dates make the clause impossible.** v0.2.4 = `49b271d` ("Merge pull
   request #5"), published 2026-08-25 — 50 days BEFORE PR #60 merged. npm
   `@lariocpt/crust` latest = 0.2.4 (published 2026-08-25, gitHead
   `49b271d`), so every released "0.2.4" a user can install (binary from the
   GitHub release, launcher from npm) has the preflight on neither path.
5. **The misread that let it land.** The "only `--check` has it" state DID
   exist — only inside PR #60's branch history, between `ae82619` (check
   half) and `95a1bbe` (exec half), never in a release. Group (g) C'd the
   clause off the CURRENT index.ts L207–208 comment ("The same preflight now
   guards the exec path too (src/runLine.ts, F19); check mode keeps its
   exit 1") — that comment describes the current dual-path state, not the
   0.2.4 state. Group (h) amends the clause to X; W218's other four halves
   (mixed-only, exit 2, nothing-ran-structural, 127-invisible) stand
   unchanged.

The rest of the page's paragraph is code-true (recorded on the W218 row,
group (g)): the exec path runs the same `shellSyntaxPreflight` before the
pipeline is built for MIXED lines, exits 2 (runLine.ts L207) with the
W217/G28 format, and a pure-shell line skips the preflight by design (one
`sh -c` parses the whole line before executing anything, so sh's own stderr
stays the answer).

## Impact

A user reading the page while 0.2.4 is the release (it still is — npm
latest = 0.2.4) is told `--check` catches shell stages that do not parse.
On 0.2.4 it does not, on either path: `--check` validates tool-builtin flag
specs and builds sources, and a malformed shell stage only fails when the
line RUNS (at which point earlier stages have already run their side
effects — the pre-fix leak the F19 comment records). The clause documents a
distinction ("only `--check` has it") that never existed in any release; it
was an intra-PR state. 288b2d3 drift class: a documented behavior the
shipped binary does not have. The fix is a history correction, not a code
change — PR #60 is exactly where the preflight landed (check first,
exec second), and the "as of PR #60" half of the sentence is already right.

## Out of scope for this gap (cross-refs, NOT closed here)

- The W218 (b) probe (rm -f f; `touch f | base64 | head -(`; verify exit 2
  + f absent + the named-stage message) stays in the (b) queue on the W218
  row — it is runtime evidence for the CURRENT (post-PR #60) contract, which
  is code-true and already C'd.
- Cross-check row T38 quotes the same clause; it is noted here and closes
  with this fix. The skills SKILL.md files (`skills/crust-builtins/SKILL.md`,
  `skills/crust-cli/SKILL.md`) contain zero "0.2.4"/"PR #60" mentions, so
  the fix is site-only.
- W217's G28 (the failure-format block's shape) is a separate defect in the
  same paragraph family and is untouched here.

## Fix

Website, `cli.mdx` L135 — rewrite the parenthetical to state the actual
history:

> The runtime runs the same preflight before executing any stage of a
> **mixed** line (as of PR #60, which gave `--check` the preflight first and
> the exec path second; the 0.2.4 release had it on neither): a shell stage
> whose text does not parse exits 2 with the message above, and nothing has
> run.

Verification: re-run `git show v0.2.4:src/index.ts` (check loop =
`parse(line)(ctx)` + `checkBuiltinLine` only) and `git grep
'sh -n\|shellSyntax\|noexec' v0.2.4 -- src/` (expect ZERO matches);
`git merge-base --is-ancestor ae82619 699986c` and `git merge-base
--is-ancestor 95a1bbe 699986c` (both YES); `git show -s --format=%cd 49b271d`
(2026-08-25) vs the PR #60 merge date (2026-10-14). Website `bun run build`
+ `bun scripts/lint-examples.mjs ../crust/bin/crust` + `bun run check-links`
(the sentence carries no code fence, so the Grammar gate is unaffected).

## Commit

`fix(docs): the 0.2.4 preflight clause described a state that never shipped (audit W218)` (website).
