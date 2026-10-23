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

## EXACT POSITION (rolling — update after EVERY unit; verified on disk 2026-10-23)
- **FIX PHASE IN PROGRESS 2026-10-23 (user-directed; supersedes the item-4
  ordering for now — the probe list resumes after the fixes).**
  Orchestration: a fast 7900xt-128k (or rtx5080-64k) subagent implements one G
  in small units (red → green → docs+commit); the orchestrator verifies on disk
  (re-runs gates, inspects diffs, spot-checks behavior with proper exit-code
  capture) and records each task in `FIX-PROGRESS.md` — READ THAT FILE FIRST on
  resume. Worker rules: `FIX-HANDOFF-PROMPT.md`. Subagent model:
  `7900xt/7900xt.qwen3.8.c131072.kq8_0-vq8_0.s1.fast-128k.798be05243`.
  DONE: **G06** (crust `940658a`+tick, site `f40f6b6`, KB `22d1634d` local),
  **G07** (crust `085e0bf`+tick, site `b226311`, KB `d39aa4a` local; KB
  re-ingest HELD — operator-controlled publication, pending for G06+G07).
  **G08 CODE DONE + COMMITTED at crust `1a2bdfa`** (units A+B, orchestrator-
  verified 2026-10-23: suite 1228/0 in three runs, typecheck clean, heredoc
  refusal + script-side empty-stage wording spot-checked with exit codes,
  REPL wording suite-pinned). REMAINING: G08 unit C (docs/website/KB/plan-
  tick/commit) — USAGE keybindings + limits bullet + a multi-line JSON example
  that passes --check; skills/crust-cli; website quickstart.mdx +
  agent-skills/cli.mdx; KB round-10 + round-5 internals; plan tick; commit,
  push both repos. Heredoc truth for unit C's docs (measured 2026-10-23): a
  TERMINATED heredoc works when the stage text carries real newlines (the
  runLine-level control, suite-pinned); continuations join with a SINGLE
  space (splitLines' existing semantics, mirroring the doc linters) so a
  `<<EOF` heredoc CANNOT be formed across continuation lines — it is refused
  as unterminated (loud, nonzero, names the marker; sh itself exits 0 on a
  true unterminated heredoc — a false pass — which is why crust refuses
  before running). Document that honestly. Carry-forward note for the G12
  close-out: the same space-join fact. ALSO 2026-10-23: the user unplugged
  mini-cachy (the 7900 XT host) — the fast subagent model is OFF until it is
  powered back on; the remaining units can run on this session's model
  (Geekom 240k) or any capable model — the doc tasks (G13–G30) are small
  single units. AFTER G08: G09 →
  G10 → G11 (after G08/G09 — shared repaint path) → G12 (last code task — the
  Limits-section sweep, do not skip) → G13–G30 (docs-only, one unit each; G13
  also rewrites AGENTS.md's stale no-npm-resolution constraint) → the W40
  in-place twin (reword npm-packages.mdx L44 per its row in full-audit.md) →
  then RESUME item-4 (the probe list, below).
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
- **+ (m) W473 vs W515 message dialect DONE 67/71** (1 row W473 — C on
  the code half; row stays `?` probe-owned, the five probe sub-claims
  stay (b)). New reads this unit: testFixture/runner.ts L196–240
  (FIRST read — the (c) group read testPipes/runner.ts, a different
  file) + testFixture/report.ts L24–30 (first read) +
  mockServer/validateRequest.ts L1–14 + L89–90 + L115–145 (RE-MARKS —
  (k) had read validateRequest.ts for the W515 message shapes
  L198–320) + genFixtures/generate.ts L952 + L986 (pinpoint cites; (j)
  had read the genFixtures source). Facts on the row: (1) per-field
  JSON-pointer + every-violation-named — runner.ts L217–227
  (`for (const v of validateSchema(…)) failures.push({ path:
  `output.data${v.pointer}`, expected: `${v.rule}: ${v.message}`,
  actual: v.received })` — no first-only truncation) + report.ts L30
  (the byte-shape of the page's FAIL lines; missing property → `got
  undefined`); (2) the (m) core — the dialect cross-ref SETTLED: ONE
  walker, TWO formatters, one message source (the walker's messages
  carry NO keyword prefix — W515 (k) carries them verbatim
  validateRequest.ts L198/L258/L268/L304–320; the fixture prefix is
  runner.ts L220's `${v.rule}: ${v.message}`; the request-side 422
  body is server.ts L461–485, (k) on disk) — no mismatch, recorded as
  the cross-ref reading, NOT an X; (3) the never-invent contract —
  validateRequest.ts L1–12 header verbatim ("a schema the walker can't
  judge validates successfully — the validator never invents a
  violation…") + the deliberately-unsupported list + additionalProperties
  unsupported by default (strict enforces a literal false at plain
  object nodes — U104 on disk) + "validates successfully" = a SILENT
  pass (non-object schema → `[]` L126; unknown type keyword
  `default: return true` L89–90; the fixture runner prints only on
  violations); (4) functions inside a schema object never invoked —
  runner.ts L196–208 (extracted BEFORE resolveDeep, the comment names
  `default`-style fn values) + the nuance: a 0-arg FUNCTION as the
  top-level `schema` value is the lazy-field form and IS resolved
  (L203–206) — the schema itself, not inside it; the page's claim
  holds; (5) same walker in both systems — runner.ts L2 imports
  validateSchema from ../mockServer/validateRequest; (6) gen-fixtures
  emits the key conditionally — generate.ts L952 + L986 ("nothing is
  invented" code-true; W397's probes stay (b) on its row). NO X, NO G.
- **+ (n) W514 line-numbering DONE 68/71** (1 row W514 — C on the
  line-numbering half; row stays `?` probe-owned, the five probe
  sub-claims stay (b)). New read this unit (RE-MARKS the (c)-read
  file — (c) read testPipes/runner.ts in full for W465's hermeticity
  verdict; this unit re-marks the numbering region): testPipes/runner.ts
  L130–160 — L132 `text.split("\n")` (every line), L137–138 `if
  (!line || line.startsWith("#")) continue;` (blanks + `#` comments
  skipped — not run, no result), L146/L154 `lineNo: i + 1` over the
  RAW split — the `:N` in `PASS <file>:N` is the 1-based FILE POSITION
  (counts comments/blanks when present — a position, not a run
  ordinal); the pass-count summary derives from `results`, which
  records ONLY run lines. The page's 5-line block (no comments shown)
  + `:2` + `5 pass` is consistent on both counts; the comment-shift
  diff stays (b). NO X, NO G. **CODE REVIEW PHASE COMPLETE** —
  (a)–(l) + (m) + (n) = 68/71 rows; W240 (probe-owned, W237 sub-claim
  4) + ~2 unidentified gap rows close in the probe phase or stay
  recorded (denominator LOCKED, gap recorded at the (l) close — never
  silently changed).
- Next phase on disk: **ITEM-4 — the probe phase** (Phase 1 step 4 of
  the audit prompt; the full probe list is item 4 of
  `resume-history.md`). FRESH BUILD DONE + VERIFIED 2026-10-22 10:31
  (`bun run build` → `bin/crust-bin` 93411296 bytes, mtime Oct 22
  10:31 > HEAD aaf04df 10:29:44; `CRUST_CONFIG=/dev/null
  bin/crust-bin --version` → `0.2.0-dev` exit 0). Next unit:
  Then run the probe list IN ORDER, logging every probe into
  `full-audit.md` section (b) with the EXACT command + output + exit
  code (the house rules: prefix every probe with
  `CRUST_CONFIG=/dev/null`; capture exit codes without piping through
  `head` — `> /tmp/out 2> /tmp/err; echo exit=$?`; in zsh quote
  `=`-leading words; `crust --check '<line>'` separates "grammar says
  no" from "runtime misbehaves"): gen-fixtures minimal-spec runs →
  log-mining matrix → api-smoke-tests matrix (W453–W481, incl. the
  W473 five probe sub-claims + the W477/G22 sql probes) → mock-server
  matrix (W484–W525: boot forms ×7, flag exclusions, seed
  empty-only/restart, envelope detect/unwrap, table DDL diff,
  sql-assert suite, 422 body diff, never-invent battery, --strict,
  2.0 body param, GET-body discard, proxy forwarding/502/records,
  violations endpoint + cap + DELETE, CI gate 3 steps, in-process
  builtin + `&` refusal, wait `:4000` vs `:4000/pets` vs `port:4000`,
  burn-in 10k stats) → ci-load-gates matrix (W528–W548 notes) →
  stress-testing matrix (W549–W552+ notes: burst-arrival histogram,
  ramp count = phase sum, drop line E+D==T, maxLagMs, --timeout
  pinned shapes, --every window deltas/final) → the pre-existing
  probes (R24, U3, U16, U30, U33–U34, U47, U51–U57, G07, G08,
  C1/C2/C6/C7, C14, A1, SK2, SK14, SK17–SK24, SK25–SK32, SK38–SK44,
  SK53, SK54–SK66, SK68–SK77, SK78–SK86) → the one-offs (`bun -e
  'console.log(typeof Bun.SQL, typeof Bun.sql)'`; `range(0, 3) | cat`
  count; `echo hi | wrap [ ]` verbatim; `sql "select 1"` without
  DATABASE_URL; `CRUST_DEBUG=1 CRUST_CONFIG=/dev/null bin/crust -c
  '…'` stderr; `bun -e 'console.log(typeof range)'`;
  `ls ~/.bun/install/global/node_modules`; W9, W16 install.mjs, W84,
  W37, W52, W53, W55, W58, W60, W61, W67) → the load-testing /
  verify-web-links matrices in the W-row notes → AND the PER-ROW (b)
  QUEUE accumulated across the review groups (each `?` probe-owned row
  carries its queue item in its plan cell — e.g. W21's five-example
  runs, W81's write/dest refusal, W265's eight traps, W224/W225 pty
  keymap, W240, group (b)'s W137/W143/W147/W152/W158/W163/W164,
  W473's five sub-claims, W514's five sub-claims, W462/W465's probes,
  W68's editor-keymap pty probe, W217/W218's verbatim captures, …).
  As probes land: record them in (b), close the owning rows' probe
  halves (the row flips to C/V only when every half is on disk), and
  feed (c) findings / (d) fixed-in-place / (e) G31+ as the loop
  requires. Gates after any fix: the (Gates) section below, both
  repos.
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

Next unit = **ITEM-4 — the probe phase** (Phase 1 step 4 of the
audit prompt). The CODE REVIEW PHASE IS COMPLETE: (a)–(l) + (m) +
(n) = 68/71 rows (W240 + ~2 unidentified gap rows close in the probe
phase or stay recorded — denominator LOCKED, gap recorded at the (l)
close). The EXACT POSITION block above carries the full item-4
bullet (the whole probe list in order). The fresh build is DONE +
VERIFIED (2026-10-22 10:31 — `bin/crust-bin` from HEAD aaf04df,
`0.2.0-dev`, exit 0). First unit: run the probe list IN ORDER (gen-fixtures minimal-spec runs →
log-mining matrix → api-smoke-tests W453–W481 → mock-server
W484–W525 → ci-load-gates W528–W548 → stress-testing W549–W552+ →
the pre-existing probes → the one-offs → the load-testing /
verify-web-links matrices → AND the per-row (b) queue on every
`?` probe-owned row — each row's plan cell carries its queue item),
logging every probe into `full-audit.md` section (b) with the EXACT
command + output + exit code. House probe rules: prefix every probe
with `CRUST_CONFIG=/dev/null`; capture exit codes without piping
through `head` (`> /tmp/out 2> /tmp/err; echo exit=$?`); in zsh
quote `=`-leading words; `crust --check '<line>'` separates
"grammar says no" from "runtime misbehaves". As probes land: record
in (b), close the owning rows' probe halves (a row flips to C/V only
when EVERY half is on disk), feed (c) findings / (d) fixed-in-place
/ (e) G31+ as the loop requires; commit md-only per probe group and
push. Gates after any fix: the (Gates) section, both repos. After
item-4: Phase 2 (act on findings — immediately-broken FIRST) → Phase
3 (the G06→G12 gap loop, with G13+ woven in — the user gate on
Phase 3 is the explicit "Phase 1 fully recorded" condition in the
(Blocked) section; it is met when item-4's recording is complete) →
Phase 4 wrap-up.
