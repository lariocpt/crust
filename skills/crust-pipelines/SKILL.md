---
name: crust-pipelines
description: Compose crust pipelines — sources (range, glob, read, tail, GET, load, procs, sql), transforms (TS lambdas, filter, HTTP verbs, parallel), assertions (expect, assert), and request chaining with capture. Use when writing or debugging crust one-liners, `crust -c` scripts, .crust script files, or .pipes lines that mix HTTP, SQL, and processes.
---

# crust pipelines

crust is a Bun-powered pipeline runner where every command is a typed stream
(`Pipeline<T>`). Stages compose under `|`. Plain shell still works — a line
whose stages are all ordinary commands is handed to `sh -c` untouched.

## How a stage is classified (first token decides)

| You type | You get |
|---|---|
| `range(0, 9)` | numbers 0..9 inclusive, one item each |
| `**/*.ts` | glob source — file paths |
| `read fixtures/*.json` | whole-file contents, one item per file (sorted; zero matches = error) |
| `tail -F app.log` | native tail source (`-n N`, `-F` follow); the `-n N` cut is a bounded backward read, safe on huge files |
| `stdin` (alias `-`) | piped-stdin source, one item per line — `docker logs -f X \| crust -c 'stdin \| …'`. Source position only. Bare `cmd \| crust` treats stdin as a SCRIPT, so data pipes need `-c` |
| `grep ERROR` mid-pipeline | native line-buffered grep (`-i`/`-v`/`-F`, ONE pattern) — follow streams don't stall on grep's 4KB pipe buffer. Combined/unknown flags, two positionals, any `$`, `\`, or `[[:` = exact system grep via sh; first-stage grep = file grep via sh |
| `load 30s 100/s` | paced load ticks (see the crust-load-testing skill) |
| `{"name": "x"}` | JSON-literal source — ONE parsed item (the request body). Invalid JSON is a hard error |
| `GET :3000/path` | HTTP. First stage: one `Response`. Mid-pipeline: per-item timed `{status, ms, url}` |
| `POST/PUT/PATCH/DELETE url` | per-item request; upstream item = body (objects auto-JSON) |
| `GET url --timeout 2s` | per-request timeout on any http stage (`ms`/`s`/`m`); timed paths yield `{status: 0, timedOut: true}`, plain verbs fail the pipeline; unknown `--flags` are errors |
| `(x => x * 2)` | TypeScript lambda, per item, async ok — MAPS, never drops (falsy results are emitted as-is) |
| `filter (l => l.ok)` | keeps items whose predicate is truthy; falsy (`0`, `""`, `null`…) drop; async ok; empty result passes |
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
# log mining — read yields file CONTENTS (a bare glob would grep the paths);
# after a shell stage like grep, items are LINES, so filter is per-line
read **/*.log | grep ERROR | filter (l => !l.includes('healthcheck')) | wc -l

# lambda + shell mixing — items cross as lines (objects as JSON)
range(1, 5) | (n => n * n) | sort -rn

# HTTP fixture in one line: body | request | status | parsed-body assert
{"name": "x"} | POST :3000/users | assert (r => r.status === 201) | (r => r.json()) | assert (u => u.id > 0)

# DB verification — rows stream, assert sees each row object
sql "SELECT count(*)::int AS c FROM users WHERE email = $1" "a@b.c" | assert (r => r.c === 1)

# fan out any per-item work
read fixtures/*.json | parallel 8 | POST :3000/users | expect 2xx

# follow a log live — native grep emits each match immediately
tail -n 0 -F app.log | grep ERROR

# any command's output as a source (run under `crust -c`, data piped in)
stdin | (l => JSON.parse(l)) | filter (e => e.level >= 40) | (e => e.msg)
```

To ITERATE on filters over one held live stream, use the `logs` builtin
(`logs tail -n 0 -F app.log`, `logs procs({…})`, `logs docker logs -f c`):
every line typed at its prompt is a fragment like the ones above, run over
a buffer of the recent past and then live; Ctrl-C once ends the view and
flushes terminal stages (bare `stats` prints there), `exit` leaves.

## Traps

- A plain lambda MAPS — `(l => l.includes('ERROR'))` emits `true`/`false`
  per item, and `(x => cond ? x : null)` prints literal `null` lines. To
  drop items, use `filter (l => l.includes('ERROR'))`.
- `filter` passes an empty stream through silently; `assert` fails on EMPTY
  upstream ("no items reached") — deliberate, it closes the
  sql-returned-zero-rows silent pass. `expect` does not fail on empty either.
- `parallel` streams results in COMPLETION order, not input order.
- `parallel N` before anything except an http verb, lambda, or registered
  fn is a parse error; so is a trailing `parallel N`.
- A glob source yields PATHS; `read <glob>` yields file CONTENTS. `POST`ing
  a glob posts path strings.
- Builtins (`test-pipes`, `mock-server`, `logs`, …) cannot be piped — a
  builtin line must contain no `|`.
- Native grep patterns are JS regexes: quoted `'a|b'` ALTERNATES (ERE)
  where BRE grep matched the literal — use `grep -F 'a|b'` for the literal.
- `stdin` is single-shot per process: inside a bare `cmd | crust` script it
  errors (the pipe was already consumed as the script itself).
- In `… | expect 200 | stats`, a failing expect throws at drain BEFORE stats
  emits — gate status inside a stats assert instead if you need the summary.

## Exit codes

Any stage throw → `crust: <message>` on stderr, line exits 1. `crust -c`,
`crust file.crust`, and piped stdin all run newline-separated lines through
the same fail-fast loop and STOP at the first non-zero — put warmup and
cleanup on their own lines. Blank lines and `#` comments are skipped, so a
`#!/usr/bin/env crust` shebang works in `.crust` files.
