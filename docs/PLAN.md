# crust — a Bun-powered shell

> **Historical design document.** crust began life as the shell for a
> Fedora-COSMIC-based distro concept, which is the framing below. The
> project has since been repositioned as a pipeline-first devops toolkit
> built on Bun — see `README.md` and `docs/USAGE.md` for current
> positioning and behavior. Kept unedited because the pipeline architecture
> decisions here still govern the code. References to `lariocpt`
> name a defunct GitHub org.

## Context

You want a Linux distro flavor called **Crust** built on the Fedora COSMIC spin, where the headline feature is a Bun-powered terminal shell (also called `crust`). Phase 1 is intentionally not a full ISO — it's a post-install layer distributed exactly like oh-my-zsh / Bun / Homebrew: a one-line `curl … | bash` installer that turns a vanilla Fedora COSMIC install (or any modern Linux/macOS) into a Crust system. The deliverable for phase 1 is the **shell itself + the installer**.

Decisions locked from conversation:

- Base distro: **Fedora COSMIC spin**
- Delivery: **`curl | bash` installer**, not an RPM, not an ISO
- Repo: **`~/Projects/crust`**, new git repo, hosted at `github.com/lariocpt/crust`
- Install target on end-user machines: **`~/.crust/`** (oh-my-zsh style)
- Bun is **the terminal-app shell**, not the system login shell — avoids breaking PAM / `/etc/profile` / `.desktop` assumptions
- Scope: **"boss" v0.1** — real interactive shell with line editing, history, completion, builtins. Job control deferred to v0.2.
- **Architecture: gulp-shell (option B).** One parser, one `Pipeline<T>` model. Sources (globs, range, GET, src, read), Transforms (shell cmds, TS lambdas, .map/.filter, POST/PUT/PATCH/DELETE, parallel, expect), Sinks (stdout, write, dest, stats, collect). Per-stage bash parsing delegated to `sh -c`; we do NOT reimplement bash.
- **Devops-first feature set:** HTTP verbs as first-class pipeline stages (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`), parallel worker fanout (`range(0,N).parallel(fn)`), assertion stages (`expect(predicate)`), and timing/stats sinks. The shell doubles as a load-test/API-test tool. **Canonical motivating one-liner:**
  ```bash
  fixtures/*.json | POST https://api.example.com/users | expect 201
  ```
  …reads each fixture file from disk, POSTs its contents as the request body, asserts every response is 201. Add `| parallel 50` for concurrency, `| stats` for a latency summary, `-H` flags on the verb for headers.
- **TDD:** v0.1 contract lives at `docs/spec/v0.1-contract.md` and is enforced by `bun:test`. Tests are written first, watched fail (red), then implemented (green). Bash reference manual is checked into `docs/spec/` as reading material — NOT as parser input.

## Use-case taxonomy

Crust is one shell, many jobs. All of these are one-liners in the Pipeline model:

| Domain | Example one-liner | Phase |
|---|---|---|
| **Interactive shell** | `git status` / `ls -la \| grep .ts` | v0.1 |
| **API testing** | `fixtures/*.json \| POST :3000/users \| expect 201` | v0.1 |
| **Load / scale testing** | `range(0, 10000) \| parallel 100 \| GET :3000/health \| expect 200 \| stats` | v0.1 |
| **Glob / log mining** | `read **/*.log \| grep ERROR \| filter (l => l.includes('user=42'))` | v0.1 |
| **Health monitoring loops** | `range(0, 100).parallel(() => fetch(url)) \| expect 200` | v0.1 |
| **Image optimization** | `src/images/**/*.png \| optimize --quality=85 \| dest dist/images/` | v0.2 |
| **Bundling / packaging** | `./src \| bundle \| dest dist/app.js` | v0.2 |
| **Folder → archive** | `./src \| bundle \| tar \| write dist/app.tar.gz` | v0.2 |
| **CI / test runners** | `tests/**/*.test.ts \| run \| expect pass \| stats` | v0.2 |

Architectural promise: v0.2 features are pure additions of new transforms/sinks. No rearchitecting. Sources stay sources, sinks stay sinks, Pipeline shape unchanged.

## v0.1 — hard scope line

Below this line is in v0.1. Anything else is v0.2+, period.

**In v0.1:**

- Interactive shell: line editor, prompt, history, completion, builtins
- One parser, one Pipeline model
- Sources: globs (`**/*.ts`), `range(a,b)`, `read(file)`, shell-cmd-output, `GET url`
- Transforms: shell commands (via `sh -c` per stage), TS lambdas `(x => …)`, `.map`/`.filter`, `POST`/`PUT`/`PATCH`/`DELETE`, `parallel N`, `expect <status|2xx|predicate>`
- Sinks: stdout, `write file`, `dest dir/`, `collect`, `stats`
- Config: `~/.config/crust/init.ts` with `crust.alias()`, `crust.fn()`, `crust.prompt`
- `curl | bash` installer
- `bun:test` suite enforcing the v0.1 contract

**Extensibility (free in v0.1, by virtue of Bun):** any globally-installed npm package (`bun add --global <pkg>` or via npm's global prefix) is importable from `~/.config/crust/init.ts`. Users register transforms with `crust.fn("name", fn)` and they become shell-line stages. This is THE plugin story — no separate plugin system needed. `init.ts` can pull `sharp`, `chalk`, `zod`, `esbuild`, `playwright`, anything.

**Not in v0.1 (parked for v0.2):**

- `bundle()`, `optimize()`, `tar()`, `run-smoke()`, `dest dir/` as a packaging sink
- Job control (`fg`/`bg`/Ctrl-Z)
- `|>` operator and `[0..9]` range-literal (need custom Bun loader)
- `$(...)` command substitution / backticks mid-pipeline
- Multi-line input / heredocs
- Syntax highlighting / fuzzy history search
- The Crust distro ISO
- RPM packaging

Bun is confirmed installed locally at `/opt/homebrew/bin/bun` (1.3.14), so dev iteration works without setup.

## Language design — pipelines & parallelism

Two distinctive features that shape the executor and the TS surface area. They're what makes crust crust, not just-another-shell.

### A. Pipelines: shell `|` and TS `.pipe()` are the same thing

Every command in crust produces a `Pipeline<T>`. Stages are uniform: shell processes, TS lambdas, async iterators, arrays — they all compose under `|` / `.pipe()`.

```bash
# shell-line form
ls | grep .ts | head 5

# equivalent TS form (usable from init.ts and TS scripts)
ls().pipe(grep(".ts")).pipe(head(5))

# array methods are pipeline stages too
range(1, 100).pipe(x => x * 2).filter(x => x % 3 === 0).collect()
```

`Pipeline<T>` API:

| Method | Purpose |
|--------|---------|
| `.pipe(next)` | next = shell cmd, `(line) => out`, async iterator, or another Pipeline |
| `.map(fn)`, `.filter(fn)`, `.reduce(fn, init)` | standard, but also act as pipeline stages |
| `.lines()`, `.text()`, `.json()`, `.collect()` | terminal ops |
| `.parallel(fn)`, `.reusePorts(fn)` | fan out across workers (see B) |

**v0.1 honest scope:** the interactive shell-line parser still hands `ls | grep foo | head` straight to `Bun.$` (which already parses shell `|` correctly), so it works today. The `Pipeline<T>` API is fully real and usable from TS/init.ts. v0.2 unifies them by writing our own `|` parser that builds a `Pipeline` directly. The visible behavior is the same; the seam is internal.

### B. Range + parallel fanout with SO_REUSEPORT

```ts
range(0, 9).parallel(i => doWork(i))
//   → spawns 10 Bun Workers, each runs the fn with index i, returns Promise<results[]>

range(0, 3).reusePorts(i => Bun.serve({ port: 3000, fetch: req => new Response(`w${i}`) }))
//   → same as .parallel(), but any Bun.serve() call inside the fn gets reusePort: true
//     auto-injected, so the Linux kernel load-balances connections across workers
```

Built on Bun primitives that already exist — we don't reimplement them:

- `new Worker(url, opts)` — real OS threads on Linux/macOS
- `Bun.serve({ reusePort: true })` — surfaces the kernel SO_REUSEPORT socket option

**Range literal syntax (`[0..9]`)** would need a Bun loader doing AST rewrites — deferred to v0.2. v0.1 ships the `range(a, b)` helper (inclusive). Same call site, no syntax magic.

**Pipe operator (`|>`)** for TS — same story: needs a custom loader, deferred to v0.2. `.pipe()` works today and is what we ship.

## Repo layout (`~/Projects/crust/`)

```
.gitignore
LICENSE                       MIT, Lario Borges, 2026
README.md                     install one-liner + features
install.sh                    curl|bash entry point
package.json                  name=crust, type=module, bun-types devDep only
tsconfig.json                 Bun preset
bin/crust                     bash launcher → exec bun src/index.ts
src/
  index.ts                    main REPL loop
  types.ts                    Context interface
  shell.ts                    execute() — alias expand → builtin dispatch → Bun.$
  pipeline.ts                 Pipeline<T> — the unified pipe/chain abstraction
  parallel.ts                 range(), .parallel(), .reusePorts() + Worker plumbing
  worker.ts                   Worker entry — runs a user fn in a thread
  builtins.ts                 cd, export, alias, unalias, source, exit, history, help
  editor.ts                   raw-mode line editor (the bulk of the work)
  completion.ts               path + $PATH command completion (sync)
  prompt.ts                   cwd + git branch, ANSI-coloured
  history.ts                  load/append ~/.local/share/crust/history
  config.ts                   load ~/.config/crust/init.ts via dynamic import
skel/init.ts                  default user config — exposes global `crust` API
                              + shows pipeline/range/parallel/reusePorts examples
```

No runtime deps. `bun-types` only.

## Component design

### `src/editor.ts` — line editor (the hard part)

Raw-mode line input. Pure TypeScript, no readline dep. Single exported function:

```ts
readLine({ prompt, history, complete }): Promise<string | null>
```

Returns `null` on Ctrl-D with empty buffer (signals exit). Handles:

- Printable chars, Backspace, Delete
- Arrow keys: ←/→ cursor, ↑/↓ history
- Home/End, Ctrl-A, Ctrl-E
- Ctrl-W (delete word), Ctrl-U (delete to start), Ctrl-K (delete to end)
- Ctrl-L (clear screen), Ctrl-C (cancel line), Ctrl-D (EOF if empty)
- Tab (completion)
- Enter (submit)

Render strategy: `\r` + prompt + buffer + `CSI K` + cursor reposition. Single-line only in v0.1 (multi-line input via `\` continuation deferred).

Sync completion only — `readdirSync` and `$PATH` scanning are fast enough that we don't need async, and it keeps the keypress loop simple.

### `src/shell.ts` — executor

```ts
execute(line, ctx) → Promise<exitCode>
```

Steps:
1. Trim. Empty → return 0.
2. Expand alias (first word only — v0.1 limitation).
3. If line starts with `(` or `await ` → treat as TS expression, `eval` it with the `crust` globals + `range`/`Pipeline`/`parallel` in scope.
4. If first word is a builtin AND line has no `|&;<>` operators → dispatch in-process (cd, export, etc. must run in-process).
5. Otherwise hand to `Bun.$` using the raw-interpolation form: `await $\`${{raw: line}}\`.nothrow()` so Bun's shell parses pipes/redirects/globs/env-vars natively.

### `src/pipeline.ts` — Pipeline<T>

```ts
class Pipeline<T> {
  static of<T>(source: T[] | AsyncIterable<T> | ShellOutput): Pipeline<T>
  pipe<U>(next: Stage<T, U>): Pipeline<U>
  map<U>(fn: (x: T) => U): Pipeline<U>
  filter(fn: (x: T) => boolean): Pipeline<T>
  reduce<A>(fn: (acc: A, x: T) => A, init: A): Promise<A>
  lines(): AsyncIterable<string>
  text(): Promise<string>
  json<U = unknown>(): Promise<U>
  collect(): Promise<T[]>
  parallel<U>(fn: (x: T) => U | Promise<U>): Promise<U[]>      // see parallel.ts
  reusePorts(fn: (x: T) => unknown): Promise<void>             // see parallel.ts
}

type Stage<T, U> =
  | ((x: T) => U | Promise<U>)
  | AsyncIterable<U>
  | Pipeline<U>
  | { spawn(): ChildProcess }   // shell command stage
```

Shell-command stages execute via `Bun.spawn` with `stdio: ["pipe","pipe","inherit"]` and stream stdout line-by-line. TS-function stages run inside the same process. Mixed pipelines stream as soon as data is available — no buffering the whole upstream.

### `src/parallel.ts` — range / parallel / reusePorts

```ts
function range(start: number, end: number): Pipeline<number>   // inclusive

// On Pipeline<T>:
.parallel<U>(fn): Promise<U[]>
  // serialize fn (function.toString()) into a temp module that imports user's
  // init.ts globals, hand to new Worker(), pass input via postMessage,
  // await all, return ordered results.

.reusePorts(fn): Promise<void>
  // same fan-out, but monkey-patch Bun.serve inside the worker so
  // any { reusePort } not explicitly set defaults to true.
  // Linux kernel handles connection load-balancing across workers.
```

`src/worker.ts` is the tiny Bun entry that workers run — receives the user fn + input, executes, returns result via postMessage.

Honest limits in v0.1: closures only capture serializable values (function body + JSON-safe args). No shared mutable state across workers. Errors in workers surface as rejections of the parent promise.

### `src/builtins.ts`

| Name | Behaviour |
|------|-----------|
| `cd` | `process.chdir(target ?? $HOME)`, supports `cd -` via `OLDPWD` |
| `export` | `KEY=value` → `process.env[KEY] = value` |
| `alias` | `name='cmd'` add; bare `alias` lists |
| `unalias` | remove |
| `source` | dynamic import of `.ts`/`.js`, exec of `.sh` via Bun.$ |
| `exit` | `ctx.exit(code)` |
| `history` | print numbered list from `ctx.history` |
| `help` | print builtin list |

### `src/completion.ts`

```ts
complete(buf, cursor) → { replace: [start, end], with: string } | string[]
```

- If completing at start of line or after `\|;&\|\|&&`: complete commands by scanning `$PATH` (cached on startup).
- Otherwise: complete file paths from CWD (or absolute prefix).
- Single match → return replacement.
- Multiple matches → return array (caller prints on new line, re-renders prompt + buffer).
- Common prefix completion when array is returned.

### `src/prompt.ts`

```
~/path/to/dir [main] $
```

- cwd with `$HOME` → `~` substitution, in cyan
- Git branch via `git symbolic-ref --short HEAD 2>/dev/null` (shelled out, cached per `cd`), in green and brackets
- `$ ` (or `# ` for uid 0)
- All overridable from `init.ts` by assigning `crust.prompt = (cwd, git) => string`

### `src/history.ts`

- File: `~/.local/share/crust/history` (XDG-correct)
- Load on start, in-memory array
- Append on each non-empty submission, dedupe consecutive duplicates
- v0.1: no fuzzy search; just ↑/↓ traversal

### `src/config.ts`

- Resolve `~/.config/crust/init.ts`
- Before import, install globals:
  ```ts
  globalThis.crust = {
    alias(name, cmd) { ... },
    unalias(name) { ... },
    fn(name, handler) { ... },        // register a TS function as a command
    prompt: undefined as ((cwd, git) => string) | undefined,
  }
  globalThis.range    = range;        // from parallel.ts
  globalThis.Pipeline = Pipeline;     // from pipeline.ts
  globalThis.$        = Bun.$;        // shell template tag, always available
  ```
- Dynamic-`import()` the file. Bun runs TS natively, no transpile step.
- Missing file → silently skip.

### `bin/crust`

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/../src/index.ts" "$@"
```

## `install.sh` — the curl|bash installer

```bash
#!/usr/bin/env bash
set -euo pipefail

CRUST_DIR="${CRUST_DIR:-$HOME/.crust}"
REPO="https://github.com/lariocpt/crust.git"
BRANCH="${CRUST_BRANCH:-main}"

# 1. Bun
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Clone/update
if [[ -d "$CRUST_DIR/.git" ]]; then
  git -C "$CRUST_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$CRUST_DIR"
fi

# 3. No runtime deps, but bun install is cheap and writes lockfile
( cd "$CRUST_DIR" && bun install )

# 4. Default config
mkdir -p "$HOME/.config/crust"
[[ -f "$HOME/.config/crust/init.ts" ]] || cp "$CRUST_DIR/skel/init.ts" "$HOME/.config/crust/init.ts"

# 5. /etc/shells (asks for sudo)
CRUST_BIN="$CRUST_DIR/bin/crust"
chmod +x "$CRUST_BIN"
grep -qxF "$CRUST_BIN" /etc/shells 2>/dev/null || echo "$CRUST_BIN" | sudo tee -a /etc/shells >/dev/null

# 6. Next steps
cat <<EOF

  crust installed → $CRUST_BIN

  Try:        $CRUST_BIN
  Set in COSMIC Terminal:   Settings → Profiles → Command: $CRUST_BIN
  Login shell (optional):   chsh -s $CRUST_BIN
  Config:                   ~/.config/crust/init.ts
  Update:                   curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
  Uninstall:                rm -rf ~/.crust ~/.config/crust

EOF
```

End-user one-liner once pushed to GitHub:

```
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
```

(Later: register `crust.sh` domain → redirect `/install` to that raw URL.)

## Out of scope for v0.1 (explicitly)

- Job control (`fg`/`bg`/Ctrl-Z, process groups, `tcsetpgrp`) — needs Bun-side support it doesn't yet expose
- Multi-line input / heredocs
- Syntax highlighting *as you type*
- Fuzzy history search (Ctrl-R)
- Async completion / completion plugins
- `|>` pipe operator in TS — needs custom Bun loader, v0.2
- `[0..9]` range-literal syntax — needs custom Bun loader, v0.2
- Unifying the shell `|` parser with `Pipeline<T>` — v0.2; v0.1 still leans on `Bun.$`'s native pipe parser for shell-syntax lines
- Shared-memory worker primitives (only param-passing for now)
- The actual Crust distro ISO (phase 2)
- RPM packaging (phase 2 alternative path)

## Verification

After scaffolding, before declaring done:

1. `cd ~/Projects/crust && bun install` → no errors.
2. `bun src/index.ts` directly → prompt appears, can run `ls`, `pwd`, `cd ..`, `cd -`, `echo $HOME`, `ls | head`.
3. Builtins: `alias ll='ls -la'` then `ll` works in same session. `history` lists submitted commands. `exit 0` ends cleanly.
4. Line editor: ↑/↓ history nav works, Ctrl-A / Ctrl-E jump correctly, Ctrl-W deletes a word, Tab completes a partial filename.
5. `cp skel/init.ts ~/.config/crust/init.ts`, add `crust.alias('g', 'git')`, restart shell, `g status` runs.
6. `bash install.sh` from a fresh checkout into `CRUST_DIR=/tmp/crust-test` → fresh install works.
7. Run on Linux too (verify cosmic-term integration manually once you push and install on the Fedora box).

Honest limit: I can run steps 1–6 on this macOS box but cannot verify COSMIC Terminal integration from here — that requires the Fedora target machine.

## Critical files to be created

All under `~/Projects/crust/`:

- `install.sh`
- `bin/crust`
- `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `README.md`
- `src/index.ts`, `src/types.ts`, `src/shell.ts`, `src/builtins.ts`, `src/editor.ts`, `src/completion.ts`, `src/prompt.ts`, `src/history.ts`, `src/config.ts`
- `skel/init.ts`
