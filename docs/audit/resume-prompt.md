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

- Last row on disk: **W602** (verify-web-links recipe `## Related`, L185–188 — the page ends
  at L188, so the page is complete).
- Page boundaries (recipe queue): stress-testing **W549–W568** (L1–315) · dev-tail
  **W569–W582** (L1–236) · heap-snapshots **W583–W591** (L1–195) · verify-web-links recipe
  **W592–W602** (L1–188).
- **DONE (a, page-level):** repo docs — README R1–R26, USAGE U1–U134, CHANGELOG, PLAN
  P1–P17, spec C1–C24, INTERNAL I1–I5, AGENTS AG1–AG11, A1, nine skills SK1–SK94,
  examples/args.crust — plus **all 29 website pages W1–W602** (all 10 recipe pages included).
- **NOT done (a), in order:**
  1. **8 components** (install-command claims): Hero (182 L), InstallBlock (143),
     CodeSwitcher (181), Header (103), Sidebar (130), Footer (72), RecipeCard (77),
     FeatureCard (50) — in the website repo `src/components/`.
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

Start the 8-component pass: `src/components/Hero.tsx` (182 L) → rows with a new prefix
(continue the claim numbering; suggested `M1…` for "components", or next free W-block —
record the choice in the STATUS block), window ≤160 L, rows written per window, focus:
install-command claims + version numbers. Then InstallBlock, CodeSwitcher, Header, Sidebar,
Footer, RecipeCard, FeatureCard. Update the audit STATUS block after each page.
