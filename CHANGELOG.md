# Changelog

Notable changes to crust. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so minor versions may carry breaking changes.

## [Unreleased]

### Added

- **`crust mcp` — the Model Context Protocol server.** An MCP-capable agent
  (OpenCode, Claude Code, Codex, Cursor) now drives crust directly over
  JSON-RPC stdio, with every capability as a first-class tool. One-shot
  tools (`crust_run_line`, `crust_check_line`, `crust_test_fixture`,
  `crust_test_pipes`, `crust_gen_fixtures`, `crust_verify_web_links`,
  `crust_load_run`) run a fresh crust child per call — real exit codes,
  killable process groups, per-call `cwd`/`env`. Lifecycle tools hold a
  **mock server, a supervised `procs` runner, or a buffered `logs` session**
  open across calls and tear everything down on exit (stdin EOF or signal,
  SIGTERM→SIGKILL escalation per process group). The protocol surface is
  hand-rolled to keep the binary zero-dependency, and the repo's first
  design rule ports intact: a nonzero exit, a killed timeout or a failed
  assert is always an `isError` result with verbatim output, output caps are
  always announced, and zero matches is an answer, never silence. `procs()`
  gained `opts.signal` — the per-instance kill a multi-session supervisor
  needs (a global SIGINT would tear down every session at once). A REPL line
  `mcp` refuses with the real reason instead of sh's `command not found`.
  The `crust-mcp` skill ships with `crust skills install`.
- **Scripts take positional arguments.** `crust script.crust prod staging`
  used to exit **2** (`script arguments are not supported`) — parameterizing a
  script meant the environment. Now the extra arguments are the script's
  positionals, the way `sh script.sh prod staging` carries them: `$0` is the
  script's path, `$1`…`$9` the rest, `$#` the count, `$@`/`$*` all of them
  space-joined, and a leading `--` after the path is a separator, not an
  argument. They expand exactly where an env var does — URLs, `-H` header
  strings, JSON-literal sources, `stats --out` paths, registered-fn args,
  tool-builtin args — and nowhere else; outside script mode (the REPL, `-c`,
  piped stdin) they are empty, never the literal text, so `$#` is the guard.
  The edges are the sh ones: sh stages see sh's own (empty) `$1`, source
  patterns (`read $1`) don't expand, `range(N,M)` takes literal integers so
  `range($1)` is a shell stage, and assignment values expand env names only —
  `FOO=$1` stores the literal. Carry a positional across with a crust stage
  that pipes its value in (`{"v": "$1"} | (x => x.v) | tr -d '\n'`) or into the
  environment with `capture`. One break to know about: `$N` in a registered-fn
  argument is now a positional, so a SQL query's placeholder is `?`
  (`sql "… WHERE name = ?" "Court"`), not `$1`. `source file.crust a b` hands
  the args to the sourced file — whose `$0` is its own path — and restores the
  caller's positionals when it ends.

- **`FOO=value` sets the session environment.** It used to be `sh -c 'FOO=value'`
  — a subprocess that exited **0** and forgot the value on the way out, while
  `export FOO=value` worked. A line of pure assignments (`FOO=v`, `FOO+=v`,
  `A=1 B=2`) is session state now and runs the same code `export` runs, so the
  two spellings cannot drift. Values expand with sh's quoting rules — `'…'`
  protects `$`, `"…"` expands it, a backslash protects exactly one character so
  `FOO=C:\temp` survives — and a value that would have to come from a child
  process (`FOO=$(date)`) is refused with the pipeline route named, because what
  it used to do was run the command, discard its output, and exit 0. Quoting the
  substitution or hiding a pipe in it (`FOO=$(date | head -1)`) used to slip past
  that check onto sh's path, where the answer was the same silent nothing at
  exit 0; it is refused too, quoting the assignment whole.
  `FOO=value cmd` stays sh's *transient* prefix on purpose. `export` also no
  longer ignores a word it does not understand (`export A=1 -p` set `A`, printed
  nothing, and exited 0); bare `export` and `export -p` still list.
