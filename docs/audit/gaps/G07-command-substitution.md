# G07 — no `$(...)` in cross-stage position

**Doc:** `docs/USAGE.md:2196` (\"`$(...)` inside a shell stage is delegated to
sh\"), parked in `docs/PLAN.md` and `docs/spec/v0.1-contract.md`.

## Measured

| line | result |
|---|---|
| `echo $(echo a b \\| tr \" \" \"-\")` | `a-b` — one shell stage, sh does it, tokenizer keeps the inner `\\|` (depth tracking in `tokenize` is correct) |
| `range(1,3) \\| grep $(echo 1)` | works — the shell-stage half expands it |
| `range(1,$(echo 3))` | **falls through to shell**, dies with `sh: syntax error near unexpected token \\`1,$(echo 3)'` |
| `GET $(echo httpbin.org)/get \\| expect 200` | **`getaddrinfo ENOTFOUND $(echo`** — crust built the URL from the literal text |

So the claim is true and the failure mode is worse than \"not supported\": the
`GET` one resolves host `$(echo`, which reads like a network problem.

## Design

Do **not** add a substitution grammar to every stage. Add it in the one place
arguments are already expanded, and make everything else honest.

1. **`$(...)` / backticks are substituted by `sh` once, at the head of a shell
   stage** — that is already true and stays the documented mechanism.
2. **In crust stages, `$(...)` is refused with a message that names the two
   ways that work.** Widen the existing `rejectRedirect`-style guard
   (`src/lexer.ts:157-167`) with a `substitutionTail()` check mirroring
   `redirectTail()`: if a non-shell stage carries an unquoted, depth-0 `$(…)` or
   backtick, throw
   `crust: \\`$(…)\\` runs in a shell stage only — either end the line with a
   shell stage (\\`| sh \"…\"\\`), or capture it first: \\`sh \"cmd\" | capture NAME\\`
   and use `$NAME` downstream.` Refuse; never build the host/path/regex from
   literal `$(echo`.
3. **The capture route is the feature, and it already exists.** `capture NAME`
   (`src/lexer.ts:296-300` → `captureEnv`) writes env that later stages expand
   through `expandEnv`. Confirm by probe that this round-trips and make it the
   documented answer:
   `sh \"date +%s\" | capture TS` then `GET host/?t=$TS`. If a trailing newline
   breaks the captured value (it will — shells emit one), **trim trailing
   newlines in `captureEnv`** and pin it; that is a real bug in the workaround
   the docs point at.
4. Keep the guard *after* stage classification so shell stages are untouched,
   exactly like the redirect guard, and reuse the same \"the refusal must name
   the fix\" style.

## Tests (red-first; extend `tests/redirect.test.ts` or new `tests/substitution.test.ts`)

- `GET $(echo host)/get` refuses with `/\\$\\(…\\) runs in a shell stage/`,
  exit nonzero, **and performs no request** (control: a real request still
  succeeds on the same host in the same file).
- `range(1,$(echo 3))` refuses with the same message, not sh's syntax error.
- `(x => x + $(date))` and `grep $(echo p)`-as-crust-stage: same refusal.
- `capture` round-trip: `printf '7\\n' | … sh \"echo 7\" | capture N` then
  `echo \"[$N]\"` → `[7]`, no trailing newline in the value; and a shell stage
  downstream sees `$N` expanded (crust hands the stage text to sh — pin which of
  the two expanded it).
- Controls: `echo $(seq 3) | wc -w` still prints `3`; a quoted literal
  `'$(nope)'` inside a crust stage stays literal (no spawn); a backtick inside a
  double-quoted JS lambda body is untouched by the guard (compile a lambda that
  contains a template literal with a `$` in it).

## Docs / website / KB

- `docs/USAGE.md`: replace the limits bullet with the honest rule — substitution
  happens in shell stages; crust stages expand `$VAR`, so capture into a var.
  Add a worked two-line example in the `capture` section (grep `capture NAME`).
- `skills/crust-pipelines/SKILL.md` (its `$`-handling row: unknown flags/`$`
  already push grep to sh — align) and `skills/crust-builtins/SKILL.md`.
- Website: `src/pages/docs/pipes-vs-typescript.mdx` and
  `src/pages/docs/agent-skills/pipelines.mdx` — wherever `$VAR` expansion is
  described.
- KB: `knowledge/learnings/round-10-limits-measured.md`, including the
  `capture` trailing-newline finding.

## Commit

`feat(lexer): refuse $(…) on a crust stage and make capture the named route`
