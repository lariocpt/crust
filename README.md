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

crust is published to the LAN artifact plane on the build host. Either channel resolves the same
prebuilt binary and verifies its sha256 — no clone, no GitHub credential, and no Bun needed
on the target machine:

```bash
curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust
npm i -g crust --registry https://npm.in.drlario.org
```

To hack on it instead, clone and build for your own architecture:

```bash
git clone git@github.com:lariocpt/crust.git ~/.crust && ~/.crust/install.sh
```

## What it looks like

```bash
# API smoke test — every fixture file's contents, POSTed and asserted
read fixtures/*.json | POST :3000/users | expect 201

# A whole CRUD suite as one .pipes file — request, then assert the DB saw it
#   {"name":"Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | expect 201
#   sql "SELECT count(*)::int AS c FROM buildings" | assert (r => r.c === 1)
test-pipes --target smoke.pipes --bail

# Generate the negative-test matrix (401/403/404 + per-field 400s) from a spec
# (copy examples/gen-setup.ts as your starting --setup module)
gen-fixtures --swagger ./openapi.json --out tests/gen --setup ./tests/gen-setup.ts
test-fixture --target 'tests/gen/*.gen.crust.ts' --threads 8

# Load testing
range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats

# Log mining — grep splits files into lines, filter applies the TS predicate
read **/*.log | grep ERROR | filter (l => !l.includes('healthcheck')) | wc -l

# One dev tail — merge every dev process, auto-restart the flaky one
procs({web: "bun run dev", api: {cmd: "bun api.ts", restart: true}}) | (l => `[${l.proc}] ${l.line}`)
```

Fixtures (`test-fixture`) run `.crust.ts` files with `{ input, output }`
shapes: `setup()` context flows into the request and every matcher, matchers
may be async (DB side-effect assertions await), and `--count/--threads`
turns any fixture into a stress run with p50/p95/p99 reports —
`--timeout/--bail` keep long runs honest. `mock-server --swagger spec.json`
serves an OpenAPI spec example-first so clients run without their backend;
`--stateful` makes it remember what you POST.

## What crust is not

Not a login shell and not a bash replacement — plain shell lines are
delegated to `sh -c` untouched; there is no job control (`Ctrl-Z`,
`fg`/`bg`) and plain `FOO=x` assignments don't persist (use `export` or
`capture`). The full list lives in [Limits](docs/USAGE.md#limits-in-v01).

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
