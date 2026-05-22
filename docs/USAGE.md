# crust — usage

A Bun-powered shell with first-class pipelines. Shell commands, TypeScript lambdas, HTTP verbs, globs, and parallel workers all compose under one `|` / `.pipe()` model. v0.1.

**Mental model:** crust is effectively an inline JavaScript global-scope script runner in Bun, shell-flavoured. Every line you type runs in a Bun context where `Pipeline`, `range`, `GET`/`POST`, `parallel`, `$` (Bun.$), and anything you registered in `~/.config/crust/init.ts` are globals. Shell commands and TS lambdas are equal citizens; both are stages on the same pipeline.

## Contents

- [Install](#install)
- [Hello world](#hello-world)
- [The Pipeline model](#the-pipeline-model)
- [Shell-line syntax](#shell-line-syntax)
- [TypeScript API](#typescript-api)
- [Builtins](#builtins)
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
| `exit [code]` | Exits crust with optional code (default 0). |
| `help` | Lists builtins. |

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
};

crust.alias("ll", "ls -la");
crust.alias("g", "git");

// Any globally-installed npm package can be imported and exposed as a stage.
//   bun add --global chalk
// then:
//   import chalk from "chalk";
//   crust.fn("red", (text: string) => chalk.red(text));
// Then in the shell:  echo "warning" | red

// Custom prompt (overrides defaultPrompt):
// crust.prompt = (cwd, git) => `${cwd}${git ? ` (${git})` : ""} > `;
```

`crust.fn(name, handler)` is the way to make custom functions callable. Registered functions auto-dispatch from the shell line: `echo hi | wrap [ ]` calls `wrap("hi", "[", "]")` if `crust.fn("wrap", (item, l, r) => `${l}${item}${r}`)` was registered. The function signature is `(item, ...staticArgs)`; static args come from the shell-line tokens after the function name.

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
