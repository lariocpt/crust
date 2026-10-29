# crust — `Limits in v0.2` gap closure

Master index. Each section links a per-gap plan file in `gaps/`.
Audited 2026-10-16 against crust `main` @ `85bb6f6`. Baseline suite:
**1113 pass / 1 skip / 0 fail** (15.7s).

> 2026-10-17: G01–G05 merged (crust `c34ca65`, site `b314237`, KB `e4e00057`).
> **2026-10-18: audit in progress, paused mid-(a) at W602** (all 29 website pages
> recorded; remaining: 8 components → skills↔site parity → full code review → fresh
> build + full probe list → sections (b)–(e)). Resume entry point (self-contained:
> rolling EXACT POSITION block, recovery procedure, compaction-safe method):
> `resume-prompt.md` (this directory). Audit log: `full-audit.md`. Original
> scope prompt: `full-audit-prompt.md`.

## The loop (run this for every section)

1. Read the gap file. Write its tests **red first**, with the controls it names.
2. Implement. `bun test` + `bun run typecheck` + `bunx biome check .` green.
3. Update docs: `docs/USAGE.md`, `README.md` if user-facing, `CHANGELOG.md`
   (`## [Unreleased]`), the affected `skills/*/SKILL.md`.
4. Update the website (see paths below) and run its own gates.
5. Update the crust agent KB (submodule), re-ingest.
6. `git commit` — one commit per gap. Tick the box here. Carry on.

## Repos

| repo | path | branch |
|---|---|---|
| crust | `/home/lario/Projects/personal/crust` | `feat/limits-gap-closure` (new, off `main`) |
| crust-website | `/home/lario/Projects/static-websites/crust-website` (**not** `../crust-website`) | `docs/limits-gap-closure` |
| crust agent KB | `/home/lario/Projects/personal/agents/hermes/crust-agent` (git **submodule** of `agents`) | `docs/limits-gap-closure`, then bump the `agents` submodule pointer |

Website gates (run from the website repo, after building the crust binary with
`bun run build` in crust): `bun run build`,
`node scripts/lint-examples.mjs /home/lario/Projects/personal/crust/bin/crust`,
`bun run check-links`. Nav lives in `src/components/Sidebar.astro`.

KB: add `knowledge/learnings/round-10-<topic>.md` (rounds stop at 9), update
`knowledge/internals/round-5-repl-and-logs.md` when the REPL/editor machinery
changes, re-ingest with `agents/deploy/ingest_kb.py crust-agent`.

## Enforcement (AGENTS.md) — the asymmetry that bites

`tests/docs-lint.test.ts` parses every crust line in `docs/USAGE.md` +
`README.md`; `tests/skills.test.ts` does the same for `skills/`. Nothing in the
crust repo can fail because the **website** drifted — its `Grammar` stage only
runs on the website's own commits. Treat a behaviour change as unshipped until
the website PR is open. Never document behaviour not run through
`bun src/index.ts -c`.

## Audit verdict — all 11 bullets

Verdicts are measured, not read off the code. Full evidence is in each file.

