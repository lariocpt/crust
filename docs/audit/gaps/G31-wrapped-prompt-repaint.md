# G31 — a prompt that wraps the terminal smears on every keystroke

**Doc:** nowhere — no page claims anything about a prompt wider than the
terminal. Found while probing **G09** (Ctrl-R search, 2026-10-27), which had to
reason about exactly this geometry. It is PRE-EXISTING: the probe below touches
no search code, and G09 neither causes nor fixes it.

## Measured (tmux, `bin/crust-bin`, no Ctrl-R at any point)

30-column window at a cwd whose git-aware prompt is 35 characters, so the
**prompt alone wraps**. `/tmp/opencode/probe-g31.sh` drives it and captures the
pane (row numbers from `grep -n`, blanks dropped):

```
=== 1. right after start (prompt wraps on its own) ===
1:~/Projects/personal/crust (mai
2:n) $

=== 2. after typing `echo` ===
1:~/Projects/personal/crust (mai
2:~/Projects/personal/crust (mai
3:n) $ echo

=== 3. after typing ` hi` ===
1:~/Projects/personal/crust (mai
2:~/Projects/personal/crust (mai
3:~/Projects/personal/crust (mai
4:n) $ echo hi

=== 4. after Enter (does the line run correctly?) ===
…
4:n) $ echo hi
5:hi
6:~/Projects/personal/crust (mai
7:n) $
```

Every keystroke pushes another copy of the prompt down the screen and overwrites
the row above; after three repaints the first row of the real prompt is gone.
**Display-only:** step 4 shows the line still runs and prints `hi`, and the
submitted text is correct — which is precisely why this has survived: the
function is fine, the screen is a mess, and nothing tests a wrapped prompt.

Same shape at width 24 with the same prompt (measured during the G09 probes,
typing `echo hi` then more).

## Cause

`render()` in `src/editor.ts` is one line:

```ts
stdout.write("\r" + prompt + buf + CSI + "K");
```

`"\r"` returns to column 0 of the **current row** — and when `prompt + buf` is
wider than the terminal, the cursor is on the LAST row of that logical line. So
the repaint re-emits the whole `prompt + buf` starting there, and the wrap pushes
a new row each time. Round 5 fixed cursor math *inside* a wrapped line (the
`round-5-repl-and-logs.md` internals note); the case where the **prompt itself**
wraps was never handled, and it is reachable with an ordinary long cwd.

## Design sketch

The editor already learned this model in G09 for the search line: it measures
its OWN paints (`backToCol0(n, width) = (n - 1) % width + 1`, spilled rows
`= (n - 1) / width`) instead of asking the terminal where the cursor is, because
that question has no portable answer. Apply the same accounting to the draft
line:

- track the rows the last `prompt + buf` paint occupied;
- before repainting, climb to the line's FIRST row (`CSI n A`), then `CR` +
  `CSI J` (erase to the bottom — `CSI K` only reaches the cursor's row), then
  paint `prompt + buf` and let the terminal wrap as it will;
- the cursor placement after the paint is the same `place(visualEnd - cursorCol)`
  rule G09 introduced, so the two lines finally share one geometry helper set.

Two things to decide in the fix, not here:

- **Cell width.** The arithmetic counts UTF-16 units. `héllo` is fine (BMP
  single-width), `☺` and any wide/CJK glyph are not — the same limitation
  `render()` has today, so the fix must not *claim* to solve it. If it cannot
  measure width, say so in the code comment and keep the gap open for a
  width-aware measure.
- **Scroll at the bottom row.** Never open a line with a newline when the paint
  may sit on the last row (that is how a prompt eats scrollback — see the G09
  rules in the KB's round-5 seam addendum).

## Tests

Byte-level, using the `columns` capture the G09 harness added
(`tests/history-ctrl-r.test.ts`'s `captureStreams(columns)`): a prompt + buffer
wider than `columns` must (a) climb to the first row before repainting, (b) erase
with `CSI J` rather than `CSI K` alone, and (c) never emit a bare newline.
Control: a prompt + buffer narrower than `columns` keeps today's minimal repaint
(no climb, no scroll) — the fix must not start moving the cursor on a one-row
line.

**And a pty probe, mandatory** (the G09 lesson, recorded in the KB: byte
assertions prove what was *written*, not what the screen *looks like*): 30-column
tmux, wrapped git prompt, type, `capture-pane`, assert the prompt appears ONCE.

## Docs / website / KB

Until fixed: a Limits bullet in `docs/USAGE.md` ("the REPL prompt assumes
`prompt + line` fit the terminal width") with website parity — a user with a
long cwd and a narrow terminal deserves to know before they file it as a crash.
KB: extend the round-5 seam addendum (the search-line rules are already there;
this is the draft-line twin), and close the §10 note in
`round-10-limits-measured.md` that flags it as pre-existing.

## Commit

`fix(repl): repaint a wrapped prompt line from its first row`
