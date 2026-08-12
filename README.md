# crust

A Bun-powered shell with first-class pipelines and devops primitives. Globs, HTTP verbs, parallel workers, and TypeScript lambdas all compose under a single `|` / `.pipe()` abstraction.

Battle-tested by dogfooding against a real 97-operation API (a production API):
406 fixtures, spec-driven mocking for two clients, and the load pipelines
below — all run through the released binary.

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
gen-fixtures --swagger ./openapi.json --out tests/gen --setup ./tests/gen-setup.ts
test-fixture --target 'tests/gen/*.gen.crust.ts' --threads 8

# Load testing
range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats

# Log mining
**/*.log | (l => l.includes('ERROR')) | wc -l

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

## Docs

- [docs/USAGE.md](docs/USAGE.md) — user-facing reference: sources, transforms, sinks, builtins, editor keybindings, `init.ts` configuration, examples, limits.
- [docs/spec/v0.1-contract.md](docs/spec/v0.1-contract.md) — the green-light test contract.
- [docs/PLAN.md](docs/PLAN.md) — design notes.

## Dev

```bash
bun install
bun test          # red/green TDD harness
bun src/index.ts  # try the shell
```
