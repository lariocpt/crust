# Changelog

Notable changes to crust. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0, so minor versions may carry breaking changes.

## [0.2.0] — unreleased

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

[0.2.0]: https://github.com/lariocpt/crust/releases/tag/v0.2.0
