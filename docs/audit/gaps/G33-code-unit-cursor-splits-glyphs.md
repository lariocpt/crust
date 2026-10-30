# G33 — the editor splits astral glyphs and combining sequences while editing (found while verifying G32, 2026-10-30)

**Status: FIXED 2026-10-30** (code crust `983a8f3`; audit: this commit). G32 made the
*columns* right, this was the *granularity* of `cursor` — out of G32's scope on
purpose. The fix moves the caret in **graphemes** on the same `Intl.Segmenter`
clustering `cells()` uses, so measure and motion cannot drift: 11 red-first tests,
mutation matrix 8/8, pty probe 7/7 (§4–§7). The chunked-stdin caveat the sketch
flagged settled at the decode layer — Bun materialises a truncated UTF-8 sequence
as U+FFFD *code points* before the string layer, measured byte-identical pre/post
(§5).

## The defect (pre-fix)

`buf` and `cursor` in `src/editor.ts` are indexed in UTF-16 **code units**, and every
edit moved exactly one unit:

- `case "D"` / `case "C"` (arrow Left/Right): `cursor--` / `cursor++`
- Backspace: `buf.slice(0, cursor - 1) + buf.slice(cursor)`
- Insert: `buf.slice(0, cursor) + ch + buf.slice(cursor)`

So a glyph made of more than one code unit — any astral character (emoji: 2 units),
any base + combining mark, any ZWJ family sequence, a regional-indicator flag —
could be cut in half. Half a surrogate pair is not valid UTF-16: what reaches the
terminal and what reaches the shell is replacement characters, and the user cannot
get the glyph back.

## Measured pre-fix (`/tmp/opencode/g33-corrupt.ts`, through `handleStdinData`, 2026-10-30)

| keystrokes | submitted buffer | valid UTF-16 |
|---|---|---|
| `echo 🚀` , `Left` , `x` | `"echo \ud83dx\ude80"` | **false** |
| `echo 🚀` , `Left` , Backspace | `"echo \ude80"` | **false** |
| `echo 🚀` , Backspace (control — no arrow key at all) | `"echo \ud83d"` | **false** |

The control row matters: this was not an arrow-key edge case. **Deleting an emoji the
user just typed left half of it on the line**, with no navigation involved.

Where the caret went was separately visible (tmux `#{cursor_x}`, fresh prompt per
case, `/tmp/opencode/g32-arrows.py`):

| buffer ends with | caret at end | caret after `Left` | correct |
|---|---|---|---|
| `🚀` (U+1F680, 2 units, 2 cells) | 23 | **22** — half a cell, inside the glyph | 21 |
| `é` (e + U+0301, 1 cell) | 22 | **22** — appears to do nothing | 21 |
| `日` (U+65E5, 1 unit, 2 cells) | 23 | 21 ✓ | 21 |

BMP wide glyphs were correct *because* they are one code unit — which is exactly why
this survived: the obvious test (CJK) worked.

The paint was not the corrupting agent: the repaint writes the whole `buf`, and no
lone surrogates were emitted for the caret move itself (measured 0 lone high /
0 lone low). The corruption happened at the next edit, and it was committed to the
submitted line.

## Why G32 did not (and should not) fix it

`cells()` in `src/width.ts` already clusters with `Intl.Segmenter`, so the pieces
existed — but G32's contract was strictly "characters for the buffer, cells for the
terminal". Changing how `cursor` moves is a different change with its own risk: it
touches every edit path (arrows, Home/End, Ctrl-arrows if any, Backspace, Delete,
typeahead) and its own tests. Filing it separately kept G32's diff reviewable and
keeps this one honest as its own defect.

## The fix (what shipped in `983a8f3`)

The sketch became the implementation, with one addition the sketch had to flag:

- **The helpers** — `src/width.ts` exports `graphemeStartBefore(text, i)` (the
  largest segmenter cluster start *strictly less* than `i`, else 0) and
  `graphemeEndAfter(text, i)` (the first cluster start *strictly greater* than `i`,
  else `text.length`), built on a private `graphemeStarts(text)` over the **same
  `Intl.Segmenter`** `cells()` uses, so measure and motion share one clustering and
  cannot drift.
