# crust

A pipeline-first devops toolkit built on Bun, shipped as one binary. A
spec-driven OpenAPI mock server, fixture and load-test runners, a process
orchestrator, and a link checker — every tool composes on the same
`|` / `.pipe()` stream, driven from an interactive REPL, a `crust -c`
one-liner, or a `.crust` script.

Battle-tested by dogfooding against a real 97-operation production API:
406 generated fixtures, spec-driven mocking for two client apps, and the
load pipelines below — all run through the released binary.

## Install

Either channel resolves the same prebuilt binary and verifies its published
sha256 before it is ever executable — no clone and no Bun on the target machine:

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
npm i -g @lariocpt/crust
```

The installer drops the binary in `~/.local/bin` (override with `--dir`); the
npm package is a small launcher that fetches the same release asset on first
use. Prebuilt binaries cover linux and macOS on x64 and arm64.

### Build from source

Any other platform, or a working copy you intend to change:

```bash
git clone https://github.com/lariocpt/crust.git ~/.crust && ~/.crust/scripts/install-from-source.sh
```

## What it looks like

```bash
# API smoke test — every fixture file's contents, POSTed and asserted
read fixtures/*.json | POST :3000/users | expect 201

# A whole CRUD suite as one .pipes file — request, then assert the DB saw it
#   {"name":"Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | expect 201
#   sql "SELECT count(*)::int AS c FROM buildings" | assert (r => r.c === 1)
test-pipes smoke.pipes -b

# Generate the negative-test matrix (401/403/404 + per-field 400s) from a spec
# (copy examples/gen-setup.ts as your starting --setup module)
gen-fixtures ./openapi.json                       # --out/--setup default to tests/gen
test-fixture 'tests/gen/*.gen.crust.ts' -j8

# Load testing
range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats

# Log mining — `lines` streams a file line by line (`read` yields whole files)
lines **/*.log | grep ERROR | filter (l => !l.includes('healthcheck')) | wc -l

# Any command's output as a source — and native grep keeps follow streams live
docker logs -f my-app | crust -c 'stdin | (l => JSON.parse(l)) | filter (e => e.level >= 40)'
tail -n 0 -F app.log | grep ERROR

# Interactive log search — hold one live stream, iterate on filters against
# its buffered past + live future (every query is ordinary pipeline grammar)
logs docker logs -f my-app

# One dev tail — merge every dev process, auto-restart the flaky one
procs({web: "bun run dev", api: {cmd: "bun api.ts", restart: true}}) | (l => `[${l.proc}] ${l.line}`)
```

Fixtures (`test-fixture`) run `.crust.ts` files with `{ input, output }`
shapes: `setup()` context flows into the request and every matcher, matchers
may be async (DB side-effect assertions await), and `--count/--threads`
turns any fixture into a stress run with p50/p95/p99 reports —
`-t/-b` keep long runs honest. `mock-server spec.json` serves an OpenAPI
spec example-first so clients run without their backend; `--stateful` makes it
remember what you POST. Every tool builtin takes its primary argument
positionally; the old `--target`/`--swagger` spellings still work.

## What crust is not

Not a login shell and not a bash replacement — plain shell lines are
delegated to `sh -c` untouched; `Ctrl-C` cancels the running line but there
is no `Ctrl-Z`/`fg`/`bg`/`&` job control, and plain `FOO=x` assignments
don't persist (use `export` or `capture`). The full list lives in
[Limits](docs/USAGE.md#limits-in-v02).

## Docs

- [docs/USAGE.md](docs/USAGE.md) — user-facing reference: sources, transforms, sinks, builtins, editor keybindings, `init.ts` configuration, examples, limits.
- [docs/spec/v0.1-contract.md](docs/spec/v0.1-contract.md) — the green-light test contract.
- [docs/PLAN.md](docs/PLAN.md) — design notes.

## Dev

```bash
bun install
bun test          # red/green TDD harness
bun src/index.ts  # try the REPL
```
