# crust audit — history + worklist definitions (static)

Read this file ONLY when needed: the worklist definitions (item-3 group map,
item-4 probe list), a completed group's one-line summary, or the
parity/component/boundary inventories. CURRENT POSITION lives in
`resume-prompt.md` (EXACT POSITION) + the disk. The worklist definitions below
are never annotated with progress — completion state lives in the EXACT
POSITION entry (rolling) and the one-line-per-group block below (append-only).

## Completed code-review groups (a)–(l), one line each

Full verdicts (claim-by-claim, with `file:line` evidence) live in the rows of
`full-audit.md` and in each group's audit commit message; they are NOT
restated here. (a) sql — W477 X → G22; W107/W118/W132/W305/W475 C-code; W241
sql cell C (the `$1`-as-bind question stays with the (b) probe). (b)
auto-dispatch — all 40 rows (W134–W168, W228–W232); W141 X → G23; 7
probe-owned `?` halves (W137/W143/W147/W152/W158/W163/W164) queued in (b).
(c) init.ts — W129 X CONFIRMED / W131 C (via the user-directed G13
investigation 2026-10-18, fresh build `bin/crust-bin` sha256
`947d2f4dd62e6705…`); W465 code-half C (src/testPipes/runner.ts in full).
(d) export surface + runtime globals — W227 C; U129/W474/W455/W476/W468/W531
code-halves C; W551 addendum; SK47/48/50/94 C; U61 flag half X → G25; W144
X CONFIRMED → G24. (e) source-fn flattening — W126 C; W433 code-half C;
W477(3) X CONFIRMED → G22 scope EXTENDED; W525 zero-arg parallel fn C + X →
G26; W554 load-mode C. (f) stage-error index — W158 throw/sinks/propagate C +
"index preserved" X → G27; W266 C (W158-vs-W266 resolves W266's way). (g)
skills — all 27 rows closed (21 C, 5 R: W197/W201/W203/W204/W205, W217 X →
G28). (h) base64 — W244 C on every half; W252 C on every code half; W218
0.2.4 clause X → G29. (i) redirect/`&` refusal — W250/W251 C on every half;
W525 `&` half C; W525 row truncation (group (e) commit bae078f) repaired.
(j) genFixtures — W390 C all code halves; U82 C; W420 C full close;
W421/W422/W423 C code halves. (k) mock-server — 12 rows (W484/W485/W513/
W515/W516/W517/W518/W520/W521/W522/W523/W524) code halves: DDL byte-identical,
422 build, message-dialect settled, 1000-cap, 502-not-recorded. (l) logs
session / pty keymap / procs stream kinds / wait item shape / tail source /
grep native-subset / stats --every / read API / histogram + scope-decision
(W21/W33/W81/W265) — 66/71 rows closed 2026-10-19→2026-10-22: (1) logs
session 19 rows (W331–W343, W345–W349, W578); (2) pty 4 rows (W68 FULL C;
W224/W225 code halves, rows stay ? pty-probe-owned; SK34 C); (3) procs 20
rows (W351, W353–W364, W570–W575, W577 — sources.ts L460–1000 full read:
readyGen/liveGen/exitGen, restart backoff 250→2s cap, killGroup/terminate);
(4) wait 3 rows (W363/W576/W577 — wait.ts 76 L full: item shape
{target, ready, ms, attempts}, --timeout 30s / --interval 500ms /
--probe-timeout min(interval*4, 2s)); (5) tail 2 rows (W435/W258 — sources
L175–370: holder-owned signal, 64KB-backward byte-safe window scan,
inode-change rotation reset); (6) grep 4 rows (SK69/W442/U33/U34 —
grepStage L12–40 per-line JS regex, -F substring, classifyGrep L458–503
rejection set; W442's `{3}` brace-trigger correction in-row); (7) stats
--every 6 rows (U39/W543/W559/W560/SK42/SK44 — two-accumulator design:
delta windows {window: N} vs cumulative final {final: true}, flush ONLY on
the item path, --out .json write-then-rename after every window); (8) read
API 3 rows (W82/W379/W430 — the 20-name injection map L70–90 provenance,
GET/request minted-per-request timeout, httpRequest body "upstream item IS
the body"); (9) histogram 1 row (W539 — BUCKET_BOUNDS constant grid +
nearest-rank percentiles over bucket counts, constant memory); (10) W33
FULL C (the five names live in exactly TWO of the three stated files —
pipeline.ts holds Pipeline, a different listed global; the 3-file list is
collectively true, loose, not false; the npm launcher has NO importable
surface — the `crust/…` subpath stays parked with G13); (11) W21 **X → G30**
(intro.mdx TS slot — the only new G of the group: `stats()` = the REMOVED
sink in the wrong `.to(…)` shape per the G26 tombstone + "globals auto-
loaded when the script imports from 'crust'" has no entry to resolve to —
G13 Q1; `expectStage` is a map alias only, the export is `expect`; W40's
same shape on npm-packages is a separate page, trivial in-place candidate);
(12) W81 C code halves (sinks.ts export surface is EXACTLY
`write`/`dest` with the page's arities; NO write/dest in the 22-kind
StageKind union — the refusal probe stays (b)); (13) W265 C code halves on
ALL EIGHT traps (assert is a FULL stage — empty upstream fails, the code
comment names "the sql-returned-zero-rows trap" verbatim; filterStage
`if (keep) yield` drops falsy, silent on empty; looksJsonish parse-first
with spaced=shell / tight-with-$/quote/colon/comma=literal-attempt and the
false-pass ordering rationale; builtinInShellRefusal via the
!hasUnquotedShellMeta dispatch gate; parallel completion order per W551 (d);
all eight probes stay (b)). 71-row scope bookkeeping (recorded at the
close): 66 closed by (l); remaining in the locked scope = W473 ((m)) +
W514 ((n)) → 68; of the 7-row 71-gap, 5 identified (W21/W33/W81/W265 —
closed by (10)–(13); W240 — probe-owned, stays (b) with W237's sub-claim
4) + ~2 unidentified (pre-existing bookkeeping ambiguity — 71's derivation
is not reconstructable from disk artifacts; the denominator stays LOCKED,
the gap is recorded, never silently changed). NEXT after (l): (m) W473 vs
W515 message dialect (W515 carries its code half from (k)) → (n) W514
line-numbering → item-4 (fresh build + full probe list → (b), then
(c)–(e)). G task files:
`docs/audit/gaps/`; plan lines: `CRUST_GAPS_PLAN.md`; X-census:
`full-audit.md`.

## Parity rows (T1–T81, all pairs done)

Live in full-audit.md under `### parity check:` (prefix **T1+**): T1 =
index.mdx `skills list` block vs the nine SKILL.md frontmatters (X → **G17**);
T2–T7 = pipelines pair (T3 → **G18**); T8–T14 = api-testing pair (CLEAN all
C); T15–T21 = load-testing pair (T20 → **G19** — guard-without-`--every`
inverts the short-circuit; same sentence in ci-load-gates.mdx L163, W543 `?`
pending its (b) probe); T22–T27 = mock-server pair (T26 → **G20** —
conformance-gate line missing the required `(r => r.json())` decode stage;
the site's own recipe page has it in both places, L482/L521); T28–T33 = procs
pair (NO X — all C; T33 C-PENDING: site "evaluated as JavaScript" ×2 pages vs
SKILL "read as data by a pipeline stage" for bare `procs(...) > file` —
settled by the W364(4) + SK86 (b) probes; no G until they land); T34–T39 =
cli pair WINDOW 1 of 2 (intro / run modes / exit codes / --check /
Environment head — NO X; T38 C-PENDING: site 2-line --check failure block +
"the `sh:` line after that" vs SKILL L93 inline `: sh: …` on line 1 — settled
by the SAME probe queued at W217 + SK31; SKILL.md's Environment section is
ONLY L109–118 = the 5-row table, so the site's env elaborations W221/W222 are
site-only expansions, verified). Parity queue: **CLEAR — all 10 pairs done
(T1–T81).** verify-web-links pair DONE (T72–T81, 0 of 10 X — frontmatter/
intro site-only intro paragraph · check table cell-identical · exit codes
surface-words-only · pointing block + prose identical · Green-does-not-mean-
checked with the site-only verbatim note strings carried `?` at W376 · In CI
with the identical `--strict` example string (inline vs fenced) · meta fixture
block line-identical · tuning with the SKILL-only 4th bullet = anchor-skip
companion that agrees with the site's honesty block · Traps + Related
site-only, W385/W386 R). logs pair DONE (T64–T71, 0 of 8 X — boot-line focal
no third variant, T66; `search` adverb delta carried). builtins pair DONE
(T46–T63, 1 of 18 X): T62 → G21; T50 + T54-lambda C-PENDING carried; both
files list the same EIGHT tool builtins (6-vs-8 resolves: AGENTS.md's six =
the `parseFlags` CLI set, T47); W237's dispatch-table grep stays open for the
CODE REVIEW.

## Component rows (M1–M17)

Live under `### website components` between the W602 row and the
`### parity check:` heading: M1–M6 Hero · M7–M11 InstallBlock+site.ts ·
M12 CodeSwitcher · M13 Header · M14 Sidebar · M15 Footer · M16 RecipeCard ·
M17 FeatureCard.

## Page boundaries (recipe queue, historical)

stress-testing **W549–W568** (L1–315) · dev-tail **W569–W582** (L1–236) ·
heap-snapshots **W583–W591** (L1–195) · verify-web-links recipe
**W592–W602** (L1–188).

## DONE (a, page-level)

repo docs — README R1–R26, USAGE U1–U134, CHANGELOG, PLAN P1–P17, spec
C1–C24, INTERNAL I1–I5, AGENTS AG1–AG11, A1, nine skills SK1–SK94,
examples/args.crust — plus **all 29 website pages W1–W602** (all 10 recipe
pages included). Components M1–M17 DONE 2026-10-18 (the files are `.astro`,
not `.tsx`: Hero 182 L, InstallBlock 143, CodeSwitcher 181, Header 103,
Sidebar 130, Footer 72, RecipeCard 77, FeatureCard 50 — in the website repo
`src/components/`; the install-command surface reduces to the four
`src/lib/site.ts` constants (INSTALL_COMMAND ×2 modes, NPM_INSTALL_COMMAND,
CLONE_COMMAND) — all C vs I1/AG10/R-rows; the Jenkins Gate claim verified
against the live Jenkinsfile).

## Worklist definitions — "NOT done (a), in order"

Item 1 (8 components → M1–M17, DONE 2026-10-18) and item 2 (parity, DONE
2026-10-18: `src/pages/docs/agent-skills/*.mdx` ↔ repo `skills/*/SKILL.md`;
esp. G01–G05 topics, W184's nine skill descriptions vs SKILL.md frontmatter,
builtins-list coverage (now includes `test-fixture`), logs-boot-line format
parity (W344 vs W446: `logs: <cmd>` — buffering last 10000 items); each pair's
T-rows in full-audit.md define the per-pair comparison) are DONE — see above.
Items 3–4 remain; this is the DEFINITION of the code-review worklist.
Progress on it lives only in resume-prompt.md's EXACT POSITION entry.

3. **Code review** — `src/` top-level + builtin dirs (`builtinFns/`,
   `genFixtures/`, `logs/`, `mockServer/`, `testFixture/`, `testPipes/`,
   `verifyWebLinks/`) + `tests/` (honest-failure controls intact?) + `npm/`
   (read-only) — **close every `?` row**. Group map (work ONE group per
   unit; within a group, one subtopic per unit): (a) sql builtin existence +
   W107/W118/W132/W241/W305 error strings + W475/W477 sql stage modes, sql
   reads `$DATABASE_URL`; (b) auto-dispatch subsystem (W134–W168, W228–W232);
   (c) init.ts loading; (d) export surface + runtime globals (W227, U129) —
   wait/logs/search/buffer/clear session commands + test-pipes/test-
   fixture/gen-fixtures/verify-web-links/mock-server dispatch entries + exact
   flag sets + expectStage/expect export names (W474) + readAll export (W455)
   + Pipeline.of (W476) + arity hard error since 0.2.4 (W468) +
   timedGet/statsStage/load-as-array-source (W531) + sort-stage presence
   (W551); (e) source-fn array flattening; (f) stage-error index
   preservation; (g) skills subsystem; (h) base64 `--file`/`--out`
   main-vs-published; (i) tool-builtin redirect refusal (W250/W251) +
   inside-crust `&` refusal (W525); (j) `crust/genFixtures/generate` subpath
   export (W390) + examples/gen-setup.ts + setup-contract exports; (k)
   mock-server: three import surfaces + exports map + crust_mock_state DDL +
   __crust/violations endpoint + x-crust-validation header + subset walker +
   422 + proxy --report; (l) logs session ring buffer / pty keymap + procs
   stream kinds + wait item shape + tail source + grep native-subset + stats
   --every + read/lines/readAll/read API surface + histogram bucketing code
   (W539 C-half); (m) W515 vs W473 message dialect; (n) W514 line-numbering.
   Also close the SK rows' `?`-as-code-review half where a group names them
   (SK47 buffer default + fragment-as-query, SK48 boot-message format, SK50
   session message formats, SK94 defaults, W237 dispatch grep).

4. **Fresh build + full probe list → section (b).** `cd /home/lario/Projects/
   personal/crust && bun run build` → `bin/crust-bin` (verify newer than
   main's last commit). Probe list: gen-fixtures minimal-spec runs; log-
   mining matrix; api-smoke-tests matrix (W453–W481); mock-server matrix
   (W484–W525: boot forms ×7, flag exclusions, seed empty-only/restart,
   envelope detect/unwrap, table DDL diff, sql-assert suite, 422 body diff,
   never-invent battery, --strict, 2.0 body param, GET-body discard, proxy
   forwarding/502/records, violations endpoint + cap + DELETE, CI gate 3
   steps, in-process builtin + `&` refusal, wait `:4000` vs `:4000/pets` vs
   `port:4000`, burn-in 10k stats); ci-load-gates matrix (W528–W548 notes);
   stress-testing matrix (W549–W552+ notes: burst arrival histogram, ramp
   count = phase sum, drop line E+D==T, maxLagMs, --timeout pinned shapes,
   --every window deltas/final); pre-existing probes unchanged: R24, U3, U16,
   U30, U33–U34, U47, U51–U57, G07, G08, C1/C2/C6/C7, C14, A1, SK2, SK14,
   SK17–SK24, SK25–SK32, SK38–SK44, SK53, SK54–SK66, SK68–SK77, SK78–SK86;
   `bun -e 'console.log(typeof Bun.SQL, typeof Bun.sql)'`; `range(0, 3) |
   cat` count; `echo hi | wrap [ ]` verbatim; `sql "select 1"` without
   DATABASE_URL; `CRUST_DEBUG=1 CRUST_CONFIG=/dev/null bin/crust -c '…'`
   stderr; `bun -e 'console.log(typeof range)'`; `ls ~/.bun/install/global/
   node_modules`; W9, W16 install.mjs, W84, W37, W52, W53, W55, W58, W60,
   W61, W67; plus load-testing/verify-web-links matrices in W-row notes.
   Then: **(c) Findings, (d) Fixed in place, (e) G13+**.

## Already done during the divert (do NOT redo)

- **R24** FIXED: crust `0b15108` (PR #63, merged `efe7687`) — README "What
  crust is not" FOO=x persists clause (G04 leftover). Probed first
  (persists: `bar`, exit 0).
- **W235** FIXED: builtins frontmatter 5-vs-8 — crust `d68665c` (PR #64,
  merged `0e624ae`) + site `0ab04b0` (PR #52, merged `7803ba5`). All three
  surfaces (SKILL.md shared source + builtins.mdx + index.mdx).
- **W153** → V (not a finding: probe artifact — `wrap` needs the page's
  init.ts; under the page's own preconditions both lines pass).
- **W600** CONFIRMED (probe, free-port twin: steps 1–3 pass, step 4 exit 2 —
  nothing in the gate starts :3000).
- **W561** stale forward refs — already fixed on disk pre-divert.
- **G13–G16** task files created (the "write each finding as a task" output so
  far): G13 npm-resolution-clash (W129/W131) · G14 procs-live-stream (W581)
  · G15 procs-elapsed-comma (W586) · G16 vwl-ci-gate-incomplete (W600) — in
  `docs/audit/gaps/`, plan lines in CRUST_GAPS_PLAN.md, listed in audit (e).
  **Their fix commits are NOT yet made — that is Phase 2, after (a) closes.**
- npm-packages drift fix (earlier session) — **RESOLVED 2026-10-19, group
  (d)**: SHA = **288b2d3** (2026-10-06, "fix(docs): the TypeScript slots
  named an API that does not exist") — it touched db-drivers/intro/
  quickstart/recipes pages, NOT npm-packages.mdx itself (last npm-packages.mdx
  commit = 5bb532c 2026-08-12); logged in the full-audit X-census region +
  the group (d) COMPLETE marker.

## Decision (2026-10-18, user + audit rules)

- **Order: finish the analysis first** (steps 1–4 above → (b)–(e)), **then**
  Phase 2 fixes (including G13–G16 fix commits), **then** Phase 3 gap loop.
  Rationale: (i) every on-record finding is already a task, so deferring
  fixes loses nothing; (ii) a fix that lands mid-audit makes later findings
  stale — components/parity/code-review read the same files G13–G16 would
  modify; (iii) G06→G12 is user-gated on Phase 1 fully recorded.
- **Code review is BACK in scope** (user decision 2026-10-18, on the strength
  of the compaction-safe method holding; it is step 3 of the remaining list
  above). The earlier "drop" applied only to the fix-workflow review step. It
  is a review, not a fix gate: it closes `?` rows to C/V/X in place. Rows
  that contradict (X) become new G17+ items (same shape as G13–G16) + plan
  lines. Do NOT fix code while auditing; record the finding as a task and
  move on.
- **Code-review chunking protocol** (heaviest phase — strictest discipline):
  work the priority list one group at a time; per group read only the src
  files that group names; write each row's verdict (C/V/X + `file:line`
  evidence) into the row's status cell IMMEDIATELY (anchor `awk '/^\| WNNN
  \|/'`, never line numbers); never re-read a src file after its verdict is
  on disk; checkpoint the completed group letter into the audit STATUS block
  after each group. A mid-group compaction resumes at last checkpointed group
  + 1.
- G01–G12 are the "what crust is not" / Limits work — limitations-area
  findings ride with them (P15 → G10; R24 was a G04 leftover, fixed; G12
  sweep owns the final README/Limits rewrite). G13+ holds only genuinely new
  findings.
