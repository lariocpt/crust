---
name: crust-cli
description: How to invoke crust and read its answer — the run modes (`-c`, script file, piped stdin, REPL), what each exit code actually means (0/1/2/127/130, and why there is no 124), `--check` as a linter including what it cannot catch, `--env-file` vs `dotenv` vs `export`, the REPL's verified keybindings and Ctrl-C semantics, and where crust's globals (`GET`, `range`, `parallel`, `crust.fn`) do and do not exist. Use when a crust run's exit code is confusing, when a CI step passes on a failing line, when `--check` says ok but the line dies, when `GET is not defined` appears in a `.ts` file, or when driving the REPL from a script.
---

# Running crust, and reading what it says back

## Run modes

| Invocation | What happens |
| --- | --- |
| `crust` (stdin is a TTY) | Interactive REPL. |
| `crust` (stdin is piped) | Reads **lines of crust** from stdin to EOF and runs them like a script (fail-fast, same exit codes). stdin is the *command* source in this mode, so a shell stage inside those lines sees EOF. Want data on stdin? Use `-c`. |
| `crust run.crust` | Script mode: blank lines and `#` comments are skipped (so a `#!/usr/bin/env crust` shebang works), lines run in order, and it **fails fast** — the first failing line stops the file and becomes the process exit code. A line ending in `\` continues on the next. The extension doesn't matter. Positional args after the path are refused (exit 2), an unreadable path is 127. |
| `crust -c '<line>'` | One line. A shell stage inherits the process stdin, so `docker logs app \| crust -c 'grep ERROR'` really does grep the logs. To feed a **crust** pipeline, name the source: `docker logs -f app \| crust -c 'stdin \| grep ERROR'`. To run several lines, put a **newline inside the one argument** — they then behave like a script (fail-fast) — or continue one line with a trailing `\`. Two lines as two arguments is refused. Quote the whole pipeline: `-c range(1,2) extra` splits into three argv words and is refused. |
| `crust --check '<line>'` | Parse without running. See below. |
| `crust --env-file <path> …` | Loads `.env` before *any* run mode and before `init.ts`. The "loaded" note goes to stderr so a `-c` pipeline's stdout stays clean. A missing file exits **2, loudly** — this flag exists to replace shell shims that failed silently. Does not combine with `--check`. |
| `crust -h` / `-V` | Usage / version, exit 0. |

## Exit codes (measured against the binary, not guessed)

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | Success. | `range(1,2)` |
| 1 | **crust** failed. Every error crust itself raises. | `assert` mismatch, a lambda that throws, `expect 200` vs a 500, `wait: <target> not ready after Ns`, a `GET` that can't connect, `read` on a missing file, a refused empty stage (`echo a \|\| echo b`), a builtin name that reached sh. |
| 2 | Invocation or syntax error — nothing ran. | `crust --nonsense`, `--check` with no line, `--env-file` on a missing file, `crust x.crust extra`, `-c` given two lines, `mock-server --bogus` (prints the valid flags), and sh's own parse errors on a pure-shell line (`bundle(5)`). |
| the stage's own | A shell stage's exit code, propagated. | `range(1,3) \| sh -c "exit 9"` → 9 |
| 127 | Command not found (shell stage), or an unreadable script file. | `nosuchbinary-xyz` |
| 130 / 143 | crust killed by SIGINT / SIGTERM. | Ctrl-C during a long `-c` run |

**There is no crust exit 124.** `wait` timing out is exit **1** with
`crust: wait: <target> not ready after Ns`. If a probe reports 124, then
`timeout(1)` — your harness — killed crust. Give `wait`/`load`/`procs` probes a
generous outer timeout, and when testing cancellation signal the real bun PID.

A **bare `wait :3000` probes `/`**, and readiness means a **2xx** — a mock server
or an API with no root route 404s forever, so the line fails after the full
timeout on a server that is perfectly up. Use a real health path (`wait
:3000/health`) or `wait port:3000` for a TCP connect; crust says so in the
failure message now, because "not ready" alone reads like a slow boot.

### The last command wins (the one CI trap here)

A line made **entirely of shell stages** is handed to sh as one `sh -c` string,
so its code is the **last** command's — no `pipefail`:

```bash
ls /nope | wc -l      # 0 — wc succeeded
ls /nope              # 2
```

The moment a line contains a crust stage, crust owns the exit code and a
failing shell stage propagates. So a gate must **end on a crust stage**:

```crust
# a run.crust: blanks and `#` are skipped, lines run in order, first failure stops the file
wait :3000/health
range(1,99) | parallel 10 | GET http://localhost:3000/items | expect 200 | stats
GET http://localhost:3000/items | assert (x => x.length > 0)
# a trailing `\` continues the line — the only way to write a pipeline over
# more than one line, in a script, in piped stdin or in a multi-line -c
load 10s 100/s | parallel 20 | GET http://localhost:3000/items \
  | expect 200 | stats
