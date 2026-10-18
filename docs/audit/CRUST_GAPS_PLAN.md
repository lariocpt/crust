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
| 10 | [G10](gaps/G10-job-control.md) | No Ctrl-Z suspend, no `fg`/`bg`/`&` | **True.** Feasibility corrected: `Subprocess.signal` does **not** exist in Bun 1.4.3 and `SIGTSTP` never stops a Bun-spawned child, but `process.kill(pid,"SIGSTOP"/"SIGCONT")` **does** (`/proc/<pid>/stat` → `T` → `S`) |
| 11 | [G11](gaps/G11-editor-highlighting.md) | No syntax highlighting | **True** — `src/editor.ts` paints one undifferentiated repaint of `prompt + buf` |

## Execution order

Cheapest and least risky first; the two doc-only ones open the branch.

- [x] **G01** — stdin/EOF claim is wrong for script mode → [file](gaps/G01-stdin-eof.md) · crust `4b58ca9`, site `3328f01`, KB `a638d5e`
- [x] **G02** — `|>` / `[0..9]`: close the claim, keep the grammar clean → [file](gaps/G02-pipe-op-and-range.md) · crust `f478ac5`, site `c1c1728`, KB `707b668`
- [x] **G03** — redirect refusal coverage hole → [file](gaps/G03-redirect-refusal-coverage.md) · crust `9852e4a`, site `02634ee`, KB `68e5035`
- [x] **G04** — `FOO=x` persists → [file](gaps/G04-plain-env-assignment.md) · crust `b992c6b`, site `d97fc84`, KB `70d88ca`
- [x] **G05** — `$0/$1/$@/$*` for scripts → [file](gaps/G05-positional-script-args.md) · crust `634011d`, site `efbca00`, KB `de72a53b`
- [ ] **G06** — `source` runs bash scripts → [file](gaps/G06-source-bash.md)
- [ ] **G07** — `$(…)` / backticks in cross-stage position → [file](gaps/G07-command-substitution.md)
- [ ] **G08** — multi-line input + heredocs at the REPL → [file](gaps/G08-repl-multiline.md)
- [ ] **G09** — Ctrl-R fuzzy history → [file](gaps/G09-ctrl-r-history.md)
- [ ] **G10** — job control: `&`, `jobs`, `fg`, `bg`, Ctrl-Z → [file](gaps/G10-job-control.md)
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
