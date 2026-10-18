# crust — full-audit prompt for a NEW session (copy everything below the line)

> **2026-10-18: relocated to the crust repo** (`docs/audit/`). The
> `/home/lario/.opencode/plan/...` paths below are historical; the canonical copies
> live next to this file (`full-audit.md`, `CRUST_GAPS_PLAN.md`, `gaps/G01–G16`,
> `resume-prompt.md`).

Written 2026-10-17 by the gap-closure session, after G01–G05 merged (crust main `c34ca65`,
site main `b314237`, KB main `e4e00057`). Paste into a fresh session in
`/home/lario/Projects/personal/crust`.

---

You are taking over a long-running effort on **crust** — a Bun/TypeScript pipeline test
toolkit (spec-driven mocks, generated fixtures, load gates, log tooling) shipped as one
zero-dependency compiled Bun binary, driven from a REPL or a `.crust` script. The
`docs/USAGE.md` "Limits in v0.2" bullets were measured and turned into gaps G01–G12;
G01–G05 are done and merged. Your job now is a **full audit before the remaining gaps
resume**: read **every** doc page (crust repo + website), **code-review the entire app**
functionally and technically, **run the binary against every behavioral claim** in the
docs and website, record everything in writing, and then keep the gap loop moving.

## Durable state — read first

- Master tracker: `/home/lario/.opencode/plan/CRUST_GAPS_PLAN.md`
- Per-gap files: `/home/lario/.opencode/plan/crust-gaps/G01-…` through `G12-closeout.md`
- Your audit log (create it): `/home/lario/.opencode/plan/crust-gaps/full-audit.md`

G06–G12 are pending, in order, with plan files: `G06-source-bash`,
`G07-command-substitution`, `G08-repl-multiline`, `G09-ctrl-r-history`,
`G10-job-control`, `G11-editor-highlighting`, `G12-closeout`. **Do not start G06 until
Phase 1 of your instructions below is fully recorded in writing** — the audit exists
because a fix that lands mid-audit would make later findings stale.

## Repos (all on `main`, clean as of 2026-10-17)

| repo | path | main |
|---|---|---|
| crust | `/home/lario/Projects/personal/crust` | `c34ca65` |
| crust-website (Astro) | `/home/lario/Projects/static-websites/crust-website` (**not** `../crust-website`) | `b314237` |
| crust agent KB (git **submodule** of `agents`) | `/home/lario/Projects/personal/agents/hermes/crust-agent` | `e4e00057` |

Leave the parent `agents` repo's uncommitted files alone (`.opencode/`,
`deploy/find_crossref.py`, `session-*.md`). The `agents` submodule-pointer bump and KB
re-ingest (`agents/deploy/ingest_kb.py crust-agent`) are deferred to G12 by design.

## Design rules (from `AGENTS.md` — judge every finding against these)

1. **crust must never report a false pass.** Errors propagate: a lambda that throws
   under `parallel` fails the line; a shell stage's nonzero exit becomes the line's exit
   code; an unknown fixture `output` key is an error; a matcher that throws is reported
   as `predicate threw`, not a mismatch. `tests/honest-failure.test.ts` (+
   `honest-failure-2`) is the contract, and its controls exist so a fix can't make
   everything fail.
2. **The primary argument is positional; one parser owns every CLI** —
   `parseFlags(argv, spec)` in `src/args.ts` gives all six tool builtins positionals,
   short flags, `--flag=value`, value-swallow guard, uniform `--help`, uniform exit 2.
3. **Don't grow the grammar; give users the general mechanism.** Aliases expand at the
   head of every stage. A new stage keyword must not shadow a real binary (`lines` is
   free, `split` would shadow `/usr/bin/split`).
- `new Function` evaluation of user-typed lambdas is **deliberate** — do not flag it.
- The shipped artifact is a compiled Bun binary: runtime code may only touch relative
  modules and Bun builtins; nothing may need third-party npm resolution at runtime.
