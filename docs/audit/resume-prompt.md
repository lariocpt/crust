# crust audit — resume prompt (persisted 2026-10-18)

Handoff file. To resume: fresh session in `/home/lario/Projects/personal/crust` with
the **thin restart prompt** (3 lines: read this file top to bottom → run its Recovery
procedure → start at Next Move). Pasting everything below the line also works but is
less smooth. This is the **further-down-the-line plan** with the compaction-safe working
method. Supersedes nothing in `full-audit.md` — it points into it.

---

You are resuming the crust full-audit after it was diverted into fix work. Everything
lives in this directory — repo-canonical, git-synced across machines; run commands from
the crust repo root. Audit log (single source of truth): `docs/audit/full-audit.md`.
Master plan: `docs/audit/CRUST_GAPS_PLAN.md`. Original audit prompt (scope source):
`docs/audit/full-audit-prompt.md`.

## EXACT POSITION (rolling — update this block after EVERY unit; verified on disk 2026-10-18)

- Last unit on disk: **code review group (b) auto-dispatch, COMPLETE 2026-10-18**
  (sources read in full: src/discover.ts 170 L, src/config.ts 109 L; plus
  parser.ts dispatch/buildSource/applyStage regions, runLine.ts dispatch head,
  index.ts bootstrap, builtins.ts record, lexer.ts time region, builtinFns/):
  all 40 rows adjudicated — W134–W168 + W228–W232 + W237. C: W134–W140,
  W142, W145–W146, W148–W151, W154, W155 (bash half), W157, W159–W162,
  W165–W167, W228–W232, W237 (subs 1–3); W168 R. Deliberately `?`
  (probe-owned halves, queued in (b)): W137 (slugify canonical loop), W143
  (bash tour), W147 (glob-as-source + bare `read`), W152 (bare `[` bracket
  token — lexer/G02 territory; the row goes X if the grammar refuses), W158
  (stage-error index — the (f) group W158-vs-W266), W163 (npm-resolution at
  scale), W164 (prettier output). X: W141 → **G23** (npm-packages L37–40/
  L183–185 source position `pkg(undefined, "arg1")` — parser.ts L298–313
  invokes `fn(...staticArgs)`, item slot ABSENT; transform half C; W154
  duplicate covered); W144's X cell extended with the case sub-claim
  (severity still pending U129). G23 file in gaps/ + census + (e) + plan line
  all on disk. Last unit before this one: **group (a) sql, COMPLETE** (W477
  X → G22; W107/W118/W132/W305/W475 C-code; W241 sql cell C; the
  `$1`-vs-`?` placeholder question — page L345 `$1` vs SKILL L65 `?` —
  deliberately NOT closed, stays with the (b) probe). The skills↔site parity
  check remains COMPLETE (T1–T81, all 10 pairs; T50 + the T54 lambda example
  still C-PENDING at the W240+SK14 / W245+SK19 probes).