- **Left / Right** (`case "D"` / `case "C"`) step to the adjacent boundary via the
  helpers: Left lands on the cluster start that owns the unit just left of the caret;
  Right on the end of the cluster that owns the unit at the caret.
- **Backspace** (0x7f / 0x08) deletes `[startBefore(caret), endAfter(that start))` —
  the whole cluster that owns the unit just left of the caret. **Delete** (xterm
  `CSI 3~`) deletes `[endAfter(caret), startBefore(that end))` — the cluster that
  owns the unit just right. A caret stuck mid-cluster (only reachable from a
  pre-fix leftover or a chunk-split pair, §5) deletes that cluster **whole** and
  lands on its start — never a half pair. A lone surrogate is its own segment to
  the segmenter, so all four operations stay consistent on a corrupt buffer.
- **The search query** — the three truncations (CSI Delete, Ctrl-D, Backspace)
  became `sq.slice(0, graphemeStartBefore(sq, sq.length))`: a query ending in an
  emoji loses the whole glyph, so the search line cannot hold a half pair either.
- **`commonPrefix`** (`src/completion.ts`) — the unit-by-unit shrink can stop
  mid-pair (`a🚀x` + `a🚁x` → `a\ud83d`) and its result splices straight into the
  draft, so it now trims a trailing **high** surrogate explicitly after the shrink.
  The segmenter cannot catch this — to it a lone surrogate is a whole cluster — so
  the check is a `charCode` range test. (A prefix of well-formed text can never end
  in a lone *low* surrogate: its high always precedes it inside the prefix. Only
  the high is at risk.)

**Unchanged, and why** (each verified against the code, not asserted):

- Home / End / Ctrl-A / Ctrl-E — land on 0 and `len`, cluster boundaries for any
  string.
- Ctrl-U / Ctrl-K — splice at the caret; the caret starts on a boundary (the read
  begins at 0/`len`) and every operation above lands on one, so the invariant holds
  by induction and the splices are grapheme-aligned.
- Ctrl-W — the walk stops only at a single-unit space/pipe or at 0, both
  boundaries; it passes *through* pairs (neither half is a delimiter) rather than
  stopping mid-cluster.
- The insert run and the Tab replace region — splice at such indices and keep the
  chunk whole; a mid-cluster caret is unreachable post-fix.

## The split-pair caveat, settled at the decode layer

The sketch asked whether a pair can arrive split across two `handleStdinData`
calls on a real tty. `~/tmp/g33/probe-split.py` (python pty; U+1F680's four bytes
forced to arrive as `F0 9F` | sleep | `9E A0`) ran against **both** the pre-fix
(`~/tmp/g33/prefix-bin`) and the post-fix (`~/tmp/g33/fixed-bin`) binaries:

- **A real pty does split the pair** — the forced 2+2 split was honoured by the
  driver.
- But Bun's incremental UTF-8 decoder (`chunk.toString("utf8")` in
  `handleStdinData`) materialises a sequence truncated at a read boundary as
  **U+FFFD code points**: the truncated `F0 9F` becomes one U+FFFD and each
  orphaned continuation byte another (3 in total, measured). The editor's string
  layer therefore **never receives a lone surrogate from a real tty** — the damage
  is locked in at the decode boundary, the user sees replacement characters
  immediately, and the grapheme logic handles them as ordinary narrow characters.
- Case A (no key in the split window) and case B (Left in the window) came back
  **byte-identical pre/post** — 3 FFFD each, no clean 🚀. So the mid-pair inversion
  the sketch feared (a keypress reordering the two halves) is **not a regression**:
  at the string layer it is only reachable through programmatic `handleStdinData`
  chunk feeding (unit-test style), and its outcome is identical pre/post. The snap
  rules in §4 still bound the damage for any input that does reach the string layer.

## Tests (11, red-first, mutation-checked)

`tests/editor-grapheme-cursor.test.ts`: Left / Right / Backspace / Delete on the
emoji, base+combining `é`, ZWJ family and flag; Backspace on a search query;
`commonPrefix`; plus ASCII and `日` controls that must stay byte-for-byte
unchanged.