```

Or ask sh to gate, explicitly:

```bash
sh -c 'set -o pipefail; ls /nope | wc -l'   # 2 — would be 0 without pipefail
```

## `--check`: the linter, and its edges

`crust --check '<line>'` exits **0** if every line parses, **1** with the error
otherwise (`ok: N line(s) parse`). It splits on newlines and skips blank and
`#` lines, so a whole fenced block goes in as one argument. It checks three
things: crust's own grammar, a builtin-head line against **that CLI's flag
spec**, and every shell stage through `sh -n` (noexec — `cat > f` under `-n`
does not create `f`).

```bash
crust --check 'read /nonexistent/*.json | POST :3000/x'   # ok — sources are lazy
```

```
crust: shell stage does not parse (stage: head -(): sh: -c: line 1: syntax error near unexpected token `(`
  in: range(1,3) | head -(
```

What it does **not** check: anything needing I/O or a live process — a missing
fixture path, an unreachable URL, a wrong `output` matcher key, a semantic
refusal at runtime (`--env-file` + `--check` is refused for exactly this
reason). "Checks clean" means *parses*, never *will pass*.

## Environment

| How | Scope | Reaches sh stages? |
| --- | --- | --- |
| `crust --env-file <path> …` | one process, before `init.ts` | yes |
| `dotenv <path>` / `dotenv --append` / `dotenv status` / `dotenv clear` | the session | yes |
| `export FOO=bar` | the session | yes |
| `capture NAME` stage | writes `process.env.NAME` from the stream, for **later lines** | yes |

## The REPL

Verified in a real pty, not read off the source:

- **Editing:** `Ctrl-A` / `Ctrl-E` home/end, arrow keys move (and `Home`/`End`/
  `Delete`), `Ctrl-K` kill to end, `Ctrl-U` kill to start, `Ctrl-W` kill
  previous word, `Ctrl-L` repaint (the buffer survives), `Backspace`, `Tab`
  completes.
- **Tab** completes a **path** mid-stage (`ls sr` + Tab → `ls src/`) and lists
  names from `$PATH` at the start of a stage. It does **not** know crust's own
  builtins or registered functions — `verify-web-` + Tab lists nothing useful.
- **History:** up/down arrows. It is plain text at
  `$XDG_DATA_HOME/crust/history` (default `~/.local/share/crust/history`), it
  survives restarts, `history` prints it numbered, and re-running a recalled
  line does not append a duplicate.
- **`Ctrl-C`** at the prompt just clears the line. Mid-run it **cancels**:
  children are killed, the line reports 130, and the prompt comes back so the
  session continues. One item already produced by the source can still print
  after the prompt redraws — cosmetic; the source is stopped.
- **`Ctrl-D`** (or `exit`) leaves; the exit code is 0 unless `exit <code>`.

Driving it non-interactively: crust checks for a TTY, so pipe bytes through
`script` and pace them — `{ printf 'range(1,3)\n'; sleep 1; printf '\004'; } |
script -qec 'crust' /dev/null`.

## Where crust's globals exist

`GET`, `range`, `parallel`, `load`, `procs`, `$`, `crust.*` and everything you
define in `init.ts` are globals **wherever crust starts its runtime**: the REPL,
`-c`, piped stdin, a script file, `~/.config/crust/init.ts`, and any `.ts`/`.js`
file crust imports (`source hooks/warmup.ts` — inside it, `load` and `parallel`
are just there). A file run by plain `bun script.ts` never starts crust, so
those names are `undefined` there; import what you need from the modules
(`../src/sinks` today) or run the file under crust instead.

## Auto-discovered stages

crust scans your **global bun install** at startup and turns opted-in packages
into pipeline stages — no `init.ts` entry needed.

- Reads `$CRUST_GLOBAL_PREFIX/package.json` (default `~/.bun/install/global`) and
  inspects its dependencies. A package with a `bin` field and **no** `crust`
  field is skipped, so it keeps working as a plain shell command; add
  `"crust": { … }` and it becomes a stage *as well as* a command.
- `package.json` → `"crust": { "stage": "default" }` (or a named export) picks
  which export becomes the stage; otherwise the default export, or the sole
  function export. The stage is called `fn(item, ...args)` like any registered
  function, so it works as a source *and* mid-pipeline.
- Scoped packages are exposed after the `/` (`@me/shout` → `shout`). A name
  already registered (by `crust.fn` in `init.ts`) wins — discovery never
  overwrites explicit config.
- The scan is cached at `$CRUST_CACHE_DIR/globals.json` (default
  `~/.cache/crust`) keyed on the prefix `package.json` mtime; delete that file
  after changing the install by hand.
- `CRUST_DEBUG=1` prints every decision: `skipping "x" — has bin field`,
  `failed to inspect …`, `name collision on …`. That's where to look when a
  package you expected just isn't a stage.
