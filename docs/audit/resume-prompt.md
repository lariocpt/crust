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

- Last unit on disk: **code review group (i) tool-builtin redirect refusal (W250/W251) + inside-crust `&` refusal (W525), COMPLETE 2026-10-19** —
  src read this unit: src/lexer.ts L60–211 (redirectTail L69–97; refusal()
  L99–113 — the full message: target line + "crust has no redirect except on
  a shell stage, whose text goes to sh as-is" + article/kind clause, the
  L108–110 `>`-tail hint "to save a pipeline, end the line with a shell
  stage instead: | cat <t>" (lowercase "to save" = the code's own spelling —
  the row's byte question settled), article logic L111 (`http` always "an");
  rejectRedirect L119–122; stageHiddenByRedirect L170–178 — strip the
  redirect tail, reclassify, null when the inner is shell or grep; classify
  L180–211 — the two refusal sites L197–200 (non-shell kind with a tail) and
  L207–210 (shell kind whose tail hides a crust stage), the "Measured leaks"
  comment L205–209 = the page's exact seven (range/capture/parallel/expect/
  stats/stdin/load), the grep exception comment L196–198); src/runLine.ts
  L110–176 + L205–245 (runLine L110; exHead = first word L117; in-process
  dispatch gate L118 — a tool-builtin head runs in-process, so no sh, no `&`;
  the tool-builtin redirect refusal L162–174 — comment L162–166 = the pre-fix
  127 leak, redirectTail(expanded) L167, the Bun.which(exHead) guard L168 so
  the refusal reaches only a name that is BOTH a crust builtin and on PATH,
  rest = user's line minus the tail L169, message + return 1 L170–174; the
  pure-shell path + per-stage builtinInShellRefusal loop L212–220);
  src/builtins.ts L547–571 (isToolBuiltin L547–549; design comment L554–557
  "no shell operator can wrap them" = the page's sentence;
  builtinInShellRefusal L559–571 — "Give it a line of its own.");
  src/parser.ts L180–225 + L630–700 (resolveKind L187–207 +
  rejectRedirect; shellSource refusal L640; shellTransform refusal L683);
  src/args.ts L261 (hasUnquotedShellMeta — an unquoted `&` marks the line
  shell, so the in-process dispatch gate steps aside); npm/package.json
  (bin = `crust` ONLY — sh has no `mock-server` to exec); the file-flag
  sites: testPipes/cli.ts L21 (-o, --out), testFixture/cli.ts L21 (-o,
  --out), bundle.ts L21 (--outfile/--outdir), mockServer/cli.ts L45
  (--report <path>), verifyWebLinks/cli.ts L49 (stdout --json, NO file
  flag). Page reads: agent-skills/builtins.mdx W250 L155–186 / W251
  L188–203; recipes/mock-server.mdx (NOT agent-skills) W525 L526–563, the
  `&` sentence L528–531. Verdicts — **W250** C on every half (the verbatim
  message byte-exact; the hidden-stage strip with its two refusal sites; the
  explicit grep exception; `base64 hello | cat > out.b64` C by
  construction). **W251** C on every half (refusal on the exec path BEFORE
  any spawn; the double-condition Bun.which guard + the recorded pre-fix 127
  leak; the suggestion line reproduces the exact flags BY CONSTRUCTION since
  rest = the user's line minus the tail; every cited file-flag name real —
  nuance: verify-web-links has no file flag, the row's parenthetical is an
  example set; the W250 cross-check: the two messages ARE distinct —
  runLine L171–172 vs lexer refusal() — plus a third mid-pipeline form
  builtinInShellRefusal, no contradiction). **W525** C on the `&` half (the
  in-scope one): `&` is unquoted shell meta (args.ts L261) so the dispatch
  gate steps aside, the redirect gate finds no tail, and the per-stage loop
  L212–220 refuses the tool-builtin head BEFORE any spawn; the refusal is
  against the tool-builtin head, not against `&` itself — a non-builtin `&`
  line goes to sh; "hand sh a name it does not have" C from the artifact;
  the wait-target rationale (:4000/pets vs wait :4000 404 trap, port:
  scheme) stays probe-owned (b). **W525 row repair (pre-existing defect,
  found this unit):** group (e)'s commit bae078f left the row truncated
  mid-sentence at "The row" (verified: bae078f^ well-formed, bae078f and
  every commit since broken; single-line preserved) — this unit restored
  the "Row stays `?`" closing and recorded the repair in the row itself. No
  new G (next free G stays G30) → no plan line, no X-census entry, no (e)
  line this unit. No code changes (audit only). The W250/W251/W525 rows
  stay `?` — their (b) probe halves (the verbatim captures, the tail-form
  file check, the file-flag probe list, the in-process `&`-refusal pair, the
  wait-target rationale, the switcher trio, the burn-in, the ts runtime
  half) stay in (b).
  Next unit = **code review group (j) `crust/genFixtures/generate` subpath
  export (W390) + examples/gen-setup.ts + setup-contract exports**.
  Last unit before this one: **code review group (h) base64 `--file`/`--out` main-vs-published, COMPLETE 2026-10-19** —
  src read this unit: src/builtinFns/base64.ts in full (235 L — usage L36;
  parseOptions L67–91: -f/--file/-o/--out L67–82, `--` operand stop
  L83–91, typo refusal L95–100; render(Buffer) L118–125 binary-safe
  (decode via decodeBytes, no UTF-8 round-trip), writeTo L127–130
  (`wrote N bytes to <p>`), readTheFile L132–135 raw readFileSync;
  NOT_BASE64 L143 + decodeBytes throw L148–154; head form: file branch
  L182–184, text encode + stderr `note:` L195–204; base64Stage L212–235 —
  parseOptions on the LINE args only, item → String/Buffer, the two
  mid-pipeline refusals); src/builtinFns/index.ts in full (46 L —
  BUILTIN_FN_USAGE L24–31 keyed by all six names; BUILTIN_FNS +
  isBuiltinFn identity check L43–46); src/parser.ts L605–627 (HelpExit
  class L608–613; builtinHelp L615–627: isBuiltinFn gate L616, `--` stop
  L619, piped-item comment L621–623, throw L624) + the two builtinHelp
  call sites (fn-source arm L301, fn-stage arm L444); src/runLine.ts
  L288–303 (the HelpExit catch L293–295 → usage on STDOUT + return 0);
  src/index.ts L185–200 (the check path: parse-only loop, HelpExit arm
  L192–196 = valid line, usage prints when it RUNS). Git (all read-only):
  `git show v0.2.4:src/builtinFns/base64.ts` (the whole 16-line file — no
  option parsing, no `--`, no usage; decode scan `args.some(a => a ===
  "-d" || …)`; plain lenient `Buffer.from(str, "base64")`), `git show
  v0.2.4:src/index.ts` (the check loop = `parse(line)(ctx)` +
  `checkBuiltinLine` only), `git grep 'sh -n\|shellSyntax\|noexec' v0.2.4
  -- src/` = ZERO matches, ancestry checks (`ae82619` → `7a85aca` →
  `95a1bbe` all ancestors of `699986c`). Verdicts — **W244** C on every
  half (six parse-time screens via HelpExit; "before any stage runs"
  STRUCTURAL — builtinHelp runs in the parse BUILD phase and 95a1bbe's
  message records the touch-never-happens measurement; `--` stop L619;
  piped value is data (parser L621–623 + base64Stage L212–235); crust.fn
  override bypass (isBuiltinFn L616); usage line byte-exact = L36; "That
  is the PR #60 change" C — F42 = 95a1bbe in the 699986c merge; "In
  0.2.4 … `LS1oZWxw`" C from the flag-less v0.2.4 file; the row's
  internal-consistency note resolves C — the usage block is a verbatim
  MAIN quote, not a linted fence, and the published state (npm latest
  0.2.4, published 2026-08-25, gitHead `49b271d`; the GitHub-release
  binary = v0.2.4 tag) really lacks the flags); **W252** C on every code
  half (head form encodes TEXT L195–205 + the offline encodings verified;
  PNG claim = L14–16 header + `7a85aca`'s message; --file/--out on main
  L67–82 + raw-bytes binary-safe path + `wrote N` + byte-for-byte round
  trip + note: stderr-only — MAIN-VS-PUBLISHED settled C: v0.2.4 lacks
  BOTH flags, `7a85aca` is in PR #60 postdating the 0.2.4 publish, npm
  latest 0.2.4; item-is-data L212–235 + the v0.2.4 history
  code-verified (item `-d` → missing input exit 1, `--desc` → `LS1kZXNj`
  exit 0); NOT_BASE64 refusal L143/L148–154 vs v0.2.4's lenient
  Buffer.from). **W218 AMENDMENT**: the 0.2.4 clause "(in 0.2.4 only
  `--check` has it)" is **X → G29** — v0.2.4 had the preflight on NEITHER
  path (check loop pure-parse + checkBuiltinLine only; zero `sh -n` in
  the tree); the preflight is PR #60's (`ae82619` check half, `95a1bbe`
  exec half, both ancestors of `699986c`); the "only --check" state was
  intra-PR only, never a release; group (g) had C'd it off the CURRENT
  dual-path comment (a misread — recorded); W218's other four halves
  stand. G29 file in gaps/ + plan line + X-census entry + (e) line.
  No code changes (audit only). W244/W252 stay `?` — their (b) probes
  (six screens, touch-never-runs, `--` stop, round-trip, note:, LWQ=/
  refusal captures) stay in (b). Next free G = G30.
  Next unit = **code review group (i) tool-builtin redirect refusal
  (W250/W251) + inside-crust `&` refusal (W525)**.
  Last unit before this one: **code review group (g) skills subsystem, COMPLETE 2026-10-19** —
  src read this unit: skillsCli.ts (spec comments L19–21; installSkills
  L80–151 incl. idempotency L80–82 + refusal format L135–140 + summary L145–149;
  wantsMenu L128–131; list L218–230; exit-code table L151–235), skillsPicker.ts
  (keymap L81–100; toggleAll L112–116; defaultChoice L139–141; status labels
  L143–147; global/force toggles L255–260), skillsData.ts (EMBEDDED_SKILLS
  L6–30; skillDescription L33–37; status pre-read L105–115), skillsCompat.ts
  (link ensure L60–64), npm/scripts/postinstall.mjs + npm/lib/skills-prompt.mjs
  in full (five never-ask conditions shouldAsk L36–63; warn-only
  try/catches; explicit exit 0 L36), tests/skills.test.ts (live-lexer import
  L6; KEYWORDS set L43–60; fence extraction L64; fail-on-unclassified L70–73;
  keyword-head assertion L74–78), index.ts L175–269 re-verified (check path
  L189–219: `parse(line)(ctx)` build-only L190, preflight L209–216, `where`
  L211, exit 1 L215; tool dispatch L235–241; script read 127 L261–265),
  runLine.ts L150–269 (isPureShell L179–191; exec preflight L193–208;
  pure-shell one `sh -c` L229–238; catch format L288–303), lexer.ts L195–304
  (ShellSyntaxProblem L216–221; shellSyntaxPreflight L238–253 — `sh -n -c`
  spawn, stderr PIPED L241–245, `first` = sh's first stderr line L249; F19
  comment L223–237), args.ts L270–301 (expandEnv L283–301 — process.env
  L296, unset → `""` L296–298, opt-in-sites comment L281–282), parser.ts
  L195–344 (expansion call sites L204/L216/L241/L259/L337/L417; json case
  eager `JSON.parse(expandEnv(...))` L256–261; readsrc raw pattern L262–269;
  -H no-colon throw L217–218), sources.ts L130–158 (readAll laziness —
  `Bun.file(p)` at iteration). Verdicts — all 27 in-scope rows closed
  (W184/W188/W194–W218): **21 C** (W184 nine-names + frontmatter
  verbatim-by-construction; W188 two summary lines verbatim; W194 picker
  keymap + 3 nuance notes; W195 non-interactive contract; W196 postinstall
  five never-ask + never-fail; W198 idempotency; W199 edit-refusal format
  verbatim; W200 exit-code table 0/1/2; W202 live-lexer lint, KEYWORDS
  superset note; W206–W212 run-modes/exit-codes/wait contract; W213–W215
  --check contract/lazy-source; W216 env-expansion all four halves C + two
  nuances (read path NEVER expanded at build — parser L269 raw; whole-unset
  `-H` → build error L217–218); W218 runtime preflight all halves C —
  mixed-only, BEFORE build so "nothing has run" is structural, F19 comments
  verbatim); **5 R** (W197/W201/W203/W204/W205); **1 X → G28** (W217:
  cli.mdx L121–132 failure block — the verbatim block is a line-1 truncation
  and "the `sh:` line after that" is a line the code cannot produce; the
  format appends `problem.first` to the END of line 1, index.ts L212–214 /
  runLine.ts L204–206, and the preflight's stderr is captured not passed
  through, lexer.ts L241–249; the "names the stage" + "passes it through
  unchanged (wording)" halves C). G28 file in gaps/ + plan line + X-census
  entry + (e) line. No code changes (audit only). Next free G = G29.
  Next unit = **code review group (h) base64 `--file`/`--out` main-vs-published**
  (W244/W252).
  Last unit before this one: **code review group (f) stage-error index preservation, COMPLETE 2026-10-19** —
  src read this unit: runLine.ts L55–95 (splitLines continuation + `runLines`
  L76–85 — the SHARED fail-fast loop, comment names script file / piped stdin
  / multi-line `-c` / `source`d file, `if (last !== 0) break;` L82) + the
  line-exec catch L288–303 (HelpExit → stdout + 0; ShellExitError → child's
  code, no `crust:` line; else `crust: <err.message>` + return 1, L301–302) +
  the in-process builtin dispatch catch L125–140 (same format); transforms.ts
  L185–222 (ExpectError L187–196 — `expect: item at index ${index} failed
  matcher ${…}` at L193; the expect stage's own counter `i` L215/L217/L219,
  stage-local over surviving items); pipeline.ts re-verified NO-INDEX in
  every arm (fn-arm L75–83 no try/catch; only throw = unsupported-source
  L58). Verdicts: **W158** C on throw-fails + sinks-reject (collect
  L107–111 for-await rejects) + non-terminal-propagate (no local catch in
  the generator chain); the "with the index preserved" half **X → G27** (no
  index in chain or format; the sole indexed error is a stage-local
  ExpectError MISMATCH, not a preserved source index), **W266** C on all
  three halves (format verbatim + the two documented in-contract exceptions;
  the three entry modes DO share `runLines`) — the W158-vs-W266
  contradiction resolves in W266's favor in code. G27 file in gaps/ + plan
  line + (f) section line; both rows stay ? with their (b) verbatim-capture
  probes (throw-on-item-2-of-5; good/bad/good fail-fast). No code changes
  (audit only). Next free G = G28.
  Next unit = **code review group (g) skills subsystem**
  (W184/W188/W194–W218 — the skills-CLI surface: what `crust skills`
  subcommands actually exist vs what the skills pages claim).
  Last unit before this one: **code review group (e) source-fn array flattening,
  COMPLETE 2026-10-19** —
  src read this unit: pipeline.ts L44–142 in full (pipe fn-arm L75–83 =
  the no-flatten contract `yield await fn(item)`; collect L107; `to` L140–142
  — a stage passed there is a laziness trap), parser.ts shellSource
  L636–684 + shellTransform L686–745 (per-line linearization: `buf.split("\n")`
  yield-per-line, flush `if (buf) yield buf` L668/L738, empty lines = ""
  items — "drops blanks" is grep's `.`) + parallel-modifier region L83–121
  (NOT a stage — pending-concurrency consumed by the NEXT stage) + applyStage
  arms L326–355 (GET = parallel(n, timedGet) at any n; write verbs + modifier
  = LOAD mode parallel(concurrency, timedHttpItem)), transforms.ts parallel
  body L253–300 (fn(item) call site L277 — zero-arg fn ignores the item) +
  statsStage L619–700 (yields per-window + final tagged), sources.ts L50
  (range(): Pipeline<number>), config.ts L65–90 (21-name map RE-VERIFIED —
  statsStage IS injected, bare stats is NOT; L65–68 drift comment), sinks.ts
  (removed-stats() tombstone), mockServer/ listing (NO index.ts;
  startMockServer = zero matches in src/+tests/; loadSpec.ts L49 + server.ts
  L127 corroborated for W485). Verdicts: **W126 C** (closed by cross-ref —
  parser.ts L298–313 per W154 (b); `fn === sql` → sqlSource L53–56 per group
  (a); Pipeline.of array arm L31–33; no probe plan carried), W433 code-half C
  (linearization shellSource/shellTransform; no mid-pipeline flatten
  pipeline.ts L79–81; source-fn-only flattening L298–313; (2)'s whole-file
  half = W430's ?; four probes stay (b)), W477 sub-claim (3) **X CONFIRMED →
  G22 scope EXTENDED** (ts "Source equivalent" collects `[]` — zero-arg pipe
  fn never runs on empty seed, pipeline.ts L31–33 + L75–83 + L107–111; G22
  file updated — NOT a new G; verbatim capture probe stays (b)), W525
  code-half C + **X → G26** (zero-arg parallel fn C — transforms L253/L277;
  range-as-TS-source C — sources L50; `stats()` = removed sink +
  `startMockServer` = nonexistent name — sinks.ts tombstone, config L69–90,
  grep zero, no index.ts, no exports map (G13); expectStage-vs-expect nuance
  recorded (W474); row stays ? with the (b) probe plan), W554 code-half C
  (`parallel 8 | POST …` = write-verb LOAD mode — parser L83–121 + L335–355;
  tick shapes are W552's; probe trio stays (b)). G26 file in gaps/ + plan
  line + (e) lines; G22 file scope-extended (Sub-claim (3) section + Fix
  addition + Out-of-scope correction). All (e) probes appended to the (b)
  queue (L83 note). No code changes (audit only). Next free G = G27.
  Next unit = **code review group (f) stage-error index preservation**
  (W158 vs W266 — which index a stage error reports, pre- or post-transform
  item position; W158's row carries the (f) probe).
  Last unit before this one: **code review group (d) export surface + runtime globals,
  COMPLETE 2026-10-19** —
  src read this unit: genFixtures/cli.ts L36–41, mockServer/cli.ts L48–60,
  verifyWebLinks/cli.ts L258–279 + parseArgs defaults, testPipes/cli.ts
  L29–35, testFixture/cli.ts L30–37, skillsCli.ts L22–27, testFixture/
  runner.ts L288–305 (arity guard + per-field paths), pipeline.ts L107
  (collect → Promise<T[]>), sources/transforms export lines, + website git
  log (the earlier "npm-packages drift fix" = **288b2d3** 2026-10-06 "fix
  (docs): the TypeScript slots named an API that does not exist" — touches
  db-drivers/intro/quickstart/recipes pages, NOT npm-packages.mdx itself;
  last npm-packages.mdx commit = 5bb532c 2026-08-12; logged in full-audit
  X-census region). Verdicts: W227 C (injection map config.ts L69–90 = the
  page's full surface incl. expectStage L83 + crust obj L37; every entry
  mode passes loadConfig per W136; plain bun never does), U129 → code-half
  C (exports exist in a checkout with the used shapes; "once published"
  parked with G13 — no exports map), W474 code-half C (module export
  `expect` transforms L211; global `expectStage` config L83; 3-form matcher
  L185/L198–209; shell `expect` → expectStatus parser L361), W455 code-half
  C (read L122 lines / readAll L139 whole-file / readLines L165;
  ExpectError {item,index,matcher} L187–196), W476 code-half C (Pipeline.of
  L29 array/AsyncIterable/ReadableStream; collect L107; throw = failure
  text per design rule 1), W468 code-half C (hard error L283–292 names
  field + both fixes; OUTPUT + boolean-resolves only; per-field via
  resolveDeep L300–305; C14 changelog ✓), W531 code-half C (load L1033
  phases-array; parallel L253; timedGet L366; statsStage L619, p95
  L600–609; bare names = injected globals only → plain bun = ReferenceError),
  W551 addendum (NO sort stage anywhere — barrier note transforms L249–252
  is the verbatim design comment; "Sort downstream" = aspirational,
  finding-lite not X), SK47/48/50 C (src/logs read in full; SK48 nuance:
  actual boot message wraps `help`/`exit` in backticks the page quote
  omits — W160 precedent), SK94 C (defaults 5/4/10000 + --exclude
  repeatable + include-external/redirect/norecurse opt-outs all confirmed).
  **U61 flag-table half X → G25** (test-pipes row omits [-o <path>];
  mock-server row omits --proxy-timeout + --report; test-fixture/
  gen-fixtures/skills/logs exact, verify-web-links legitimate summary).
  **W144 severity settled → X CONFIRMED → G24** (U129 verdict is in: no
  bare globals under plain bun + no exports-map escape hatch; surviving
  instance of the 288b2d3 drift class). G24 + G25 files created (gaps/,
  (e) lines, plan lines). No code changes (audit only). Next free G = G26.
  Next unit = **code review group (e)**: source-fn array flattening (W126,
  W433, W477(3), W525 zero-arg parallel fn, W554 parallel(8, verb) load mode;
  W154 from the item-3 map was already C'd in (b) — cross-ref only).
  Last unit before this one: **code review group (c) REMAINDER (W465),
  COMPLETE 2026-10-18** —
  src/testPipes/runner.ts read in full (180 L): W465 code-half C (per-file
  hermeticity — `freshContext()` L33–41 called inside the per-file loop (L133):
  fresh `aliases`/`functions` Maps + `registerBuiltinFns` (L39) = "builtin fns
  registered, no shared alias state"; the init.ts import (config.ts L101–108) is
  a bootstrap job the test-pipes path never enters = "no init.ts"; env snapshot
  L128 before `runSetup` (L130) + FULL restore in the `finally` (L166–171) per
  file even on failure = "snapshotted before setup and restored when the file
  finishes"; probe trio stays in (b); row remains ? overall). **Group (c)
  COMPLETE** (W129 X, W131 C, W146/W150/W163/W164 consumed, W160/W162 C, W465
  code-half C). No new G; next free = G24.
  Last unit before this one: **G13 investigation (user-directed, 2026-10-18) — COMPLETE** —
  the two pending questions (is the no-npm-resolution constraint empirical? does
  any channel make the page's pattern work?) answered by fresh probes on a fresh
  build (`bin/crust-bin` 21:36, sha256 `947d2f4dd62e6705…`, Bun v1.4.3; full
  commands/outputs/exit codes in full-audit.md §(b) "G13 investigation probes"):
  (1) the AGENTS.md constraint is REFUTED — plain dynamic `import(absolutePath)`
  (testFixture/runner.ts L20; config.ts L101–108) + the compiled binary's standard
  node_modules resolution walking UP from the user file (P2 init.ts `left-pad` →
  `000hi` exit 0; P1b fixture PASS exit 0; P4 standard location-dependent negative;
  P1a CJS named-import caveat); (2) `import "crust"` has NO importable entry
  (npm/package.json: no exports/main/module/index, only `bin`) — P5 + no-entry
  control C2 vs positive control C1. Verdicts: W129 X CONFIRMED (claim 1; claim 2
  C-by-delegation), W131 C (clash resolves in the page's favor; the stale
  AGENTS.md line joins G13's fix scope), the four parked npm-resolution halves at
  W146/W150/W163/W164 consumed (addenda in-cell). G13 file rewritten (Q1–Q3
  answered; Fix revised to include AGENTS.md + the two page edits + db-drivers if
  repeated). Census updated. No new G (G13 absorbs; next free = G24).
  Last unit before this one: **code review group (b) auto-dispatch, COMPLETE
  2026-10-18**
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
Next unit = **code review group (j) `crust/genFixtures/generate` subpath export (W390) + examples/gen-setup.ts + setup-contract exports**
(item-3 group (j): the genFixtures subpath export surface + examples/
gen-setup.ts + the setup-contract exports vs what the pages claim; group
(i) is DONE 2026-10-19: W250 C on every half, W251 C on every half, W525
`&` half C, the W525 row truncation repaired — no new G, next free G =
G30; see the EXACT POSITION block)
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
no new G, next free G = G30); (j) genFixtures subpath export; (k)
mock-server surfaces; (l) logs ring buffer / pty keymap / procs stream kinds /
wait item shape / tail / grep / stats --every / read API / histogram
bucketing (W539 C-half); (m) W515 vs W473 message dialect; (n) W514
line-numbering. Also close the SK rows' `?`-as-code-review half where a group
names them (SK47 buffer default + fragment-as-query, SK48 boot-message
format, SK50 session message formats, SK94 defaults, W237 dispatch grep).
Then fresh build + full probe list → (b) (item 4), then (c)–(e).
