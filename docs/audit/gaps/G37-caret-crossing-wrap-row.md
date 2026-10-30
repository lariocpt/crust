# G37 — moving the caret across a wrap row of a wrapped draft lands it on the
wrong row, and the next repaint smears

**FIXED 2026-10-31** — crust `711e029` (code + 6 byte tests) · audit (this
commit) · KB (crust-agent submodule, local commit only — ingest is
operator-controlled, `23b1536e`): `round-10-wrapped-prompt-repaint.md` closes §4 and
corrects its header; four stale "G37 still open" pointers corrected in three
sibling files.

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

## The fix (measured before documenting, as the filing demanded)

One position model for both ends of the placement — the same model
`backToCol0` and the G31 climb are built on: an offset `o` sits at row
`floor(o / width)`, column `o % width`, and an exact multiple of the width
sits at column 0 of the **next** row (the wrap is pending or already
happened), which `floor()` gives for free. The caret's target falls out of
the recorded caret offset, the paint's end out of the recorded paint cells,
and `placeCaret(o, v, width)` then:

- **same row** → the single `CSI (eCol - tCol) D` backtab the pre-fix code
  got right (within one row, `v - o` = `eCol - tCol`) — kept, and
  control-pinned so a line that fits never gains row moves;
- **crossing, target column LEFT of the end column** →
  `CSI (eRow - tRow) A` then `CSI (eCol - tCol) D`;
- **crossing, target column RIGHT of the end column** → `CSI (eRow - tRow) A`
  then `CSI (tCol - eCol) C` — **the subcase the recorded direction
  missed**: a backtab (CUB) can only move LEFT, so a target to the right of
  the end column must use CUF, and CUF cannot scroll here because the target
  column is inside the row and the move never crosses the right margin. Every
  flush or pending-wrap end (`v % width == 0` → the paint ends at column 0 of
  the row below) produces exactly this case whenever the caret sits anywhere
  in the row above;
- **equal columns** → the climb alone;
- **descend** → impossible: `o <= v` is monotone, the caret is never past the
  paint's end.

`paintDraft` now computes the caret offset once and derives both the
placement and the recorded `draftCaretCells` from it, so measure and motion
cannot drift (G32's rule). `place` / `placeRightOfCaret` are retired — the
search line never used them (it counts back with `backToCol0`), and the old
"one cursor rule the draft line and the search line share" comment was
already stale and died with the code.

### Byte tests (red-first: 4 red / 2 green against the pre-fix tree)

| # | case | setup (30 cols unless noted) | expected placement | pre-fix bytes |
|---|------|------------------------------|--------------------|---------------|
| 1 | control: same row | 6-cell line, 1 left | `CSI 1 D`, no `A`/`C` anywhere | green |
| 2 | control: caret at the end | 5-cell line, no navigation | nothing between the paint's `CSI K` and the newline | green |
| 3 | crossing, backtab subcase | 35-cell line (end at row 1, col 5), 33 lefts → offset 2 (row 0, col 2) | `CSI 1 A` + `CSI 3 D` | `CSI 33 D` (clamped) |
| 4 | crossing, CUF subcase (FLUSH end) | 60-cell line, end exactly at the width → col 0 of the row below; 1 left → offset 59 | `CSI 1 A` + `CSI 29 C` | `CSI 1 D` |
| 5 | crossing, equal columns (EXACT multiple) | 60-cell line; 30 lefts → offset 30 = col 0 of the row BELOW | `CSI 1 A` alone | `CSI 30 D` |
| 6 | cells, not characters | 10 cols, 2-cell prompt, buffer `日本aaaa` (8 cells, flush); 4 lefts → offset 6, after the prefix's 4 cells | `CSI 1 A` + `CSI 6 C` — a char-counting placement would aim at col 4 | `CSI 4 D` |

Each crossing test's expected tail is taken between the last draft paint's
`CSI K` and the newline, isolating the placement from the G31 climb that
precedes it (the climb bytes are identical pre/post — the record was never
the liar, the cursor was).

### Mutation matrix (4 pins, one site at a time, tree restored byte-for-byte)

| pin | kill set | what it localises |
|-----|----------|-------------------|
| M1 — restore the pre-fix single backtab | tests 3, 4, 5, 6 | row-awareness as a whole (every crossing test) |
| M2 — CUF branch removed | tests 4, 6 | the CUF subcase (both are targets right of a flush end) |
| M3 — D-after-A branch removed | test 3 | the backtab subcase (3 is the only target left of the end column) |
| M4 — exact multiple kept on the LOWER row | tests 4, 6 | the exact-multiple ROW rule, pinned at the end (v) side |

The two controls stay green under every pin. One recorded deviation from the
plan: M4 was expected to kill test 5 as well — it does not. Test 5 has BOTH
offset and end as exact multiples, and a uniform row shift (breaking both
sides of the same shared function) cancels in `eRow - tRow`: the broken model
emits the same one-row climb with equal columns. Test 5 therefore pins the
equal-columns subcase (climb-only placement), and the caret-side (o) exact
multiple is covered by the very `caretRowCol` call the v-side tests pin —
there is no per-side code path.

### Pty probe (`~/tmp/g37/probe-caret.sh`, self-calibrating; 35-cell prompt +
62 chars = 97-cell line in 30 columns; pre-fix and fixed binary pair)

