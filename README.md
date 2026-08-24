# crust

A pipeline-first devops toolkit built on Bun, shipped as one binary. A
spec-driven OpenAPI mock server, fixture and load-test runners, a process
orchestrator, and a link checker — every tool composes on the same
`|` / `.pipe()` stream, driven from an interactive REPL, a `crust -c`
one-liner, or a `.crust` script.

Battle-tested by dogfooding against a real 97-operation production API:
406 generated fixtures, spec-driven mocking for two client apps, and the
load pipelines below — all run through the released binary.

**Documentation:** https://lariocpt.github.io/crust-website/

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

Every line below is a real one — this README is parsed against the live grammar
on each `bun test`, so an example that stopped working fails the build.

**Fixture tests.** `.crust.ts` fixtures with `setup()` context, async matchers
and JUnit for CI; `-n/-j` turns any fixture into a stress run with p50/p95/p99.

```crust
test-fixture "tests/api/**/*.crust.ts" -j 8 -o reports/api.junit.xml
test-fixture tests/api/checkout.crust.ts -n 500 -j 32 -o reports/stress.json
```

Or a whole CRUD suite as one `.pipes` file — one pipeline per line, chained
with `capture`:

```crust
{"name": "Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
test-pipes "tests/**/*.pipes" -s tests/seed.setup.ts -b -o reports/pipes.junit.xml
```

**Load testing that CI can gate on.** Thresholds are `assert` composition, so a
failure names the predicate and exits non-zero. A run that measured nothing is
tagged `empty` and refused — `{count: 0, p95: 0}` never passes a gate.

```crust
load 30s 200/s | parallel 50 | GET :3000/health | expect 200 | stats | assert (s => s.p95 < 250)
load 10s 50/s, 5m 200/s | parallel 200 | GET $BASE/api/search | stats --every 15 | assert (s => !s.window || s.p99 < 800)
load 60s 100/s | parallel 50 | GET :3000/health | stats --out load/last.json | assert (s => s.p95 < 250)
```

**A persistent mock server from a Swagger/OpenAPI spec.** Example-first
responses, stateful CRUD persisted to sqlite or postgres so it survives a
restart, seeded from a file, with spec-violating requests rejected as 422.

```crust
mock-server ./openapi.yaml -p 4010 --state ./.crust/mock.sqlite --seed seeds/dev.json --validate
{"thing": {"name": "x"}} | POST :4010/api/things | expect 201 | (r => r.json()) | capture TID (t => t.thing.id)
```

Point it at a *real* API instead and it becomes a conformance audit — every
request forwarded untouched, every spec violation recorded:

```crust
mock-server ./swagger.json -p 4747 --proxy http://localhost:3001 --report violations.ndjson
```

**SQL assertions, inline.** Rows stream one item each, so the database is just
another stage. An empty result **fails** rather than passing quietly.

```crust
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
sql "SELECT status FROM orders WHERE id = $1" $OID | assert (r => r.status === "paid")
```

**Pretty logs from every service at once.** `procs` merges stdout and stderr
from any number of processes into one stream of `{proc, stream, line}` items —
filter them as objects, then hand the text to `pino-pretty`. Local
`node_modules/.bin` is on PATH the way `npm run` does it, so no global install.

```crust
procs({api: "bun run dev", worker: "bun run worker", db: "docker compose logs -f postgres"}) | (l => l.line) | pino-pretty --colorize
procs({api: "bun run dev", worker: "bun run worker"}) | filter (l => l.stream === "stdout") | (l => l.line) | pino-pretty --colorize --minimumLevel warn
```

**Interactive log querying.** `logs` holds one live stream and lets you iterate
on filters against its buffered past *and* live future — every query is ordinary
pipeline grammar, so nothing new to learn.

```crust
logs procs({api: "bun run dev", worker: "bun run worker", db: "docker compose logs -f postgres"})
logs docker logs -f my-app
```

At its prompt, each line runs over the buffer and then live until Ctrl-C:

```text
logs> filter (l => l.proc === "api") | (l => l.line) | grep -i timeout
logs> json on
logs> filter (e => e.level >= 50) | stats --every 5
logs> search "connection reset"
logs> buffer 50000
```

## What crust is not

Not a login shell and not a bash replacement — plain shell lines are
delegated to `sh -c` untouched; `Ctrl-C` cancels the running line but there
is no `Ctrl-Z`/`fg`/`bg`/`&` job control, and plain `FOO=x` assignments
don't persist (use `export` or `capture`). The full list lives in
[Limits](docs/USAGE.md#limits-in-v02).

## Docs

- [https://lariocpt.github.io/crust-website/](https://lariocpt.github.io/crust-website/) — the rendered documentation site: quickstart, recipes,
  agent skills, and the pipe-shorthand-vs-TypeScript comparison.
- [docs/USAGE.md](docs/USAGE.md) — user-facing reference: sources, transforms, sinks, builtins, editor keybindings, `init.ts` configuration, examples, limits.
- [docs/spec/v0.1-contract.md](docs/spec/v0.1-contract.md) — the green-light test contract.
- [docs/PLAN.md](docs/PLAN.md) — design notes.

## Dev

```bash
bun install
bun test          # red/green TDD harness
bun src/index.ts  # try the REPL
```
