# G04 — plain `FOO=x` assignments don't persist across lines

**Doc:** `docs/USAGE.md:2184-2185`.

## Measured

```
$ crust -c 'FOO=bar
echo "[$FOO]"'
[]
```

`FOO=bar` is not a builtin head (`src/runLine.ts:112`), so it is one
`sh -c 'FOO=bar'` — a subprocess that exits and forgets. `export FOO=bar` in the
same shape prints `[bar]`.

## Fix

Intercept a **bare assignment line** in `runLine`, next to the builtin gate:

- Shape: one or more `NAME=VALUE` tokens, no other text, no unquoted shell
  metacharacters (`hasUnquotedShellMeta` already guards that), names matching
  `^[A-Za-z_][A-Za-z0-9_]*$`. Split values with `splitArgs` so `FOO="a b"` works.
- Effect: write `process.env` and return 0 — i.e. identical to `export`, which
  is what people expect `FOO=x` to have done.
- Share the code: extract the loop from `exportBuiltin`
  (`src/builtins.ts:35-51`) into `assignEnv(parts)` and call it from both, so
  the two can never drift.
- Support `NAME+=VAL` (append) while we are here; a stray `FOO+=x` today becomes
  a literal shell word.

### Two decisions to record

1. **`NAME=value cmd args` stays sh's transient semantics.** The line is not
   bare, so it still goes to `sh -c`, sets the var for that command only, and
   nothing persists. That is correct shell behaviour and persisting it would be
   a regression. Pin it with a control test.
2. **Expand `$VAR` in the assigned value** (`FOO=$BAR`, `FOO=${BAR:-d}` via
   `expandEnv`, `src/args.ts:269`). Today `export FOO=$BAR` stores the literal
   `$BAR` — a value that looks set and reads wrong downstream, i.e. a false
   pass by crust's own standard. Apply to both spellings, CHANGELOG it as a
   fix, and pin both the expansion and the quoted-`$` escape (`FOO='$BAR'`).

## Tests (red-first; new `tests/env-assignment.test.ts`)

- Persists across lines in `-c`, in a script file, and across two `runLine`
  calls on one shared ctx (the REPL shape).
- Quoted value with a space; two pairs on one line; `FOO=` sets empty; `PATH=…:$PATH`
  reaches a later shell stage.
- `FOO=$BAR` and `FOO=${BAR:-fallback}` expand; `FOO='$BAR'` stays literal.
- `FOO+=x` appends.
- Control: `FOO=bar echo $FOO` prints `bar` and the **next** line sees nothing.
- Control: `export FOO=x` still works; `FOO=x | wc -l` is still a pipeline
  (assignment handling must not swallow stages); a line that merely *starts* with
  something assignment-shaped but carries metachars (`FOO=x && echo hi`) still
  runs through sh unchanged.

## Docs / website / KB

- `docs/USAGE.md`: the limits bullet shrinks to the transient-prefix case only
  ("`FOO=x cmd` is transient, as in sh"). Add the rule where `export` is
  documented (grep `export FOO`), and in the "Environment" area near `dotenv`.
- `skills/crust-builtins/SKILL.md`: `export` section gains the
  "`FOO=x` alone is the same thing" line; `skills/crust-cli/SKILL.md` if it
  shows env setup.
- Website: `src/pages/docs/quickstart.mdx` and
  `src/pages/docs/agent-skills/builtins.mdx` (grep `export ` to locate).
- KB: `knowledge/learnings/round-10-limits-measured.md`.

## Commit

`feat(env): a bare FOO=x line sets the session environment, like export`