| # | Section file | Doc claim | Verdict |
|---|---|---|---|
| 1 | [G01](gaps/G01-stdin-eof.md) | Shell stages see EOF on stdin in script/piped mode | **Partly false** — true only for `cmd \| crust`; `crust file.crust` does *not* drain stdin (a shell stage ate the 2 piped lines) |
| 2 | [G02](gaps/G02-pipe-op-and-range.md) | No `\|>` and no `[0..9]` | **True** — close as won't-fix, grammar rule 3 forbids the range literal |
| 3 | [G03](gaps/G03-redirect-refusal-coverage.md) | No redirects on crust stages, "anywhere else the line is refused" | **True but leaky** — `range(1,3) > f` reclassifies as shell and dies with sh's error, not crust's refusal |
| 4 | [G04](gaps/G04-plain-env-assignment.md) | Plain `FOO=x` doesn't persist | **True** — measured: `FOO=bar` then `echo "[$FOO]"` → `[]` |
| 5 | [G05](gaps/G05-positional-script-args.md) | No positional script arguments | **True** — measured exit 2 `script arguments are not supported` |
| 6 | [G06](gaps/G06-source-bash.md) | `source` doesn't run bash scripts | **True** — measured: `if`/`fi` file → `sh: syntax error near unexpected token`, exit 2 |
| 7 | [G07](gaps/G07-command-substitution.md) | No `$(...)` across stages | **True** — inside one shell stage it works (`$(echo a b \| tr " " "-")` → `a-b`); in crust stages it breaks: `GET $(echo host)/get` → `getaddrinfo ENOTFOUND $(echo` |
| 8 | [G08](gaps/G08-repl-multiline.md) | No multi-line input / heredocs in the REPL | **True**, plus a lying message: the `empty stage` refusal tells you to end the previous line with `\`, which the REPL does not honour |
| 9 | [G09](gaps/G09-ctrl-r-history.md) | No fuzzy history search (Ctrl-R) | **True** — measured in a pty: Ctrl-R is swallowed, next line runs unmodified |
| 10 | [G10](gaps/G10-job-control.md) | No Ctrl-Z suspend, no `fg`/`bg`/`&` | **True — shipped 2026-10-29.** Feasibility corrected twice: `Subprocess.signal` does **not** exist in Bun 1.4.3; `SIGTSTP` is not deliverable at all (the runtime ignores it and children inherit that ignore across `exec`), while `process.kill(pid,"SIGSTOP"/"SIGCONT")` **does** work (`/proc/<pid>/stat` → `T` → `S`); and `detached: true` really does setsid, contrary to the original note |
| 11 | [G11](gaps/G11-editor-highlighting.md) | No syntax highlighting | **True** — `src/editor.ts` paints one undifferentiated repaint of `prompt + buf` |

## Execution order

Cheapest and least risky first; the two doc-only ones open the branch.

- [x] **G01** — stdin/EOF claim is wrong for script mode → [file](gaps/G01-stdin-eof.md) · crust `4b58ca9`, site `3328f01`, KB `a638d5e`
- [x] **G02** — `|>` / `[0..9]`: close the claim, keep the grammar clean → [file](gaps/G02-pipe-op-and-range.md) · crust `f478ac5`, site `c1c1728`, KB `707b668`
- [x] **G03** — redirect refusal coverage hole → [file](gaps/G03-redirect-refusal-coverage.md) · crust `9852e4a`, site `02634ee`, KB `68e5035`
- [x] **G04** — `FOO=x` persists → [file](gaps/G04-plain-env-assignment.md) · crust `b992c6b`, site `d97fc84`, KB `70d88ca`
- [x] **G05** — `$0/$1/$@/$*` for scripts → [file](gaps/G05-positional-script-args.md) · crust `634011d`, site `efbca00`, KB `de72a53b`
- [x] **G06** — `source` runs bash scripts → [file](gaps/G06-source-bash.md) · crust `940658a`, site `f40f6b6`, KB `22d1634d`
- [x] **G07** — `$(…)` / backticks in cross-stage position → [file](gaps/G07-command-substitution.md) · crust `085e0bf`, site `b226311`, KB `d39aa4a`
- [x] **G08** — multi-line input + heredocs at the REPL → [file](gaps/G08-repl-multiline.md) · crust `1a2bdfa`+`0a33774`, site `054c09b`, KB `ceb0e777`
- [x] **G09** — Ctrl-R fuzzy history → [file](gaps/G09-ctrl-r-history.md) · crust `f2d5da5`+`bf4d518`+`0717f1c`, site `72e457b`, KB `db8c83a7` (local — ingest held, operator-controlled)
- [x] **G10** — job control: `&`, `jobs [-l]`, `fg`, `bg`, `wait %N`, `kill %N`, Ctrl-Z → [file](gaps/G10-job-control.md) · crust `5bb95c9`+`2d09056`+`760ec92`+`47bda42`, site `fc0be8c`, KB `7177a9fc` (local — ingest held, operator-controlled)
- [ ] **G11** — editor highlighting (scope or close) → [file](gaps/G11-editor-highlighting.md)
- [ ] **G12** — close-out sweep: rewrite `Limits in v0.2`, `docs/PLAN.md`, `docs/spec/v0.1-contract.md`, README, website parity, KB ingest → [file](gaps/G12-closeout.md)
- [ ] **G13** — npm-packages page: `init.ts` npm imports vs the compiled-binary constraint → [file](gaps/G13-npm-resolution-clash.md)
- [ ] **G14** — procs page: Knobs stream set omits `live` → [file](gaps/G14-procs-live-stream.md)
- [ ] **G15** — procs page: `elapsed: 1,842 ms` pin vs `toFixed(0)` → [file](gaps/G15-procs-elapsed-comma.md)
- [ ] **G16** — verify-web-links page: 4-line pre-deploy gate incomplete as written → [file](gaps/G16-vwl-ci-gate-incomplete.md)
- [ ] **G17** — agent-skills index: crust-cli description in the `skills list` block lags the SKILL.md frontmatter (missing "tool subcommands" clause) → [file](gaps/G17-cli-skill-desc-drift.md)
- [ ] **G18** — pipelines page: "SQL placeholders survive untouched" sentence omits the script-positional rule SKILL.md states (site behind) → [file](gaps/G18-pipelines-sql-placeholder-drift.md)
- [ ] **G19** — load gates: guard-without-`--every` sentence inverts the short-circuit on two site pages ("threshold applies unguarded" — it never runs; no-op gate = false pass) → [file](gaps/G19-guard-without-every-false-pass.md)
- [ ] **G20** — agent-skills mock-server page: conformance-gate line omits the required `(r => r.json())` decode stage (the skill marks it "not optional"; the gate dies with `predicate threw`) → [file](gaps/G20-mockserver-gate-missing-decode.md)
- [ ] **G21** — agent-skills builtins page: Traps bullet-1 measured table, row 1's base64 value does not match its own annotation (`YjY0aW4udHh0` = base64("b64in.txt") ≠ annotated "in.ts"; SKILL's `aW4udHM=` is the correct encoding — settled by computation, no probe needed) → [file](gaps/G21-builtins-traps-b64-row.md)
- [ ] **G22** — website api-smoke-tests.mdx L335 "Using the `sql` builtin directly": "the upstream item is *not* auto-bound, so reach for a lambda when you need to inject a value from the stream" is REFUTED by src/builtinFns/sql.ts L66–74 (`sqlStage`: when the line declares no params, the piped item IS bound as the first parameter — the L68–71 comment records the pre-fix "dropped on the floor" behavior the page still describes); the builtins SKILL.md L54 already states the current contract, so fix the page to match SKILL/code (code review group (a), 2026-10-18) → [file](gaps/G22-apisql-not-autobound.md)
- [ ] **G23** — website npm-packages.mdx L37–40 + L183–185: the `crust.fn` calling convention says source position invokes `pkg(undefined, "arg1")` ("the first arg is `undefined`"); src/parser.ts buildSource's function case invokes `fn(...kind.args)` — a zero-item call with NO item slot, so the handler's first parameter receives the first static arg; the transform-position sentence is correct as written — fix the page (check USAGE.md + SKILL for the same claim) (code review group (b), 2026-10-18) → [file](gaps/G23-fn-source-position-undefined.md)
- [ ] **G24** — website npm-packages.mdx L60–81 TS tour: "no crust runtime needed" premise refuted (bare `Pipeline`/`glob`/`range` exist only in the loadConfig injection map; plain bun injects nothing; the published package has no exports map to import from — G13) + wrong-case `// → "Hello-World"` comment (slugify default = `hello-world`) — rewrite the tour to run under the crust runtime (or explicit checkout imports) and fix the comment; the surviving instance of the 288b2d3 drift class (code review group (d), 2026-10-19, W144) → [file](gaps/G24-w144-ts-tour-no-runtime.md)
- [ ] **G25** — USAGE.md builtins table: the `test-pipes` row omits `[-o <path>]` and the `mock-server` row omits `--proxy-timeout` (default 30000) + `--report` — both documented by the CLIs' own usage lines and the linked `###` sections; all other rows verified complete or legitimate summaries — docs-only two-row fix (code review group (d), 2026-10-19, U61) → [file](gaps/G25-builtins-table-flag-omissions.md)
- [ ] **G26** — mock-server pairing page ts embed names two APIs that do not exist: `.to(stats())` calls the REMOVED `stats()` sink (sinks.ts tombstone; no export or injected global by that name — the real surface is the `statsStage(everySec?, out?)` STAGE, `.pipe` form not `.to`) and `import { startMockServer } from "crust/mockServer"` names a function with zero matches in src/+tests/ (no `src/mockServer/index.ts`; no npm exports map — G13) — the zero-arg `parallel(100, fn)` half and `range(0,9999)` as TS source are C; surviving 288b2d3 drift class; docs-only rewrite of the ts embed (code review group (e), 2026-10-19, W525) → [file](gaps/G26-w525-mock-pairing-ghost-api.md)
- [ ] **G27** — npm-packages page throw bullet promises "with the index preserved" but a plain stage throw carries NO item index anywhere (pipeline.ts has no counters in any arm; the `crust: <err.message>` + exit 1 format, runLine.ts L301–302, has no index slot; the ONE indexed pipeline error is `ExpectError`, a stage-local MISMATCH, transforms.ts L187–196) — the W158-vs-W266 cross-check resolves in W266's favor; 288b2d3 drift class; docs-only rewrite of the L212 bullet (code review group (f), 2026-10-19, W158) → [file](gaps/G27-w158-index-preserved-claim.md)
- [ ] **G28** — cli skill page `--check` failure block mis-describes the output shape: the verbatim block is a line-1 truncation (the real first line ends in `: <sh's first line>`) and "the `sh:` line after that" is a line the code cannot produce — the format appends `problem.first` to line 1 (`crust: shell stage does not parse${where}: ${problem.first}` + `  in: <line>`, index.ts L212–214 / runLine.ts L204–206) and the preflight's stderr is captured, not passed through (lexer.ts L241–249); the "names the stage" (`where` clause L211/L203) + "passes it through unchanged" (wording) halves are C; 288b2d3 drift class; docs-only rewrite of the L121–132 block + sentence (code review group (g), 2026-10-19, W217) → [file](gaps/G28-w217-preflight-output-shape.md)
- [ ] **G29** — cli skill page preflight paragraph: "(in 0.2.4 only `--check` has it)" — v0.2.4 (`49b271d`, 2026-08-25) had the syntax preflight on NEITHER path (check loop = `parse(line)(ctx)` + `checkBuiltinLine` flag-spec check only; ZERO `sh -n`/`shellSyntax`/`noexec` matches in the v0.2.4 tree) and the preflight is PR #60's (`ae82619` check half → `95a1bbe` exec half, both ancestors of merge `699986c`, 2026-10-14) — the "only --check has it" state existed only in the PR's branch history, never in a release; W218's other halves stand; site-only fix (group (h) amendment, 2026-10-19, W218) → [file](gaps/G29-w218-preflight-0-2-4-clause.md)
- [ ] **G30** — website intro.mdx L38–79 TS slot: the comment promises "bun script.ts / bun repl + globals auto-loaded when the script imports from 'crust'" — plain bun never enters loadConfig (W227 (d)) and the staged npm package has no exports/main/index entry (G13 Q1 P5: `Cannot find package 'crust'`), so all five bare-name examples throw ReferenceError as written; example 1's `.to(stats())` additionally calls the REMOVED `stats()` sink (tombstone per G26) in the wrong shape (`.to` never consumes a stage — the real form is `.pipe(statsStage())` by iteration); `expectStage` is a map alias only (export is `expect`, transforms L211); fix: name the real runtime (or explicit checkout imports) + `statsStage` rename — the name half immediately actionable, the comment half with the W40/G13 family (group (l) subtopic (11), 2026-10-21, W21) → [file](gaps/G30-w21-intro-ts-slot-stats-import.md)
- [ ] **G31** — REPL: a prompt that already wraps the terminal smears on EVERY keystroke — `render()` writes `"\r" + prompt + buf + CSI K`, and `"\r"` is column 0 of the CURRENT row, so with `prompt + buf` wider than the terminal the repaint re-emits the whole line from the cursor's last row: measured in tmux at 30 cols with the 35-char git-aware prompt (`/tmp/opencode/probe-g31.sh`), typing `echo` then ` hi` stacks the prompt 2 then 3 times and eats its own first row; display-only — Enter still runs the correct line (`hi`), which is why it survived; PRE-EXISTING, found while probing G09 (that unit neither caused nor fixed it, and its own geometry assumes a one-row draft); fix = apply G09's self-measured row accounting to the draft line (climb to the line's first row, `CR` + `CSI J`, repaint, let it wrap), byte tests + a mandatory pty probe, and a Limits bullet + site parity until then → [file](gaps/G31-wrapped-prompt-repaint.md)

Audit X census disposition (2026-10-18): R24 FIXED `0b15108` · W235 FIXED
`d68665c`/`0ab04b0` · W153 → V (probe artifact, no finding) · W561 refs already
fixed on disk. "What crust is not" / Limits-area findings ride with G06–G12
(P15 → G10; the G12 sweep owns the final README/Limits rewrite) — G13+ is only
genuinely new website-recipe findings. All fixes follow the loop pattern:
branch per repo off main, one commit per repo per fix, gates green, push + PR +
`gh pr merge --merge`.

## Ground rules for every gap

- crust must never report a false pass, and must never **silently do nothing**.
  A half-feature that quietly no-ops is worse than the refusal it replaces.
- Don't grow the grammar to patch a missing convenience; give the general
  mechanism (design rule 3). Any new stage keyword must not shadow a real
  binary.
- `new Function` for user lambdas is deliberate. Don't "fix" it.
- Tests are red-first with controls, in the style of `tests/honest-failure.test.ts`.
- The shipped artifact is a compiled Bun binary: nothing may require third-party
  npm resolution at runtime.

## Phase 5 (user request, 2026-10-18) — website quick-start overhaul + ground-truth run

AFTER the audit closes (G12 + full-audit phases done). Owner confirmed this is
wanted on the crust website.

Goal: a visitor goes from zero to large results extremely quickly.

1. **Early positioning, stated up front (intro/quickstart, before the deep
   content):** a well-implemented Swagger/OpenAPI spec means clean, easy crust
   — "crust to the max". The spec is the input; crust consumes it.
2. **An AI quick guide:** the "install skills" command, shown exactly as the
   visitor would type it (verbatim, copy-paste — no elided placeholders).
3. **A worked prompt flow (example):** run the server → do fixture tests
   against the swagger → do perf tests. The point is a copy-paste path where
   people get large results extremely quickly.
4. **Test the instructions before shipping** — the site must not lie:
   ground-truth run on `mybodycorpai`
   (`/home/lario/Projects/personal/mybodycorpai`): on a TEMP BRANCH, remove
   crust totally from the project (installed binary/launcher, skills, configs,
   any crust test files), then follow the new site quick-start verbatim —
   install crust, run the install-skills command, drop the prompt — and verify
   every claim in the copy holds end to end. Ship the site copy only if the
   run passes; fix the copy or the product where it doesn't.

- [ ] P5.1 draft the website copy (positioning line, install-skills command,
      worked prompt flow)
- [ ] P5.2 mybodycorpai temp-branch ground-truth run of the exact published
      copy
- [ ] P5.3 website commit + lint/check-links gates green
