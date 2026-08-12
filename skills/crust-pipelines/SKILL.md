---
name: crust-pipelines
description: Compose crust shell pipelines — sources (range, glob, read, tail, GET, load, procs, sql), transforms (TS lambdas, HTTP verbs, parallel), assertions (expect, assert), and request chaining with capture. Use when writing or debugging crust one-liners, `crust -c` scripts, or .pipes lines that mix HTTP, SQL, and processes.
---

# crust pipelines

crust is a Bun-powered shell where every command is a typed stream
(`Pipeline<T>`). Stages compose under `|`. Plain shell still works — a line
whose stages are all ordinary commands is handed to `sh -c` untouched.

## How a stage is classified (first token decides)

| You type | You get |
|---|---|
| `range(0, 9)` | numbers 0..9 inclusive, one item each |
| `**/*.ts` | glob source — file paths |
| `read fixtures/*.json` | whole-file contents, one item per file (sorted; zero matches = error) |
| `tail -F app.log` | native tail source (`-n N`, `-F` follow) |
| `load 30s 100/s` | paced load ticks (see the crust-load-testing skill) |
| `{"name": "x"}` | JSON-literal source — ONE parsed item (the request body). Invalid JSON is a hard error |
| `GET :3000/path` | HTTP. First stage: one `Response`. Mid-pipeline: per-item timed `{status, ms, url}` |
| `POST/PUT/PATCH/DELETE url` | per-item request; upstream item = body (objects auto-JSON) |
| `GET url --timeout 2s` | per-request timeout on any http stage (`ms`/`s`/`m`); timed paths yield `{status: 0, timedOut: true}`, plain verbs fail the pipeline; unknown `--flags` are errors |
| `(x => x * 2)` | TypeScript lambda, per item, async ok |
| `assert (r => r.ok)` | falsy FAILS the pipeline; empty upstream also fails |
| `capture NAME (r => r.id)` | write value to `process.env.NAME` for later lines |
| `expect 201` / `expect 2xx` | status assertion, counts mismatches, fails at drain |
| `stats [--every N] [--out f.json]` | summary: count/rps/status histogram/p50/p95/p99 |
| `parallel N` | modifier: fan-out for the NEXT stage (http, lambda, or fn — anything else errors) |
| `sql "SELECT …" $1-params` | registered fn — rows stream one item each (needs `$DATABASE_URL`) |
| anything else | plain shell via `sh -c` |

`:3000/path` expands to `http://localhost:3000/path` everywhere.

## Env expansion — parse time, opt-in per position

`$VAR`/`${VAR}` expand from `process.env` in: URLs, whole `-H` header
strings, JSON literals, `stats --out` paths, and registered-fn args. They do
NOT expand inside lambda/`assert`/`capture` bodies (those are JS — use
`process.env.VAR`) or shell stages (sh does its own). SQL positional
placeholders are safe: `$1`/`$2` inside a `sql "…"` string survive
expansion untouched (a digit can't start an env var name) and bind to the
trailing quoted args — which DO env-expand: `sql "… WHERE id = $1" "$MY_ID"`.

Inside a parenthesized lambda/`assert`/`capture` body, anything goes: the
tokenizer tracks paren depth and quotes, so literal `|`, `??`, single/double
quotes, and backticks (template literals) are all safe. In double-quoted
strings and JSON literals, `\"` escapes work.

## Request chaining with capture

Each line parses right before it runs, so a capture on one line feeds `$VAR`
on every later line — the chaining contract for REPL, `-c` scripts, and
`.pipes` files:

```crust
{"name": "Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
```

- Last item wins; omit the lambda to capture the item itself (objects are
  JSON-stringified).
- A nullish captured value or empty upstream fails IMMEDIATELY — a typo'd
  accessor dies on the capture line, not three lines later as a baffling
  `""` expansion.
- Don't capture into `TOKEN`, `BASE`, or `PATH` unless you mean to overwrite
  them.

## Verified one-liner patterns

```crust
# log mining — read yields file CONTENTS (a bare glob would grep the paths)
read **/*.log | grep ERROR | wc -l

# lambda + shell mixing — items cross as lines (objects as JSON)
range(1, 5) | (n => n * n) | sort -rn

# HTTP fixture in one line: body | request | status | parsed-body assert
{"name": "x"} | POST :3000/users | assert (r => r.status === 201) | (r => r.json()) | assert (u => u.id > 0)

# DB verification — rows stream, assert sees each row object
sql "SELECT count(*)::int AS c FROM users WHERE email = $1" "a@b.c" | assert (r => r.c === 1)

# fan out any per-item work
read fixtures/*.json | parallel 8 | POST :3000/users | expect 2xx
```

## Traps

- `assert` fails on EMPTY upstream ("no items reached") — deliberate, it
  closes the sql-returned-zero-rows silent pass. `expect` does not.
- `parallel` streams results in COMPLETION order, not input order.
- `parallel N` before anything except an http verb, lambda, or registered
  fn is a parse error; so is a trailing `parallel N`.
- A glob source yields PATHS; `read <glob>` yields file CONTENTS. `POST`ing
  a glob posts path strings.
- Builtins (`test-pipes`, `mock-server`, …) cannot be piped — a builtin line
  must contain no `|`.
- In `… | expect 200 | stats`, a failing expect throws at drain BEFORE stats
  emits — gate status inside a stats assert instead if you need the summary.

## Exit codes

Any stage throw → `crust: <message>` on stderr, line exits 1. `crust -c`
runs newline-separated lines and STOPS at the first non-zero — put warmup
and cleanup on their own lines.
