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

---

## FIXED — 2026-10-30

`fix(repl): caret columns count cells, not characters (double-width glyphs)`

### What shipped

`src/width.ts` — `cells(text)`: COLUMNS, not code units.

- **Measure:** East_Asian_Width `W`/`F` = 2 cells, everything else 1.
- **Generated data:** `src/widthTable.ts` — 122 `W`/`F` ranges (Unicode 16.0.0) plus
  368 zero-width ranges (`Mn`, `Me`, `Cf` — **`Mc` excluded**, spacing marks really
  do occupy a cell).
- **Clustering:** `Intl.Segmenter` graphemes, so ZWJ families and regional-indicator
  flags count as the one glyph the terminal shows.
- **Fast path:** an ASCII-only string returns `text.length` without touching the
  segmenter or the tables, so the fix is free on ordinary commands.

Every site that turns a length into terminal movement now goes through it — one
conversion point per concern, each mutation-pinned:

| site | before | after |
|---|---|---|
| `placeRightOfCaret()` (new, used by `render` + `paintDraft`) | `place(buf.length - cursor)` | `place(cells(buf.slice(cursor)))` |
| `render()` flush detection | `promptLen + buf.length` | `promptLen + cells(buf)` |
| `paintSearch()` | `stripAnsi(text).length` | `cells(stripAnsi(text))` |
| `promptLen` (init, and `setPrompt`) | `stripAnsi(prompt).length` | `cells(stripAnsi(prompt))` |

`buf` and `cursor` stay character-indexed, unchanged — see G33 for why that is now
the remaining problem.

### Verification

- **The probe that found it, re-run** (`/tmp/opencode/g32-measure2.py`, tmux
  `#{cursor_x}`, fresh prompt per case): drift **+0 on all 8 rows**, including the
  rows that measured +5 (`echo 日本語日本x`), +2 (`echo 日本`) and +1 (`echo a✅b`).
  ASCII rows unchanged, so nothing was fixed by breaking the common case.
- `tests/editor-cells.test.ts` — 13 tests: the measure (measured widths, ambiguous
  narrow, marks/VS16/ZWJ/flags), the table's shape, and byte pins on `CSI n D` /
  `CSI n P`.
- **Mutation-checked, one site at a time**: reverting the caret site killed exactly
  the 3 caret pins; reverting `searchVisual` killed exactly the 2 search pins;
  reverting the flush site killed exactly its 1 pin; degrading `cells()` to
  `text.length` killed 9 and left the ASCII controls green. A test that only ever
  fails when the whole feature is gone would not have pinned any one of them.
- Gates: `bun test` **1339 pass / 1 skip / 0 fail**, `tsc --noEmit` clean,
  `biome check` exit 0, binary rebuilt, editor-adjacent suites (cells, history-ctrl-r,
  repl-multiline, jobs-repl) 83 pass.

## Calibration

The whole fix rests on one claim: **this terminal follows Unicode East_Asian_Width.**
It was measured, not assumed.

- `/tmp/opencode/g32-sample.py` — 131 code points sampled from all 122 `W`/`F`
  ranges plus a non-wide spread: **130 agree** with the model. The single
  disagreement is **U+3EABF**, an *unassigned* code point in a plane that EAW
  assigns `W` by default — crust counts it 2, the terminal shows 1, so the caret
  drifts 1 column for that glyph. Documented limit of a table-driven measure.
- `/tmp/opencode/g32-widths.py` — per-code-point confirmation, including the
  ambiguous set: `U+2500`, `U+00B1`, `U+00E9` all render **1** cell, so `A` is
  treated as narrow. That is this terminal's choice and `cells()` follows it;
  a locale that renders ambiguous wide will disagree, which is why the tests call it
  a pinned decision rather than a fact.
- `/tmp/opencode/g32-clusters.py` — the multi-code-point rules, all measured:
  combining mark 0 · VS16 promotes its base to 2 · ZWJ sequence = 1 glyph (2) ·
  regional-indicator pair = 2 · CJK + mark = 2.
- **VS15 (`U+FE0E`) is deliberately not special-cased**, because measuring it said
  not to: this terminal *ignores* text presentation for emoji-presentation glyphs
  (`U+231A U+FE0E` → 2, `U+1F600 U+FE0E` → 2) while a narrow base with VS15 stays
  narrow (`U+2764 U+FE0E` → 1). Falling through to the base's width is the measured
  answer, not an unhandled case.

### Regenerating `src/widthTable.ts`

No runtime dependency in this repo carries EAW data, so the table is generated from
Python's `unicodedata` and committed. To regenerate (then run the suite — it pins
the shape and the measured points):

```python
import unicodedata as u

def ranges(pred):
    out, run = [], None
    for cp in range(0x110000):
        if pred(cp):
            run = cp if run is None else run
        elif run is not None:
            out.append((run, cp - 1)); run = None
    if run is not None:
        out.append((run, 0x10FFFF))
    return out

wide = ranges(lambda c: u.east_asian_width(chr(c)) in ("W", "F"))     # → WIDE_RANGES
zero = ranges(lambda c: u.category(chr(c)) in ("Mn", "Me", "Cf")      # → ZERO_WIDTH_RANGES
              and c != 0)                                              #   (NOT Mc)
```

Update the header's Unicode version and counts to match, and re-run
`g32-sample.py` if the terminal or the Unicode version changes — the table is only
as good as the measurement behind it.

## Consequences for G11 (highlighting stays closed, for fewer reasons)

G11 closed partly on "every paint site would have to agree with the terminal in
cells, an arithmetic the editor does not have yet". **That reason is now gone**, and
both places that stated it were corrected rather than left standing:

- `docs/USAGE.md`, Limits → the highlighting bullet now costs two obstacles, not
  three, and says the cells one came down on 2026-10-30.
- `docs/PLAN.md`, roadmap → same correction.

The decision itself does not change: an incomplete token still classifies as a shell
stage (4–5 colour flips per line, `parse()` throwing on 3–11 % of prefixes), and a
tolerant tokenizer is a second grammar. Highlighting remains deliberately unbuilt —
now on one documented cost instead of two.

## Limits after the fix (stated, not discovered later)

- **G33** — the cursor still moves in code units, so astral glyphs and combining
  sequences split under editing. Measured, filed separately; G32 fixed the measure,
  not the motion.
- U+3EABF and any other unassigned point in a W-assigned plane: 1 column of drift.
- Ambiguous-width rendering is followed, not forced; a wide-ambiguous locale will
  disagree with `cells()` until someone measures that terminal too.
