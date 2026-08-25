# Changelog

Notable changes to crust. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so minor versions may carry breaking changes.

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