- **`crust skills install` works from a shell.** The published README leads with
  `bunx crust skills install`, and it did not work: every positional was read as
  a script path, so that command exited **2** (`script arguments are not
  supported`) and a bare `crust verify-web-links` exited **127** (`cannot read
  verify-web-links`) — a code that reads as "the binary is not installed" while
  the binary was the thing printing it. The tool builtins are argv subcommands
  now, flags and all, booted through the same context as `-c` so `--env-file`
  and `init.ts` behave the same whichever spelling is used. Only the builtins
  that need nothing from a live session qualify (`skills`, `test-fixture`,
  `test-pipes`, `gen-fixtures`, `mock-server`, `verify-web-links`); `cd`,
  `export`, `alias`, `source` and the rest stay REPL-only, because a one-shot
  process has no session to change and a command that quietly does nothing is
  worse than one that refuses. A file that exists still wins when it is the only
  argument, so an existing script named `skills` keeps running as a script.
- **A picker for `skills install`.** On a terminal it no longer writes all nine
  skills into a project on someone's behalf: a menu lists each one with its
  status **in the target it would actually write to** (`not installed`,
  `current`, `EDITED locally`), pre-checked to everything not already current
  there, with `g` switching between the project and `~/.claude/skills` — which
  recomputes the statuses, since a skill current here can be missing there.
  Cancel and empty-selection exit `0`: declining is not a failure. Piped or
  non-TTY output keeps the old install-everything behaviour, and `--all` /
  `--select a,b` say it explicitly.
- **`npm install` offers to install the skills**, once. It stays silent on CI,
  with a piped stdout, for a global install, when crust is pulled in as a
  dependency (the target would have been `node_modules/crust`), and once crust
  skills are already in the project; `CRUST_NO_SKILLS=1` stops it permanently.
  Answering yes hands the terminal to the picker. Every failure path resolves to
  "declined" with exit 0 — a postinstall that fails takes the whole install with
  it, and not wanting to answer a question is not a reason to refuse a package.
- **Job control.** `&` backgrounds a line into a job table, and `jobs [-l]`,
  `fg`, `bg`, `wait %N`, `kill %N` and Ctrl-Z work against it. The measurement
  that shaped it: SIGSTOP is the only stop the runtime honors — Bun swallows
  `SIGTSTP` and its children inherit that ignore — so Ctrl-Z suspends crust's
  own pipelines and builtins, while a foreground inherit-stdio child takes
  Ctrl-C (the child dies, the line reports 130). The parked claim that job
  control "needs Bun-side support it doesn't yet expose" was wrong in both
  halves: `detached: true` really does setsid. Still out, by the Limits
  section: `disown`, `nohup`, job patterns (`%?vim`).
- **`source` runs shell scripts.** A file carrying a shell marker — a
  `.sh`/`.bash`/`.zsh` extension or a shell `#!` shebang — runs **once in a
  child shell**: the exported `KEY=value` diff is applied to the session, the
  script's exit code is the line's, and its side effects are real. Unsets
  don't propagate and the child's cwd never comes back. An unmarked file that
  looks like multi-line shell, or that doesn't parse as crust, is refused with
  both options named — never half-run.
