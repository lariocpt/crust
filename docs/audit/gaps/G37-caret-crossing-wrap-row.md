# G37 — moving the caret across a wrap row of a wrapped draft lands it on the
wrong row, and the next repaint smears

**Doc:** nowhere — no page claims anything about caret movement on a wrapped
line. Found while measuring the **G31** fix (2026-10-30), which had to ask
whether the caret *placement* inside a wrapped line was in scope. It is
PRE-EXISTING: the single-backtab `place()` rule dates from G09/G32, and the
terminal's clamp behaviour predates every crust change; the G31 smear simply
masked it (every repaint was already wrong, so nobody could tell the caret was
wrong too).

## Measured (tmux, `bin/crust-bin`, 30-column window)

35-cell git-aware prompt + 62 ASCII chars typed — the whole line is 97 cells
= 4 rows. Self-calibrating probe (`~/tmp/g31/probe-caret.sh`): it measures the
prompt's width from the caret the editor leaves after the prompt alone, then
derives every expected caret position from the line's FIRST row. (tmux
`#{cursor_x}/#{cursor_y}` are 0-based; `capture-pane` line numbers are 1-based
— the probe's first version mixed the two and its verdicts were coincidental,
so the numbers below come from the calibrated run.)

```
at end of line           got x=7  y=9   expected x=7  y=9   OK
1 Left (same row)        got x=6  y=9   expected x=6  y=9   OK
8 Left (CROSSES a row)   got x=0  y=9   expected x=29 y=8   WRONG
```

The expected row for 8 lefts is the row ABOVE the line's end row (offset 89
sits in row 2 of 3); the drawn caret sits at column 0 of the END row (row 3).

And one keystroke after the crossing:

```
~/Projects/personal/crust (mai   <- old first row, left stranded
~/Projects/personal/crust (mai   <- repaint re-emitted from the line's row 2
n) $ abcdefghijklmnopqrstuvwxy
z0123456789ABCDEFGHIJKLMNOPQRz
STUVWXYZ                        <- spilled one row past the line's own end
```

The G31 smear signature is back: the first row of the prompt is duplicated and
the line is re-emitted from its own second row. Display-only again — the line
still runs (the buffer caret is always correct). The disagreement also
COMPOUNDS: each further keystroke climbs from a cursor that is already too
low, so the line drifts down the screen — an earlier 12-Left walk ended with
the caret two rows below the line's last row.

## Cause

`place(n)` in `src/editor.ts` is a single backtab — `CSI n D`, `n` = cells
between the caret and the end of the paint. A terminal's CUB stops at column 0
of the CURRENT row; it does NOT climb to the previous row. So when the caret's
true row is above the row the end of the line sits on, the drawn caret clamps
at column 0 of the end row — one or more rows too low — while the editor's
bookkeeping (`draftCaretCells`) still records the caret's true offset. The
next `render()` then climbs `floor(draftCaretCells / width)` rows from where
the cursor ACTUALLY is, lands on the line's row `endRow - trueRow` instead of
its row `trueRow` (equal only for a caret exactly mid-line), and the repaint
re-emits the line from the middle of itself.

Two independent defects in one measurement:

1. the caret lands on the wrong cell (CUB clamp) — visible on the crossing
   move itself;
2. the recorded offset and the physical cursor disagree, so the G31 climb
   undershoots and the smear returns — visible on the next keystroke.

## Why it is not G31

G31 = the repaint started from the wrong row because the cursor sits on the
line's LAST row and `\r` is relative to the current row; fixed by climbing to
the first row and erasing to the bottom. G37 = the caret PLACEMENT (the
backtab) cannot cross a wrap boundary. Different site, different mechanism,
and G37 was unobservable before G31: with every repaint already smeared, the
caret's row could not be trusted either way. G31's dossier excludes it.

## Fix direction (not yet measured — measure before documenting)

Row-aware placement. The caret's target row/column fall out of the recorded
cells exactly like the G31 climb (`offset o` → row `floor(o / width)`,
column `o % width`, exact-multiple case included — the same model as
`backToCol0`); the paint's end row/column fall out of `draftPaintCells`. Then:

- same row: today's single `CSI n D` (a control test keeps it);
- target row above the end row: `CSI (endRow - targetRow) A`, then
  `CSI (endCol - targetCol) D` when `endCol > targetCol`;
- the caret is never to the right of the paint's end, so no descend is needed.

Tests: byte-level (the crossing move must emit the climb + a shorter backtab;
the same-row move must stay a single backtab), plus the self-calibrating pty
probe above turning green on every case — including the post-crossing
keystroke, whose pane must still start the line on its first row.

## Docs / KB

Nothing to retract: no page claims caret placement on wrapped lines. If the
fix lands as sketched it is display-only and needs no Limits bullet (the G32
rule). KB: a round-5 seam addendum entry, pending the fix — the seam already
carries the search-line rules, and this is the third member of the family
(draft repaint, caret placement, and the flush flag all measure the editor's
own paints instead of asking the terminal).
