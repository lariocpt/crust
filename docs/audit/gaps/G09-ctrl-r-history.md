# G09 — no fuzzy history search (Ctrl-R)

**Doc:** `docs/USAGE.md:2202-2203` (\"No fuzzy history search (Ctrl-R). v0.1.5\").

## Measured

pty probe: Ctrl-R is swallowed (0x12 is a control byte the editor ignores), the
following keystrokes become an ordinary line (`grep` ran as a command).
`src/editor.ts` has no `0x12` case; `src/history.ts` is append + load with no
search.

## Design

An incremental reverse search over the existing history array, in the editor's
existing single `data`-listener seam (`src/editor.ts`, documented in the KB's
`knowledge/internals/round-5-repl-and-logs.md` — read it first, the repaint and
cursor-column logic is subtle and it is what previous rounds got wrong).

- `0x12` enters search mode: prompt becomes `(crust-search): <query>` on its own
  line, buffer is the match, cursor at end.
- More `0x12` walks further back (same query), printable bytes append to the
  query, `Backspace` shrinks it.
- **Accept:** `←`/`→`, Home/End, or a cursor-moving key keeps the match
  editable; `Enter` runs the match; `Ctrl-G` / `Esc` / `Ctrl-C` cancels and
  restores the pre-search buffer exactly.
- **Matching:** substring, case-insensitive, most-recent-first — the zsh
  behaviour users actually have muscle memory for. A separate fuzzy scorer is a
  later nicety, not required.
- Search must never mutate history; the recalled line is appended again when
  executed only if the repo's current history-dedupe rule allows it (check
  `appendHistory`'s consecutive-duplicate behaviour and keep it).
- Non-TTY (piped stdin) must be untouched.

Guardrail from the AGENTS.md honest-failure rule: if history is empty or the
query matches nothing, the search line shows no match and Enter inserts **the
query as typed text** (zsh semantics) rather than running nothing silently —
pin both.

## Tests

- Unit over a pure `searchHistory(history, query, skip)` helper (keep the search
  logic out of the editor so it is testable): ordering, case-insensitivity,
  no-match, empty history, duplicates.
- Editor-level keystroke tests (existing editor-test harness): `0x12` + `GET`
  finds the newest `GET` line; second `0x12` finds the older one; `Enter` runs
  it (assert via a stubbed runner); `Ctrl-G` restores the draft; `Backspace`
  narrows; cancel restores exactly, including a draft with ANSI-free multi-width
  characters.
- Control: normal editing keys still work after leaving search; the plain `↑`
  history walk is unchanged; `CRUST_CONFIG=/dev/null` (no history file) does not
  crash search — it reports no match.
- Cursor-column/repaint control (the round-5 trap): a long match longer than the
  terminal width must not corrupt the prompt.

## Docs / website / KB

- `docs/USAGE.md`: keybindings table row `Ctrl-R` + a short \"Incremental
  history search\" paragraph mirroring the accept/cancel semantics exactly;
  limits bullet goes.
- `skills/crust-cli/SKILL.md` REPL section.
- Website: `src/pages/docs/quickstart.mdx` / the docs page that lists keybindings
  (grep `Ctrl-` to find it).
- KB: `knowledge/learnings/round-10-limits-measured.md`, plus an update to
  `knowledge/internals/round-5-repl-and-logs.md` (the editor seam gained a mode).

## Commit

`feat(repl): incremental reverse history search on Ctrl-R`
