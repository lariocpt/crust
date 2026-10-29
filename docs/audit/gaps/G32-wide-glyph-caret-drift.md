# G32 — the caret drifts on double-width glyphs (display-only; found while costing G11)

**Doc:** nothing claims this works. `docs/USAGE.md` → "Editor keybindings"
promises `←`/`→`/`Home`/`End` and Tab completion, all of which are column
operations. `src/editor.ts:342` admits the cause in a comment written for another
feature: the editor cannot know "double-width glyphs, tabs, and the difference
between the cursor's column and the last column that holds a glyph".

## Measured (tmux `#{cursor_x}`, 2026-10-29, crust `bin/crust-bin` @ `cdde3c5`)

Type a line, press `Ctrl-A`, read where the terminal caret actually is. Each case
starts from a freshly submitted (empty) line and re-reads the baseline caret, so no
row inherits the previous row's screen state — an earlier harness that reused the
line via `Ctrl-U` produced drift figures up to **+11** on buffers with *no* wide
glyphs, and those numbers are wrong (kept as `g32-measure.py`, the counter-example;
the clean one is `g32-measure2.py`).

Prompt width 16 (`/tmp/opencode $ `), measured in the same session. `cells` is the
naive East-Asian-width model a `cells()` helper would start with.

| Buffer | chars | cells | caret at end | ideal | after `Ctrl-A` | drift | `cells − chars` |
|---|---|---|---|---|---|---|---|
| `echo aaaaaa` | 11 | 11 | 27 | 27 ✓ | 16 ✓ | 0 | 0 |
| `echo ab` | 7 | 7 | 23 | 23 ✓ | 16 ✓ | 0 | 0 |
| `echo 日本` | 7 | 9 | 25 | 25 ✓ | **18** | **+2** | 2 |
| `echo 日本語日本x` | 11 | 16 | 32 | 32 ✓ | **21** | **+5** | 5 |
| `echo a✅b✅c✅` | 11 | 14 | 30 | 30 ✓ | **19** | **+3** | 3 |
| `echo a✅b` | 8 | 9 | 25 | 25 ✓ | **17** | **+1** | 1 |
| `echo ─────` (box drawing) | 10 | 10 | 26 | 26 ✓ | 16 ✓ | 0 | 0 |
| `echo éx` | 7 | 7 | 23 | 23 ✓ | 16 ✓ | 0 | 0 |

**Drift is exactly `cells − chars` right of the caret, 8/8.** Two things fall out
that a fixer needs:

- The *paint* is right every time (`caret at end` = prompt + cells, 8/8): the
  terminal knows the widths. Only the editor's own back-tab is wrong, because
  `place(n)` (`src/editor.ts:204`) emits `CSI n D` with `n = buf.length - cursor` —
  a **character** count, while a terminal's back-tab moves **columns**.
- The naive width model agrees with this terminal on all eight buffers, including
  emoji (U+2705 is East-Asian-Wide) and box drawing (ambiguous → rendered **1 cell**
  here). So the `cells()` sketch below is viable without a full Unicode table —
  but "ambiguous" is a locale question, so pin the box-drawing row as a documented
  choice rather than a fact.

Re-run identically with `LANG=en_US.UTF-8 LC_CTYPE=en_US.UTF-8` in the pane
(`g32-measure-utf8.py`): every row identical, so it is **not** a locale artifact.

**Mechanism:** the same char-vs-column mixing appears in `backToCol0(n, width)`
(`:218`), in `promptLen = stripAnsi(prompt).length` (`:195`), and in the
`draftWrapped` / `searchVisual` wrap arithmetic (`:259`), which is why this is
G31's neighbour: both are the "the editor measures its own paints" model meeting a
terminal whose units are cells.

**Not affected:** the buffer. Insertion happens at a char index, so what runs is
always correct — verified by typing `echo 日本`, pressing `Ctrl-A`, typing `#` and
running it: `#echo 日本`. The user sees the caret one or two glyphs to the right of
where the character will land. Display-only, but it makes editing any line with
CJK, emoji or box-drawing characters blind.

## Design (small, and it wants a byte test + a pty probe)

- Add one `cells(text)` helper (2 for East Asian Wide/Fullwidth and the emoji
  ranges, 0 for combining marks and ZWJ joiners, 1 otherwise) and use it for
  **every** column computation: `place()`, `backToCol0()`, `draftWrapped`,
  `searchVisual`/`searchRows`. `promptLen` already strips ANSI; it needs cells too.
- Keep `buf` in characters (editing is char-index based and correct). The rule to
  write in the file: *characters for the buffer, cells for the terminal*.
- `stripAnsi` + `cells` should be one pass so a paint does not measure twice.

## Tests

- Byte-level: for a known buffer with wide glyphs, assert the emitted
  `CSI n D` count (the existing editor byte assertions are the harness — G09's
  search-paint tests already pin escape counts).
- Table test over `cells()`: CJK, fullwidth forms, combining accents, ZWJ emoji
  family, box drawing, ASCII (the control that must stay exact).
- pty probe (the one that found this): tmux `#{cursor_x}` after `Ctrl-A` for a
  table of buffers, **fresh prompt per case** with the baseline caret re-read. Probe
  corpus: `/tmp/opencode/g32-measure2.py` (the good one), `g32-measure-utf8.py`
  (locale control), `g32-measure.py` (contaminated harness — it reused the line and
  invented +11 drift on ASCII-only rows; keep as the counter-example), plus
  `g11-caret.sh`, `g11-locale.sh` and `g11-wide.sh` (the last is the **wrong**
  oracle — it reads the buffer through `echo`, which is why this bug survived it).
- Control that must stay green: `Ctrl-L` repaint, Ctrl-R search paint, and the
  wrapped-draft continuation rows (G31's territory) — a cells-based `place()`
  changes the numbers those paths already depend on.

## Docs / website / KB

- It is a bug, not a feature gap, so it gets **no Limits bullet** — nobody should
  read it as supported-then-removed. It is cited once, as evidence, in the
  highlighting sentence in `docs/USAGE.md` → "Limits in v0.2" (the reason G11
  closed is that highlighting would land on this arithmetic), and that citation is
  the only place it may appear in user docs until it is fixed — at which point the
  citation goes away with the bug.
- KB: recorded inside `knowledge/learnings/round-10-highlighting-costed.md`
  (§ "the column arithmetic is the real cost"), since it is the reason G11 closed.

## Commit

`fix(repl): caret columns count cells, not characters (double-width glyphs)`
