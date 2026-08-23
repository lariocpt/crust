# crust — usage

A pipeline-first devops toolkit built on Bun. Shell commands, TypeScript lambdas, HTTP verbs, globs, and parallel workers all compose under one `|` / `.pipe()` model; the mock server, fixture runners, and load pipelines are builtins on that same stream. v0.2.

**Mental model:** every crust line is an inline JavaScript global-scope script run in Bun. Whether it arrives from the REPL, `crust -c`, piped stdin, or a `.crust` file, the line runs in a Bun context where `Pipeline`, `range`, `GET`/`POST`, `parallel`, `$` (Bun.$), and anything you registered in `~/.config/crust/init.ts` are globals. Shell commands and TS lambdas are equal citizens; both are stages on the same pipeline.

## Contents

- [Install](#install)
- [Hello world](#hello-world)
- [One-liners, scripts, and stdin](#one-liners-scripts-and-stdin)
- [The Pipeline model](#the-pipeline-model)
- [Shell-line syntax](#shell-line-syntax)
- [CI gates: thresholds, baselines, exit codes](#ci-gates-thresholds-baselines-exit-codes)
- [Shorthand fixture grammar](#shorthand-fixture-grammar)
- [TypeScript API](#typescript-api)
- [Builtins](#builtins)
- [test-fixture](#test-fixture)
- [test-pipes](#test-pipes)
- [gen-fixtures](#gen-fixtures)
- [mock-server](#mock-server)
- [verify-web-links](#verify-web-links)
- [logs — interactive log searching](#logs--interactive-log-searching)
- [Editor keybindings](#editor-keybindings)
- [Configuration (`init.ts`)](#configuration-initts)
- [Examples](#examples)
- [Limits in v0.2](#limits-in-v02)

---

## Install

Either channel resolves the same prebuilt binary and verifies its published
sha256 before it is ever executable:

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
npm i -g @lariocpt/crust
```

Prebuilt binaries cover linux and macOS on x64 and arm64; on anything else,
build from source with `scripts/install-from-source.sh`. (Internal LAN
channels are documented in [docs/INTERNAL.md](INTERNAL.md).)

Then launch `crust` for the REPL — or skip straight to
[one-liners and scripts](#one-liners-scripts-and-stdin) and call it from bash/zsh/fish; crust is
not a login shell and doesn't want to be one.

## One-liners, scripts, and stdin

Crust is designed to be called from bash/zsh/fish for the one-liners where its pipeline syntax wins — and the same fail-fast runner powers `.crust` script files and piped stdin:

```bash
crust -c 'range(0,99) | parallel 20 | GET :3000/health | expect 200 | stats'
crust -c 'ls *.json | (s => JSON.parse(await Bun.file(s).text())) | (j => j.id)'
crust -c 'src/**/*.ts | wc -l'
```

`-c` runs the line through the full pipeline parser and exits with the line's status. Your `~/.config/crust/init.ts` is still loaded, so any `crust.fn(...)` registrations are available.

| Flag | Effect |
|---|---|
| `crust` | Interactive REPL (default, when stdin is a TTY). |
| `crust <file.crust>` | Run a script file and exit. Blank lines and `#` comments are skipped (so a `#!/usr/bin/env crust` shebang works), and execution is **fail-fast**: crust stops at the first failing line and exits with *its* code. Positional script arguments are not supported — extra arguments are rejected (exit 2). An unreadable file exits 127. |
| `cmd \| crust` | With stdin piped, crust reads it to EOF and runs the lines exactly like a script file — same comment handling, same fail-fast exit codes. Because stdin is drained up front, shell stages inside the script see EOF on their stdin. Piping **data** (not a program) is the [`stdin` source](#reading-piped-stdin-stdin-source)'s job: `docker logs -f app \| crust -c 'stdin \| grep ERROR'`. |
| `crust -c <line>` | Run one line and exit. Multi-line strings split on `\n`, skip blanks and `#` comments, and are **fail-fast**: crust stops at the first failing line and exits with *its* code (previously a later success masked an earlier failure). |
| `crust -h`, `--help` | Show usage. |
| `crust -V`, `--version` | Show version. |

### Checking a line without running it

`crust --check '<line>'` parses and exits — 0 if every line parses, 1 with the
parse error otherwise. It builds the pipeline but never drains it, and every
source is lazy, so nothing is opened, fetched or spawned:

```bash
crust --check 'range(0,999) | parallel 50 | GET :3000/health | expect 200 | stats'
# ok: 1 line(s) parse

crust --check 'read /nonexistent/*.json | POST :3000/x'   # still ok — no I/O happens
crust --check 'time warmup | range(1,3)'
# crust: time: the label must be quoted — did you mean `time "warmup"`?
```

It also validates BUILTIN invocations against each CLI's own flag spec, so
`crust --check 'test-pipes --bogus x'` and a `mock-server` with no spec both
fail — the parser alone treats a builtin line as an opaque shell stage and would
call either one fine.

That makes it the linter for documented examples: blank lines and `#` comments
are skipped, so a whole fenced block can be piped in as one argument. crust's
own suite lints every ```crust example in the shipped agent skills this way.

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
| **Transform** | Stream-in, stream-out | shell command, `(x => …)`, `filter (x => …)`, `POST <url>` |
| **Sink** | Stream-in, value-out | stdout (default), `write`, `dest` |

The shell parser classifies each `|`-separated stage by looking at its first token:

| Trigger | Stage kind |
|---|---|
| Contains `*` / `?` / `[…]` | Glob source |
| Matches `range(a, b)` | Range source |
| Matches `load <dur> <rate>[, …]` | Paced load source (malformed spec = hard error; bare `load` = shell) |
| Starts with `{` or `[` | JSON-literal source (invalid JSON = hard error, never shell) |
| Starts with `read <path\|glob>` | Whole-file source — one item per matched file |
| Starts with `tail <path>` (with optional `-F` / `-n N`) | Native `tail` source |
| Starts with `(` and contains `=>` | TypeScript lambda |
| Starts with `assert (` | Assert stage — falsy or empty upstream fails the pipeline |
| Starts with `filter (` | Filter stage — keeps items whose predicate is truthy; falsy items (`0`, `""`, `null`…) are dropped, async predicates awaited, an empty result passes silently |
| Matches `capture NAME [(fn)]` | Capture stage — writes `process.env.NAME` for later lines |
| Matches `expect NNN` or `expect Nxx` | Expect stage — status equality or class (`2xx`…`5xx`) |
| Matches `stats [--every N] [--out f.json]` | Stats stage (unknown flags fall through to shell) |
| Starts with `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | HTTP stage (`-H` headers, `--timeout <dur>`, `$VAR` expansion, `:port` shorthand; unknown `--flags` are errors) |
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
**/*.ts                           # glob — Pipeline<string> of paths, SORTED
src/*.{ts,tsx}                    # globs support **/*, ?, [abc]
tail app.log                      # last 10 lines, then done — Pipeline<string>
tail -n 100 app.log               # custom line count
tail -F app.log                   # follow mode: stream new lines forever
GET https://api.example.com/  # → Pipeline<Response> (single item)
GET :3000/health                  # localhost shorthand
GET localhost:3000/health         # bare host[:port] — http:// is assumed
GET example.com/status            # …as is a bare hostname
# Unknown flags are an ERROR, single-dash included: `-t 2s` is not `--timeout 2s`,
# and a curl-style lowercase `-h` is not `-H`. Only -H and --timeout are accepted.
read fixtures/*.json              # whole-file contents, ONE item per file
lines app.log                     # one item per LINE — what you usually want
lines **/*.log                    # across every match, sorted
{"name": "Court"}                 # JSON literal — one parsed item (the request body)
procs({web: "bun run dev", api: "bun api.ts"})   # merge long-lived processes
load 30s 100/s                    # paced ticks: 100/s for 30s (load runs)
load 10s 50/s, 30s 200/s          # ramp: comma-separated phases, one stream
stdin                             # piped stdin, line by line (alias: -)
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

`load <dur> <rate>` yields one tick per scheduled slot — durations in
`ms`/`s`/`m`, rates as `N/s` or `N/m` (decimals allowed). Slots are anchored
to absolute times, so pacing doesn't drift, and each phase ends on its
wall-clock regardless of how many ticks got out. When downstream can't keep
up (the `parallel` pool is saturated), stale slots are **skipped, never
burst**, counted, and reported to stderr on drain:

```
load: target 3000 ticks — emitted 2868, dropped 132 (downstream saturated; raise parallel N?), achieved 95.6/s
```

`stats.rps` is always the **measured** rate — crust structurally cannot
report a target rate it didn't sustain (the classic coordinated-omission
trap). Ticks are `{n, phase, scheduledAt, lagMs}` objects, so a body-builder
lambda gets real material: `load 10s 20/s | (t => ({name: "user" + t.n})) |
parallel 8 | POST :3000/users`.

Each wakeup emits **every due slot** (a batch), so the generator itself no
longer caps the rate — 5000/s tick emission is verified in the suite; the
sustained request rate is bounded by downstream (`parallel` pool size ×
service time), not by pacing. A due slot is dropped only when consumer
backpressure let it go stale beyond `maxLagMs` (default 1s; TS API
`load(phases, {maxLagMs})`) or the phase clock ran out — catch-up of due
slots is the schedule, never a burst beyond it. Still single-process CI
smoke-load and soak tooling, not a distributed load rig.

`procs({name: "command", …})` spawns each command and streams
`{ proc, stream, line }` for every stdout/stderr line (plus an `exit`
marker), merged as lines arrive — the "one dev tail" source. Children are
killed when the pipeline ends or crust gets SIGINT/SIGTERM — and at the
REPL, `Ctrl-C` on a running `procs` line delivers exactly that: the whole
process group is torn down (SIGTERM, then SIGKILL for stragglers) and the
prompt comes back.

A spec value can also be an object — `{cmd, env?, restart?, ready?, after?}`:

```bash
procs({
  db:  {cmd: "docker compose up pg", ready: "port:5432"},
  api: {cmd: "bun api.ts", after: "db", ready: ":3001/health", restart: {max: 3}},
  web: {cmd: "bun run dev", after: "api", env: {PORT: "3001"}}
})
```

- `env` — extra env for THAT process, merged over the inherited environment.
- `restart: true` — respawn on unexpected exit, with backoff starting at
  250ms and doubling to a 2s cap (a `restarting in Nms` line is emitted on
  the `exit` stream). A **user kill** (Ctrl-C / SIGTERM) never respawns.
  `restart: {max: N}` gives up after N consecutive restarts with a
  `giving up after N restart(s)` line; a stretch of >10s uptime **while
  ready** resets the counter (it guards against crash *loops*, not against
  ever crashing twice; procs without `ready:` count as ready at spawn — a
  proc that hangs un-ready until its ready-timeout kill never resets it).
- `ready` — a readiness probe: `":3001/health"` / `"http(s)://…"` (ready =
  any 2xx) or `"port:5432"` (ready = TCP connect succeeds). Long form
  `{url?, port?, timeoutMs?, intervalMs?, probeTimeoutMs?}` (defaults 30s /
  250ms; each probe is capped at `min(intervalMs*4, 2s)` unless
  `probeTimeoutMs` raises it — needed for health endpoints that take >2s to
  first byte). Probe progress is reported on a `ready` stream
  (`ready after 120ms (…)`). On
  timeout, a restartable proc is killed and respawned (readiness is
  re-awaited after every restart); a non-restartable one fails the whole
  pipeline — CI semantics.
- `after` — a name or list of names that must be **ready** before this proc
  spawns (procs without `ready:` count as ready once spawned). Gating is
  one-shot: a dependency restarting later never re-blocks a dependent, but a
  dependency that dies or gives up before ever becoming ready fails the
  pipeline with `dependency "<name>" exited before becoming ready`. Unknown
  names, self-dependencies, and cycles throw before anything spawns.

Children are spawned in their own process group and the whole group is
SIGTERM'd on teardown, escalating to SIGKILL after 3s — grandchildren
(a dev server spawned by `sh -c`, say) don't outlive the pipeline. The same
escalation runs on Ctrl-C and on a ready-timeout kill, so a child that
ignores SIGTERM can't wedge the shutdown or the restart loop.

> **`read` yields files, `lines` yields lines.** They print identically on a
> terminal, so the difference is invisible until a downstream stage sees it:
> `read app.log | filter (l => l.includes('ERR'))` hands the predicate the
> **entire file** as one string, so it matches if *any* line matches. `grep`
> hides this because it splits multi-line items internally — which is why
> `read **/*.log | grep ERROR | filter (…)` works and swapping the last two
> stages silently does not. Use `lines` when you want lines; keep `read` for
> `read fixtures/*.json | POST …`, where whole-file items are the request
> bodies. Bare `lines` mid-pipeline splits whatever is upstream:
> `read f.json | lines`.

### Transforms

```bash
… | grep TODO                              # native line-buffered grep (fancier flags → sh)
… | (line => line.toUpperCase())           # TS lambda (maps every item)
… | filter (line => line.includes('ERR'))  # keep items whose predicate is truthy
… | tr '[:lower:]' '[:upper:]'             # standard pipes work
… | POST :3000/users                       # per-item HTTP POST (body = item)
… | DELETE :3000/users/:id                 # per-item DELETE
… | GET :3000/health                       # per-item timed GET (item = trigger)
… | POST $BASE/api/things -H "authorization: Bearer $TOKEN"   # headers + env vars
```

Three lambda-shaped stages, three different jobs — pick by what a falsy
result should mean:

| Stage | Falsy result means | Empty upstream |
|---|---|---|
| `(x => …)` | nothing special — the value is emitted as-is (a plain lambda **maps**, it never drops) | passes |
| `filter (x => …)` | the item is **dropped** (plain JS truthiness: `0`, `""`, `null`, `undefined` all drop) | passes |
| `assert (x => …)` | the **pipeline fails** naming the item | **fails** |

Async predicates are awaited in all three.

**Shell stages see `node_modules/.bin` on PATH, npm-run style.** Every
ancestor `node_modules/.bin` of the current directory is prepended
(nearest first) for shell stages, pure shell lines, `logs` shell sources,
and `procs` children — so locally-installed tool binaries work bare:
`… | pino-pretty --colorize`, `… | tsc --noEmit`, no
`node_modules/.bin/` prefix. Computed per spawn, so `cd` is respected.
Same trust model (and same shadowing caveat) as `npm run`/`bun run`: a
project's `node_modules/.bin` entry takes precedence over a system binary
of the same name while you're inside that project. Use an absolute path
when that matters.

**`grep` mid-pipeline is native and line-buffered.** GNU grep block-buffers
~4KB when writing into a pipe, which used to stall `tail -F app.log | grep
ERROR` until enough matches accumulated. The safe subset now runs as a
native stage that emits each match immediately:

```bash
tail -F app.log | grep ERROR               # streams matches as they happen
range(1, 20) | (n => `item-${n}`) | grep 'item-1[0-9]'
… | grep -i error                          # case-insensitive
… | grep -v healthcheck                    # invert
… | grep -F "a.b"                          # fixed string, no regex
```

Native handles `-i`, `-v`, `-F`, `-E` (a no-op — JS regexes are ERE-shaped)
with exactly **one** pattern argument. Matching is per LINE on the same
formatted text a shell grep received: multi-line items (`read` whole-file
contents) are split at their newlines and the matching lines are emitted,
so `read app.log | grep -v ERROR` behaves exactly like the sh pipe did.
> **Exit-code difference worth knowing.** The native stage is a *stream
> filter*: matching nothing yields nothing and the line still exits 0. A stage
> that falls through to `grep(1)` is a real process, and since v0.2 a shell
> stage's nonzero exit becomes the line's exit code — so `… | grep -x nope`
> (unsupported flag → `sh`) exits 1 on no match while `… | grep nope` (native)
> exits 0. Assert on the data if you need a gate: `… | grep ERROR | stats |
> assert (s => s.count === 0)`.

Everything else keeps exact `grep` semantics via `sh`: bare `grep` or
flags with no pattern, combined or unknown flags (`-iv`, `-c`, `--color`),
`-F` together with `-E` (grep's own error), two positionals (that's a file
grep), any `$` in the stage (env expansion is sh's job), and — for regex
patterns (a `-F` literal needs none of this) — backslash escapes, POSIX
classes (`[[:digit:]]`), GNU open intervals (`{,5}`), `(?`-groups, and
anything JS's regex engine rejects (`*.log`). Pure shell lines
(`ps aux | grep node`) and first-stage grep (`grep ERROR app.log`) always
use the system binary, byte-for-byte. Two divergences to know: a quoted
`'a|b'` pattern alternates (ERE) where plain BRE grep matched the literal
`a|b` — write `grep -F 'a|b'` for the literal — and lines containing NUL
bytes are matched and passed through raw where GNU grep would suppress
them with "binary file matches".

`GET` as a transform fires one request per upstream item and yields
`{ status, ms, url }` timing records (bodies are drained, not kept) — pair it
with `parallel` and `stats` for load pipelines.

Every http verb stage accepts repeatable `-H "Key: value"` header flags
(quote them — values may contain spaces and colons). The **whole** raw `-H`
string is `$VAR`/`${VAR}` env-expanded before the `Key: value` split, so one
variable can carry a complete header line (`-H "$AUTH_HEADER"`). URLs are
expanded too, and the `:port/path` localhost shorthand works for **all**
verbs, source or transform.

**The `parallel` modifier puts any http verb in load mode**: output becomes
`{status, ms, url}` timing records, response bodies are drained, and a
network error yields a `status: 0` record instead of killing the run. That
includes `parallel 1 | POST …` — the explicit opt-in for serial-but-timed.
Without `parallel`, non-GET verbs keep yielding real `Response` objects
(`{…} | POST :3000/users | (r => r.json())` still works).

**`--timeout <dur>`** (durations `ms`/`s`/`m`, e.g. `--timeout 2s`) bounds
every request the stage makes — a hung upstream can no longer stall a load
run or a `.pipes` line. On timed stages (GET, any verb under `parallel`) a
timeout yields `{status: 0, timedOut: true, …}` — it shows in the stats
histogram and fails `expect`, and the `timedOut` flag distinguishes it from
a connection refusal. On plain verb stages and source `GET` a timeout fails
the pipeline with `<VERB> <url>: timed out after <ms>ms`. A TS-API
caller-supplied `signal` always wins. This is per-REQUEST, unlike
`test-fixture`/`test-pipes` `--timeout` (integer ms, per fixture/line).
Typo'd `--flags` on http stages are loud errors (they used to be silently
ignored).

HTTP transforms auto-set `content-type: application/json` for object items. String items are sent as text. `Buffer`/`Uint8Array` go raw.

### Assertions & concurrency

```bash
range(0, 999) | parallel 50 | GET :3000/health | expect 200 | stats
sql "SELECT count(*)::int AS c FROM users" | assert (r => r.c === 1)
load 60s 25/s | parallel 25 | GET :3000/health | stats --every 5
{"n":"x"} | POST :3000/things | (r => r.json()) | capture THING_ID (t => t.id)
```

- `parallel N` — sets the fan-out for the NEXT stage (it is a modifier, not a
  buffering stage). It applies to http verbs (load mode — see above), TS
  lambdas, and registered functions (`parallel 4 | sql "…"`); putting it
  before any other stage kind, or leaving it trailing, is a **parse error**
  (it used to be silently ignored). **Results stream in COMPLETION order,
  not input order** — a deliberate contract so downstream windowed stats see
  a live stream instead of a final-millisecond dump. If you need input
  order, sort downstream.
- `expect NNN` / `expect Nxx` — passes items through; when the stream drains,
  fails the pipeline (exit 1) naming the mismatch count if any item's
  `status` didn't match the code or class (`2xx` = 200–299). Items with no
  numeric `status` count as mismatches.
- `assert (x => expr)` — per-item predicate; a **falsy** result fails the
  pipeline naming the item. Unlike a plain lambda (which maps), unlike
  `filter` (which drops), and unlike `expect`, an **empty upstream also
  fails** ("no items reached") — the sql-returned-zero-rows silent pass is
  exactly the trap this closes. Async predicates are awaited, so
  `assert (async s => …)` can read files or hit the DB.
- `capture NAME (fn)` — runs `fn` on each item and writes the result to
  `process.env.NAME` (last item wins; omit the lambda to capture the item
  itself — objects are JSON-stringified). Items pass through unchanged.
  Because crust parses each line right before running it, **every later line
  sees `$NAME`** — in the REPL, in `-c` scripts, and in `.pipes` files. A
  nullish captured value or an empty upstream fails the pipeline
  immediately: a capture that silently captured nothing turns into a
  baffling `""` expansion three lines later. Mind the names: capturing into
  `TOKEN`, `BASE`, or `PATH` overwrites those for the rest of the run.
- `stats` — consumes the stream and yields one summary: `count`, `wallMs`,
  `rps`, a status histogram, and real `p50/p95/p99/meanMs` latency
  percentiles from the timed-request records.
- `stats --every N` — additionally emits a **per-window delta summary** every
  N seconds (`{window: 1, …}`, `{window: 2, …}`) and finishes with one
  cumulative summary tagged `{final: true}`. Windows flush on the item path —
  a fully stalled upstream delays the next window until an item arrives.
  Because `parallel` streams in completion order, a slow request lands in
  the window it *finished* in; `ms` values are true durations, so the
  percentiles stay honest.
- `stats --out results.json` — also writes the run to a versioned JSON
  artifact: `{crustStats: 1, startedAt, urls, summary, windows?}` where
  `summary` is exactly the stdout summary object. The file is written
  **before** the final summary is yielded, so a downstream threshold gate
  that fails the pipeline still leaves the artifact behind for CI upload.
  The path is env-expanded (`--out $RUN_DIR/health.json`); only `.json` is
  supported.

### CI gates: thresholds, baselines, exit codes

`stats` yields plain objects, and `assert` awaits real JS predicates — so
thresholds are just composition, no special syntax:

```bash
load 30s 100/s | parallel 50 | GET :3000/health | stats \
  | assert (s => s.p95 < 200) \
  | assert (s => s.rps > 80)
```

Chain **one assert per threshold**: the failure message names the exact
predicate and prints the actual summary —
`assert: item 1 failed (s => s.p95 < 200) — got {"count":3000,…,"p95":312.4,…}` —
and the line exits 1, which `crust -c` propagates (it stops at the first
failing line).

**What makes a line fail.** As of v0.2 the gate is honest in three more places
that used to exit 0:

| Situation | Exit |
|---|---|
| An `assert` predicate returned falsy, or its upstream was empty | `1` |
| An `expect` found mismatched statuses at drain | `1` |
| A stage's lambda **threw** — including under `parallel N` | `1` |
| `assert` was handed an **empty** `stats` summary (0 items measured) | `1` |
| An http stage got an unknown flag, including single-dash (`-t`, `-h`) | `1` |
| A spawned shell stage exited nonzero (`\| tee bad/path`, `\| false`) | that code |
| A fixture's `output` names an unknown key (`data` misspelled) | `1` |
| Multi-line `-c`: any line fails | that line's code — fail-fast |
| Builtin runners: bad args / no files matched | `2` |

Before v0.2 a lambda that threw under `parallel` was silently dropped — an
entire load run whose handler always threw reported success — and a failing
shell stage mid-pipeline was discarded outright. A child that exits early
after closing the pipe (`\| head -3`) is still exit 0, as it should be.

**A gate that measured nothing is not a pass.** `stats` over an empty stream
emits `{"count": 0, …, "empty": true}` and `assert` refuses it, because
`{count: 0, p95: 0}` satisfies `s => s.p95 < 200` — so a run that issued zero
requests (a glob that matched nothing, a filter that dropped everything, a
server never reached) used to report success. A bare `… | stats` with no
assertion still prints the tagged summary and exits 0, so exploring stays cheap.

**Percentiles are bucketed, not exact order statistics.** `stats` keeps a fixed
histogram rather than every sample: memory is constant regardless of run length,
`p50/p95/p99` are accurate to within a bucket (0.1ms below 100ms, 1ms below 1s),
and the reported value is the bucket's upper bound — never faster than reality.
`meanMs` and `count` remain exact. Retaining every sample cost ~124MB at 3.6M
requests and made each `--every` window re-sort the cumulative array, which
blocked the load client itself for up to 1.6s per window on a long soak.

**Baselines.** `--out` writes the artifact; an async assert reads it back.
The "worse than 2× baseline p95 is a failure" gate is one line:

```bash
load 10s 100/s | parallel 50 | GET :3000/health | stats --out load/last.json \
  | assert (async s => { const b = await Bun.file("load/baseline.json").json(); return s.p95 < 2 * b.summary.p95 })
```

**Soak gating with `--every`.** A bare predicate runs against every window
object AND the final summary — fail-fast the moment a window degrades. Guard
with the tag keys to scope it:

```bash
… | stats --every 5 | assert (s => !s.window || s.p95 < 400)   # windows only
… | stats --every 5 | assert (s => !s.final  || s.p95 < 200)   # final only
```

Both guards are also correct without `--every` (the plain summary carries
neither key, so the threshold applies).

**Warmup** is a separate line in the same `-c` script — its summary simply
isn't gated:

```bash
crust -c 'range(0, 99) | parallel 10 | GET :3000/health | stats
load 30s 100/s | parallel 50 | GET :3000/health | stats | assert (s => s.p95 < 200)'
```

**Ordering trap:** in `… | expect 200 | stats | assert (…)`, a failing
`expect` throws at drain — *before* `stats` emits — so you lose the summary.
Either gate status inside the predicate (`s.status["200"] === s.count`) or
accept that a hard expect failure hides the stats.

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

The initial `-n N` cut is a **bounded read**: crust scans backward from the
end of the file in 64KB blocks to find where the last-N-lines window starts
and reads only that window — `tail -n 10` on a multi-GB log reads a few KB,
and `tail -n 0 -F` reads nothing at all before following.

Polling interval is 200ms by default. From the TS API: `tail(paths, { lines, follow, pollMs })` where `paths` is a string or string[] (globs expanded automatically) — see [TypeScript API](#typescript-api).

### Reading piped stdin (`stdin` source)

`stdin` (alias `-`) in source position streams whatever is piped into crust,
line by line — the bridge between any Unix command and the pipeline grammar:

```bash
docker logs -f my-app | crust -c 'stdin | grep ERROR'
docker logs -f my-app | crust -c 'stdin | (l => JSON.parse(l)) | filter (e => e.level >= 40) | (e => e.msg)'
journalctl -f -o json | crust -c 'stdin | (l => JSON.parse(l)) | filter (e => e.PRIORITY <= 3) | (e => e.MESSAGE)'
kubectl get pods -o name | crust -c 'stdin | (p => p.replace("pod/", ""))'
```

A trailing line without a final newline is still emitted — as a full item,
so the printed output gains a terminating `\n` the raw input lacked (items
are lines; byte-exact passthrough is `cat`'s job, not a line pipeline's).
`stdin` is only a source — mid-pipeline it errors.

**The bare-pipe trap:** `cmd | crust` (no `-c`, no script file) treats piped
stdin as **lines to run** — it reads to EOF first, so `docker logs -f app |
crust` would sit forever consuming an endless "script". When the pipe
carries *data*, pass the program via `-c` (or a script file) as above; crust
detects the already-drained pipe and says so instead of hanging. On a TTY
with nothing piped, `stdin` errors immediately.

### Builtins

```bash
# shell
cd <dir>          # cd, cd -, cd ~, cd ~/path
export FOO=bar    # set env var
alias g=git       # define alias (also: alias g='git status')
alias             # list aliases
unalias g
source <file>     # .ts/.js imported; anything else runs line-by-line in this session
history           # list this session's lines
exit [code]
help

# tools (each takes its primary argument positionally)
dotenv [<path>]                 # load a .env into the session
test-fixture <glob> [-j N]      # run .crust.ts HTTP fixtures
test-pipes <glob> [-b]          # run .pipes suites
gen-fixtures <spec>             # derive negative-case fixtures from an OpenAPI spec
mock-server <spec> [-p N]       # serve an OpenAPI spec
verify-web-links <url|sitemap>  # crawl a site for broken links, anchors, meta
logs <source>                   # interactive log search over a held stream
skills <list|install>           # install the embedded agent skills
```

Builtins run in-process. They dispatch when the first token matches a builtin
name **and** the line has no *unquoted* pipe (`|`), redirect (`<`, `>`), or
sequencing (`&`, `;`) operator. Quoted ones are fine, which is what makes
`export DB='postgres://h/d?a=1&b=2'` and `alias two='a | b'` work — before the
gate understood quotes, both silently did nothing and exited 0.

---

## Shorthand fixture grammar

One shell line can now be a complete HTTP fixture — body, auth header, and
assertion. This is what [test-pipes](#test-pipes) runs from `.pipes` files,
and it works identically at the prompt and in `crust -c`:

```bash
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
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
  fails**. `expect NNN` / `expect Nxx` stays the status assertion; `assert`
  is for everything else (DB rows, parsed bodies).
- **`capture NAME (fn)`** — the chaining primitive: write a value from this
  line into `process.env.NAME` so `$NAME` expands on every later line.
  Captures happen at **run** time; `$VAR` expansion happens at **parse**
  time — which is why chaining works *across* lines but never within one.
- **`:port/path`** — localhost shorthand, all verbs, source or transform.
- **GET dual role** — first stage: one `Response` item (fixture asserts);
  mid-pipeline: per-item timed `{status, ms, url}` records (load).

### Where `$VAR` expands

`$VAR` / `${VAR}` come from `process.env`; missing vars become the empty
string. Expansion is **opt-in per position** — crust expands exactly:

| Position | Expanded? |
|---|---|
| URLs (all http verbs) | yes |
| `-H` header strings (name and value) | yes — one `$VAR` can hold the whole header line |
| JSON-literal sources | yes |
| `stats --out` paths | yes |
| Registered-fn args (`sql "…" "$RUN_ID"`) | yes — SQL positionals `$1`/`$2` survive (a digit can't start an env var name) |
| Lambda / `assert` / `capture` bodies | **no** — they're JS; use `process.env.TOKEN` |
| Shell stages | untouched — `sh` does its own expansion |

---

## TypeScript API

The full pipeline surface is available to any `.ts` file run by Bun, including `~/.config/crust/init.ts`. Crust exposes these as globals when starting up:

```ts
Pipeline             // class — the unified stream abstraction
range(start, end)    // source
glob(pattern)        // source
read(path)           // source — Pipeline<string> of lines
readLines(pattern)   // source — lines across every match (the shell's `lines`)
readAll(pattern)     // source — whole-file contents, one item per matched file
                     // (the shell line's `read <glob>`)
tail(paths, opts?)   // source — string | string[]; globs expanded; multi-file merges
procs(spec)          // source — merged child-process streams (the shell's `procs`)
GET(url, opts?)      // source
POST(url, opts?)     // transform: Pipeline<T> → Pipeline<Response>
PUT, PATCH, DELETE   // same shape as POST
expectStage(matcher) // transform — fails the pipeline on mismatch
parallel(n, fn)      // transform — N concurrent workers, COMPLETION order
load(phases, opts?)  // source — paced LoadTick stream (the shell's `load`)
timedGet(url, opts?)          // per-item fn — timed GET → {status, ms, url}
timedHttpItem(m, url, opts?)  // per-item fn — timed any-verb, body = item
statsStage(everySec?, out?)   // transform — the shell's `stats`
captureEnv(name, fn?)         // transform — the shell's `capture`
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
```

(The old `stats()` sink is gone — it reported fabricated zero percentiles.
Use `statsStage()` in a `.pipe()` chain instead:
`load([{durMs: 10_000, rps: 100}]).pipe(parallel(50, timedGet(url))).pipe(statsStage())`.)

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
| `alias name='cmd'` | Adds an alias. Bare `alias` lists. Quotes optional. Expands at the head of **every stage**, so `range(0,99) \| parallel 50 \| hc` resolves `hc`. Single pass — an expansion is not rescanned, so `alias ls='ls -la'` terminates. |
| `unalias name` | Removes an alias. |
| `source file` | `.ts`/`.js`/`.mjs` dynamically imported; anything else (`.crust`) runs line-by-line through the crust parser **in this session** — aliases, `export`s, and `capture`s persist. To run a bash script, run it with `sh` instead. |
| `history` | Numbered list of this session's lines. Persistent at `~/.local/share/crust/history`. |
| `dotenv [<path>] [-a]` | Loads `.env` files into the session. Tracks history, supports `dotenv status` and `dotenv clear`. See [dotenv](#dotenv). |
| `test-fixture <glob> [-o p] [-j N] [-n N] [-t ms] [-b]` | Runs `.crust.ts` HTTP fixtures. See [test-fixture](#test-fixture). |
| `test-pipes <glob> [-b] [-t ms] [-s m]` | Runs `.pipes` files — one shorthand fixture pipeline per line. See [test-pipes](#test-pipes). |
| `gen-fixtures <spec> [-o d] [-s m] [--no-flows]` | Generates negative-case `.crust.ts` fixtures and CRUD flow `.pipes` suites from an OpenAPI spec. See [gen-fixtures](#gen-fixtures). |
| `mock-server <spec> [-p N] [-b addr] [--stateful] [--state <path\|url>] [--seed <file>] [--validate] [--strict] [--proxy <upstream>]` | Boots a `Bun.serve` instance that mocks every operation in an OpenAPI 3.x spec; `--stateful` adds a CRUD layer, `--state` persists it to sqlite/postgres, `--seed` inserts boot data, `--validate` rejects spec-violating requests with 422, `--strict` also enforces literal `additionalProperties: false`, `--proxy` turns it into a validation proxy in front of a real upstream. See [mock-server](#mock-server). |
| `verify-web-links <url\|sitemap> [-c N] [-t ms] [--fixtures g] [--exclude s]` | Crawls a site from its sitemap (or auto-discovers one from a base URL), verifying every link, anchor and redirect, and diffs Open Graph/meta tags against fixtures. See [verify-web-links](#verify-web-links). |
| `skills <list\|install> [--global] [--force]` | Claude agent skills shipped in the binary. See [Agent skills](#agent-skills). |
| `logs [--buffer N] <source>` | Interactive log searcher: holds a `tail -F`/`procs(...)`/shell-command stream, buffers the last N items, and every typed line is a pipeline fragment run over the buffer then live. See [logs](#logs--interactive-log-searching). |
| `exit [code]` | Exits crust with optional code (default 0). |
| `help` | Lists builtins. |

### Agent skills

Crust ships Claude-agent skills — SKILL.md guides that teach a coding agent
how to drive crust's pipelines, tests, mocks, load runs, and process
tooling. They're embedded in the binary and installed per project:

```bash
skills list                 # what's embedded, with descriptions
skills install              # write to ./.claude/skills/<name>/SKILL.md
skills install --global     # write to ~/.claude/skills/ instead
skills install --force      # overwrite locally-edited copies
```

Install is idempotent; a file you've edited locally is refused without
`--force`. Every example line inside the skills is checked against the live
grammar by the test suite, so they can't silently rot. Exit codes: `0` ok,
`1` refused overwrites, `2` bad args.

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

Supported `.env` syntax: `KEY=value`, `KEY="quoted value"`, `KEY='single quoted'`, leading `export` prefix, `#` comments (whole-line and trailing on unquoted values). Multi-line quoted values and `$FOO` interpolation are not supported in v0.2.

### test-fixture

Runs `.crust.ts` fixture files against an HTTP service. Each file is a normal TypeScript module that default-exports a fixture (or array of fixtures) with `input` and `output` objects. Fields can be values *or* zero-argument functions (resolved + awaited at run time). In `output`, a function with at least one parameter is treated as a predicate matcher over the actual value.

**`output.schema`**: give it a JSON Schema and the response body must
conform. Violations fail the fixture with per-field pointer paths
(`output.data/items/0/name — minLength: …`). The schema must be inline —
the runner has no spec to resolve references against, so a `$ref` anywhere
in it is a loud error (the fixture reports `output.schema contains a
$ref … — inline it`) rather than a silently-passing no-op. The validator is
the mock-server's subset walker, so its never-invent-a-violation rule
applies (unknown keywords pass). Functions inside a schema object are never
invoked. `gen-fixtures` emits this key automatically (pre-dereferenced) for
any case whose expected status documents a response schema.

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
test-fixture --target 'fixtures/**/*.crust.ts' --out report.xml   # JUnit for CI
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

Report formats are picked from `--out`'s extension: `.json`, `.md`, `.xml` (JUnit), anything else is plain text. With no `--out`, prints a colored, folder-grouped summary to stdout. Exit codes: `0` all pass, `1` any failure/error, `2` no files matched or bad args.

The JUnit report maps one `<testsuite>` per fixture file and one `<testcase>`
per run — under `--count N`, each iteration is its own testcase (`name #3`),
so CI points at the exact failing iteration; the stress percentile table
rides along as the suite's `<system-out>`. Failures carry the first mismatch
as the `message` and every mismatch in the body.

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
test-pipes --target 'tests/**/*.pipes' --out report.xml   # JUnit for CI
```

```bash
# smoke.pipes — a whole CRUD suite with request chaining, no framework
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
{} | DELETE $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 204
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 404
```

**Chaining.** `capture NAME (fn)` on line N makes `$NAME` expand on every
later line of the same file — ids, tokens, anything a response yields. This
works because each line is parsed (and env-expanded) right before it runs.
Captures require the sequential-per-file execution model; that's a contract,
not an accident.

Flags: `--bail` stops at the first failing line (across files); `--timeout
<ms>` fails any line that runs longer; `--out <path>` writes the report to a
file instead of stdout — `.json` for the raw report, `.xml` for JUnit (one
`<testsuite>` per `.pipes` file, one `<testcase>` per line).

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
registered, but no `init.ts` and no shared alias state — and `process.env`
is **snapshotted before setup and restored when the file finishes**, so
setup vars and captures never leak across files or into your interactive
session. A `.pipes` file must behave the same on every machine. Exit codes:
`0` all lines pass, `1` any fail, `2` no files matched / bad args.

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

Some creates need values a spec can't express — business date rules,
foreign keys to live rows. The setup module may export
`flowOverrides: Record<template, { body?: object; skip?: boolean }>`:
`body` merges over the derived schema-valid create body, `skip` drops the
flow entirely (a required FK no static value can satisfy). Skips are
reported at generation time.

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

A complete runnable module to copy lives at
[`examples/gen-setup.ts`](../examples/gen-setup.ts).

**If you get `generated 0 cases`:** derivation keys off **documented
responses**, not `securitySchemes` — 401 needs a documented `401` whose
description says the caller is not authenticated ("not authenticated" /
"log in"; a login endpoint's bad-credentials 401 deliberately doesn't
count), 403 needs `scopeParam` plus a documented `403`, 404 needs non-scope
path params plus a documented `404`, and the 400 matrix needs a JSON
request-body schema plus a documented `400`.

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

Flags: `--swagger <url-or-path>` (required; URL or local `.json`/`.yaml`/`.yml`; Swagger 2.0 specs are auto-converted to OpenAPI 3.x), `--port N` (default `3000`, `0` = ephemeral), `--host addr` (default `0.0.0.0`), `--stateful` (CRUD layer — see below), `--state <path|url>` (persist the CRUD state in sqlite/postgres — see below; implies `--stateful`, excludes `--proxy`), `--seed <file.json>` (insert boot data into empty collections — see below; implies `--stateful`, excludes `--proxy`), `--validate` (reject spec-violating requests with `422` — see below), `--strict` (also enforce literal `additionalProperties: false` — see below; implies `--validate`), `--proxy <upstream>` (validation-proxy mode — see below; mutually exclusive with `--stateful`), `--proxy-timeout N` (upstream timeout in ms, default `30000`), `--report <path>` (append violations as NDJSON; requires `--proxy`).

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

Ctrl-C (or `SIGTERM`) shuts the server down cleanly. Limits: remote `$ref` resolution, faker-style data, and hot-reload are not supported yet.

#### Stateful mode (`--stateful`)

By default the mock is stateless — every request replays the spec's example.
`--stateful` adds a CRUD layer on top, so what you POST is what you GET back:

- `POST /things` **creates**: the stored entity is the spec-synthesized base
  merged **under** the request body, plus an `id` (yours if the body has one,
  else a random uuid).
- `GET /things/{id}` returns the stored entity; `GET /things` returns
  everything stored, **shaped like the spec's collection envelope** (a
  documented `{ items: [...] }` wrapper is preserved; a bare array stays a
  bare array).
- `PATCH`/`PUT /things/{id}` **merge** the body over the stored entity.
- `DELETE /things/{id}` removes it and returns `204`; unknown ids `404`.

**Entity envelopes are detected and honored.** If the collection POST's
201 example (or schema-synthesized body) is an object with exactly one
object-valued property and no top-level `id` — e.g.
`{"thing": {"id": "…", "name": "…"}}` — that key is treated as the entity
envelope: the store keeps the **bare** entity, POST responds
`{"thing": {…, "id": "<real id>"}}` (so a pipeline capturing `t.thing.id`
round-trips), item GET/PATCH/PUT responses re-wrap with the item GET's
envelope (falling back to the POST's), and request bodies arriving wrapped
(`{"thing": {…}}`, per the POST's request example) are unwrapped before
storing. Detection is deterministic and **flat on ambiguity** — two
object-valued props, a top-level `id`, or a non-object body all mean the
flat behavior above, unchanged.

**Untouched collections keep serving spec examples** — consumers see no
change until they write. State lives in memory by default (restart = clean
slate); add `--state` to persist it.

#### Persistent state & seeding (`--state`, `--seed`)

`--state <path|url>` (implies `--stateful`, excludes `--proxy`) moves the
CRUD store into SQL via `Bun.SQL`: a bare file path or `sqlite://` URL for
sqlite, or a `postgres://`/`postgresql://` URL for Postgres (any other
scheme exits `2`). State survives restarts and is **shared cross-process** —
every request reads through to the database (no cache), and writes are
single-statement upserts, so last write wins. The boot line gains
`(state: sqlite)` or `(state: postgres)`.

The table is created idempotently at open and its shape is a **public
contract** — assert on it from pipelines or anything else that speaks SQL:

```sql
CREATE TABLE IF NOT EXISTS crust_mock_state (
  collection TEXT NOT NULL,   -- the collection path template, e.g. '/api/things'
  id         TEXT NOT NULL,   -- the entity id (stringified)
  doc        TEXT,            -- sqlite: JSON text | postgres: JSONB
  updated_at TEXT NOT NULL,   -- sqlite: ISO 8601 | postgres: timestamptz DEFAULT now()
  PRIMARY KEY (collection, id)
)
```

`doc` is always the **bare** entity (envelopes stripped). With the `sql`
builtin (one item per row; `DATABASE_URL=sqlite://./mock.sqlite` works —
`Bun.SQL` handles sqlite URLs):

```crust
# sqlite
sql "SELECT json_extract(doc, '$.name') AS name FROM crust_mock_state WHERE collection = '/api/things' AND id = '$TID'" | assert (r => r.name === "Crusty")
# postgres
sql "SELECT doc->>'name' AS name FROM crust_mock_state WHERE collection = '/api/things' AND id = '$TID'" | assert (r => r.name === "Crusty")
```

`--seed <file.json>` (implies `--stateful`, excludes `--proxy`) inserts boot
data. The file maps collection templates to entity arrays:

```json
{ "/api/things": [ { "id": "seed-1", "name": "Seeded Thing" }, { "name": "No Id — gets a uuid" } ] }
```

Seeding is **empty-only and restart-safe**: collections that already have
rows are skipped entirely (a persistent store's accumulated state is never
clobbered — re-booting with the same seed neither duplicates nor resets).
Seeded collections count as written, so their lists serve the seeded data
instead of spec examples. Unknown collection keys (no matching route) print
a boot warning and are skipped; an unreadable or invalid seed file exits
`1`. The boot line gains `(seeded N)` with the number of items actually
inserted.

#### Request validation (`--validate`)

Opt-in: by default the mock accepts anything (existing suites may rely on
that). With `--validate`, every matched request is checked against the spec
before any mock/stateful handling; violations answer `422` with header
`x-crust-validation: request` and body
`{"error": "request validation failed", "violations": [...]}` — each
violation carries `pointer` (JSON pointer into the body, or the param name),
`rule`, `message`, `expected`/`received`, and `location`
(`body`/`path`/`query`). Composes with `--stateful`: an invalid POST returns
`422` and creates nothing.

What is checked: path/query parameters (string values are coerced to the
declared `integer`/`number`/`boolean` type first; path params are
percent-decoded before validation; `header`/`cookie` params are skipped),
required query params, `requestBody.required` (`required-body`),
unparseable JSON bodies (`json-parse`), and JSON body schemas. Query arrays
accept the exploded form (`?tag=a&tag=b`), plus the comma-joined form
(`?tag=a,b`) when the spec says `explode: false` (form style); other
serialization styles pass unchecked. The schema
walker supports `type` (incl. the 3.1 `["string","null"]` array form),
`required`, `properties`/`items`, `enum`, `nullable`, `anyOf`/`oneOf` (pass if
any branch passes), `allOf`, `format` (`uuid`, `email`, `date`, `date-time`,
`uri`), `pattern`, `minLength`/`maxLength`, `minimum`/`maximum` (incl. both
`exclusiveMinimum`/`exclusiveMaximum` forms), and `minItems`/`maxItems`.

The governing rule: **a schema the walker can't judge validates
successfully** — unknown formats, uncompilable patterns, unresolvable or
cyclic `$ref`s, and unsupported keywords (`not`, `uniqueItems`,
`multipleOf`, …) never produce a violation, so extra properties are never
rejected **unless you pass `--strict`**. Non-JSON request bodies (multipart,
form) pass untouched.

`--strict` (implies `--validate`) enforces a **literal
`additionalProperties: false`**, and only at object nodes the walker can
fully judge: a node whose schema also carries `allOf`/`anyOf`/`oneOf`
siblings or `patternProperties` stays exempt, and inside an `allOf` branch
the check is suppressed at that instance position — sibling branches may
legitimately contribute the "extra" properties (the OpenAPI allOf-merge
idiom; enforcing there is the classic validator false positive). Inside
`anyOf`/`oneOf` branches it applies (each branch is a self-contained
alternative, so an extra key just fails that branch's selection), and it
applies again to deeper standalone objects inside any branch. The
object-form `additionalProperties: {schema}` stays unenforced. Violations
use `rule: "additionalProperties"` with the offending key in the pointer.

#### Validation proxy (`--proxy <upstream>`)

Puts the spec in front of a **real** backend: every request is forwarded to
the upstream (hop-by-hop headers stripped, 3xx passed through untouched) and
the upstream's response is returned as-is — while both directions are
checked against the spec and violations are **recorded, never enforced**.
Responses are checked for documented status (exact key, then `NXX` range,
then `default` — miss records `undocumented-status`), documented
content-type, and JSON body schema conformance. Requests that match no
documented operation are forwarded anyway and recorded as
`undocumented-operation`. An unreachable upstream answers
`502 {"error": "upstream unreachable", ...}` and is *not* recorded — infra
failures aren't spec violations.

Inspect findings at `GET /__crust/violations`
(`{count, dropped, violations}`; capped at 1000 in memory, oldest dropped)
and clear them with `DELETE /__crust/violations`; `--report <path>` also
appends every violation as one NDJSON line as it happens. Each recorded
violation adds `ts`, `direction` (`request`/`response`), `method`, `path`,
`template`, and (response side) `status` to the fields above. Per-request
log lines gain a ` [N violation(s)]` suffix. `--proxy` implies validation of
both directions (`--validate` alongside it is accepted, redundant) and is
mutually exclusive with `--stateful`. `--strict` composes with `--proxy`:
the additionalProperties check then applies to both request and response
bodies — recorded, never enforced, like every proxy-mode violation.

```bash
mock-server --swagger ./openapi.yaml --port 4000 --validate
mock-server --swagger ./openapi.yaml --port 4000 \
  --proxy http://localhost:8080 --report violations.ndjson
```

#### test-fixture stress mode (`--count`) and randomized inputs

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

Flags: `--site-map-url <url-or-path>` or `--base-url <url>` (one required, mutually exclusive); `--fixtures <glob>` (optional `.crust.ts` meta fixtures); `--concurrency N` (default `4`); `--timeout ms` (default `10000`); `--user-agent <s>`; `--max-depth N` (default `5`); `--no-recurse` / `--no-anchors` / `--no-redirect-warnings` to opt out of those checks; `--include-external` to status-check off-origin links (never recursed); `--exclude <substring>` (repeatable) to skip URLs containing the substring — for subtrees that redirect by design, like a WooCommerce `/checkout/` or `/wp-admin/`; `--max-pages N` to stop after N URLs (the report counts what was left unchecked — a safety valve for crawls that explode into e.g. WooCommerce filter URLs; default `0` = unlimited); `--no-progress` to silence the 5-second progress heartbeat on stderr; `--json` for a machine-readable report.

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

### logs — interactive log searching

`logs` holds a live source open and buffers its recent past, so you can
**iterate on filters without restarting the tail**. Each line typed at the
`logs>` prompt is an ordinary pipeline fragment — the whole shell grammar is
the query language — run first over the buffered history (retro), then over
the live stream until Ctrl-C:

```bash
logs tail -n 0 -F app.log            # follow a file (globs work too)
logs procs({web: "bun run dev", api: "bun api.ts"})   # hold a process group
logs docker logs -f my-container     # any shell command's stdout
logs --buffer 50000 tail -F big.log  # deeper history (default 10k, cap 1M)
```

A session:

```
logs> grep ERROR                     # matches from the buffer, then live ones
-- live --
^C
logs> (l => JSON.parse(l)) | filter (e => e.level >= 40) | stats --every 5
-- live --
^C
logs> buffer
buffer: 4211/10000 items (pushed 4211, evicted 0)
logs> exit
```

Rules of the road:

- **A fragment runs twice** — once over the buffer snapshot, once over the
  live stream — so side-effecting stages fire twice: append with `>>`, not
  `>`, and know that a `POST` fragment re-sends buffered matches.
- **Ctrl-C once** ends the live view *gracefully*: the stream finishes, so
  terminal stages flush — a query ending in bare `stats` prints its summary
  exactly then. **Ctrl-C twice** hard-cancels a stuck query. The session
  survives both; `exit` or Ctrl-D tears down the held source (procs get the
  SIGTERM→SIGKILL escalation).
- The live view is a bounded queue (1024): if a query can't keep up, the
  oldest pending items are dropped and the drop count is **reported**.
- Query errors print and re-prompt; they never kill the session or the
  held source. `clear` empties the buffer; `buffer` shows usage; `help`
  lists everything.
- `procs` items are `{proc, stream, line}` **objects** — `(l => l.line)`
  extracts text, `filter (l => l.proc === "web")` selects a stream.
- Fragments end in shell stages, so pretty-rendering is just another
  stage: `grep api_request | pino-pretty --colorize --singleLine`
  pretty-prints the buffered past AND the live stream (`--colorize`
  forces ANSI through the pipe; local `node_modules/.bin` is on PATH, so
  no prefix needed). For `procs` sources, normalize the object first —
  see the pino-pretty recipe in [Log mining](#log-mining).
- The `logs` line itself takes no pipes or redirections (put a complex
  command in a script); interactive-only — with piped stdin use
  `cmd | crust -c 'stdin | …'` instead (exit 2 points you there).

### Built-in functions

Crust ships a small set of `crust.fn`-registered helpers. They work as both pipeline stages (`echo … | base64`) and one-shot sources (`base64 hello`). User-defined `crust.fn(...)` calls in `init.ts` override these by name.

| Function | Usage |
|---|---|
| `base64 [-d \| decode]` | Encode (default) or decode. `echo hi \| base64` → `aGk=`; `echo aGk= \| base64 -d` → `hi`. |
| `salt [bytes] [hex\|base64\|base64url]` | Cryptographically random bytes. Defaults: 16 bytes, hex. `salt 32 base64`. |
| `jwt sign \| verify \| decode --secret <s>` | HS256 JWT. Reads `$JWT_SECRET` if `--secret` omitted. Item can be a JSON string (sign) or a token (verify/decode). |
| `bundle <entry> [--outdir \| --outfile \| --minify \| --sourcemap \| --target=bun\|browser\|node]` | Wraps `Bun.build` for one-shot bundling. With `--outfile`, writes the first artifact and returns `{outfile, bytes}`. |
| `sql "<query>" [params…]` | Runs a SQL query via Bun's SQL client using `$DATABASE_URL`. **Streams one item per row in both positions** — as a source and mid-pipeline. Mid-pipeline the upstream item **binds as the first parameter** when the line declares none, so `range(1,1) \| sql "SELECT … WHERE id = ?"` queries id 1; an explicitly declared parameter still wins. |
| `wait <target> [--timeout <dur>] [--interval <dur>] [--probe-timeout <dur>]` | Blocks until a target answers, then emits `{target, ready, ms, attempts}`. Target: `:3001/health` / `http(s)://…` (ready = any 2xx) or `port:5432` (TCP connect). Durations like `300ms`/`30s`/`2m` (defaults 30s / 500ms). `--probe-timeout` caps each probe (default `min(interval*4, 2s)`) — raise it for slow-to-accept targets. Not ready in time → error, exit 1 — CI-friendly. |

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

# Block a CI step until the app is up (exit 1 if it never is)
wait :3001/health --timeout 30s

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
| `Ctrl-C` | At the prompt: clear the line, fresh prompt. **While a line runs: cancel it** — the pipeline/builtin stops (exit 130), children are killed, the prompt returns. In a `logs` session: end the live view (once = graceful flush, twice = hard cancel). |
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
// into keep their default disposition. Note on SIGINT: at the REPL prompt
// Ctrl-C stays inside the editor (no signal), but Ctrl-C while a line RUNS
// fires an in-process SIGINT as part of cancelling it — a registered
// SIGINT handler will observe those cancellations.
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

```bash
range(0, 999) | parallel 50 | GET :3000/health | expect 200 | stats
```

Or in a `.ts` file (run with `bun script.ts`):

```ts
const summary = await load([{ durMs: 10_000, rps: 100 }])
  .pipe(parallel(50, timedGet("http://localhost:3000/health")))
  .pipe(statsStage())
  .collect();
```

### Log mining

```bash
# On-disk sweep: read streams file CONTENTS (a bare **/*.log glob yields
# PATHS — grep would match filenames and count 0).
read **/*.log | grep ERROR | wc -l
read **/*.log | grep ERROR | filter (l => !l.includes('healthcheck')) | wc -l

# Live: native grep is line-buffered, so follow streams don't stall.
tail -F app.log | grep ERROR

# Anything that writes to a pipe becomes a source via stdin:
docker logs -f my-app | crust -c 'stdin | (l => JSON.parse(l)) | filter (e => e.level >= 40) | (e => e.msg)'

# Iterating on filters? Hold the stream once, query it repeatedly:
logs docker logs -f my-app        # then: grep ERROR / filter (…) / stats --every 5
```

After a shell stage like `grep`, items are individual lines, which is what
makes the `filter` predicate per-line. See [logs](#logs--interactive-log-searching)
for the interactive session.

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

## Limits in v0.2

Honest about what doesn't work yet:

- **Partial job control.** `Ctrl-C` cancels the running line at the REPL
  (pipelines, builtins, and inherit-stdio shell children all stop; exit
  130), but there is no `Ctrl-Z` suspend — pressing it suspends crust
  *together with* its child — and no `fg`/`bg`/`&` background jobs.
- **No multi-line input / heredocs** in the REPL editor.
- **Plain `FOO=x` assignments don't persist** across lines — each shell line
  is its own `sh -c`. Use `export FOO=x` (builtin) or `capture`.
- **No positional script arguments.** `crust file.crust prod` is rejected —
  there is no `$1`/`$@` plumbing yet; parameterize via environment variables.
- **Shell stages see EOF on stdin** in script/piped mode (stdin is drained
  before the first line runs).
- **`source` doesn't run bash scripts.** Non-`.ts`/`.js` files are parsed as
  crust lines; multi-line bash constructs (`if`/`fi`, loops) won't survive
  line-by-line execution — run those with `sh file.sh`.
- **No `$(...)` substitution across stages.** Within a single shell stage it works (delegated to `sh`).
- **No `|>` operator and no `[0..9]` range literal.** Need a Bun loader; v0.2.
- **No syntax highlighting in the editor.** v0.1.5.
- **No fuzzy history search (Ctrl-R).** v0.2.

See `docs/spec/v0.1-contract.md` for the green-light test contract and `docs/PLAN.md` for the design notes.

---

## Reporting issues

Bugs, unexpected behaviour, or feature requests: open an issue at [github.com/lariocpt/crust/issues](https://github.com/lariocpt/crust/issues).
