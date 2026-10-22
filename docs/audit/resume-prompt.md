# crust audit — resume prompt (persisted 2026-10-18; restructured 2026-10-19 for 128k resilience)

Handoff file. To resume: fresh session in `/home/lario/Projects/personal/crust`
with the **thin restart prompt**: (1) read this file top to bottom — it is
thin now; the static worklist definitions + completed-group history live in
`resume-history.md`, read that only when you need them; (2) run
`sh docs/audit/resume-check.sh` and compare against the EXACT POSITION block
— if they disagree, **trust the disk** (the script output) and fix the block
before any other work; (3) start at Next Move. A failed compaction is the
same path: restart the session with this prompt — position is on disk, not in
context. Supersedes nothing in `full-audit.md` — it points into it.

You are resuming the crust full-audit after it was diverted into fix work.
Everything lives in this directory — repo-canonical, git-synced across
machines; run commands from the crust repo root. Audit log (single source of
truth for verdicts): `docs/audit/full-audit.md`. Master plan:
`docs/audit/CRUST_GAPS_PLAN.md`. Original audit prompt (scope source):
`docs/audit/full-audit-prompt.md`.

## EXACT POSITION (rolling — update after EVERY unit; verified on disk 2026-10-22)
- **Group (l) COMPLETE 2026-10-22 — 66/71 rows** (all thirteen
  subtopics DONE: (1) logs session (2) pty (3) procs (4) wait (5) tail
  (6) grep (7) stats --every (8) read API (9) histogram (10) W33 (11)
  W21 (12) W81 (13) W265). The full scope lock, READ MAP, FACTS and the
  per-subtopic PROGRESS records are demoted to `resume-history.md`'s
  (l) group line (append-only) and the per-unit audit commit messages —
  per-row verdicts live in `full-audit.md`'s rows; they are NOT
  restated here. Outcomes: W21 **X → G30** (the group's only new G);
  W33/W81/W265 C (W81/W265 rows stay `?` probe-owned); W68/SK34 FULL C;
  the (1)–(9) rows' code halves on disk (per-row evidence in the rows).
  71-row scope bookkeeping (locked at group start, recorded at the
  close): 66 rows closed by (l); remaining in the locked scope = W473
  ((m)) + W514 ((n)) → 68 after those; of the 7-row 71-gap, 5
  identified (W21/W33/W81/W265 closed by (10)–(13); W240 probe-owned,
  stays (b) with W237's sub-claim 4) + ~2 unidentified (pre-existing
  bookkeeping ambiguity — 71's derivation is not reconstructable from
  disk artifacts; the denominator stays LOCKED — the gap is recorded,
  never silently changed).
- Next unit on disk: **code review (m) W473 vs W515 message dialect**
  (W473, 1 row — website `docs/recipes/api-smoke-tests.mdx` L261–270:
  "Violations fail the fixture with **per-field JSON-pointer paths** —
  every violation named, not just the first" + the deliberately-broken
  pair transcript + the subset-walker contract (never invent a
  violation: unknown keywords pass, `additionalProperties: false` is not
  enforced, a schema it can't judge validates successfully; functions
  inside a `schema` object are never invoked — it's data, not matchers;
  gen-fixtures emits the key automatically — W397 carries the emit
  side). W515 (mock-server page, the `--validate` request-validation
  row) already carries its (k) code half — "message-dialect settled" —
  so (m) closes W473 + the cross-ref. A review, NOT a fix gate: fetch
  W473's claim cell; the code-half facts ride (k)'s on-disk mockServer
  read (W515's row) — NEVER re-read a src file after its verdict is on
  disk; new bounded reads only if W473's row names a fact (k) did not
  record (a re-read re-marks the region). W473's own plan names five
  probe sub-claims (the broken pair; "validates successfully" = silent
  pass or a note; the fn-valued-schema-keyword never-invoked probe; the
  W397 gen-fixtures cross-ref) — those stay (b) per the row's plan.
  Adjudicate: per-field JSON-pointer + every-violation-named + the
  walker contract hold against the (k) facts → C code half, row stays
  `?` probe-owned; a message-dialect mismatch between the W473 fixture
  format (`output.data/plan: expected "…", got …`) and the W515
  request-validation body format is recorded as the cross-ref reading
  or X → G31 + plan line. After (m): (n) W514 line-numbering (fetch the
  row's plan cell — mock-server page L370–398, the SQL-assert `.pipes`
  suite; the subtopic is the `PASS mock-state.pipes:2` line-numbering
  claim); then item-4 (fresh build + full probe list → (b), then
  (c)–(e)) — item-4's full probe list is in `resume-history.md`.
- Completed code-review groups (a)–(l): one line each in `resume-history.md`
  (append-only; no progress annotations there). **next free G = G31.** G
  task files: `docs/audit/gaps/`; plan lines: `CRUST_GAPS_PLAN.md`;
  X-census: `full-audit.md`. Parity T1–T81 / components M1–M17 / page
  boundaries / DONE page-level: `resume-history.md`.

## Recovery procedure (fresh session / failed compaction / no context)

If you are starting with NO conversation context (new session, or a
compaction that failed and the session was restarted):

1. Read this file top to bottom — it is the only required read (thin by
   design; `resume-history.md` only if a definition or a completed-group
   line is needed).
2. Run `sh docs/audit/resume-check.sh` (seconds; checks both repos' head +
   clean/dirty, the last W row, next free G, and the audit STATUS line).
   Expect: crust clean @ `d4194ac` or later, website clean @ `7803ba5` or
   later, last W row W602+, next free G30 (or higher).
3. If the script output disagrees with the EXACT POSITION block: **trust
   the disk** (the script), not the block — fix the block before doing any
   other work.
4. **Dirty tree branch:** if a repo is DIRTY, that is a unit killed
   mid-flight. `git diff` the audit files: rows/verdicts written but not
   committed are the partial unit — trust them (disk is truth), finish the
   unit (write the missing halves, update EXACT POSITION), then commit.
   Never revert written rows to "clean up".
5. A killed unit loses at most one unit (one subtopic's rows, ≤ ~20 rows):
   re-read those rows' claim cells and re-read the src the unit names
   (bounded — see the EXACT POSITION read map), then continue. Rows are the
   unit of state; there is no finer loss.
6. After every unit: write the rows/verdicts into `full-audit.md` AND update
   the EXACT POSITION block here. The block is the recovery artifact — a
   stale block makes recovery stale.

## Compaction-safe working method (the rules — re-read after any compaction)

1. **Disk is memory.** Every verdict, probe (exact command + output + exit
   code) and SHA is written to `full-audit.md` (and the plan) as it happens.
   If it isn't on disk, it didn't happen.
2. **No big re-reads.** Recover with grep + byte cuts: `awk '/^\| W552 \|/'
   full-audit.md | cut -c1-200`, `tail -c`, `head -c`. Rows are 0.3–2 KB
   (up to ~20 KB for wide probe rows); line numbers shift after edits —
   **anchor by row ID / content, never by line number.**
3. **Small units, verify, then next.** One page window → its rows → next
   window. One repo, one commit, gates, push, PR, merge — verify via
   `git log` before moving on. zsh: quote `=`-leading words (a bare
   `echo ====` fails in zsh — equals-expansion; use `printf -- '==='` or
   the resume-check script); apostrophes in commit messages →
   `git commit -F <file>`.
4. **A compaction can still happen; these rules make it harmless, they
   don't prevent it.** If unsure of position: read only this file's
   EXACT POSITION block + run `resume-check.sh`.
5. **Chunked row writing:** write a page in windows (≤160 L), rows
   immediately after each window, never re-reading earlier windows of the
   same page.
6. **Subtopic = unit (code review groups).** Within a group, one subtopic
   per unit: fetch that subtopic's claim cells, read only the src it names,
   write every verdict, checkpoint EXACT POSITION, commit md-only, push.
   A compaction loses at most the current subtopic, not the whole group.
7. **Facts go to rows or nowhere.** Src facts read in-session belong in the
   rows as soon as their subtopic is written; the EXACT POSITION
   "FACTS IN CONTEXT" list is the ONLY holding spot for facts not yet in
   rows, and a fact is deleted from it the moment its row carries it.
   Facts for a DONE subtopic live in its rows — never restated in the
   block.

## Gates (unchanged)

- crust: `bun test` (1187 run / 0 fail, ~17s), `bun run typecheck`,
  `bunx biome check .` (428 warnings / 18 infos / 0 errors).
- website: `bun run build`, `bun scripts/lint-examples.mjs
  /home/lario/Projects/personal/crust/bin/crust`, `bun run check-links`
  (baseline at b314237: 29 pages / 348 examples 0 failed / 1163 links 0
  dead — **re-baseline after the R24/W235 merges if counts move; R24/W235
  touched prose/frontmatter only, counts held**).
- Repo state at divert: crust main clean (`0e624ae` head), site main clean
  (`7803ba5` head); stale local branches `fix/audit-r24-foox-persist`,
  `fix/audit-w235-builtin-count` (both = main, safe to delete).

## Blocked

- G06 → G12 gap loop: blocked on Phase 1 (the worklist in
  `resume-history.md`) fully recorded in `full-audit.md` (explicit user
  gate). G13–G16 fix commits: blocked on the same, by the decision in
  `resume-history.md`.

## Next move (first unit of a resuming session)

Next unit = **code review (m) W473 vs W515 message dialect** — W473
(1 row; website `docs/recipes/api-smoke-tests.mdx` L261–270). Group
(l) is CLOSED (66/71 rows; the (l) line is in `resume-history.md`,
this file's EXACT POSITION block carries the demoted pointer). A
review, NOT a fix gate: close `?` rows to C/V/X in place, verdict
carries `file:line` evidence; an X row becomes a NEW G task file
(next free G31, same shape as G13–G30) + a plan line — no code fixes
while reviewing (a fix landing mid-audit would make later findings
stale). Method: rules above + the chunking protocol in
`resume-history.md`; fetch W473's claim cell. W473's claim:
"Violations fail the fixture with **per-field JSON-pointer paths** —
every violation named, not just the first" + the deliberately-broken
pair transcript + the subset-walker contract (never invent a
violation: unknown keywords pass, `additionalProperties: false` is
not enforced, a schema it can't judge validates successfully;
functions inside a `schema` object are never invoked — it's data, not
matchers; gen-fixtures emits the key automatically — W397 carries
the emit side). W515 (the mock-server `--validate` request-validation
row) already carries its (k) code half — "message-dialect settled" —
so (m) closes W473 + the cross-ref: the code-half facts ride (k)'s
on-disk mockServer read (W515's row) — NEVER re-read a src file after
its verdict is on disk; new bounded reads only if W473's row names a
fact (k) did not record (a re-read re-marks the region). W473's own
plan names five probe sub-claims (the broken pair; "validates
successfully" = silent pass or a note; the fn-valued-schema-keyword
never-invoked probe; the W397 gen-fixtures cross-ref) — those stay
(b) per the row's plan. Adjudicate in the row: per-field JSON-pointer
+ every-violation-named + the walker contract hold against the (k)
facts → C code half, row stays `?` probe-owned (the W224/W225 (2)
precedent); a message-dialect mismatch between the W473 fixture
format (`output.data/plan: expected "…", got …`) and the W515
request-validation body format is recorded as the cross-ref reading
or X → G31 + plan line. Write the verdict into the row, then
checkpoint EXACT POSITION, commit `docs/audit/` (md-only) and push.
Then (n) W514 line-numbering (fetch the row's plan cell — mock-server
page L370–398, the SQL-assert `.pipes` suite; the subtopic is the
`PASS mock-state.pipes:2` line-numbering claim — does the `:N`
numbering count comments/blanks? W465's (c) full read of
testPipes/runner.ts is the likely on-disk home for the mechanism;
the probe settles the rest); then item-4 (fresh build + full probe
list → (b), then (c)–(e)) — item-4's full probe list is in
`resume-history.md`.
