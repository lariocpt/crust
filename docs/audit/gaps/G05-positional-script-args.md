# G05 — positional script arguments (`$0 $1 $@ $* $#`)

**Doc:** `docs/USAGE.md:2186-2190` and the `crust <file.crust>` row
(`docs/USAGE.md:67`).

## Measured

```
$ crust ./s.crust prod
crust: script arguments are not supported — got "prod"   # exit 2
```

`src/index.ts:255-258` rejects every extra argv. The rejection itself is good
behaviour (it replaced silently-ignored operands); it is now the feature that is
missing.

## Design

**State.** A tiny `src/positionals.ts`: `setPositionals(argv0, args)` /
`getPositionals()` / a `withPositionals()` helper for `source`. Module state,
same discipline as `interrupt.ts` — crust is one session, one thread. Do **not**
stash them in `process.env` under keys like `"1"`: that leaks into every child
process and every `export` dump.

**Expansion.** Widen the `expandEnv` regex (`src/args.ts:269`, currently
`[A-Za-z_]`-only names) to also accept `$0`–`$9`, `${1:-default}`, `$@`, `$*`,
`$#`, `$0`. Semantics, sh-compatible:

| token | value |
|---|---|
| `$0` | the script path (empty for `-c` / piped stdin) |
| `$1`…`$9` | nth argument, **empty when absent** |
| `${1:-d}` | `d` when the positional is unset *or* empty (same rule as `${VAR:-d}` already implemented) |
| `$@` / `$*` | all arguments, space-joined |
| `$#` | count |

Empty-on-missing is the sh answer and keeps `"$@"` idioms working; the honest
failure still happens downstream (bad URL, ENOENT) rather than as a silent pass.
Say so in the docs.

**Entry points.**
- `crust file.crust a b` → `setPositionals(flag, ["a","b"])`; drop the rejection.
  A leading `--` is stripped (`crust deploy.crust -- prod`).
- `source file.crust a b` (`src/builtins.ts:83`) sets them for the sourced file
  and restores the caller's afterwards.
- `crust -c` **keeps rejecting** a second operand (`src/index.ts:137-143`) —
  `-c` takes exactly one line; that guard is not this gap. Pin as a control.
- The tool-builtin and "not a command" gates stay exactly as they are: the
  script reading only wins where it already wins (`asScript`, `notACommandReason`).

**Interaction to check:** `$@`/`$1` expansion applies wherever `expandEnv`
already applies (URLs, `-H` values, JSON-literal sources, tool-builtin args).
Shell stages keep sh's own `$1` — which is *sh's* positional context, always
empty under `sh -c`. That mismatch is real and confusing: state it in the docs
("inside a shell stage, `$1` is sh's; use `$1` in crust stages or
`"$@"`-style strings crust expands"). Verify what `crust s.crust prod -c`-free
shell lines do with `$1` and pin the measured answer.

## Tests (red-first; new `tests/script-args.test.ts` + edits to `tests/cli.test.ts`)

- `$0` is the script path; `$1`/`$2` expand in crust stages and in a
  `capture`d value; `${2:-dev}` default fires; `$#` counts; `$@` joins and
  keeps a quoted argument whole (`crust f.crust 'a b'` → one item).
- No args: `$1` → empty, `$#` → `0`; a line referencing `$1` with none passed
  still fails loudly downstream (bad path), not a silent success.
- Exit code still comes from the failing line, unchanged.
- Update the existing expectations in `tests/cli.test.ts` (around lines 471 and
  527-539) that currently assert the rejection; keep the misuse refusals
  (`crust cd /tmp`, `crust logs tail x`) exactly as they are — controls.
- Control: `crust -c 'a' 'b'` still exits 2 with "-c takes one line".
- Control: an existing file named `skills` still runs as a script.

## Docs / website / KB

- `docs/USAGE.md`: run-mode table row + a **Script arguments** subsection (with
  a worked `crust deploy.crust prod` example, `--` form, the shell-stage caveat,
  and `$#` as the guard). Remove the limits bullet.
- `examples/`: add a two-line `examples/args.crust` so the feature is runnable.
- `skills/crust-cli/SKILL.md` (its line 36 currently explains the *rejection*
  as the contract — rewrite) and `skills/crust-builtins/SKILL.md` for `source`.
- Website: `src/pages/docs/quickstart.mdx` + `src/pages/docs/agent-skills/cli.mdx`.
- KB: same file as G04 (`round-10-limits-measured.md`).

## Commit

`feat(cli): scripts take positional arguments — $0 $1 $@ $* $#`
