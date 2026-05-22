# crust — usage

A Bun-powered shell with first-class pipelines. Shell commands, TypeScript lambdas, HTTP verbs, globs, and parallel workers all compose under one `|` / `.pipe()` model. v0.1.

**Mental model:** crust is effectively an inline JavaScript global-scope script runner in Bun, shell-flavoured. Every line you type runs in a Bun context where `Pipeline`, `range`, `GET`/`POST`, `parallel`, `$` (Bun.$), and anything you registered in `~/.config/crust/init.ts` are globals. Shell commands and TS lambdas are equal citizens; both are stages on the same pipeline.

## Contents

- [Install](#install)
- [Hello world](#hello-world)
- [One-liner mode](#one-liner-mode)
- [The Pipeline model](#the-pipeline-model)
- [Shell-line syntax](#shell-line-syntax)
- [TypeScript API](#typescript-api)
- [Builtins](#builtins)
- [mock-server](#mock-server)
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
| `crust -c <line>` | Run one line and exit. Multi-line strings split on `\n`; exit code is the last line's. |
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
| Starts with `(` and contains `=>` | TypeScript lambda |
| Starts with `GET` / `POST` / `PUT` / `PATCH` / `DELETE` | HTTP stage |
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
GET https://api.example.com/  # → Pipeline<Response> (single item)
GET :3000/health                  # localhost shorthand
```

### Transforms

```bash
… | grep TODO                              # any shell command
… | (line => line.toUpperCase())           # TS lambda
… | tr '[:lower:]' '[:upper:]'             # standard pipes work
… | POST :3000/users                       # per-item HTTP POST (body = item)
… | DELETE :3000/users/:id                 # per-item DELETE
```

HTTP transforms auto-set `content-type: application/json` for object items. String items are sent as text. `Buffer`/`Uint8Array` go raw.

### Assertions & concurrency (TypeScript-only in v0.1)

`expect`, `parallel`, and `stats` are not yet shell-line keywords — they're TS-API only. To use them from a shell line, call into a TS script you `source`, or write the line as a `.ts` file and run it with `bun`. Native shell-line support is a v0.1.5 stretch.

### Timing a pipeline (`time "label"`)

`time` is a prefix-only decorator — bash-style. Put it before the source and it wraps the whole pipeline, printing elapsed wall time + item count to **stderr** when the iterator drains:

```bash
time "warmup" | range(0, 1000) | GET :3000/health
# stderr → [time] warmup: 412.3ms (1001 items)
```

Quotes (`"` or `'`) are required around the label; data flowing through the pipeline is untouched. The timer fires even if a downstream stage throws (e.g. `expect 500` failure), so you still see how long you got before the break. Only allowed as the first stage — `... | time "x"` is rejected. The matching TS API is `time(label, out?)`.

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

## TypeScript API

The full pipeline surface is available to any `.ts` file run by Bun, including `~/.config/crust/init.ts`. Crust exposes these as globals when starting up:

```ts
Pipeline             // class — the unified stream abstraction
range(start, end)    // source
glob(pattern)        // source
read(path)           // source — Pipeline<string> of lines
GET(url, opts?)      // source
POST(url, opts?)     // transform: Pipeline<T> → Pipeline<Response>
PUT, PATCH, DELETE   // same shape as POST
expectStage(matcher) // transform — fails the pipeline on mismatch
parallel(n, fn)      // transform — N concurrent workers, order-preserving
$                    // Bun's tagged-template shell (`Bun.$`)
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

The TS-test ecosystem owns the name `expect`. Crust exports the API name as `expectStage` to avoid collisions when you `import { expect as expectStage }` in test files. From the shell line in v0.1.5 it'll just be `expect 201`.

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
| `test-fixture --target g [--out p] [--threads N]` | Runs `.crust.ts` HTTP fixtures. See [test-fixture](#test-fixture). |
| `mock-server --swagger <url-or-path> [--port N] [--host addr]` | Boots a `Bun.serve` instance that mocks every operation in an OpenAPI 3.x spec. See [mock-server](#mock-server). |
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

```bash
test-fixture --target fixtures/*.crust.ts
test-fixture --target fixtures/users.crust.ts --out report.md
test-fixture --target 'fixtures/**/*.crust.ts' --threads 8 --out report.json
test-fixture --target fixtures/users.crust.ts --count 1000 --threads 32   # stress
```

Module resolution inside a fixture file uses Bun's normal walk: imports resolve from the fixture's own directory upward, so the nearest `node_modules` wins — same as running `bun` from that directory.

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

### mock-server

Boots a `Bun.serve` instance that mocks every operation in an OpenAPI 3.x spec — useful for frontend dev before the backend exists, demoing a pipeline, or seeding fixture tests against an upstream you don't want to spin up.

```bash
mock-server --swagger ./openapi.yaml --port 4000
mock-server --swagger https://petstore3.swagger.io/api/v3/openapi.json --port 4747
mock-server --swagger ./spec.json --port 0 --host 127.0.0.1   # OS-assigned port
```

Flags: `--swagger <url-or-path>` (required; URL or local `.json`/`.yaml`/`.yml`), `--port N` (default `3000`, `0` = ephemeral), `--host addr` (default `0.0.0.0`).

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

Ctrl-C (or `SIGTERM`) shuts the server down cleanly. v0.1 limits: Swagger 2.0, remote `$ref` resolution, request validation, faker-style data, and hot-reload are not supported yet.

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
fixtures/*.json | POST :3000/users | (r => r.status === 201)
```

(The `(r => …)` lambda passes through items where the predicate is truthy, fails the shell-line pipeline on a thrown error. Native `expect 201` is v0.1.5.)

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
- **`expect`, `parallel`, `stats` are TS-only.** Shell-line keywords land in v0.1.5.
- **No `|>` operator and no `[0..9]` range literal.** Need a Bun loader; v0.2.
- **No syntax highlighting in the editor.** v0.1.5.
- **No fuzzy history search (Ctrl-R).** v0.2.

See `docs/spec/v0.1-contract.md` for the green-light test contract and `docs/PLAN.md` for the design notes.

---

## Reporting issues

Bugs, unexpected behaviour, or feature requests: open an issue at [github.com/lariocpt/crust/issues](https://github.com/lariocpt/crust/issues).
