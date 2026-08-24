# crust

A pipeline-first devops toolkit built on Bun, shipped as one binary: a
spec-driven OpenAPI mock server, fixture and load-test runners, a process
orchestrator, and a link checker — every tool composes on the same `|` stream,
driven from an interactive REPL, a `crust -c` one-liner, or a `.crust` script.

```bash
npm i -g @lariocpt/crust
```

**Documentation: https://lariocpt.github.io/crust-website/**

Source and issues: https://github.com/lariocpt/crust

## What it looks like

Lines below are parsed against the live grammar on every build, so an example
that stopped working fails CI rather than misleading you.

**Fixture tests** — `.crust.ts` fixtures with `setup()` context and async
matchers, JUnit for CI, and `-n/-j` to turn any fixture into a stress run:

```crust
test-fixture "tests/api/**/*.crust.ts" -j 8 -o reports/api.junit.xml
test-fixture tests/api/checkout.crust.ts -n 500 -j 32 -o reports/stress.json
```

**Load testing with a gate CI can trust** — thresholds are `assert`
composition, and a run that measured nothing is refused rather than passing:

```crust
load 30s 200/s | parallel 50 | GET :3000/health | expect 200 | stats | assert (s => s.p95 < 250)
load 10s 50/s, 5m 200/s | parallel 200 | GET $BASE/api/search | stats --every 15 | assert (s => !s.window || s.p99 < 800)
```

**A persistent mock server from a Swagger/OpenAPI spec** — stateful CRUD
persisted to sqlite so it survives a restart, seeded from a file, with
spec-violating requests rejected as 422:

```crust
mock-server ./openapi.yaml -p 4010 --state ./.crust/mock.sqlite --seed seeds/dev.json --validate
{"thing": {"name": "x"}} | POST :4010/api/things | expect 201 | (r => r.json()) | capture TID (t => t.thing.id)
```

Point it at a real API instead and it audits that API's spec conformance:

```crust
mock-server ./swagger.json -p 4747 --proxy http://localhost:3001 --report violations.ndjson
```

**SQL assertions, inline** — rows stream one item each, and an empty result
fails instead of passing quietly:

```crust
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
sql "SELECT status FROM orders WHERE id = $1" $OID | assert (r => r.status === "paid")
```

**Pretty logs from every service at once** — `procs` merges stdout and stderr
into one stream of `{proc, stream, line}` items, so you filter them as objects
and hand the text to `pino-pretty` (local `node_modules/.bin` is on PATH):

```crust
procs({api: "bun run dev", worker: "bun run worker", db: "docker compose logs -f postgres"}) | (l => l.line) | pino-pretty --colorize
procs({api: "bun run dev", worker: "bun run worker"}) | filter (l => l.stream === "stdout") | (l => l.line) | pino-pretty --colorize --minimumLevel warn
```

**Interactive log querying** — `logs` holds one live stream and lets you iterate
on filters against its buffered past and live future:

```crust
logs procs({api: "bun run dev", worker: "bun run worker"})
logs docker logs -f my-app
```

At its prompt each line runs over the buffer, then live until Ctrl-C:

```text
logs> filter (l => l.proc === "api") | (l => l.line) | grep -i timeout
logs> json on
logs> filter (e => e.level >= 50) | stats --every 5
logs> search "connection reset"
```

## What this package installs

This package is a ~4 KB launcher, not the binary. On first use it downloads the
`bun build --compile` executable for your platform from the matching GitHub
Release, verifies its published sha256 before the file is ever made executable,
and caches it under `~/.cache/crust`. Every install route resolves that same
artifact.

Supported platforms: linux x64/arm64, macOS x64/arm64. On anything else, build
from source — see the repository README.

### Environment variables

| Variable | Effect |
|---|---|
| `CRUST_SOURCE` | `github` (default for this package) or `apps` — which artifact plane to resolve from. |
| `CRUST_GITHUB_REPO` | Override the `owner/repo` the release is fetched from. |
| `CRUST_APPS_URL` | Base URL of a self-hosted artifact plane, used when `CRUST_SOURCE=apps`. |

MIT © Lario Borges
