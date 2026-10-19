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

## EXACT POSITION (rolling — update after EVERY unit; verified on disk 2026-10-19)

- Last unit on disk: **code review group (l) logs session / pty keymap / procs
  stream kinds / wait item shape / tail source / grep native-subset / stats
  --every / read API surface / histogram bucketing (W539 C-half), IN PROGRESS
  2026-10-19** —
  scope LOCKED at 71 rows across 9 subtopics (all verified plain `?` with
  zero code halves on disk; R internal-link rows W344/W350/W352/W365/W569
  excluded; SK48/SK94 already C from (d); W237 excluded — subs 1–3 C from
  (b), sub-claim 4 stays open with W240): (1) logs session W331–W343,
  W345–W349 (18; W338 already carries the (d) code-side note) + W578;
  (2) pty keymap W68, W224, W225, SK34; (3) procs stream kinds W351,
  W353–W364 (13) + W570–W575, W577 (7); (4) wait item shape W363, W576,
  W577 (+ W241's wait cell routed to (l) on disk; W211's (g) verdict says
  the wait ITEM shape is group (l)'s); (5) tail source W435, W258;
  (6) grep native-subset SK69, W442, U33, U34; (7) stats --every U39,
  W543, W559, W560, SK42, SK44; (8) read API W82, W379, W430 (W455
  already (d)-C, excluded); (9) histogram W539 (C-half named).
  READ MAP (src regions for the remaining subtopics; verdicts already on
  disk — NEVER re-read: read family sources.ts L98–174 + L50 (d);
  transforms.ts parallel L253–300 + expect L185–222 + statsStage L619–700
  (e); lexer L60–211 (i); runLine L55–95/L110–176/L125–140/L205–245/
  L288–303 (f)/(i); config L65–90 map (e); readiness L1–50 + wait.ts
  L62–72 (g); sinks.ts (e); builtins.ts L547–571 (i); genFixtures/
  mockServer (j)/(k); src/logs/cli.ts + ring.ts + session.ts (l)(1);
  sources.ts L175–1000 (l)(3)+(5); transforms.ts L1–122 (l)(6);
  transforms.ts L505–703 (l)(7); lexer.ts L440–576 (l)(6)):
   editor.ts in full (321 L), completion.ts L80–95,
  interrupt.ts L40–88, builtinFns/wait.ts in full (76 L — facts below),
  sources.ts L371–466 (mergeAsync body + readiness-probe internals +
  GET L418 / request L425 for (8)),
  transforms.ts L123+ (httpRequest body — (8)),
  config.ts L60–95 (injection map re-verify
  for W82 — (e) precedent).
  FACTS IN CONTEXT (holding spot — these are read but NOT yet in rows;
  write each into its row as that subtopic lands, and delete it from here
  once the row carries it): (8) GET L418 / request L425 (read API source
  stages) + transforms.ts httpRequest L106–122 read under (l)(6) (signal
  minted PER REQUEST L114–122; a caller-supplied signal always wins and
  only a MINTED abort may classify as a timeout). (9) transforms.ts:
  histogram L514–618 (BUCKET_BOUNDS, bucketFor L542, overflow bucket
  index = BUCKET_BOUNDS.length, nearest-rank over histogram L586+);
  statsStage L619+ (summary shape L600–609 {count, wallMs, rps, status,
  p50, p95, p99, meanMs} on disk via U129/W531).
  PROGRESS: (2) pty DONE 4/71 — W68 C (code review closes the row), W224 +
  W225 code halves (rows stay ? pty-probe-owned), SK34 C (code review +
  C-by-usage); the subtopic's read record (editor.ts 321 L keymap map,
  completion, interrupt, history, index REPL loop, builtins L193–208) is
  fully carried in those four rows — commit d4194ac. (1) logs session DONE 23/71 (19 rows, all code halves on disk — see commit)
  + (3) procs stream kinds DONE 43/71 — W351, W353–W364 + W570–W575, W577
  (20 rows) ALL carry code halves (sources.ts L460–1000 full-read
  2026-10-19: ProcLine/ReadySpec/LiveSpec/ProcSpec types L467–526,
  normalizeReady L548 / normalizeLive L580 / restartMax L609, upfront
  after-validation L652–679 (self/unknown/cycle), readyGen L770–813
  (timeout: restart → terminate+respawn; else throw), liveGen L820–889
  (per-spawn, armed post-ready, 3 message shapes + label suffixes),
  exitGen L937–940, restart backoff 250→2s cap L979 + healthy-uptime
  reset L960–962, detached group leaders L920 + killGroup L618–631 +
  terminate L702–721 + kill() owner L729–737; per-row evidence on disk —
  see the commit). + (4) wait item shape DONE 46/71 (3 rows W363/W576/W577 —
  wait.ts 76 L read in full 2026-10-19; record EXACTLY {target, ready:
  true, ms, attempts}, parseDuration ms/s/m + bare=ms, defaults --timeout
  30s / --interval 500ms / --probe-timeout min(interval*4,2s), not-ready
  throw → runLine `crust:` prefix → exit 1, both flag forms, usage screen
  on bad args — per-row evidence on disk — see the commit). + (5) tail
  source DONE 48/71 (2 rows W435/W258 — sources.ts L175–370 read
  2026-10-19: TailOptions L175–187 incl. the holder-owned signal
  cancellation the logs session uses; tail L194 (lines??10 / follow??false
  / pollMs??200); expandTailPaths glob-sorted+deduped L216–239;
  findTailWindowStart 64KB-backward byte-safe scan L247–272 (n<=0 → size
  = no initial cut); tailOne bounded initial cut L289–300, poll loop
  L315–348 with inode-change + size-shrink rotation reset L331–337 and
  offset+buf byte-exact follow; mergeAsync arrival-order contract L351–354
  — per-row evidence on disk — see the commit). + (6) grep native-subset
  DONE 52/71 (4 rows SK69/W442/U33/U34 — transforms.ts L1–122 +
  lexer.ts L440–576 read 2026-10-19: grepStage L12–40 per-line yield, no
  trailing-empty pop L30–32, -F substring L19–21, -v invert L34, -E
  parse-then-drop; classifyGrep L458–503 rejection set = $ L460–462 /
  unknown-or-combined flag L476–477 / ≠1 positional L480 / -F-E L481 /
  substrings \\ [[: {, (? L488–495 / JS-reject L496–500; raw passthrough
  L456–457; linesStage L48–60 pops vs grep doesn't; U34 exit-0-vs-1 =
  structural — native stage has no exit path, shell child's exit becomes
  the line's code; W442's probe example `[0-9]{3}` does NOT fall back ({,
  is the brace trigger) — correction recorded in-row; classifyStats
  L507–537 + httpRequest L106–122 facts held for (7)/(8) — see the
  commit). + (7) stats --every DONE 58/71 (6 rows U39/W543/W559/W560/
  SK42/SK44 — transforms.ts L505–703 read 2026-10-19: two-accumulator
  design (total L631 vs win L634, fresh per window L678) = delta windows
  {window: N, …} L674 + cumulative final {final: true, …} L699 with NO
  window key; plain summary (no --every) = keyless L699 tagged branch
  (SK44's short-circuit is the keyless shape); window flush ONLY on the
  item path L672 — no clock anywhere, stalled upstream holds the window,
  partial-final count>0-guarded L682–688 so no empty windows ever;
  --out doc {crustStats:1, startedAt, urls sorted, summary, windows?}
  L643–649, write-then-rename L653–655, flushed after EVERY window
  L676/L686 and BEFORE the final yield L689–690 (U39's ordering);
  .json-only throw at construction L623–625 (SK42); empty run tagged
  empty:true L698; wallMs = now-winStart at the flushing item L674+L602
  so it can exceed N (SK42's measured 3006); summary shape L600–609;
  the classifyStats flag-parse boundary (lexer L507–537, read (l)(6):
  --every N[s] / --out file with or without =, ANY other token → shell
  fallback, bare stats admitted) is carried in this entry per the
  facts-in-rows rule — see the commit). NEXT: subtopic
  (8) read API W82, W379, W430 (3 rows; W455 already (d)-C, out of
  scope) — fetch the claim cells, read the src the rows name:
  sources.ts L371–466 (mergeAsync body + readiness-probe internals +
  GET L418 / request L425) + transforms.ts L123+ (the httpRequest body —
  the L106–122 header facts: signal minted PER REQUEST, caller signal
  always wins, only a MINTED abort may classify as a timeout, are in
  FACTS IN CONTEXT) + config.ts L60–95 (the injection map re-verify for
  W82 — (e) precedent), write the 3 code halves immediately, checkpoint,
  commit md-only, push; then subtopics in the locked order histogram,
  then demote this entry, add the (l) line to resume-history.md's
  completed block, Next-move head → (m), commit md-only, push.
- Completed code-review groups (a)–(k): one line each in `resume-history.md`
  (append-only; no progress annotations there). **next free G = G30.** G
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

Next unit = **code review group (l), subtopic (8) read API** —
W82, W379, W430 (3 rows; W455 already (d)-C, out of scope). A review,
NOT a fix gate: close
`?` rows to C/V/X in place, verdict carries `file:line` evidence; an X row
becomes a NEW G task file (next free G30, same shape as G13–G29) + a plan
line — no code fixes while reviewing (a fix landing mid-audit would make
later findings stale). Method: rules above + the chunking protocol in
`resume-history.md`; fetch the 3 claim cells, read only the src the rows
name: sources.ts L371–466 (mergeAsync body + readiness-probe internals +
GET L418 / request L425) + transforms.ts L123+ (the httpRequest body —
the L106–122 header facts: signal minted PER REQUEST, caller signal
always wins, only a MINTED abort may classify as a timeout, are in the
EXACT POSITION FACTS IN CONTEXT) + config.ts L60–95 (the injection map
re-verify for W82 — (e) precedent); NEVER re-read a src file
after its verdict is on disk. Write the 3 code halves into the rows, then
checkpoint EXACT POSITION, commit `docs/audit/` (md-only) and push. Then
subtopics in the locked order histogram; after group (l) closes: (m) W515 vs W473 message dialect;
(n) W514 line-numbering; then item-4 (fresh build + full probe list →
(b), then (c)–(e)) — item-4's full probe list is in `resume-history.md`.
