# G06 — `source` doesn't run bash scripts

**Doc:** `docs/USAGE.md:2193-2195`.

## Measured

`source ./b.sh` where `b.sh` is `if [ -n "$HOME" ]; then …; fi` →

```
sh: -c: line 2: syntax error: unexpected end of file from `if' command on line 1   # exit 2
```

`sourceBuiltin` (`src/builtins.ts:83-106`): `.ts/.js/.mjs` → `await import()`;
everything else → `runLines(text, ctx)`, i.e. line-by-line crust. A multi-line
bash construct is fed one line at a time and dies in sh.

## Design

Keep the line-by-line path for crust files. Add a **bash path** that runs the
script once, in one sh, and brings the exported environment back — which is the
only thing a real `source` can mean across a process boundary.

- **Detection:** extension `.sh|.bash|.zsh`, OR a `#!` first line naming a shell,
  OR an unbalanced-control-word sniff (`if|for|while|case|do|done|fi|esac` at line
  starts) so an extensionless bash script isn't silently mangled. If the shape is
  ambiguous, run the crust path only when the *whole file* parses (see below);
  otherwise **refuse with the two options named** rather than guessing.
- **Run:** `sh <path>` — argv form, not `sh -c '<text>'`, so quoting survives.
  Prefer `bash <path>` when bash exists and the shebang asked for it; fall back
  to `sh` and say which interpreter ran.
- **Capture the env delta:** run `<shell> -c '. <path>; bash -p'`/`export -p`
  (or print `KEY=VALUE` from a NUL-safe separator block) and diff against the
  pre-run snapshot. Apply added/changed keys to `process.env`; keys that
  disappeared stay (crust never unsets on a source — document that).
- **Honesty rules:** side effects run for real (the script executes); stdout /
  stderr are inherited; the script's exit code is the line's code; a script that
  exits nonzero stops a sourced chain (fail-fast already does this in `runLines`).
- **Values with newlines:** use a NUL or `\0`-delimited capture, or refuse
  multi-line values loudly — never truncate one silently.

## Tests (red-first; new `tests/source-bash.test.ts`, tmpdir fixtures)

- `if/fi` + `for` loop script runs to completion, exit 0, and its
  `echo` output appears.
- `export FOO=bar` inside the script is visible to the **next crust line**, and
  inside a later shell stage.
- Nonzero exit from the script → nonzero from `source`; a following line in the
  same sourced file does not run (`runLines` fail-fast parity).
- `.sh` with a `set -e` failure mid-script stops there.
- Env capture survives a value containing a space and one containing a newline
  (or, if refused, the refusal names the value and the script).
- A **crust** file sourced unchanged still works (control), `.ts` still imports
  (control), and `source missing.sh` fails with `source: …` not a stack trace.
- Ambiguous-extensionless file: assert one defined outcome (parses as crust, or
  refuses with both options) — never a partial run.

## Docs / website / KB

- `docs/USAGE.md`: `source` entry (grep "## Builtins"/"source ") + remove the
  limits bullet. State plainly what persists (exported env, cwd? — cwd does
  **not** persist across a child shell, say so) and what doesn't.
- `skills/crust-builtins/SKILL.md` — the builtins table + a worked example.
- Website: `src/pages/docs/agent-skills/builtins.mdx`.
- KB: `knowledge/learnings/round-10-limits-measured.md`.

## Commit

`feat(source): run bash scripts, and bring their exported env back`
