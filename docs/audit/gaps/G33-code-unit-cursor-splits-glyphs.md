# G33 — the editor splits astral glyphs and combining sequences while editing (found while verifying G32, 2026-10-30)

**Status: OPEN.** Not fixed by G32, and out of G32's scope on purpose: G32 made the
*columns* right, this is the *granularity* of `cursor`. Severity: it corrupts the
bytes a user submits, so it is worse than the display-only bugs it sits next to.

## The defect

`buf` and `cursor` in `src/editor.ts` are indexed in UTF-16 **code units**, and every
edit moves exactly one unit:

- `case "D"` / `case "C"` (arrow Left/Right): `cursor--` / `cursor++`
- Backspace: `buf.slice(0, cursor - 1) + buf.slice(cursor)`
- Insert: `buf.slice(0, cursor) + ch + buf.slice(cursor)`

So a glyph made of more than one code unit — any astral character (emoji: 2 units),
any base + combining mark, any ZWJ family sequence, a regional-indicator flag —
can be cut in half. Half a surrogate pair is not valid UTF-16: what reaches the
terminal and what reaches the shell is replacement characters, and the user cannot
get the glyph back.

## Measured (`/tmp/opencode/g33-corrupt.ts`, through `handleStdinData`, 2026-10-30)

| keystrokes | submitted buffer | valid UTF-16 |
|---|---|---|
| `echo 🚀` , `Left` , `x` | `"echo \ud83dx\ude80"` | **false** |
| `echo 🚀` , `Left` , Backspace | `"echo \ude80"` | **false** |
| `echo 🚀` , Backspace (control — no arrow key at all) | `"echo \ud83d"` | **false** |

The control row matters: this is not an arrow-key edge case. **Deleting an emoji the
user just typed leaves half of it on the line**, with no navigation involved.

Where the caret goes is separately visible (tmux `#{cursor_x}`, fresh prompt per
case, `/tmp/opencode/g32-arrows.py`):

| buffer ends with | caret at end | caret after `Left` | correct |
|---|---|---|---|
| `🚀` (U+1F680, 2 units, 2 cells) | 23 | **22** — half a cell, inside the glyph | 21 |
| `é` (e + U+0301, 1 cell) | 22 | **22** — appears to do nothing | 21 |
| `日` (U+65E5, 1 unit, 2 cells) | 23 | 21 ✓ | 21 |

BMP wide glyphs are correct *because* they are one code unit — which is exactly why
this survived: the obvious test (CJK) works.

Note the paint is not the corrupting agent: the repaint writes the whole `buf`, and
no lone surrogates are emitted for the caret move itself (measured 0 lone high /
0 lone low). The corruption happens at the next edit, and it is committed to the
submitted line.

## Why G32 did not (and should not) fix it

`cells()` in `src/width.ts` already clusters with `Intl.Segmenter`, so the pieces
exist — but G32's contract was strictly "characters for the buffer, cells for the
terminal". Changing how `cursor` moves is a different change with its own risk: it
touches every edit path (arrows, Home/End, Ctrl-arrows if any, Backspace, Delete,
typeahead) and its own tests. Filing it separately keeps G32's diff reviewable and
keeps this one honest as its own defect.

## Design sketch

Move the cursor by GRAPHEMES, using the same clustering `cells()` uses — one source
of truth, so the measure and the motion cannot drift:

- export from `src/width.ts` something like `prevGrapheme(text, index): number` /
  `nextGrapheme(text, index): number` (or a `graphemeOffsets(text)` array).
- `case "C"`/`case "D"` step to the next/previous grapheme boundary.
- Backspace deletes the grapheme before the caret; Delete (`case "3"`) the one after.
- Insert keeps whatever the input chunk is (a pasted multi-unit chunk stays whole).
- Boundary rule for an index that is *already* mid-glyph (only reachable from a
  pre-fix buffer or a chunk split across `handleStdinData` calls): snap to the
  cluster boundary rather than emitting half a pair.

A chunked-stdin caveat to settle in the probe: a surrogate pair can arrive split
across two `handleStdinData` calls on a real tty. The current code appends blindly,
which is also how a half pair can enter `buf` in the first place — worth checking
whether paste paths produce this, since a grapheme-aware cursor that assumes
well-formed `buf` would inherit that.

## Tests (red-first)

- Buffer `echo 🚀`: `Left` then `x` submits `echo x🚀`-class output that is valid
  UTF-16 — pin the exact submitted string, not just "no lone surrogates".
- Buffer `echo 🚀`: Backspace submits `echo ` (control that fails today).
- Buffer `é` (base + U+0301): `Left` then `x` keeps the accent attached to the base.
- Controls that must stay green: ASCII arrows/Backspace/Delete byte-for-byte
  unchanged; BMP wide `日` arrows unchanged (already correct).
- pty probe: the `#{cursor_x}` table above, expecting 21/21/21.

## Docs / website / KB

- `docs/USAGE.md` Limits: this is a bug, so it gets no Limits bullet while open
  (same policy as G32) — but unlike G32 it is currently reachable by ordinary
  typing, so if it stays open past this release the Limits section should say the
  editor edits BMP text reliably and astral glyphs are risky to edit, because
  today's users hit it without doing anything clever.

## Commit

`fix(repl): move the caret by graphemes so astral glyphs survive editing`
