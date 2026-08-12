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
# API testing
fixtures/*.json | POST :3000/users | expect 201

# Load testing
range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats

# Log mining
**/*.log | (l => l.includes('ERROR')) | wc -l

# Health monitoring
range(0, 100).parallel(() => fetch(url)) | expect 200

# One dev tail — merge every dev process into a single tagged stream
procs({web: "bun run dev", api: "bun api.ts"}) | (l => `[${l.proc}] ${l.line}`)
```

Fixtures (`test-fixture`) run `.crust.ts` files with `{ input, output }`
shapes: `setup()` context flows into the request and every matcher, matchers
may be async (DB side-effect assertions await), and `--count/--threads`
turns any fixture into a stress run with p50/p95/p99 reports. `mock-server
--swagger spec.json` serves an OpenAPI spec example-first so clients run
without their backend.

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