- Docs are part of the deliverable: every behavior change ships to `docs/USAGE.md`,
  `README.md` if user-facing, `CHANGELOG.md` (`## [Unreleased]`), affected
  `skills/*/SKILL.md`, the website, and the KB — and it is **unshipped until the website
  commit exists** (the crust suite cannot fail on website drift; that's the asymmetry
  that has bitten this project before). Never document behavior you haven't run through
  the binary.

## Phase 1 — the audit (record as you go; nothing is real until it's in `full-audit.md`)

Structure the audit log as: (a) doc pages read + claims extracted, (b) probes run with
exact command + output + exit code, (c) findings (each with evidence), (d) "Fixed in
place" (trivial fixes, with commit SHAs), (e) G13+ created.

### 1. Read every doc, in the crust repo
- `README.md`, `docs/USAGE.md` (the linted authority), `docs/CHANGELOG.md`,
  `docs/PLAN.md`, `docs/spec/v0.1-contract.md`, `docs/INTERNAL.md`, `AGENTS.md`,
  `examples/args.crust`
- all nine skills: `skills/{crust-cli,crust-builtins,crust-pipelines,crust-mock-server,
  crust-api-testing,crust-load-testing,crust-logs,crust-procs,
  crust-verify-web-links}/SKILL.md`
- For every page: list the **behavioral claims** (flags, exit codes, syntax, file paths,
  version numbers, error messages) as checklist items in the audit log.

### 2. Read every website page
Website repo, `src/pages/` — the build is 29 pages. All of them:
- landing `index`;
- `docs/`: `index`, `intro`, `quickstart`, `npm-packages`, `binary-vs-npm`,
  `db-drivers`, `pipes-vs-typescript`;
- `docs/agent-skills/`: `index`, `cli`, `builtins`, `pipelines`, `mock-server`,
  `api-testing`, `load-testing`, `logs`, `procs`, `verify-web-links`;
- `docs/recipes/`: `index`, `api-smoke-tests`, `ci-load-gates`, `dev-tail`,
  `gen-fixtures`, `heap-snapshots`, `log-mining`, `mock-server`, `stress-testing`,
  `verify-web-links`.
- Parity check: the `agent-skills/*` pages mirror `skills/*/SKILL.md` (site `cli.mdx`
  mirrors `crust-cli/SKILL.md`). Where the repo changed in G01–G05 (env assignment,
  script args, redirect refusal, stdin/EOF, `|>`/`[0..9]`), the site must match —
  verify by reading both sides, not by assumption.

### 3. Code-review the entire app
Every file in `src/` — the top-level modules **and** the builtin directories
(`builtinFns/`, `genFixtures/`, `logs/`, `mockServer/`, `testFixture/`, `testPipes/`,
`verifyWebLinks/`) — plus `tests/` (do the tests test the real thing? honest-failure
controls intact?) and `npm/` (launcher/install path — read-only here). Functionally
(does each module do what docs and siblings assume?) and technically (error paths,
leaked async, exit-code plumbing, `Pipeline`/`mergeAsync`/`pipelineStage` misuse,
state left behind between lines). Cross-check code against every claim extracted in
steps 1–2 — and flag claims the code cannot possibly satisfy.

### 4. Run the binary against the claims
`bun test` only proves every crust line in `USAGE.md`/`README`/skills **parses**
(`tests/docs-lint.test.ts`); it never checks the prose is true. So for every behavioral
claim: probe it.
- Build fresh first: `cd /home/lario/Projects/personal/crust && bun run build` →
  `bin/crust-bin` (verify it's newer than `main`'s last commit before trusting it).
- Prefix every probe with `CRUST_CONFIG=/dev/null`.
- Capture exit codes without piping through `head` (`... > /tmp/out 2> /tmp/err; echo
  exit=$?`). In zsh, quote words that start with `=`.
- `crust --check '<line>'` parses without running — useful to separate "grammar says no"
  from "runtime misbehaves".
- Log each probe: exact command, output, exit code, and the claim it answers.

## Phase 2 — act on findings (still inside the audit session)