- Parity rows live in full-audit.md under `### parity check:` (prefix **T1+**): T1 =
  index.mdx `skills list` block vs the nine SKILL.md frontmatters (X → **G17**);
  T2–T7 = pipelines pair (T3 → **G18**); T8–T14 = api-testing pair (CLEAN all C);
  T15–T21 = load-testing pair (T20 → **G19** — guard-without-`--every` inverts the
  short-circuit; same sentence in ci-load-gates.mdx L163, W543 `?` pending its (b)
  probe); T22–T27 = mock-server pair (T26 → **G20** — conformance-gate line missing
  the required `(r => r.json())` decode stage; the site's own recipe page has it in
  both places, L482/L521); T28–T33 = procs pair (NO X — all C; T33 C-PENDING:
  site "evaluated as JavaScript" ×2 pages vs SKILL "read as data by a pipeline
  stage" for bare `procs(...) > file` — settled by the W364(4) + SK86 (b) probes;
  no G until they land); T34–T39 = cli pair WINDOW 1 of 2 (intro / run modes /
  exit codes / --check / Environment head — NO X; T38 C-PENDING: site 2-line
  --check failure block + "the `sh:` line after that" vs SKILL L93 inline
  `: sh: …` on line 1 — settled by the SAME probe queued at W217 + SK31;
  SKILL.md's Environment section is ONLY L109–118 = the 5-row table, so the
  site's env elaborations W221/W222 are site-only expansions, verified).
- Parity queue: **CLEAR — all 10 pairs done (T1–T81).** verify-web-links pair
  DONE (T72–T81, 0 of 10 X — frontmatter/intro site-only intro paragraph ·
  check table cell-identical · exit codes surface-words-only · pointing block
  + prose identical · Green-does-not-mean-checked with the site-only verbatim
  note strings carried `?` at W376 · In CI with the identical `--strict`
  example string (inline vs fenced) · meta fixture block line-identical ·
  tuning with the SKILL-only 4th bullet = anchor-skip companion that agrees
  with the site's honesty block · Traps + Related site-only, W385/W386 R).
  logs pair DONE (T64–T71, 0 of 8 X — boot-line focal no third variant, T66;
  `search` adverb delta carried). builtins pair DONE (T46–T63, 1 of 18 X):
  T62 → G21; T50 + T54-lambda C-PENDING carried; both files list the same EIGHT
  tool builtins (6-vs-8 resolves: AGENTS.md's six = the `parseFlags` CLI set,
  T47); W237's dispatch-table grep stays open for the CODE REVIEW.
- Component rows (M1–M17) live under `### website components` between the W602 row and
  the `### parity check:` heading: M1–M6 Hero · M7–M11 InstallBlock+site.ts ·
  M12 CodeSwitcher · M13 Header · M14 Sidebar · M15 Footer · M16 RecipeCard · M17
  FeatureCard.
- Page boundaries (recipe queue, historical): stress-testing **W549–W568** (L1–315) · dev-tail
  **W569–W582** (L1–236) · heap-snapshots **W583–W591** (L1–195) · verify-web-links recipe
  **W592–W602** (L1–188).
- **DONE (a, page-level):** repo docs — README R1–R26, USAGE U1–U134, CHANGELOG, PLAN
  P1–P17, spec C1–C24, INTERNAL I1–I5, AGENTS AG1–AG11, A1, nine skills SK1–SK94,
  examples/args.crust — plus **all 29 website pages W1–W602** (all 10 recipe pages included).
- **NOT done (a), in order:**
  1. ~~**8 components**~~ — **DONE 2026-10-18** (M1–M17 on disk). Note: the files are
     `.astro`, not `.tsx`: Hero 182 L, InstallBlock 143, CodeSwitcher 181, Header 103,
     Sidebar 130, Footer 72, RecipeCard 77, FeatureCard 50 — in the website repo
     `src/components/`. The install-command surface reduces to the four `src/lib/site.ts`
     constants (INSTALL_COMMAND ×2 modes, NPM_INSTALL_COMMAND, CLONE_COMMAND) — all C vs
     I1/AG10/R-rows; the Jenkins Gate claim verified against the live Jenkinsfile.
  2. **Skills↔site parity check** — `src/pages/docs/agent-skills/*.mdx` ↔ repo
     `skills/*/SKILL.md`; esp. G01–G05 topics, W184's nine skill descriptions vs SKILL.md
     frontmatter, builtins-list coverage (now includes `test-fixture`), logs-boot-line format
     parity (W344 vs W446: `logs: <cmd>` — buffering last 10000 items).
  3. **Code review** — `src/` top-level + builtin dirs (`builtinFns/`, `genFixtures/`,
     `logs/`, `mockServer/`, `testFixture/`, `testPipes/`, `verifyWebLinks/`) + `tests/`
     (honest-failure controls intact?) + `npm/` (read-only) — **close every `?` row**.
     Priorities: (a) sql builtin existence + W107/W118/W132/W241/W305 error strings +
     W475/W477 sql stage modes, sql reads `$DATABASE_URL`; (b) auto-dispatch subsystem
     (W134–W168, W228–W232); (c) init.ts loading → W129/W131/W146/W150/W160/W162 + W465;
     (d) export surface + runtime globals (W227, U129) — wait/logs/search/buffer/clear session
     commands + test-pipes/test-fixture/gen-fixtures/verify-web-links/mock-server dispatch
     entries + exact flag sets + expectStage/expect export names (W474) + readAll export
     (W455) + Pipeline.of (W476) + arity hard error since 0.2.4 (W468) + timedGet/statsStage/
     load-as-array-source (W531) + sort-stage presence (W551); (e) source-fn array flattening
     (W126, W154, W433, W477(3), W525 zero-arg parallel fn, W554 parallel(8, verb) load mode);
     (f) stage-error index preservation (W158 vs W266); (g) skills subsystem
     (W184/W188/W194–W218); (h) base64 `--file`/`--out` main-vs-published (W244/W252);
     (i) tool-builtin redirect refusal (W250/W251) + inside-crust `&` refusal (W525);
     (j) `crust/genFixtures/generate` subpath export (W390) + examples/gen-setup.ts +
     setup-contract exports; (k) mock-server: three import surfaces + exports map +
     crust_mock_state DDL + __crust/violations endpoint + x-crust-validation header + subset
     walker + 422 + proxy --report; (l) logs session ring buffer / pty keymap + procs stream
     kinds + wait item shape + tail source + grep native-subset + stats --every +
     read/lines/readAll/read API surface + histogram bucketing code (W539 C-half);
     (m) W515 vs W473 message dialect; (n) W514 line-numbering.
  4. **Fresh build + full probe list → section (b).** `cd /home/lario/Projects/personal/crust
     && bun run build` → `bin/crust-bin` (verify newer than main's last commit). Probe list:
     gen-fixtures minimal-spec runs; log-mining matrix; api-smoke-tests matrix (W453–W481);
     mock-server matrix (W484–W525: boot forms ×7, flag exclusions, seed empty-only/restart,
     envelope detect/unwrap, table DDL diff, sql-assert suite, 422 body diff, never-invent
     battery, --strict, 2.0 body param, GET-body discard, proxy forwarding/502/records,
     violations endpoint + cap + DELETE, CI gate 3 steps, in-process builtin + `&` refusal,
     wait `:4000` vs `:4000/pets` vs `port:4000`, burn-in 10k stats); ci-load-gates matrix
     (W528–W548 notes); stress-testing matrix (W549–W552+ notes: burst arrival histogram,
     ramp count = phase sum, drop line E+D==T, maxLagMs, --timeout pinned shapes, --every
     window deltas/final); pre-existing probes unchanged: R24, U3, U16, U30, U33–U34, U47,
     U51–U57, G07, G08, C1/C2/C6/C7, C14, A1, SK2, SK14, SK17–SK24, SK25–SK32, SK38–SK44,
     SK53, SK54–SK66, SK68–SK77, SK78–SK86; `bun -e 'console.log(typeof Bun.SQL,
     typeof Bun.sql)'`; `range(0, 3) | cat` count; `echo hi | wrap [ ]` verbatim;
     `sql "select 1"` without DATABASE_URL; `CRUST_DEBUG=1 CRUST_CONFIG=/dev/null bin/crust
     -c '…'` stderr; `bun -e 'console.log(typeof range)'`; `ls ~/.bun/install/global/
     node_modules`; W9, W16 install.mjs, W84, W37, W52, W53, W55, W58, W60, W61, W67; plus
     load-testing/verify-web-links matrices in W-row notes.
     Then: **(c) Findings, (d) Fixed in place, (e) G13+**.

## Recovery procedure (fresh session / failed compaction / no context)

If you are starting with NO conversation context (new session, or a compaction that failed
and the session was restarted):

1. Read this file top to bottom — it is the only required read.
2. Verify live state (three cheap commands, seconds total):
   - `git -C /home/lario/Projects/personal/crust log --oneline -3` +
     `git -C /home/lario/Projects/personal/crust status --porcelain | wc -l` — expect clean;
     head `0e624ae` or later.
   - same two for `/home/lario/Projects/static-websites/crust-website` — expect clean; head
     `7803ba5` or later.
   - `grep -oE '^\| W[0-9]+ \|' docs/audit/full-audit.md | tail -1` — expect W602 or
     later.
3. If any check disagrees with the EXACT POSITION block: **trust the disk** (git/grep
   output), not the block — and fix the block before doing any other work.
4. A unit killed mid-flight loses at most one window (≤160 L of one page): re-read that
   one window and rewrite its rows. Rows are the unit of state; there is no finer loss.
5. After every unit: write the rows/verdicts into `full-audit.md` AND update the EXACT
   POSITION block here. The block is the recovery artifact — a stale block makes recovery
   stale.

## Already done during the divert (do NOT redo)

- **R24** FIXED: crust `0b15108` (PR #63, merged `efe7687`) — README "What crust is not"
  FOO=x persists clause (G04 leftover). Probed first (persists: `bar`, exit 0).
- **W235** FIXED: builtins frontmatter 5-vs-8 — crust `d68665c` (PR #64, merged `0e624ae`)
  + site `0ab04b0` (PR #52, merged `7803ba5`). All three surfaces (SKILL.md shared source +
  builtins.mdx + index.mdx).
- **W153** → V (not a finding: probe artifact — `wrap` needs the page's init.ts; under the
  page's own preconditions both lines pass).
- **W600** CONFIRMED (probe, free-port twin: steps 1–3 pass, step 4 exit 2 — nothing in the
  gate starts :3000).
- **W561** stale forward refs — already fixed on disk pre-divert.
- **G13–G16** task files created (the "write each finding as a task" output so far):
  G13 npm-resolution-clash (W129/W131) · G14 procs-live-stream (W581) · G15
  procs-elapsed-comma (W586) · G16 vwl-ci-gate-incomplete (W600) — in
  `docs/audit/gaps/`, plan lines in CRUST_GAPS_PLAN.md, listed in audit (e). **Their fix commits are NOT yet made — that is Phase 2, after (a) closes.**
- npm-packages drift fix (earlier session) — SHA still to be found
  (`git -C …/crust-website log -- src/pages/docs/npm-packages.mdx`) and logged in (d).

## Decision (2026-10-18, user + audit rules)

- **Order: finish the analysis first** (steps 1–4 above → (b)–(e)), **then** Phase 2 fixes
  (including G13–G16 fix commits), **then** Phase 3 gap loop. Rationale: (i) every
  on-record finding is already a task, so deferring fixes loses nothing; (ii) a fix that
  lands mid-audit makes later findings stale — components/parity/code-review read the same
  files G13–G16 would modify; (iii) G06→G12 is user-gated on Phase 1 fully recorded.
- **Code review is BACK in scope** (user decision 2026-10-18, on the strength of the
  compaction-safe method holding; it is step 3 of the remaining list above). The earlier
  "drop" applied only to the fix-workflow review step. It is a review, not a fix gate: it
  closes `?` rows to C/V/X in place. Rows that contradict (X) become new G17+ items (same
  shape as G13–G16) + plan lines. Do NOT fix code while auditing; record the finding as a
  task and move on.
- **Code-review chunking protocol** (heaviest phase — strictest discipline): work the
  priority list (a)–(n) one group at a time; per group read only the src files that group
  names; write each row's verdict (C/V/X + `file:line` evidence) into the row's status cell
  IMMEDIATELY (anchor `awk '/^\| WNNN \|/'`, never line numbers); never re-read a src file
  after its verdict is on disk; checkpoint the completed group letter into the audit STATUS
  block after each group. A mid-group compaction resumes at last checkpointed group + 1.
- G01–G12 are the "what crust is not" / Limits work — limitations-area findings ride with
  them (P15 → G10; R24 was a G04 leftover, fixed; G12 sweep owns the final README/Limits
  rewrite). G13+ holds only genuinely new findings.

## Compaction-safe working method (the rules — re-read after any compaction)

1. **Disk is memory.** Every verdict, probe (exact command + output + exit code) and SHA is
   written to `full-audit.md` (and the plan) as it happens. If it isn't on disk, it didn't
   happen.
2. **No big re-reads.** Recover with grep + byte cuts: `awk '/^\| W552 \|/' full-audit.md |
   cut -c1-200`, `tail -c`, `head -c`. Rows are 5–20 KB; line numbers shift after edits —
   **anchor by row ID / content, never by line number.**
3. **Small units, verify, then next.** One page window → its rows → next window. One repo,
   one commit, gates, push, PR, merge — verify via `git log` before moving on. zsh: quote
   `=`-leading words; apostrophes in commit messages → `git commit -F <file>`.
4. **A compaction can still happen; these rules make it harmless, they don't prevent it.**
   If unsure of position: read only this file's "Exact position" block + the audit STATUS
   block + `grep -oE '^\| W[0-9]+ \|' full-audit.md | tail -1`.
5. **Chunked row writing:** write a page in windows (≤160 L), rows immediately after each
   window, never re-reading earlier windows of the same page.

## Gates (unchanged)

- crust: `bun test` (1187 run / 0 fail, ~17s), `bun run typecheck`, `bunx biome check .`
  (428 warnings / 18 infos / 0 errors).
- website: `bun run build`, `bun scripts/lint-examples.mjs
  /home/lario/Projects/personal/crust/bin/crust`, `bun run check-links` (baseline at
  b314237: 29 pages / 348 examples 0 failed / 1163 links 0 dead — **re-baseline after the
  R24/W235 merges if counts move; R24/W235 touched prose/frontmatter only, counts held**).
- Repo state at divert: crust main clean (`0e624ae` head), site main clean (`7803ba5`
  head); stale local branches `fix/audit-r24-foox-persist`, `fix/audit-w235-builtin-count`
  (both = main, safe to delete).

## Blocked

- G06 → G12 gap loop: blocked on Phase 1 (steps 1–4 above) fully recorded in
  `full-audit.md` (explicit user gate). G13–G16 fix commits: blocked on the same, by the
  decision above.

## Next move (first unit of a resuming session)

**The parity check is DONE (T1–T81, all 10 pairs) and code review groups
(a) sql (W477 X → G22; W107/W118/W132/W305/W475 C-code; W241 sql cell C)
and (b) auto-dispatch (all 40 rows; W141 X → G23) are DONE.** Next unit =
**code review group (c) init.ts loading** (NOT-done item 3, group (c):
W129/W131/W146/W150/W160/W162 + W465) — a review, NOT a fix gate: close every
open `?` row to C/V/X in place, with the verdict carrying `file:line`
evidence; an X row becomes a NEW G task file (next free = G24, same shape as
G13–G23) +
a plan line — no code fixes while reviewing (a fix landing mid-audit would
make later findings stale). Method (same discipline as the pair units,
adapted): work the priority groups **(a)–(n)** in the item-3 list below, ONE
group per unit; read only the src files that group names; write each row's
verdict immediately; NEVER re-read a src file after its verdict is on disk
(recover via grep + byte cuts anchored on row IDs — rows are multi-KB, never
use line numbers); checkpoint the completed group letter into the audit
STATUS block + this file after each unit; commit `docs/audit/` (md-only) and
push after each unit. FIRST re-read item 3's group map from "NOT done (a)"
below (it carries the exact W-row inventory per group). Groups: (a) sql
builtin — **DONE 2026-10-18** (W477 X → G22; W107/W118/W132/W305/W475 C-code;
W241 sql cell C; the open `$1`-as-bind question — page L345 `$1` vs SKILL
L65 `?`, W264(4) + W460(4) vs U9/U57 — deliberately NOT closed, stays with
the (b) probe; if a probe later shows `$1` expanding, BOTH sides get the
`?` form; G18 does not close it either); (b) auto-dispatch (W134–W168,
W228–W232) — **DONE 2026-10-18** (all 40 rows; W141 X → G23; the 7
probe-owned `?` halves — W137/W143/W147/W152/W158/W163/W164 — land in the (b)
probe run); (c) init.ts loading → W129/W131/W146/W150/W160/W162 + W465 (NOTE:
the load mechanism is already on disk — config.ts L101–108 dynamic import,
silent `MODULE_NOT_FOUND`/`ENOENT`, warn+continue otherwise — so (c) is the
npm-resolution adjudication against that mechanism, W131/G13 family; W146/
W150/W160/W162 closed C in (b) with exactly this half deferred here; do NOT
re-read settled files); (d) export surface + runtime globals; (e) source-fn array flattening;
(f) stage-error index preservation (W158 vs W266); (g) skills subsystem; (h)
base64 `--file`/`--out` main-vs-published (W244/W252); (i) tool-builtin
redirect refusal + `&` refusal; (j) genFixtures subpath export; (k)
mock-server surfaces; (l) logs ring buffer / pty keymap / procs stream kinds /
wait item shape / tail / grep / stats --every / read API / histogram
bucketing (W539 C-half); (m) W515 vs W473 message dialect; (n) W514
line-numbering. Also close the SK rows' `?`-as-code-review half where a group
names them (SK47 buffer default + fragment-as-query, SK48 boot-message
format, SK50 session message formats, SK94 defaults, W237 dispatch grep).
Then fresh build + full probe list → (b) (item 4), then (c)–(e).
