# crust — usage

A Bun-powered shell with first-class pipelines. Shell commands, TypeScript lambdas, HTTP verbs, globs, and parallel workers all compose under one `|` / `.pipe()` model. v0.1.

**Mental model:** crust is effectively an inline JavaScript global-scope script runner in Bun, shell-flavoured. Every line you type runs in a Bun context where `Pipeline`, `range`, `GET`/`POST`, `parallel`, `$` (Bun.$), and anything you registered in `~/.config/crust/init.ts` are globals. Shell commands and TS lambdas are equal citizens; both are stages on the same pipeline.

## Contents

- [Install](#install)
- [Hello world](#hello-world)
- [One-liner mode](#one-liner-mode)
- [The Pipeline model](#the-pipeline-model)
- [Shell-line syntax](#shell-line-syntax)
- [Shorthand fixture grammar](#shorthand-fixture-grammar)
- [TypeScript API](#typescript-api)
- [Builtins](#builtins)
- [test-fixture](#test-fixture)
- [test-pipes](#test-pipes)
- [gen-fixtures](#gen-fixtures)
- [mock-server](#mock-server)
- [verify-web-links](#verify-web-links)
- [Editor keybindings](#editor-keybindings)
- [Configuration (`init.ts`)](#configuration-initts)
- [Examples](#examples)
- [Limits in v0.1](#limits-in-v01)

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
```

The installer puts crust in `~/.crust/`, installs Bun if missing, copies a starter config to `~/.config/crust/init.ts`, and (with sudo) registers `~/.crust/bin/crust` in `/etc/shells`.

Then launch:

```bash
~/.crust/bin/crust
```

Or set it as your terminal's shell. In COSMIC Terminal: **Settings → Profiles → Command → `~/.crust/bin/crust`**.

To make it your login shell:

```bash
chsh -s ~/.crust/bin/crust
```

## One-liner mode

Crust is designed to be useful even if you don't make it your daily shell. Call it from bash/zsh/fish for the one-liners where its pipeline syntax wins:

```bash
crust -c 'range(0,99) | parallel 20 | GET :3000/health | expect 200 | stats'
crust -c 'ls *.json | (s => JSON.parse(await Bun.file(s).text())) | (j => j.id)'
crust -c 'src/**/*.ts | wc -l'
```

`-c` runs the line through the full pipeline parser and exits with the line's status. Your `~/.config/crust/init.ts` is still loaded, so any `crust.fn(...)` registrations are available.

| Flag | Effect |
|---|---|
| `crust` | Interactive REPL (default). |
| `crust -c <line>` | Run one line and exit. Multi-line strings split on `\n` and are **fail-fast**: crust stops at the first failing line and exits with *its* code (previously a later success masked an earlier failure). |
| `crust -h`, `--help` | Show usage. |
| `crust -V`, `--version` | Show version. |

## Hello world

```text
~/Projects (main) $ echo hello
hello
~/Projects (main) $ range(0, 3) | (x => x * 2)
0
2
4
6
~/Projects (main) $ ls bin
crust
~/Projects (main) $ alias g=git
~/Projects (main) $ alias
alias g='git'
~/Projects (main) $ exit
```

## The Pipeline model

Every command in crust produces a stream — a `Pipeline<T>`. Stages compose under `|` (shell-line) or `.pipe()` (TypeScript). Three roles:

| Role | What it does | Examples |
|---|---|---|
| **Source** | Produces a stream | `ls`, `range(0,9)`, `**/*.ts`, `GET <url>` |
| **Transform** | Stream-in, stream-out | shell command, `(x => …)`, `POST <url>` |
| **Sink** | Stream-in, value-out | stdout (default), `write`, `dest`, `stats` |

The shell parser classifies each `|`-separated stage by looking at its first token:

| Trigger | Stage kind |
|---|---|
| Contains `*` / `?` / `[…]` | Glob source |
| Matches `range(a, b)` | Range source |
| Starts with `{` or `[` | JSON-literal source (invalid JSON = hard error, never shell) |
| Starts with `read <path\|glob>` | Whole-file source — one item per matched file |
| Starts with `tail <path>` (with optional `-F` / `-n N`) | Native `tail` source |
| Starts with `(` and contains `=>` | TypeScript lambda |
| Starts with `assert (` | Assert stage — falsy or empty upstream fails the pipeline |
| Starts with `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | HTTP stage (`-H` headers, `$VAR` expansion, `:port` shorthand) |
| First token is a builtin name | Builtin (no piping; in-process dispatch) |
| First token is a `crust.fn`-registered function | Registered function (per-item transform) |
| Anything else | Shell stage — handed to `sh -c "<text>"` |

Single-stage pure-shell lines (`ls -la`, `git status`) are short-circuited: crust execs `sh -c` with **inherited stdio** so colors, paging, and TUIs work normally. Mixed pipelines stream items through TS land.

---

## Shell-line syntax

What you can type at the prompt today.

### Sources

```bash
ls                                # any shell command — source if first stage
range(0, 9)                       # 0..9 inclusive — Pipeline<number>
**/*.ts                           # glob — Pipeline<string> of paths
src/*.{ts,tsx}                    # globs support **/*, ?, [abc]
tail app.log                      # last 10 lines, then done — Pipeline<string>
tail -n 100 app.log               # custom line count
tail -F app.log                   # follow mode: stream new lines forever
GET https://api.example.com/  # → Pipeline<Response> (single item)
GET :3000/health                  # localhost shorthand
read fixtures/*.json              # whole-file contents, one item per file
{"name": "Court"}                 # JSON literal — one parsed item (the request body)
procs({web: "bun run dev", api: "bun api.ts"})   # merge long-lived processes
```

`read <path|glob>` yields each matched file's **entire contents** as one item
(vs the TS `read(path)`, which streams lines of a single file). It's the
fixture-folder source: `read fixtures/*.json | POST :3000/users | expect 201`.
Matches are sorted; zero matches is a hard error. Note the plain glob source
(`fixtures/*.json | …`) yields *paths* — `POST` would post the path strings.

A stage starting with `{` or `[` is a **JSON-literal source**: one parsed
item. `$VAR`/`${VAR}` inside it are env-expanded first. Invalid JSON is a
hard error — it never falls back to a shell command.

`GET` has a dual role: as the **first** stage it's a source yielding one
`Response` (fixture asserts); **mid-pipeline** it's a per-item timed request
yielding `{ status, ms, url }` records (load pipelines). See
[Shorthand fixture grammar](#shorthand-fixture-grammar).

`procs({name: "command", …})` spawns each command and streams
`{ proc, stream, line }` for every stdout/stderr line (plus an `exit`
marker), merged as lines arrive — the "one dev tail" source. Children are
killed when the pipeline ends or crust gets SIGINT/SIGTERM.

A spec value can also be an object — `{cmd, env?, restart?}`:

```bash
procs({
  web: {cmd: "bun run dev", env: {PORT: "3001"}},
  api: {cmd: "bun api.ts", restart: true}
})
```

- `env` — extra env for THAT process, merged over the inherited environment.
- `restart: true` — respawn on unexpected exit, with backoff starting at
  250ms and doubling to a 2s cap (a `restarting in Nms` line is emitted on
  the `exit` stream). A **user kill** (Ctrl-C / SIGTERM) never respawns.

### Transforms

```bash
… | grep TODO                              # any shell command
… | (line => line.toUpperCase())           # TS lambda
… | tr '[:lower:]' '[:upper:]'             # standard pipes work
… | POST :3000/users                       # per-item HTTP POST (body = item)
… | DELETE :3000/users/:id                 # per-item DELETE
… | GET :3000/health                       # per-item timed GET (item = trigger)
… | POST $BASE/api/things -H "authorization: Bearer $TOKEN"   # headers + env vars
```

`GET` as a transform fires one request per upstream item and yields
`{ status, ms, url }` timing records (bodies are drained, not kept) — pair it
with `parallel` and `stats` for load pipelines.

Every http verb stage accepts repeatable `-H "Key: value"` header flags
(quote them — values may contain spaces and colons). URLs and `-H` values are
`$VAR`/`${VAR}` env-expanded, and the `:port/path` localhost shorthand works
for **all** verbs, source or transform. `parallel N` upstream is honored for
non-GET verbs too: `read fixtures/*.json | parallel 8 | POST :3000/users`.

HTTP transforms auto-set `content-type: application/json` for object items. String items are sent as text. `Buffer`/`Uint8Array` go raw.

### Assertions & concurrency

```bash
range(0, 999) | parallel 50 | GET :3000/health | expect 200 | stats
sql "SELECT count(*)::int AS c FROM users" | assert (r => r.c === 1)
range(0, 599) | parallel 50 | GET :3000/health | stats --every 5
```

- `parallel N` — sets the fan-out for the NEXT http stage (it is a modifier,
  not a buffering stage). **Results stream in COMPLETION order, not input
  order** — a deliberate contract change so downstream windowed stats see a
  live stream instead of a final-millisecond dump. If you need input order,
  sort downstream.
- `expect NNN` — passes items through; when the stream drains, fails the
  pipeline (exit 1) naming the mismatch count if any item's `status` didn't
  match.
- `assert (x => expr)` — per-item predicate; a **falsy** result fails the
  pipeline naming the item. Unlike a plain lambda (which maps), and unlike
  `expect`, an **empty upstream also fails** ("no items reached") — the
  sql-returned-zero-rows silent pass is exactly the trap this closes.
- `stats` — consumes the stream and yields one summary: `count`, `wallMs`,
  `rps`, a status histogram, and real `p50/p95/p99/meanMs` latency
  percentiles from the timed-GET records.
- `stats --every N` — additionally emits a **per-window delta summary** every
  N seconds (`{window: 1, …}`, `{window: 2, …}`) and finishes with one
  cumulative summary tagged `{final: true}`. Windows flush on the item path —
  a fully stalled upstream delays the next window until an item arrives.

### Timing a pipeline (`time "label"`)

`time` is a prefix-only decorator — bash-style. Put it before the source and it wraps the whole pipeline, printing elapsed wall time + item count to **stderr** when the iterator drains:

```bash
time "warmup" | range(0, 1000) | GET :3000/health
# stderr → [time] warmup: 412.3ms (1001 items)
```

Quotes (`"` or `'`) are required around the label; data flowing through the pipeline is untouched. The timer fires even if a downstream stage throws (e.g. `expect 500` failure), so you still see how long you got before the break. Only allowed as the first stage — `... | time "x"` is rejected. The matching TS API is `time(label, out?)`.

### Tailing files (`tail` source)

Native `tail` is a first-class crust source — no shell-out to the system `tail` needed when all you want is "last N lines" or `tail -F`-style follow. Same flags as POSIX `tail`, mapped to a `Pipeline<string>`:

```bash
tail app.log                       # last 10 lines, then done
tail -n 100 app.log                # last 100 lines, then done
tail --lines=100 app.log           # same
tail -F app.log                    # last 10 lines, then stream new ones forever
tail -F -n 0 app.log               # follow only — skip the initial cut

# Multiple files: paths and globs are accepted. Lines from all files
# merge into one stream as they arrive (like `tail -f a.log b.log`).
tail a.log b.log                   # explicit list
tail logs/*.log                    # glob expansion
tail -F services/*/access.log     # follow N files at once

# Compose like any other source
tail -F app.log | grep ERROR
tail -F app.log | (l => JSON.parse(l))
tail -F app.log | POST :3000/ingest
tail logs/*.log | grep ERROR > combined.log
```

`-F` follows the file by inode + size. Rotate-and-recreate (logrotate-style) is detected via inode change and the source switches over to the new file automatically. A truncate that shrinks the file below the current offset is also detected and resets the stream. A truncate-and-immediate-overwrite to a size ≥ the prior offset is indistinguishable from an append via `stat` alone, and is treated as an append — matches GNU `tail -F` behavior.

With multiple inputs, each file is tracked independently — every file gets its own inode/size loop, rotation handling, and initial-N-lines cut. Lines yield as they arrive (non-deterministic across files, deterministic within one file). When all paths are non-follow, the source completes once each file is drained.

Unrecognized flags (`-c`, `--pid`, etc.) fall back to the system `tail` via shell, so `tail -c 200 app.log` and `tail --help` still work as expected. Bare `tail` with no path also falls through to shell.

Polling interval is 200ms by default. From the TS API: `tail(paths, { lines, follow, pollMs })` where `paths` is a string or string[] (globs expanded automatically) — see [TypeScript API](#typescript-api).

### Builtins

```bash
cd <dir>          # cd, cd -, cd ~, cd ~/path
export FOO=bar    # set env var
alias g=git       # define alias (also: alias g='git status')
alias             # list aliases
unalias g
source <file>     # .sh runs in sh; .ts/.js dynamically imported
history           # list this session's lines
exit [code]
help
```

Builtins run in-process. They dispatch when the first token matches a builtin name **and** the line has no pipe (`|`), redirect (`<`, `>`), or sequencing (`&`, `;`) operators.

---

## Shorthand fixture grammar

One shell line can now be a complete HTTP fixture — body, auth header, and
assertion. This is what [test-pipes](#test-pipes) runs from `.pipes` files,
and it works identically at the prompt and in `crust -c`:

```bash
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | expect 201
sql "SELECT count(*)::int AS c FROM buildings WHERE name = $1" "Court" | assert (r => r.c === 1)
read fixtures/*.json | POST :3000/users | expect 201
GET :3000/api/buildings -H "authorization: Bearer $TOKEN" | (r => r.json()) | assert (b => b.items.length > 0)
```

The pieces:

- **JSON-literal source** — a stage starting `{`/`[` parses as JSON and
  yields one item: the request body. Invalid JSON is a **hard error**; it
  never falls back to shell (a typo'd body exec'ing as a command would be
  baffling).
- **`-H "Key: value"`** — repeatable header flags on every http verb stage.
- **`read <path|glob>`** — whole-file contents, one item per matched file
  (sorted; zero matches errors). Gotcha: this shadows POSIX `read <var>` at
  the prompt.
- **`assert (x => expr)`** — falsy fails the pipeline; **empty upstream also
  fails**. `expect NNN` stays the status-code assertion; `assert` is for
  everything else (DB rows, parsed bodies).
- **`:port/path`** — localhost shorthand, all verbs, source or transform.
- **GET dual role** — first stage: one `Response` item (fixture asserts);
  mid-pipeline: per-item timed `{status, ms, url}` records (load).

### Where `$VAR` expands

`$VAR` / `${VAR}` come from `process.env`; missing vars become the empty
string. Expansion is **opt-in per position** — crust expands exactly:

| Position | Expanded? |
|---|---|
| URLs (all http verbs) | yes |
| `-H` header values | yes |
| JSON-literal sources | yes |
| Registered-fn args (`sql "…" "$RUN_ID"`) | yes — SQL positionals `$1`/`$2` survive (a digit can't start an env var name) |
| Lambda / `assert` bodies | **no** — they're JS; use `process.env.TOKEN` |
| Shell stages | untouched — `sh` does its own expansion |

---

## TypeScript API

The full pipeline surface is available to any `.ts` file run by Bun, including `~/.config/crust/init.ts`. Crust exposes these as globals when starting up:

```ts
Pipeline             // class — the unified stream abstraction
range(start, end)    // source
glob(pattern)        // source
read(path)           // source — Pipeline<string> of lines
readAll(pattern)     // source — whole-file contents, one item per matched file
                     // (the shell line's `read <glob>`)
tail(paths, opts?)   // source — string | string[]; globs expanded; multi-file merges
GET(url, opts?)      // source
POST(url, opts?)     // transform: Pipeline<T> → Pipeline<Response>
PUT, PATCH, DELETE   // same shape as POST
expectStage(matcher) // transform — fails the pipeline on mismatch
parallel(n, fn)      // transform — N concurrent workers, COMPLETION order
$                    // Bun's tagged-template shell (`Bun.$`)
```

`tail(paths, opts?)` accepts a single path, an array, or a glob pattern (or a mix). Options: `lines` (default `10`, set `0` to skip the initial cut), `follow` (default `false`), `pollMs` (default `200`). With `follow: true`, the stream never ends until the consumer stops iterating — handle that explicitly with `break`, `.lines()`, or by tying the iteration to an `AbortController`.

```ts
// Last 50 lines of a log, ship to S3
await tail("application.log", { lines: 50 })
  .pipe(POST("https://logs.example.com/ingest"))
  .collect();

// Follow a log forever, alert on ERROR lines
for await (const line of tail("application.log", { follow: true }).lines()) {
  if (line.includes("ERROR")) await notifyPager(line);
}

// Tail every service's access log into one stream
for await (const line of tail("services/*/access.log", { follow: true }).lines()) {
  if (/5\d\d/.test(line)) await notifyPager(line);
}

// Explicit list — same semantics as the glob form
await tail(["api.log", "worker.log", "scheduler.log"], { lines: 100 })
  .filter((l) => l.includes("ERROR"))
  .to(write("errors.log"));
```

And these sinks are imported directly (`from "crust/sinks"` once published; today: `from "../src/sinks"` if you're hacking on the repo):

```ts
write(path)          // sink — line-per-item to disk
dest(dir)            // sink — vinyl-ish {path, contents} items to a dir
stats()              // sink — { count, durationMs, status, p50, p95, p99 }
```

### Pipeline methods

```ts
Pipeline.of(arr | asyncIterable | ReadableStream)   // construction

pipeline
  .pipe(stage)            // stage: fn(x)=>U | Pipeline | async iterable | PipelineStage
  .map(fn)                // per-item, async ok
  .filter(fn)
  .reduce(fn, init)       // terminal → Promise<A>
  .collect()              // terminal → Promise<T[]>
  .text()                 // terminal → Promise<string> (joined with \n)
  .lines()                // AsyncIterable<T> — for await
  .json<U>()              // terminal → Promise<U>
  .to(sink)               // terminal → calls sink(this)
```

### A few one-liners

```ts
// Range + parallel HTTP
await range(0, 99)
  .pipe(parallel(10, async i => fetch(`http://localhost:3000/items/${i}`)))
  .pipe(expectStage(200))
  .to(stats());

// Fixture loop
await glob("fixtures/*.json")
  .pipe(async path => Bun.file(path).text())
  .pipe(POST("http://localhost:3000/users"))
  .pipe(expectStage(201))
  .collect();

// Mixed shell + TS
await Pipeline.of(["alpha", "bravo", "charlie"])
  .pipe(s => s.toUpperCase())
  .to(write("/tmp/upper.txt"));
```

### `expectStage` matchers

```ts
expectStage(200)                        // exact status
expectStage("2xx")                      // class — "2xx", "3xx", "4xx", "5xx"
expectStage((item) => item.status < 300) // custom predicate

// On mismatch, the pipeline rejects with ExpectError{ item, index, matcher }.
```

### Why `expectStage` and not `expect`

The TS-test ecosystem owns the name `expect`. Crust exports the API name as `expectStage` to avoid collisions when you `import { expect as expectStage }` in test files. From the shell line it's just `expect 201`.

---

## Builtins

| Builtin | Behaviour |
|---|---|
| `cd [dir]` | `process.chdir`. `cd -` returns to `OLDPWD`. `~` expands to `$HOME`. |
| `export KEY=value` | Sets `process.env[KEY]`. Multiple `KEY=value` pairs accepted. Bare `export` lists. |
| `alias name='cmd'` | Adds an alias. Bare `alias` lists. Quotes optional. Expansion: first word only. |
| `unalias name` | Removes an alias. |
| `source file` | `.sh` files run via `sh`; `.ts`/`.js` dynamically imported. |
| `history` | Numbered list of this session's lines. Persistent at `~/.local/share/crust/history`. |
| `dotenv [--config p] [--append]` | Loads `.env` files into the session. Tracks history, supports `dotenv status` and `dotenv clear`. See [dotenv](#dotenv). |
| `test-fixture --target g [--out p] [--threads N] [--count N] [--timeout ms] [--bail]` | Runs `.crust.ts` HTTP fixtures. See [test-fixture](#test-fixture). |
| `test-pipes --target g [--bail] [--timeout ms] [--setup m]` | Runs `.pipes` files — one shorthand fixture pipeline per line. See [test-pipes](#test-pipes). |
| `gen-fixtures --swagger s --out d --setup m [--no-flows]` | Generates negative-case `.crust.ts` fixtures and CRUD flow `.pipes` suites from an OpenAPI spec. See [gen-fixtures](#gen-fixtures). |
| `mock-server --swagger <url-or-path> [--port N] [--host addr] [--stateful]` | Boots a `Bun.serve` instance that mocks every operation in an OpenAPI 3.x spec; `--stateful` adds an in-memory CRUD layer. See [mock-server](#mock-server). |
| `exit [code]` | Exits crust with optional code (default 0). |
| `help` | Lists builtins. |

### dotenv

Loads a `.env` file into the live shell session (mutates `process.env`, which is what `Bun.env` reflects). Mode `overwrite` (default) replaces existing values; `--append` keeps any value that's already set.

```bash
dotenv                           # load ./.env, overwrite mode
dotenv --config .env.local       # load a custom file
dotenv --config .env.local --append
dotenv status                    # show load history + which keys came from where
dotenv clear                     # restore process.env to the pre-first-load snapshot
```

The prompt shows `[env: N]` after `N` successful loads. Cleared when you run `dotenv clear`. Snapshot is taken lazily on the first ever load; subsequent loads do not re-snapshot, so `clear` always restores back to pristine state.

Supported `.env` syntax: `KEY=value`, `KEY="quoted value"`, `KEY='single quoted'`, leading `export` prefix, `#` comments (whole-line and trailing on unquoted values). Multi-line quoted values and `$FOO` interpolation are not supported in v0.1.

### test-fixture

Runs `.crust.ts` fixture files against an HTTP service. Each file is a normal TypeScript module that default-exports a fixture (or array of fixtures) with `input` and `output` objects. Fields can be values *or* zero-argument functions (resolved + awaited at run time). In `output`, a function with at least one parameter is treated as a predicate matcher over the actual value.

**Setup context flows into the request** — `setup()`'s return value is
passed to `input`/`output` when they are functions of one argument, to unary
`input` FIELD functions, and to every matcher as its second argument.
**Matchers may be async** — the runner awaits Promise-returning predicates
(a DB side-effect assertion is one `await` away).

```ts
export default {
  name: "signup lands a users row",
  setup: () => ({ email: `u-${crypto.randomUUID()}@t.dev` }),
  input: (ctx) => ({
    url: "http://localhost:3000/signup",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ctx.email, password: "pw-123456" }),
  }),
  output: {
    status: 201,
    data: async (d, ctx) => (await db.userByEmail(ctx.email)) !== null,
  },
  teardown: (ctx) => db.deleteByEmail(ctx.email),
};
```

```bash
test-fixture --target fixtures/*.crust.ts
test-fixture --target fixtures/users.crust.ts --out report.md
test-fixture --target 'fixtures/**/*.crust.ts' --threads 8 --out report.json
test-fixture --target fixtures/users.crust.ts --count 1000 --threads 32   # stress
test-fixture --target 'gen/*.gen.crust.ts' --threads 8 --timeout 5000 --bail
```

- `--timeout <ms>` — fail any fixture whose request runs longer. A fixture's
  own `input.signal` wins; `--timeout` only fills the gap.
- `--bail` — stop **starting** new fixtures after the first fail/error;
  in-flight fixtures finish and are reported.

> **Teardown isolation.** Under `--threads`/`--count`, many fixtures are
> mid-flight at once. A `teardown` must touch ONLY what its own `ctx`
> created — a "global cleanup" sweep (`DELETE FROM users`, truncate-all)
> shreds every other fixture still running. If you need a full reset, do it
> once outside the runner, not per-fixture.

**Module resolution caveat:** when the runner is the AOT-compiled binary (the normal install), fixture files can import relative modules and Bun builtins (`Bun.SQL`, `Bun.file`, …) but NOT third-party npm packages — the compiled binary has no `node_modules` walk. Keep fixture helpers on builtins (use `Bun.SQL` instead of `pg`). Under dev mode (`bun src/index.ts`), the full walk works.

Example fixture:

```ts
// fixtures/users.crust.ts
export default {
  name: "GET /users/42 returns Lario",
  input: {
    method: "GET",
    url: "http://localhost:3000/users/42",
    headers: async () => ({
      Authorization: `Bearer ${await Bun.jwt.sign({ sub: "42" }, "k")}`,
    }),
  },
  output: {
    status: 200,
    data: { id: 42, name: "Lario" },
    headers: { "content-type": (v: string) => v.startsWith("application/json") },
  },
};
```

Report formats are picked from `--out`'s extension: `.json`, `.md`, anything else is plain text. With no `--out`, prints a colored, folder-grouped summary to stdout. Exit codes: `0` all pass, `1` any failure/error, `2` no files matched or bad args.

When installed via `install.sh`, the runner is AOT-compiled to a host-arch bytecode binary at `~/.crust/bin/crust-test-fixture` for fast cold-start. The shell builtin execs that binary if present and falls back to in-process dynamic import otherwise (dev mode).

### test-pipes

Runs `.pipes` files: **one shorthand fixture pipeline per line** (the
[shorthand grammar](#shorthand-fixture-grammar)). `#` comments and blank
lines are skipped. Lines run **sequentially per file, in order** — on
purpose, because shorthand suites interleave requests with `sql`/`assert`
lines about what the previous line did.

```bash
test-pipes --target smoke.pipes
test-pipes --target 'tests/**/*.pipes' --bail --timeout 5000
test-pipes --target smoke.pipes --setup ./seed.ts
```

```bash
# smoke.pipes — a whole CRUD suite, no framework
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | expect 201
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
GET $BASE/api/buildings -H "authorization: Bearer $TOKEN" | (r => r.json()) | assert (b => b.items.length > 0)
```

Flags: `--bail` stops at the first failing line (across files); `--timeout
<ms>` fails any line that runs longer.

**Setup module.** Before a file runs, its setup module is imported and its
**default export awaited**: explicit `--setup <module>`, else a sibling
`<name>.setup.ts` next to the `.pipes` file. Setup seeds `process.env` —
that's how lines get their `$BASE`/`$TOKEN` values:

```ts
// smoke.setup.ts
export default async () => {
  process.env.BASE = "http://localhost:3000";
  process.env.TOKEN = await loginAndGetToken();
};
```

Each file gets a fresh, hermetic pipeline context: builtin fns (`sql`, …)
registered, but no `init.ts` and no shared alias state — a `.pipes` file
must behave the same on every machine. Exit codes: `0` all lines pass,
`1` any fail, `2` no files matched / bad args.

### gen-fixtures

Derives a **negative-case fixture matrix** from an OpenAPI 3.x spec (Swagger
2.0 is auto-converted): for every operation the spec documents, cases the
server must *reject*. Output is one `<tag>.gen.crust.ts` per OpenAPI tag in
`--out` (the directory is **deleted and recreated** every run — never edit
generated files), runnable by [test-fixture](#test-fixture).

```bash
gen-fixtures --swagger ./openapi.json --out tests/gen --setup ./tests/gen-setup.ts
test-fixture --target 'tests/gen/*.gen.crust.ts' --threads 8
test-pipes --target tests/gen/flows/flows.gen.pipes   # generated CRUD flows
```

Derived cases:

- **401** when the op documents a *middleware* 401 — a 401 response whose
  description matches `/not authenticated|log in/i`. Public endpoints like
  login that document 401 for bad credentials get no case.
- **403** for scope-gated ops that document 403 (an authenticated outsider
  with no membership in the scope).
- **404** for non-scope-gated ops with path params that document 404 (an
  authorised caller requests a random uuid).
- **400 per request-body field**: required field missing, wrong JSON type,
  enum violation — asserting the canonical
  `{ error, code: "validation", fieldErrors }` body. Perturbations are
  applied to a **schema-valid base body** (with format-aware synthesis:
  emails, uuids, dates, simple digit-pattern sampling), so exactly one thing
  is wrong per case.
- **400 boundary violations**, for ALL body properties — required *and*
  optional — in fixed per-field order: too short (`minLength`), too long
  (`maxLength`; skipped above 4096 to keep checked-in files reviewable),
  below minimum / above maximum (`maximum: Number.MAX_SAFE_INTEGER` is
  treated as an "unbounded" sentinel and skipped), and pattern violation
  (deduped when the required-field wrong-type case already sends an
  unparseable string). Nullable zod-style `anyOf: [X, {type: "null"}]`
  wrappers are unwrapped, so nullable fields get their boundary cases too.
  One op-level **unexpected extra property** case is added when the body
  schema has `additionalProperties: false`; it asserts only status +
  `code === "validation"` (unknown-key naming in `fieldErrors` varies by
  server). Regenerating a spec that predates the boundary matrix yields a
  purely additive diff — existing case names, order and bodies are
  untouched.

#### Generated CRUD flows

Unless `--no-flows`, qualifying collection paths also get a **CRUD flow
suite**: `--out/flows/flows.gen.pipes` plus a sibling `flows.gen.setup.ts`
that [test-pipes](#test-pipes) auto-detects — zero extra flags to run. A
collection path `P` qualifies when it has a POST with an `application/json`
request schema and a documented 2xx, an item path `P/{param}` with at least
one of GET/PUT/PATCH/DELETE exists, `P` carries no path params beyond the
scope param (nested collections are skipped with a stdout notice), and the
created id's location is derivable from the POST's 2xx response (the media
`example`, else `schema.properties`: top-level `id`, else the first
object-valued property containing an `id`; not derivable → skipped with a
notice).

Each flow chains create → read → update → delete → read-after-delete using
the [capture](#shorthand-fixture-grammar) stage — the POST captures the new
id into `$GEN_ID_<T>`, later lines interpolate it into the item URL. Update
(prefers PATCH) / delete / tombstone-404 lines are emitted only when the
spec documents those ops (the 404 read needs both a DELETE and a documented
404 on the GET). Statuses come from each op's lowest documented 2xx. The
generated setup module adapts the standard setup contract: it calls
`shared()` + `headersFor(ctx, "member")` to seed `$GEN_AUTH_HEADER` and
`resolvePath` per flow to seed `$GEN_URL_<T>`. SQL assertions are not
derivable from a spec, so none are emitted — add DB-level checks in a
hand-written `.pipes` file.

#### The setup-module contract

Generated files are app-agnostic: they import ONLY from the `--setup` module
(the import specifier is rewritten relative to `--out`). That module carries
every app-specific detail and must export:

- `shared(): Promise<Ctx>` — promise-cached scenario factory (roles, ids).
  Wired as every fixture's `setup`, so it MUST cache: build the scenario once
  on first call and return the same promise afterwards (safe under
  `--threads`). It must also be **lazy** — no side effects at module import
  time, because the generator imports the module at generation time just to
  read the scope config.
- `headersFor(ctx, role: "none" | "member" | "outsider"): Record<string,
  string>` — request headers for a caller in that role. `"member"` must
  clear both the auth and scope gates; `"outsider"` is authenticated but has
  no membership in the shared scope. Generated code only calls it with
  `"member"`/`"outsider"` — unauthenticated cases use `JSON_HEADERS`
  directly.
- `resolvePath(ctx, template: string): string` — takes the raw path template
  with `{param}` placeholders, substitutes scope params from ctx,
  substitutes any other `{param}` with a random uuid, and prefixes the API
  base URL; returns the absolute request URL.
- `scopeParam: string | null` — the template param name that marks a path as
  scope-gated (e.g. `"buildingId"`). An op is scope-gated when its path's
  FIRST template param has this name. `null` disables 403 derivation
  entirely.
- `scopeRoots?: string[]` — optional path prefixes (e.g. `"/api/buildings"`)
  whose immediately following first template param is the scope id even when
  it has a different name (`/api/buildings/{id}`).
- `JSON_HEADERS: Record<string, string>` — plain unauthenticated JSON
  headers, used for role `"none"`.

Exit codes: `0` generated, `1` generation error (including a setup module
missing `scopeParam`), `2` bad args.

### mock-server

Boots a `Bun.serve` instance that mocks every operation in an OpenAPI 3.x spec — useful for frontend dev before the backend exists, demoing a pipeline, or seeding fixture tests against an upstream you don't want to spin up.

```bash
mock-server --swagger ./openapi.yaml --port 4000
mock-server --swagger https://petstore3.swagger.io/api/v3/openapi.json --port 4747
mock-server --swagger ./spec.json --port 0 --host 127.0.0.1   # OS-assigned port
mock-server --swagger ./openapi.yaml --port 4000 --stateful   # in-memory CRUD
```

Flags: `--swagger <url-or-path>` (required; URL or local `.json`/`.yaml`/`.yml`; Swagger 2.0 specs are auto-converted to OpenAPI 3.x), `--port N` (default `3000`, `0` = ephemeral), `--host addr` (default `0.0.0.0`), `--stateful` (in-memory CRUD layer — see below).

Response bodies are picked example-first, schema-fallback:

1. `content.<media>.example` wins outright.
2. Otherwise the first entry in `content.<media>.examples`.
3. Otherwise the schema is walked: `string` → `"string"` (or a format-aware default for `email`, `date-time`, `uuid`, `uri`), `integer`/`number` → `0`, `boolean` → `false`, `array` → `[item]`, `object` → every property generated, `enum` → first value, `allOf` merged, `oneOf`/`anyOf` → first branch. Local `$ref`s into `components.schemas.*` are resolved (cyclic refs return `null`).

Status code selection within a matched operation: `200` → `201` → first `2xx` → `default` → first defined. `application/json` content is preferred; otherwise the first content type. Routes with literal segments take precedence over `{param}` siblings, so `GET /pets/mine` wins over `GET /pets/{id}`.

Unmatched paths return `404`; matched paths with the wrong method return `405`. Per request, one line goes to stderr:

```text
GET    /pets        200  3ms
POST   /pets        201  2ms
DELETE /pets/99     404  0ms
```

Ctrl-C (or `SIGTERM`) shuts the server down cleanly. Limits: remote `$ref` resolution, request validation, faker-style data, and hot-reload are not supported yet.

#### Stateful mode (`--stateful`)

By default the mock is stateless — every request replays the spec's example.
`--stateful` adds an in-memory CRUD layer on top, so what you POST is what
you GET back:

- `POST /things` **creates**: the stored item is the spec-synthesized base
  merged **under** the request body, plus an `id` (yours if the body has one,
  else a random uuid).
- `GET /things/{id}` returns the stored item; `GET /things` returns
  everything stored, **shaped like the spec's collection envelope** (a
  documented `{ items: [...] }` wrapper is preserved; a bare array stays a
  bare array).
- `PATCH`/`PUT /things/{id}` **merge** the body over the stored item.
- `DELETE /things/{id}` removes it and returns `204`; unknown ids `404`.

**Untouched collections keep serving spec examples** — consumers see no
change until they write. State lives in memory only; restart = clean slate.

#### Stress mode (`--count`) and randomized inputs

`--count N` runs every matched fixture N times. Combined with `--threads`, you get concurrency + volume. When `N > 1` the report adds a stress block per fixture: `p50`, `p95`, `p99`, mean, min, max, plus the status-code distribution. Each result is tagged with its `iter` index so failures point at the offending iteration.

To vary inputs across iterations, use thunks in `input` together with the `random` helper:

```ts
import { random } from "crust/testFixture/random";

const userIds = [1, 2, 3, 4, 5, 6, 7, 8];

export default {
  input: {
    url: () => `http://localhost:3000/users/${random.choice(userIds)}`,
    method: "POST",
    body: () => ({
      name: random.string(8),
      age: random.int(18, 99),
      tier: random.weighted([["free", 7] as const, ["pro", 3] as const]),
      id: random.uuid(),
    }),
  },
  output: { status: (s) => s < 500 },
};
```

```bash
test-fixture --target stress.crust.ts --count 1000 --threads 32 --out report.json
```

Helpers: `random.int(min, max)`, `random.float(min, max)`, `random.bool(p?)`, `random.choice(arr)`, `random.from(iter)`, `random.weighted([[v, w], ...])`, `random.string(len, alphabet?)`, `random.uuid()`, `random.shuffle(arr)`.

### verify-web-links

Crawls a site from its sitemap, verifies every link is reachable, and optionally diffs Open Graph / meta tags against `.crust.ts` fixtures. The site-health counterpart to `test-fixture`. Uses Bun's built-in `HTMLRewriter` for link and social-meta extraction.

```bash
# Direct sitemap
verify-web-links --site-map-url https://example.com/sitemap.xml

# Auto-discover from robots.txt → /sitemap.xml
verify-web-links --base-url https://example.com

# Full SEO sweep: crawl + meta + OG image checks
verify-web-links --base-url https://example.com --fixtures meta/*.crust.ts

# Sitemap-only (no recursion into internal links)
verify-web-links --site-map-url ./public/sitemap.xml --no-recurse
```

Flags: `--site-map-url <url-or-path>` or `--base-url <url>` (one required, mutually exclusive); `--fixtures <glob>` (optional `.crust.ts` meta fixtures); `--concurrency N` (default `4`); `--timeout ms` (default `10000`); `--user-agent <s>`; `--max-depth N` (default `5`); `--no-recurse` / `--no-anchors` / `--no-redirect-warnings` to opt out of those checks; `--include-external` to status-check off-origin links (never recursed); `--exclude <substring>` (repeatable) to skip URLs containing the substring — for subtrees that redirect by design, like a WooCommerce `/checkout/` or `/wp-admin/`; `--json` for a machine-readable report.

By default, all four verification behaviors are on: 2xx status, recurse into internal pages, validate `#fragment` targets against element ids on the destination page, and flag any 3xx redirect chain (often a sign of stale internal links). Each `og:image` URL is fetched and its content-type asserted to start with `image/`.

Meta fixtures use the same `.crust.ts` default-export pattern as `test-fixture`. Predicates (single-arg functions) work on any value:

```ts
// site/about.meta.crust.ts
export default {
  url: "https://example.com/about",
  meta: {
    title: "About Us",
    description: (d: string) => d.length > 50 && d.length < 160,
    "og:title": "About Us",
    "og:image": (u: string) => u.endsWith(".png") || u.endsWith(".jpg"),
    "twitter:card": "summary_large_image",
  },
};
```

```bash
verify-web-links --base-url https://example.com --fixtures site/*.meta.crust.ts
```

Exit codes: `0` all clear, `1` verification failures (broken links, missing anchors, redirect chains, OG image issues, meta mismatches), `2` bad args / unreachable sitemap.

### Built-in functions

Crust ships a small set of `crust.fn`-registered helpers. They work as both pipeline stages (`echo … | base64`) and one-shot sources (`base64 hello`). User-defined `crust.fn(...)` calls in `init.ts` override these by name.

| Function | Usage |
|---|---|
| `base64 [-d \| decode]` | Encode (default) or decode. `echo hi \| base64` → `aGk=`; `echo aGk= \| base64 -d` → `hi`. |
| `salt [bytes] [hex\|base64\|base64url]` | Cryptographically random bytes. Defaults: 16 bytes, hex. `salt 32 base64`. |
| `jwt sign \| verify \| decode --secret <s>` | HS256 JWT. Reads `$JWT_SECRET` if `--secret` omitted. Item can be a JSON string (sign) or a token (verify/decode). |
| `bundle <entry> [--outdir \| --outfile \| --minify \| --sourcemap \| --target=bun\|browser\|node]` | Wraps `Bun.build` for one-shot bundling. With `--outfile`, writes the first artifact and returns `{outfile, bytes}`. |
| `sql "<query>" [params…]` | Runs a SQL query via Bun's SQL client using `$DATABASE_URL`. As a source, **streams one item per row** (the parser flattens Array results from function-as-source). |

Examples:

```bash
echo hello | base64                                  # aGVsbG8=
echo "QmVhcmVy" | base64 -d                          # Bearer
salt 32 base64                                       # random 32-byte token

# Sign + verify a JWT
jwt sign '{"sub":"42"}' --secret k                   # eyJhbGciOiJIUzI1Ni…
echo eyJhbGciOiJIUzI1Ni… | jwt verify --secret k     # { sub: "42" }

# SQL as a streaming source — pipe rows downstream
sql "select id, email from users limit 5" | (r => r.email)

# Bundle in one shot
bundle src/index.ts --outfile dist/app.js --minify
```

Note: function-as-source now **flattens Array return values** — `fn` returning `[a, b, c]` emits three items, not one array. This makes `sql "..."` and similar row-yielding sources compose naturally with downstream lambdas.

---

## Editor keybindings

The line editor runs in raw mode (TTY-only). Reading from a pipe also works — it submits each `\n`-terminated line.

| Key | Action |
|---|---|
| `←` / `→` | Move cursor |
| `↑` / `↓` | History navigation |
| `Home` / `Ctrl-A` | Start of line |
| `End` / `Ctrl-E` | End of line |
| `Backspace` | Delete left |
| `Delete` | Delete right |
| `Ctrl-W` | Delete previous word |
| `Ctrl-U` | Delete to start of line |
| `Ctrl-K` | Delete to end of line |
| `Ctrl-L` | Clear screen |
| `Ctrl-C` | Cancel line, fresh prompt |
| `Ctrl-D` | EOF — exit if line is empty |
| `Tab` | Complete `$PATH` command at start-of-stage, file path elsewhere |
| `Enter` | Submit line |

---

## Configuration (`init.ts`)

Crust loads `~/.config/crust/init.ts` on startup. The default skel registers an alias and shows how to register a custom function:

```ts
declare const crust: {
  alias(name: string, cmd: string): void;
  unalias(name: string): void;
  fn(name: string, handler: (...args: any[]) => any): void;
  prompt?: (cwd: string, gitBranch: string | null) => string;
  onBeforeStart?: () => void | Promise<void>;
  onExit?: (code: number) => void | Promise<void>;
  onSignal(sig: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGUSR1" | "SIGUSR2",
           handler: () => void | Promise<void>): void;
};

crust.alias("ll", "ls -la");
crust.alias("g", "git");

// Custom transforms via crust.fn — see "Custom functions" below.
// crust.fn("wrap", (item, l, r) => `${l}${item}${r}`);

// Custom prompt (overrides defaultPrompt):
// crust.prompt = (cwd, git) => `${cwd}${git ? ` (${git})` : ""} > `;
```

### Lifecycle hooks

Three hooks let `init.ts` react to crust's process lifecycle:

```ts
// Runs after config loads, before the first command.
// In -c mode: before the line. In REPL mode: before the first prompt.
crust.onBeforeStart = async () => {
  console.error(`[crust] session start ${new Date().toISOString()}`);
};

// Runs right before process.exit, with the resolved exit code. Async ok.
// Errors are caught and logged — they do not block exit.
crust.onExit = async (code) => {
  await flushMetrics(code);
};

// Register handlers for OS signals. Multiple handlers per signal are allowed
// and all fire in registration order. The process.on listener is only
// installed on first registration for that signal, so signals you don't opt
// into keep their default disposition (notably: Ctrl-C in the REPL still
// goes through the editor as before).
crust.onSignal("SIGUSR1", () => {
  console.error("reloading config…");
});
crust.onSignal("SIGTERM", async () => {
  await drainQueue();
  process.exit(0);
});
```

Handlers run from the centralized shutdown path, so they fire whether crust exits via `exit N`, Ctrl-D, end of `-c`, or a signal handler that calls `process.exit`.

### Custom functions

Two ways to add new pipeline stages:

**1. Globally-installed npm packages auto-dispatch.** Any package in `~/.bun/install/global` whose default export is a function becomes a stage automatically — no `init.ts` edits needed.

```bash
bun add -g slugify
crust -c 'echo "Hello World" | slugify'         # → hello-world
```

The conventions:

- The shell-line head matches the package name. Scoped packages drop the scope (`@example/cool-pkg` → `cool-pkg`).
- The package's default export (or single named function) is called as `fn(item, ...args)`. Source-position calls (`pkg | …` as the first stage) pass `undefined` as the first arg.
- Packages with a `bin` field are skipped — they continue to behave as shell commands (`prettier foo.ts` still runs the binary). To opt a binary package into stage dispatch anyway, add a `"crust": {}` field to its `package.json`.
- To select a non-default export, add `"crust": { "stage": "exportName" }` to the package's `package.json`.

Cached at `~/.cache/crust/globals.json`; invalidated automatically when the global `package.json` changes.

**2. `crust.fn(name, handler)` in `init.ts`** — for packages whose API doesn't fit the calling convention (anything with method-dispatch like chalk, anything that needs setup), and for ad-hoc helpers:

```ts
import chalk from "chalk";
crust.fn("red", (text: string) => chalk.red(text));
// Then in the shell:  echo "warning" | red

crust.fn("wrap", (item, l, r) => `${l}${item}${r}`);
// Then in the shell:  echo hi | wrap [ ]
```

The signature is `(item, ...staticArgs)` — static args come from the shell-line tokens after the function name. Explicit `crust.fn` registrations always beat auto-dispatch.

---

## Examples

### API smoke test against a local server

```bash
read fixtures/*.json | POST :3000/users | expect 201
```

(`read` yields each file's **contents** — a bare `fixtures/*.json` glob would
POST the path strings. For a whole suite of lines like this, put them in a
`.pipes` file and run [test-pipes](#test-pipes).)

### Health-check spam

In a `.ts` file (run with `bun script.ts`):

```ts
await range(0, 999)
  .pipe(parallel(50, () => fetch("http://localhost:3000/health")))
  .pipe(expectStage(200))
  .to(stats());
```

### Log mining

```bash
**/*.log | grep ERROR | wc -l
```

### Build artifacts (using a globally-installed bundler via init.ts)

```ts
// in ~/.config/crust/init.ts
import { build } from "esbuild";
crust.fn("bundle", async (entry: string) => {
  await build({ entryPoints: [entry], bundle: true, outfile: "dist/app.js" });
  return "dist/app.js";
});
```

Then directly at the shell line:

```bash
echo src/index.ts | bundle
```

---

## Limits in v0.1

Honest about what doesn't work yet:

- **No job control.** No `Ctrl-Z`, no `fg`/`bg`, no `&` background jobs.
- **No multi-line input / heredocs.**
- **No `$(...)` substitution across stages.** Within a single shell stage it works (delegated to `sh`).
- **No `|>` operator and no `[0..9]` range literal.** Need a Bun loader; v0.2.
- **No syntax highlighting in the editor.** v0.1.5.
- **No fuzzy history search (Ctrl-R).** v0.2.

See `docs/spec/v0.1-contract.md` for the green-light test contract and `docs/PLAN.md` for the design notes.

---

## Reporting issues

Bugs, unexpected behaviour, or feature requests: open an issue at [github.com/lariocpt/crust/issues](https://github.com/lariocpt/crust/issues).