- **Red-first**: 9 red / 2 green against the stashed original — every red failed
  with the dossier's own corruption signature (`\ud83dx\ude80`, `\ud83d`,
  `x\u0301`, …), so the reds were the defect, not the harness; all 11 green on the
  fix.
- **Two harness traps the red exposed** (both invisible to a green run): the
  commonPrefix test's first red against the original was a crash — it called
  `Bun.tmpdir()`, which does not exist (Bun has no such API; the repo convention is
  `tmpdir()` from `node:os`). After the swap the run went GREEN again, which
  exposed a second bug in the test's own `hasLoneSurrogates`:
  `s.charCodeAt(i + 1)` is **NaN past the end**, and NaN compares false against
  everything, so a *trailing* lone high slipped through the scanner. With the
  bound-check in, the test fails on the real assertion against the stashed original
  (`Expected: false, Received: true`) — red re-proven against the defect. (The
  search-query test had gone red all along, because its surrogate sat mid-stream,
  not at the end.)
- **Mutation matrix 8/8** (one pin removed at a time, tree restored byte-for-byte
  between; `/tmp/opencode/g33-matrix.py`): `startBefore`→one unit kills 7 (Left×3,
  Delete, Backspace×2, search); `endAfter`→one unit kills 4 (Right, Delete,
  Backspace×2 — the search sites use only `startBefore`, so they stay green, which
  is what localises the helper); Left→`cursor--` 3; Right→`cursor++` 1;
  Delete→one unit 1; Backspace→one unit 2; search×3→`slice(0,-1)` 1;
  `commonPrefix` trim removed 1. Every pin killed exactly its own tests; the ASCII
  and `日` controls stayed green under every mutation — for a single-unit cluster
  the old and new arithmetic coincide, which is exactly why this bug survived.

## Pty probes (post-fix binary, `~/tmp/g33/`)

`probe-table.sh` — tmux, self-calibrating (the prompt's own width P is measured
from the caret after the prompt, the pattern `~/tmp/g31/probe-caret.sh` uses) —
at a 35-cell prompt / 30-column window where the `echo ` prefix ends at offset 40:
**7/7 OK**.

| buffer ends with | caret at end (x, y) | caret after `Left` (x, y) |
|---|---|---|
| `🚀` (2 units, 2 cells) | (12, 9) | **(10, 9)** — on the glyph's start |
| `é` (base + U+0301, 1 cell) | (11, 12) | **(10, 12)** — on the glyph's start |
| `日` (1 unit, 2 cells, control) | (12, 15) | **(10, 15)** — unchanged |

All three after-Left carets land on the same column (the end of `echo `) regardless
of the glyph's cell count — the pre-fix table's 22/22/21 (16-cell prompt) is the
same test at a different prompt width, where the drift showed up as a half-cell /
no-move. The Backspace marker case — `echo M-🚀` + Backspace (raw 0x7f;
`tmux send-keys Backspace` is not a key name and types the literal word) —
submits a clean `M-` line; a half pair would reach the shell as U+FFFD and print
`M-<box>`.

`probe-split.py` is §5 (before/after binary pair, byte-level).

## Docs / website / KB

- **No USAGE / site change.** The "no Limits bullet while open" line resolves to
  no change: the bug is fixed, a fixed bug earns no Limits bullet (the G32 rule),
  and nothing in `docs/USAGE.md` or the website claims anything about caret
  granularity — the REPL keybindings table lists what each key does, not glyph
  semantics — so no page and no bullet needed touching.
- **KB** (crust-agent submodule, local commit only — ingest is operator-controlled):
  new `knowledge/learnings/round-10-grapheme-cursor.md` (the rule, the
  decode-layer finding, the harness traps, the probe gotchas);
  `round-10-cells-vs-characters.md`'s "still open: G33" pointers corrected to
  fixed, pointing at it.

## Commit

- Code: `983a8f3` — `fix(repl): move the caret by graphemes so astral glyphs survive editing`
- Audit: this commit (dossier + plan + progress ticks; the probe scripts live in
  `~/tmp/g33/` and are referenced by path, per the G31 pattern).
