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

## EXACT POSITION (rolling — update this block after EVERY unit; verified on disk 2026-10-19)

- Last unit on disk: **code review group (l) logs session / pty keymap / procs stream kinds / wait item shape / tail source / grep native-subset / stats --every / read API surface / histogram bucketing (W539 C-half), IN PROGRESS 2026-10-19** —
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
  src inventory (NEW regions only — verdicts already on disk, NEVER
  re-read: read family sources.ts L98–174 + L50 (d); src/logs/* (d);
  transforms.ts parallel L253–300 + expect L185–222 + statsStage
  L619–700 (e); lexer L60–211 (i); runLine L55–95/L110–176/L125–140/
  L205–245/L288–303 (f)/(i); config L65–90 map (e); readiness L1–50 +
  wait.ts L62–72 (g); sinks.ts (e); builtins.ts L547–571 (i); genFixtures/
  mockServer (j)/(k)): src/editor.ts in full (321 L), completion.ts
  L80–95 (L1–80 seen this session), interrupt.ts L40–88 (L1–40 seen),
  builtinFns/wait.ts in full (76 L — DONE, facts below), sources.ts
  L175–1014 (tail L194 + findTailWindowStart L247 + mergeAsync L366 +
  procs L640–1014 incl. defaults L528–539, normalizeReady L548,
  normalizeLive L580, restartMax L609, killGroup L618), transforms.ts
  L1–~100 (native grep, comment L5) + L505–703 (histogram L514–618 +
  statsStage L619+ tail for --out/flush-on-item), lexer.ts L440–576
  (grep safe-subset recognizer L450), config.ts L60–95 (injection map
  re-verify for W82 — (e) precedent). Facts ALREADY read in context this
  session (must be written into the rows before they count): wait.ts in
  full (76 L) — usage `wait <target> [--timeout <dur>] [--interval <dur>]
  [--probe-timeout <dur>]`; durations `300ms`/`30s`/`2m`, bare number = ms
  (parseDuration readiness.ts L36–45: ms/s/m units — W363's "is 200ms a
  valid interval unit?" = YES); --timeout DEFAULT 30s, --interval DEFAULT
  500ms (W576(5) REVIEW answered), --probe-timeout default min(interval*4,
  2s); return type EXACTLY {target: string, ready: true, ms: number,
  attempts: number} (W363/W576(1)); both `--flag value` and `--flag=value`
  forms; unknown `--` flag / extra positional / missing target → error +
  usage screen; not-ready throws `wait: <t> not ready after <timeout>` +
  optional root-probe hint (runLine prepends `crust:` → W576(4)'s
  `crust: wait: :3999/nope not ready after 2s` shape); comment L13–14
  "A timeout throws, which runLine turns into exit 1". pty facts
  (grep-confirmed): exit 130 = runLine.ts L134 `fired ? 130 : (result ??
  0)` + L273 `return 130`; interrupt.ts = Ctrl-C interrupt bus (beginRun/
  fire/children kill set, parked-sleep races, non-REPL no-op);
  history.ts (30 L) HISTORY_PATH = $XDG_DATA_HOME/crust/history default
  ~/.local/share/crust/history, plain text, appendHistory dedupes ONLY
  against the immediately-preceding line, loadHistory splits newline +
  filters empty; completion.ts (95 L) at start-of-stage (after pipe/
  semicolon/BOL) completes $PATH names (readdir over PATH dirs, cached),
  mid-stage completes file paths, single-candidate auto-complete (dirs get
  trailing slash), common-prefix, does NOT know crust builtins; index.ts
  L271 `if (!process.stdin.isTTY)` = REPL TTY gate. sources.ts
  grep-confirmed constants: READY_DEFAULT_TIMEOUT_MS L528 = 30_000
  (W574(4)), READY_DEFAULT_INTERVAL_MS L529 = 250, LIVE_DEFAULT_INTERVAL_
  MS L532 = 5_000 (W572(5) cadence ~5s), LIVE_DEFAULT_FAILURES L533 = 3,
  KILL_GRACE_MS L536 = 3000 (W359/W575 3s-grace SIGTERM then SIGKILL),
  RESTART_HEALTHY_UPTIME_MS L539 = 10_000 (W573(2) uptime>10s reset);
  ProcLine L467, ReadySpec L474, LiveSpec L487, ProcSpec L502,
  normalizeReady L548, normalizeLive L580, restartMax L609, killGroup
  L618, procs L640; tail L194 (DEFAULT_TAIL_POLL_MS L192 = 200,
  TAIL_SCAN_BLOCK_BYTES L241 = 64KB, findTailWindowStart L247,
  mergeAsync L366); GET L418 / request L425. transforms.ts: L5 comment
  "Native grep over pipeline items — line-buffered where sh grep
  block-…" (native grep stage lives in transforms.ts, NOT a separate
  file); histogram L514–618 (BUCKET_BOUNDS, bucketFor L542, overflow
  bucket index = BUCKET_BOUNDS.length, nearest-rank over histogram L586+);
  statsStage L619+ (summary shape L600–609 {count, wallMs, rps, status,
  p50, p95, p99, meanMs} on disk via U129/W531). Next: read the remaining
  inventory regions, then write the 71 code halves row by row (subtopic
  order: pty → logs → procs → wait → tail → grep → stats → read API →
  histogram), then demote this entry, item-3 (l) line → DONE, Next-move
  head → (m), commit md-only, push.
- **Completed code-review groups (a)–(k), one line each** — full verdicts (claim-by-claim, with
  `file:line` evidence) live in the rows of `full-audit.md` and in each group's audit commit
  message; they are NOT restated here. (a) sql — W477 X → G22; W107/W118/W132/W305/W475
  C-code; W241 sql cell C (the `$1`-as-bind question stays with the (b) probe). (b)
  auto-dispatch — all 40 rows (W134–W168, W228–W232); W141 X → G23; 7 probe-owned `?` halves
  (W137/W143/W147/W152/W158/W163/W164) queued in (b). (c) init.ts — W129 X CONFIRMED / W131 C
  (via the user-directed G13 investigation 2026-10-18, fresh build `bin/crust-bin` sha256
  `947d2f4dd62e6705…`); W465 code-half C (src/testPipes/runner.ts in full). (d) export surface +
  runtime globals — W227 C; U129/W474/W455/W476/W468/W531 code-halves C; W551 addendum;
  SK47/48/50/94 C; U61 flag half X → G25; W144 X CONFIRMED → G24. (e) source-fn flattening —
  W126 C; W433 code-half C; W477(3) X CONFIRMED → G22 scope EXTENDED; W525 zero-arg parallel fn C
  + X → G26; W554 load-mode C. (f) stage-error index — W158 throw/sinks/propagate C +
  "index preserved" X → G27; W266 C (W158-vs-W266 resolves W266's way). (g) skills — all 27
  rows closed (21 C, 5 R: W197/W201/W203/W204/W205, W217 X → G28). (h) base64 — W244 C on every
  half; W252 C on every code half; W218 0.2.4 clause X → G29. (i) redirect/`&` refusal — W250/W251
  C on every half; W525 `&` half C; W525 row truncation (group (e) commit bae078f) repaired.
  (j) genFixtures — W390 C all code halves; U82 C; W420 C full close; W421/W422/W423 C code
  halves. (k) mock-server — 12 rows (W484/W485/W513/W515/W516/W517/W518/W520/W521/W522/W523/W524)
  code halves: DDL byte-identical, 422 build, message-dialect settled, 1000-cap,
  502-not-recorded. No unit after (g) found a new G beyond those listed; **next free G = G30**
  (the current (l) entry carries the same counter). G task files: `docs/audit/gaps/`; plan lines:
  `CRUST_GAPS_PLAN.md`; X-census: `full-audit.md`.
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
     (W134–W168, W228–W232); (c) init.ts loading — **DONE 2026-10-18** (W129 X CONFIRMED + W131 C + W146/W150/W163/W164 halves consumed via the G13 investigation; W465 code-half C — src/testPipes/runner.ts in full; its probe trio queued in (b));
     (d) export surface + runtime globals (W227, U129) — **DONE 2026-10-19** (W227 C; U129 code-half C; W474/W455/W476/W468/W531 code-halves C, probes → (b); W551 addendum; SK47/48/50/94 C; U61 flag half X → G25; W144 X CONFIRMED → G24; G24+G25 files + plan lines) — wait/logs/search/buffer/clear session
     commands + test-pipes/test-fixture/gen-fixtures/verify-web-links/mock-server dispatch
     entries + exact flag sets + expectStage/expect export names (W474) + readAll export
     (W455) + Pipeline.of (W476) + arity hard error since 0.2.4 (W468) + timedGet/statsStage/
     load-as-array-source (W531) + sort-stage presence (W551);
     (e) source-fn array flattening — **DONE 2026-10-19** (W126 C via cross-ref;
     W433 code-half C; W477(3) X CONFIRMED → G22 scope EXTENDED, not a new G;
     W525 zero-arg parallel fn C + X → G26 (ghost names: removed `stats()` sink
     + nonexistent `startMockServer`); W554 parallel(8, verb) load-mode C;
     W154 already C'd in (b) — cross-ref only; G26 file + plan line + G22 file
     update + (e) lines; all (e) probes in the (b) queue)
     (f) stage-error index preservation — **DONE 2026-10-19** (W158 code-half:
     throw-fails/sinks-reject/propagate C, "index preserved" X → G27; W266
     code-half C on all three halves; W158-vs-W266 resolves in W266's favor;
     G27 file + plan line + (f) line; both rows stay ? with (b) probes);
     (g) skills subsystem — **DONE 2026-10-19** (all 27 rows closed: W184/
     W188/W194–W218 — 21 C, 5 R (W197/W201/W203/W204/W205), W217 X → G28
     (cli.mdx failure block: line-1 truncation + the "sh: line after that"
     the code cannot produce); W216's two nuances recorded; all (g) probes
     stay (b)); (h) base64 `--file`/`--out` main-vs-published — **DONE 2026-10-19** (W244 C on every half — six parse-time screens via builtinHelp parser L301/L444 → HelpExit → runLine L293–295 stdout+0, `--` stop L619, piped-item-is-data, isBuiltinFn override gate L616, usage = base64.ts L36 verbatim, F42 = 95a1bbe in PR #60 merge 699986c, 0.2.4 `LS1oZWxw` from the flag-less v0.2.4 file; W252 C on every code half — flags on main L67–82, v0.2.4 lacks both (7a85aca in PR #60 postdates the 0.2.4 publish; npm latest 0.2.4), item-is-data L212–235, NOT_BASE64 refusal L143/L148–154; the W218 0.2.4 clause X → G29 — v0.2.4 had the preflight on NEITHER path (check half is PR #60's ae82619); G29 file + plan line + X-census entry + (e) line; W244/W252 stay ? with (b) probes);
     (i) tool-builtin redirect refusal (W250/W251) + inside-crust `&` refusal (W525) —
     **DONE 2026-10-19** (W250 C on every half — refusal() lexer L99–113
     byte-exact incl. lowercase "to save", hidden-stage strip classify
     L180–211 + stageHiddenByRedirect L170–178, "Measured leaks" comment
     L205–209 = the page's exact seven, grep exception L196–198/L177, the
     `| cat` tail form by construction; W251 C on every half — runLine
     exHead L117 + redirectTail L167 + Bun.which guard L168 (pre-fix 127
     leak comment L162–166) + message L170–174, rest = user's line minus
     tail L169, flag names all real: -o/--out test-pipes+test-fixture L21,
     --outfile/--outdir bundle L21, --report mock-server L45,
     verify-web-links has no file flag (stdout --json L49), the two W250
     messages distinct + third mid-pipeline form builtins.ts L559–571;
     W525 `&` half C — unquoted `&` = hasUnquotedShellMeta args.ts L261,
     refusal = the tool-builtin-head builtinInShellRefusal via runLine
     L212–220 before spawn, design comment L554–557 = the page's sentence,
     `&` itself has no dedicated token; the W525 row was found truncated
     mid-sentence at "The row" by group (e)'s commit bae078f — repaired +
     recorded in the row; all three rows stay ? with (b) probes; no new G,
     next free G = G30);
     (j) `crust/genFixtures/generate` subpath export (W390) + examples/gen-setup.ts +
     setup-contract exports — **DONE 2026-10-19** (W390 C on every code
     half — the named export generate.ts L1385 + the documented opts/
     result shapes, the subpath NOT resolvable (no exports map in either
     package.json, no src in the launcher files[]) = the relative-import
     in-repo form, the page has no in-repo caveat unlike the W485 sibling
     (record, no X), the swagger arg gets fetched when it's a URL
     (loadSpec L50) while $refs are local (derefSchemas L1326), out ↔
     -o/--out consistent, Swagger 2.0 auto-convert L63–65 → swagger2to3;
     U82 C — scopeParam the only hard-required (the in check L1396–1404),
     the four runtime exports not read by the generator (used-set L1459 +
     emitFixture L968–974), flowOverrides undocumented-optional; W420 C
     FULL CLOSE (the row waives the deep probe); W421 C code half
     (setupSpecifier L1002–1007 + isPathLike L1009–1011, bare kept as-is
     L1003, tension note → findings); W422 C on all three claims
     (examples/gen-setup.ts 106 L, DEFAULT_SETUP L8/L46/L58, the
     missing-setup message L115–125 exit 1); W423 C on the emitted
     structure (template L1462–1471 + emitFixture L966–999; the page
     sample omits the unconditional second header line L1463 — cosmetic
     note); no new G, next free G = G30; all open rows keep (b) probes);
     (k) mock-server: three import surfaces + exports map +
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
- npm-packages drift fix (earlier session) — **RESOLVED 2026-10-19, group (d)**:
  SHA = **288b2d3** (2026-10-06, "fix(docs): the TypeScript slots named an API
  that does not exist") — it touched db-drivers/intro/quickstart/recipes pages,
  NOT npm-packages.mdx itself (last npm-packages.mdx commit = 5bb532c 2026-08-12);
  logged in the full-audit X-census region + the group (d) COMPLETE marker.

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
(a) sql (W477 X → G22; W107/W118/W132/W305/W475 C-code; W241 sql cell C),
(b) auto-dispatch (all 40 rows; W141 X → G23), (c) init.ts loading
(W129 X CONFIRMED + W131 C via the user-directed G13 investigation 2026-10-18,
fresh build `bin/crust-bin` sha256 `947d2f4dd62e6705…`, Bun v1.4.3, probes
P1a/P1b/P2/P3a/P4/P5 + C1/C2 in full-audit.md §(b); W146/W150/W163/W164
halves consumed; W160/W162 C; W465 code-half C in the W465 unit —
src/testPipes/runner.ts in full: per-file freshContext L33–41 at L133, env
snapshot L128 + full finally-restore L166–171; probe trio stays in (b)), (d) export
surface + runtime globals (W227 C; U129 code-half C; W474/W455/W476/W468/W531
code-halves C, probes → (b); W551 addendum; SK47/48/50/94 C; U61 flag half X → G25;
W144 X CONFIRMED → G24) and (e) source-fn array flattening (W126 C via cross-ref;
W433 code-half C; W477(3) X CONFIRMED → G22 scope EXTENDED; W525 zero-arg parallel
fn C + X → G26; W554 load-mode C; G26 file + plan line + G22 file update + (e)
lines) and (f) stage-error index preservation (W158: throw-fails/sinks-reject/
propagate C, "index preserved" X → G27; W266 code-half C; W158-vs-W266
resolves in W266's favor; G27 file + plan line + (f) line) and
(g) skills subsystem (all 27 rows closed: 21 C, 5 R (W197/W201/W203/W204/
W205), W217 X → G28 — the cli.mdx L121–132 failure block is a line-1
truncation + a "sh: line after that" the code cannot produce; G28 file +
plan line + X-census entry + (e) line; W216's two nuances recorded; all (g)
probes stay (b)) are
ALL DONE.**
Next unit = **code review group (l) logs ring buffer / pty keymap / procs stream kinds / wait item shape / tail source / grep native-subset / stats --every / read/lines/readAll/read API surface / histogram bucketing code (W539 C-half)**
(item-3 group (l); group (k) is DONE 2026-10-19: all 12 rows (W484/W485/W513/W515/W516/W517/W518/W520/W521/W522/W523/W524) got code halves from full reads of cli.ts/proxy.ts/router.ts/server.ts/state.ts/validateRequest.ts — DDL byte-identical + the crust_mock_touched second-table nuance, the 422 build + message-dialect settled (two formatters over one walker), the exports-map state (neither package.json has one; the page's in-repo caveat stands, no X), the strip-set data point (six request headers, not the RFC set), the 1000-cap oldest-shift + DELETE-resets-dropped, 502-not-recorded, the logLine format with always-`(s)`, the --report appendFile; no new G, next free G = G30; see the EXACT POSITION block)
— a review, NOT a fix gate: close every
open `?` row to C/V/X in place, with the verdict carrying `file:line`
evidence; an X row becomes a NEW G task file (next free = G30, same shape as
G13–G29) +
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
probe run); (c) init.ts loading — **DONE 2026-10-18** (W129 X CONFIRMED /
W131 C via the G13 investigation 2026-10-18; W146+W150(+W163/W164) halves
consumed; W160/W162 C; W465 code-half C — runner.ts in full: freshContext
L33–41 at L133, env snapshot L128 + finally-restore L166–171, no init.ts
(bootstrap only); probe trio in (b)); (d) export surface + runtime globals —
**DONE 2026-10-19** (W227 C; U129 code-half C; W474/W455/W476/W468/W531
code-halves C, probe halves appended to the (b) queue; W551 sort-stage addendum
— finding-lite, not X; SK47/48/50/94 C; W338 code-side note, row stays ?
pty-probe-owned; U61 flag-table half X → G25; W144 severity settled X CONFIRMED
→ G24; G24+G25 files + plan lines + (e) lines written); (e) source-fn array
flattening — **DONE 2026-10-19** (W126 C; W433 code-half C; W477(3) X CONFIRMED →
G22 scope EXTENDED; W525 zero-arg parallel fn C + X → G26; W554 load-mode C;
G26 file + plan line + G22 file update);
(f) stage-error index preservation — **DONE 2026-10-19** (W158 code-half:
throw-fails/sinks-reject/propagate C + "index preserved" X → G27; W266
code-half C; W158-vs-W266 resolves in W266's favor; G27 file + plan line +
(f) line); (g) skills subsystem — **DONE 2026-10-19** (all 27 rows: 21 C,
5 R (W197/W201/W203/W204/W205), W217 X → G28 — the cli.mdx failure block is
a line-1 truncation + a "sh: line after that" the code cannot produce;
G28 file + plan line + X-census entry + (e) line; all (g) probes stay (b));
(h) base64 `--file`/`--out` main-vs-published (W244/W252) — **DONE
2026-10-19** (W244 C on every half; W252 C on every code half; the W218
0.2.4 clause X → G29); (i) tool-builtin redirect refusal (W250/W251) +
inside-crust `&` refusal (W525) — **DONE 2026-10-19** (W250 C on every
half; W251 C on every half; W525 `&` half C; W525 row truncation repaired;
no new G, next free G = G30); (j) genFixtures subpath export — **DONE
2026-10-19** (W390 C on every code half; U82 C; W420 C full close;
W421/W422/W423 C code halves; no new G, next free G = G30); (k)
mock-server surfaces — **DONE 2026-10-19** (12 rows W484/W485/W513/W515/W516/W517/W518/W520/W521/W522/W523/W524 code halves; no new G, next free G = G30); (l) logs ring buffer / pty keymap / procs stream kinds /
wait item shape / tail / grep / stats --every / read API / histogram
bucketing (W539 C-half); (m) W515 vs W473 message dialect; (n) W514
line-numbering. Also close the SK rows' `?`-as-code-review half where a group
names them (SK47 buffer default + fragment-as-query, SK48 boot-message
format, SK50 session message formats, SK94 defaults, W237 dispatch grep).
Then fresh build + full probe list → (b) (item 4), then (c)–(e).
