# G03 — redirect refusal has a coverage hole (`range(1,3) > f`)

**Doc:** `docs/USAGE.md:2197-2199` and §redirects (`docs/USAGE.md:242-255`):
"anywhere else the line is refused".

## Measured

`classify()` in `src/lexer.ts:157-167` checks `rejectRedirect` **after**
`classifyStage`, and only when the kind is not `shell`. A crust source with a
redirect tail appended no longer matches its own pattern, so it falls through to
`shell` and the check is skipped:

```
$ bun src/index.ts --check 'range(1,3) > /tmp/o.txt'
crust: shell stage does not parse: sh: -c: line 1: syntax error near unexpected token `1,3'
```

`GET http://x/y > /tmp/o.json` and `lines f > g` **do** get the good refusal.
So the promise holds for stages that still classify, and breaks for the ones
that don't — the user gets sh's error, exit 2, and no pointer to `| cat > f`.

## Fix

In `classify()`: when `redirectTail(text)` is non-null and
`classifyStage(text).kind === "shell"`, re-classify the text with the tail
removed. If that yields a **non-shell, non-grep** kind, throw the same
`refusal(...)` error the other path throws.

Two carve-outs, both deliberate:

- `grep` keeps the current behaviour. `grep ERROR > combined.log` is a redirect
  that **works today** and is documented as such (first-position grep is file
  grep via sh). Refusing it would break working lines.
- Anything that still classifies as `shell` after stripping (`cat > f`,
  `ls > f`, `read a < f`) keeps sh's redirect.

Probe before coding (record the answers in the test file):
`src/**/*.ts > f`, `read **/*.log > f`, `{"a":1} > f`, `[1,2] > f`,
`range(1,3) >> f`, `tail -f app.log > f`, `sql "SELECT 1" > f`. For each, the
answer must be either "sh runs it for real" or "crust refuses with its own
message" — never sh's syntax error.

## Tests (red-first, extend `tests/redirect.test.ts`)

- Red: `classify("range(1,3) > /tmp/o.txt")` throws `/redirect/`; same for
  `read **/*.log > f`, `tail -f app.log > f`, `GET :3000/x >> f`.
- Runtime: `bun src/index.ts -c 'range(1,3) > /tmp/…'` prints crust's refusal
  (`/crust has no redirect/`) and **creates no file**.
- Controls that must stay green: `cat > f` writes the file; `grep ERROR > f`
  writes it; `range(1,3) | cat > f` writes 3 lines; a quoted `>` inside an
  argument (`echo "a > b"`) is untouched; `[1,2]` without a redirect still
  parses as a JSON literal.

## Docs / website / KB

- `docs/USAGE.md` §redirects: the "anywhere else the line is refused" sentence
  becomes literally true — keep it, and show one refusal example per shape
  (source-stage and transform-stage).
- `skills/crust-pipelines/SKILL.md:125-130` and `skills/crust-builtins/SKILL.md:113-145`:
  the refusal samples already match; add the source-stage line if the wording of
  the emitted message changes.
- Website: `src/pages/docs/agent-skills/pipelines.mdx` carries the same
  no-redirect note — keep it in step in the same PR.
- KB: `knowledge/learnings/round-10-limits-measured.md` (new/refusals found in
  this pass; round-9 already has `round-9-loud-refusals.md`).

## Commit

`fix(lexer): a crust source carrying a redirect is refused by crust, not by sh`

## Status — DONE (2026-10-17)

crust `9852e4a` (`feat(lexer): a redirect can no longer hide a crust stage from
classification`), site `02634ee`, KB `68e5035` (round-10 §3).

What the measurement added over this plan: the leak was not just sources — it was
**argument-taking keyword stages** (`range`, `capture`, `parallel`, `expect`,
`stats`, `stdin`, `load`), because those patterns are the ones a trailing `> f`
breaks; sources/glob/lines/JSON/http already refused. `parallel 5 > f` was the
worst case: GNU parallel is installed, so it **exited 0 with an empty file**.
Implemented in `classify` (strip the tail, re-classify, refuse naming the real
stage) with two carve-outs: `grep` keeps its redirect, and a head that is broken
without the tail keeps its own error (`load 10s > f`). `load 10s 100/s > f`
needed the tail check on the *throw* path too, since the tail broke load's own
parser before classification. Suite: 1133 pass / 1 skip / 0 fail.
