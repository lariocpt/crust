# Changelog

Notable changes to crust. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so minor versions may carry breaking changes.

## [Unreleased]

### Added

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

### Fixed

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

### Changed

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