1. **Fix the immediately-extremely-broken FIRST — before G06.** Anything that is a
   false pass, a crash/hang on a documented path, a wrong exit code on a documented path,
   or docs/website stating the opposite of reality: fix it now, in a dedicated branch
   per repo (`fix/audit-<slug>` off `main`), one commit per repo per fix, push + PR +
   merge with `gh pr merge --merge` (remote is the `github.com-personal` SSH alias; all
   three repos merge fine that way). Record fix + evidence + SHAs in the audit log under
   "Fixed in place".
2. **Everything else substantive → G13, G14, …** Add a per-gap file
   `crust-gaps/GNN-<slug>.md` in the same shape as the existing G01–G12 files (claim,
   measured evidence, scope, tests-to-write-red-first, docs/website/KB updates,
   verification) and an unticked line in the master plan's Execution order, after G12.
   Keep G12 as the close-out sweep.
3. **Trivial stuff (typos, wrong flag name, stale SHA, wrong page title, a doc line that
   parses but describes the wrong thing, a dead internal link):** fix in place, one
   commit per repo, recorded under "Fixed in place" with SHAs.

Rules for all fixes: tests red-first with controls in the style of
`tests/honest-failure.test.ts`; gates green before pushing; behavior changes update docs
+ website + CHANGELOG in the same commit set (KB learning sections land with their gap
or in G12 — the consolidated file is
`knowledge/learnings/round-10-limits-measured.md`; insert new learning sections in
order before "Reproducing…" and renumber down; drop closed items from the "Where this
file will grow" list).

## Phase 3 — resume the gap loop

G06 → G07 → G08 → G09 → G10 → G11 → G12 in order, running the master plan's loop for
each (read gap file → red tests with controls → implement → gates → docs → website →
KB → one commit per repo per gap → tick with the three per-repo SHAs). Weave in G13+
whenever they are cheaper or more urgent than the current gap (document the reorder in
the master plan). Branch per gap off fresh `main` (`feat/gNN-<slug>`); push, PR, merge
`--merge`; fast-forward local `main` after each merge.

Gates:
- crust: `bun test` (currently 1187 run / 0 fail, ~17s — AGENTS.md's ~9s target has
  drifted; **don't add slow tests**), `bun run typecheck`, `bunx biome check .`
  (baseline 428 warnings / 18 infos / 0 errors). `noTemplateCurlyInString` fires on
  intentional `${2:-dev}` strings — `biome-ignore` on the line above.
- website: from the website repo, `bun run build`,
  `bun scripts/lint-examples.mjs /home/lario/Projects/personal/crust/bin/crust`,
  `bun run check-links` (baseline at `b314237`: 29 pages / 348 examples 0 failed /
  1163 links 0 dead).
- multi-line commit messages containing `$`/apostrophes/`?` break zsh inline quoting —
  `git commit -F <file>`.
- publishing invariant (matters at G12): the **binary publishes BEFORE the npm
  launcher** on both planes (public: `v*` tag → GitHub Releases → npmjs; LAN: Jenkins
  job `crust` → apps.in.drlario.org `BASE+sha`, npm.in.drlario.org `BASE-ci.N.sha`).
  The Jenkinsfile's sh blocks are Groovy triple-single-quoted: escape backslashes, and
  sibling containers can't resolve LAN DNS (`--add-host npm.in.drlario.org:host-gateway`).

## Phase 4 — wrap-up (when G12 is merged)

1. Update the master plan: all boxes ticked with per-repo SHAs, a final audit table,
   and a pointer to the regenerated handoff.
2. User-suggested, still pending: **deploy to the local apps plane + reinstall the
   binary global** — global `crust` is `~/.bun/bin/crust` → bun-global
   `@lariocpt/crust` 0.2.4; the LAN plane is Jenkins job `crust` (see
   `docs/INTERNAL.md`); `awsplane` skill + `plane` CLI in
   `/home/lario/Projects/personal/awsplane/` for the self-hosted plane. Confirm with
   the user before triggering.
3. Regenerate the self-contained handoff prompt (all per-repo SHAs, PR/merge status,
   plan pointers, remaining work — if any, gate commands) and stop.