Rows are relative to the line's own first row (the two runs self-calibrated
to different absolute rows — L=7 and L=8 — so the absolute y differs between
binaries; x and the relative row are the comparison).

| case (caret offset) | expected (x, rel row) | pre-fix got | pre-fix | fixed got | fixed |
|---------------------|-----------------------|-------------|---------|-----------|-------|
| at end of line (97) | x=7, row 3 | x=7, row 3 | OK | x=7, row 3 | OK |
| 1 Left, same row (96) | x=6, row 3 | x=6, row 3 | OK | x=6, row 3 | OK |
| 8 Lefts, CROSSES (89) | x=29, row 2 | **x=0, row 3** | WRONG | x=29, row 2 | OK |
| 12 Lefts, deeper (85) | x=25, row 2 | **x=0, row 7** | WRONG | x=25, row 2 | OK |
| one keystroke past the crossing (86) | x=26, row 2 | **x=0, row 8** | WRONG | x=26, row 2 | OK |

Prompt first-row occurrences after the post-crossing keystroke: **6**
pre-fix (the G31 smear signature — duplicated prompt rows, the line
re-emitted from its own second row and spilling past its end) vs **1** fixed.
The pre-fix 8-lefts numbers reproduce the original filing measurement
exactly: expected (x=29, row 2), got (x=0, row 3). The 12-left walk here is
8+4 with a repaint at every left, so the drift compounds deeper than the
filing's continuous 12-left walk (which ended two rows below the line's last
row): five rows below the true row. The point holds either way — the
disagreement grows with every keystroke, and the fixed binary is exact on
every case.

## Docs / website / MCP / KB

- **No USAGE / site change.** A fixed bug earns no Limits bullet (the G32
  rule), and nothing in `docs/USAGE.md` or the website claims anything about
  caret placement on wrapped lines — the REPL keybindings table lists what
  each key does, not placement semantics.
- **MCP reviewed — no overlap.** The nine `crust_*` tools never surface the
  interactive editor, and neither the `crust-mcp` skill nor the USAGE MCP
  section documents caret or keybinding semantics, so a display-only
  placement change owes the MCP surface no update (standing order 2026-10-31;
  recorded here rather than silently skipped).
- **KB** (crust-agent submodule, local commit only — ingest is
  operator-controlled, `23b1536e`): `round-10-wrapped-prompt-repaint.md` — the seam file,
  and this gap's home per G31's entry (the filing line's "round-5 seam
  addendum" memory was stale: round 5 is where the family's rules came from,
  round 10 §15 is where the family is recorded) — closes §4 with the measured
  fix (including the CUF subcase and the exact-multiple model) and corrects
  the header's "still open". Four stale "G37 still open" pointers corrected in
  `round-10-cells-vs-characters.md`, `round-10-grapheme-cursor.md` and
  `round-10-limits-measured.md`, pointing at the closed seam entry.

## Commit

- Code: `711e029` — `fix(repl): place the draft caret by row and column across wrap rows (G37)`
- Audit: this commit (dossier + plan + progress; the probe scripts live in
  `~/tmp/g37/` and are referenced by path, per the G31 pattern).