- **The REPL continues a line.** A trailing `\` drops to a `…` continuation
  prompt, and an unbalanced quote (`"`, `'`, `` ` ``) or unclosed `(` continues
  too — so a pasted multi-line JSON literal, or a heredoc body inside a shell
  stage (the join keeps the real newlines a `\` join would destroy), survives
  the Enter. The editor assembles; the lexer and parser are untouched. The
  assembled entry is one line: one history item, `↑` recalls it whole, and the
  REPL and a script agree character for character on what runs. The old
  `empty stage` refusal that told REPL users to use a trailing `\` the REPL did
  not have is gone with it.
- **Ctrl-R fuzzy history search.** zsh semantics, including the two that are
  the opposite of the obvious guess: `Enter` *accepts* — the match moves onto
  the prompt line, still editable, and the next `Enter` runs it — and a query
  that matches nothing puts the query itself on the line rather than replaying
  the last match. Searching from the `…` continuation prompt is safe: leaving
  search never resolves the pending line.

### Fixed

- **The launcher follows symlinks, so installs work.** `bin/crust` is the script npm
  ships as `crust`, and it resolved its own directory from the path it was *invoked*
  through. Package managers install bins as symlinks into `node_modules/.bin`, so run
  from there it looked for `crust-bin` — and, in the dev branch, `../src/index.ts` —
  beside the `.bin` directory, found neither, and died with
  `Module not found "…/node_modules/.bin/../src/index.ts"`. It now walks the symlink
  chain with plain `readlink` before taking the directory (BSD `readlink` has no `-f`,
  and the release matrix builds darwin), so both branches resolve wherever the binary
  actually lives. Reproduced first through exactly the installed shape; pinned by
  tests for the symlink, a symlink chain, the dev fallback and a BSD-shaped
  `readlink`, with the real-path invocation kept as a control.

- **A redirect no longer gets to decide what your stage is.** A stage pattern is
  matched against the whole text, so appending `> f` to `range(1,3)` made it stop
  matching as a `range`, fall through to shell, and die with sh's own
  `syntax error near unexpected token \`1,3'` at exit 2 — an error that mentions
  no way out. Measured leaks, all refused now, each naming the stage it really
  was: `range(1,3) > f`, `capture N > f`, `parallel 5 > f`, `expect 200 > f`,
  `expect 2xx > f`, `stats > f`, `stdin > f`. `load 10s 100/s > f` failed
  *inside* load's parser and complained about the rate plan, quoting the redirect
  back as part of it; it now refuses as a redirect. `grep` keeps its redirect —
  that one is the shell's and genuinely works — and a stage that is malformed
  with or without the tail keeps its own error, so the strip never invents a
  refusal. Refusals are grammatical now too: `an expect stage`, `an http stage`.
- **The limits section said scripts starve their shell stages, and they don't.**
  It claimed shell stages see EOF on stdin "in script/piped mode". Only `cmd |
  crust` drains stdin — there the *program* arrives on fd 0, so crust reads it to
  EOF before running anything. `crust file.crust` never touches stdin: with data
  piped in, a `wc -l` stage measured **2** piped lines, not 0. The false half
  hides the actual rule, which is one stdin per run — the program, the `stdin`
  source, or the shell stages, never two of them. The wording is corrected in the
  limits list and the run-mode table, and all four mode/behaviour pairs are
  pinned in `tests/stdin.test.ts`. No guard was added: detecting whether an
  arbitrary `sh -c` text reads fd 0 is not decidable, and a wrong guess is a
  false alarm on scripts that work.
- **`--check` now lints `skills install`.** The line had nothing declarative to
  check, so a wrong flag surfaced only at run time; `skills install --bogus` is
  caught at parse time alongside the other tools.
- **`sql` now binds the placeholder the docs promise.** `sql "… WHERE name = ?" "Court"`
  died on every call: the documented `?` was never converted to a bound
  parameter, so the "bound query" story the docs told was false at the driver. The fix is dialect-gated — sqlite's placeholder *is* `?`,
  Postgres' is `$n` — with a scanner for placeholders inside literals and a
  named diagnostic for the mismatched dialect; the naive `?`→`$n` rewrite would
  have broken sqlite, which is exactly what it must not do.
- **A wrapped draft no longer smears on every keystroke.** `render()` wrote
  `"\r" + prompt + buf + CSI K` — and `"\r"` returns to column 0 of the
  *current* row, so a draft already wrapped left stale text on the rows above,
  worsening with each keypress. The draft line now measures its own paints in
  cells and a multi-row repaint climbs to the line's first row before `CSI J`.
- **The caret moves in cells, not characters.** `place(n)` emitted `CSI n D`
  from a character count where the terminal moves columns, so the visible caret
  drifted on every double-width glyph. Measurement and motion now share
  `src/width.ts`, the one cell-width table the editor uses.
- **Editing is grapheme-aware.** The cursor moved in UTF-16 code units, so
  Backspace on a freshly typed emoji submitted a lone surrogate — a data
  corruption reachable by ordinary typing. The caret now moves in graphemes on
  the same `Intl.Segmenter` clustering `cells()` uses, so measure and motion
  cannot drift, and a mid-cluster caret deletes its cluster whole, never half
  a surrogate pair.
- **The caret crosses wrap rows correctly.** Moving LEFT across a wrap row of a
  wrapped draft landed on the wrong row: `place(n)` was a single backtab, which
  cannot change rows. There is now one position model for both ends of a move
  (offset → row `floor(o/width)`, col `o%width` — an exact multiple sits at
  col 0 of the next row); a same-row move keeps the single backtab, a crossing
  move climbs with `CSI A` and then backtabs.
- **The one-target refusals name the workaround.** `test-fixture 'a/*.ts'
  'b/*.ts'` — and the `test-pipes` twin — refused with `unexpected argument
  "b/*.ts"` and no way out, while CI scripts in the wild pass two globs. Both
  refusals now name the brace glob (`'{a,b}/*.crust.ts'`), which was measured
  against a live mock to expand both directories before it was documented.

### Changed

- **`|>` and `[0..9]` are no longer promised.** The limits list said "Need a Bun
  loader; v0.2" and `docs/PLAN.md` carried the wish three times, so both read as
  shipping soon. They are decisions now, in a **Syntax we deliberately did not
  add** section: crust's `|` already *is* the pipe (TS uses `.pipe()`), and a
  `[a..b]` literal collides with the JSON-array literal and with the shell's
  `[ … ]` test — precedence rules over both, with a silent wrong answer as the
  failure mode. `range(0, 9)` is inclusive and occupies the same call site.
- **Skills install to `.agents/skills`, and `.claude/skills` gets a link per
  skill.** The nine SKILL.md files were written into `.claude/skills`, which
  only Claude Code reads: a project with Codex, Cursor or OpenCode installed got
  nothing, even though those three (and the Cursor rules ecosystem) have settled
  on `.agents/skills` as the cross-client directory. The canonical copy now
  lives at `.agents/skills/<name>/` — project, or `~/.agents/skills` with
  `--global` — and each skill is symlinked at `.claude/skills/<name>` as
  `../../.agents/skills/<name>`, because Claude Code is the one mainstream host
  that still reads only its own path. One file instead of four copies, so an
  edit in either path is the same edit. Links are per-skill on purpose: linking
  the whole `skills/` directory would hide whatever else a host keeps there
  (Codex stores its built-ins under `.agents/skills/.system`). A real
  `.claude/skills/<name>` directory crust did not write is reported and left
  untouched — `--force` is what consents to replacing it with a link — and a
  link pointing somewhere else is left alone even then. None of it can fail an
  install: the canonical file is written first, systems that cannot symlink fall
  back to a copy, and the summary names what was linked. Re-running the same
  command upgrades an old-layout install in place.
- **`skills install` answers with a settled line** — `✔ installed 3, up-to-date
  6 → /path/.agents/skills`, or `✔ 9 skills already current → …` when it wrote
  nothing — instead of a `skills:`-prefixed log line, so the result of an
  install reads the same as the rest of the tool's success output.
- **`skills list` refuses arguments instead of ignoring them.** `skills list
  --global` printed the same list and exited 0 — a flag silently doing nothing.
  It exits 2 now, which is also what `--check` had been saying about it.
- An unbound escape sequence cannot press a key by accident. The picker swallows
  a whole CSI sequence instead of its first two bytes: leaving the tail behind
  fed `f` to the overwrite toggle when a right-arrow was pasted into the menu.
- **`--version` names the tool.** A bare `0.2.4` in a CI log names no tool; the
  line is `crust <version>` now. Every exact reader of the old line — the CLI
  test, the Jenkinsfile version gate, the release workflow — moved in the same
  commit, so no pipeline kept parsing the old shape.
- **`$(…)` in a crust stage is refused, not run as literal text.**
  `GET $(echo host)/get` used to build its URL from the literal characters and
  die with `getaddrinfo ENOTFOUND $(echo` — a network-shaped error answering a
  parse-level question. The refusal fires before anything runs and names the
  two routes that work: end the line with a shell stage, or capture into a
  variable first (`date +%s | capture TS`, then `$TS`). Shell stages keep sh's
  own `$(…)` untouched, and `${x}` was always a variable, never a command.

## [0.2.4] — 2026-08-25

Both of these came out of dogfooding crust against a fresh codebase
(bun-next-hono-starter): 104 fixtures and 15 pipes written from scratch, which
is exactly the situation where a sharp edge shows up.

### Fixed

- **A zero-argument `output` matcher returning a boolean is now an error.**
  Arity silently decides meaning in `output`: no arguments makes a function a
  thunk supplying the EXPECTED value, one or more makes it a predicate over the
  actual one. So `data: () => true` — the most natural way to write "any value
  here" — became the literal `true` and was compared against the body. It
  failed with a diff that explained nothing, and, if the body genuinely was
  `true`, it PASSED for the wrong reason. That is a false pass, which this
  project treats as the one unacceptable bug class. It now throws, names the
  field, and gives both fixes: `(v) => ...` for a predicate, `true` for the
  literal. Thunks returning real values are untouched.

### Changed

- **`DELETE` can open a pipeline.** It carries no body, so requiring
  `{} | DELETE $URL` was ceremony with nothing behind it — `DELETE :3000/x`
  now works like `GET`. `POST`/`PUT`/`PATCH` still cannot be sources, because
  they genuinely have nothing to send until an item arrives, and the error says
  so instead of the bare "needs upstream items".
- `gen-fixtures` explains what `scopeParam` is for when a setup module omits
  it, and tells you to export `null` when the API has no scoped resources.
  It stays required: whether 403 cases are generated at all hangs on it, so it
  should be a decision, not a default.

## [0.2.3] — 2026-08-25

### Changed

- crust described itself nine different ways across the surfaces people
  actually read — both READMEs, both manifests, the `--help` banner,
  `docs/USAGE.md`, `CONTRIBUTING.md`, `AGENTS.md`, and five more variants on
  the website. Every one led with "a pipeline-first devops toolkit built on
  Bun", which names the mechanism and not the problem solved. There is now one
  tagline: mock it, test it, load it, tail it — the whole test stack baked into
  one binary, spec-driven, generated, zero dependencies.
- The false-pass invariant is stated on the front page instead of being
  discoverable only by reading `AGENTS.md` or this changelog. It is the design
  rule the whole tool is built around, so it gets its own line under the
  tagline everywhere the tagline appears.

## [0.2.2] — 2026-08-24

### Changed

- Both front pages now show what crust actually does: fixture tests, load
  testing with a CI gate, a persistent mock server against an OpenAPI spec, SQL
  assertions, `pino-pretty` streams merged from several processes, and
  interactive log querying.

### Fixed

- `npm/README.md` — the page npmjs.org renders — was linted by nothing. It
  shipped byte-for-byte from the release workflow, so a broken example there
  passed every gate and reached every installer. It is now parsed against the
  live grammar like the repo README, and its examples are bare pipeline lines so
  that check is meaningful.

## [0.2.1] — 2026-08-24

### Changed

- The documentation site is now linked from everything that ships. `README.md`,
  `npm/README.md` and `docs/USAGE.md` carried no reference to it, and the
  `homepage` field in both manifests pointed back at the README — so someone
  arriving from npm had no path to the documentation.

## [0.2.0] — 2026-08-24

First public release. crust has been developed and dogfooded privately against a
real 97-operation production API; this is the first version published to GitHub
Releases and npm.

### Added

- **Distribution.** `install.sh` downloads the release binary for your platform
  and verifies its published sha256 before the file is ever executable;
  `@lariocpt/crust` on npm is a ~4KB launcher that resolves the same artifact.
  Prebuilt binaries for linux and macOS on x64 and arm64.
- **JUnit XML reports** — `test-fixture` and `test-pipes` accept `--out
  report.xml` for CI.
- **`mock-server --strict`** enforces a literal `additionalProperties: false`.
- **`procs` liveness probes** (`live:`) restart a proc that is alive but
  unhealthy, without letting failing-probe time count as healthy uptime.
- **`mock-server` failure injection** and a top-level **`--env-file`**.
- **`logs`**: `json on|off`, `search`, and live buffer resize.
- **`${NAME:-default}`** expansion everywhere crust expands variables.
- **`filter (x => …)`** as a real grammar stage, and `.crust` script files,
  shebang support, and piped-stdin script execution.

### Fixed

- `test-pipes` reported a **false pass** when a suite yielded zero runnable
  lines — it exited 0 and wrote a green `<testsuites tests="0">`. It now exits
  2, and refuses a target that is not a `.pipes` file instead of running its
  lines through `sh -c`.
- Readiness probes fan out over both loopback addresses. A service bound to
  `localhost` inside a container binds `::1` while the probe's connect path is
  restricted to `127.0.0.1` by glibc's `AI_ADDRCONFIG`, so a service that was up
  was reported "not ready" until the timeout expired.
- Interrupting a piped shell stage kills its **process group**. Under a forking
  `/bin/sh` (dash, i.e. Debian and Ubuntu) killing the direct child left the
  grandchild running to completion.
- A `$ref` inside `output.schema` errors loudly instead of passing vacuously.
- Trailing `#` comments parse on builtin lines, like shell stages.

[0.2.2]: https://github.com/lariocpt/crust/releases/tag/v0.2.2
[0.2.1]: https://github.com/lariocpt/crust/releases/tag/v0.2.1
[0.2.0]: https://github.com/lariocpt/crust/releases/tag/v0.2.0
