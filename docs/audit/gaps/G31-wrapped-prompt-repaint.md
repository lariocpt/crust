# G31 — a prompt that wraps the terminal smears on every keystroke

**Status: FIXED** (2026-10-30) — see the Fixed section below.

**Doc:** nowhere — no page claims anything about a prompt wider than the
terminal. Found while probing **G09** (Ctrl-R search, 2026-10-27), which had to
reason about exactly this geometry. It is PRE-EXISTING: the probe below touches
no search code, and G09 neither causes nor fixes it.

## Measured (tmux, `bin/crust-bin`, no Ctrl-R at any point)

30-column window at a cwd whose git-aware prompt is 35 characters, so the
**prompt alone wraps**. `~/tmp/g31/probe-g31.sh` drives it and captures the
pane (row numbers from `grep -n`, blanks dropped). The original probe lived in
`/tmp/opencode`, which is not durable on this machine; the copy below is the
working one.

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

## Design sketch (followed; the open questions resolved)

The editor already learned this model in G09 for the search line: it measures
its OWN paints (`backToCol0(n, width) = (n - 1) % width + 1`, spilled rows
`= (n - 1) / width`) instead of asking the terminal where the cursor is, because
that question has no portable answer. The fix applied the same accounting to
the draft line, as sketched: it tracks the cells the last `prompt + buf` paint
occupied and the caret's offset, climbs to the line's FIRST row before a
multi-row repaint (`CSI J` to erase, `CSI K` alone for the one-row control
path), and records both in the one place that paints the draft.

The two open questions resolved as:

- **Cell width — resolved by G32.** This dossier predates G32, which shipped
  `cells()` (`src/width.ts` + `src/widthTable.ts`). The fix uses it for the
  MEASURE and for the MOTION (the climb row), and `tests/editor-wrapped-prompt.test.ts`
  pins the unit: a CJK prompt must climb by cells, and counting characters
  instead drops repaints (mutation-verified).
- **Scroll at the bottom row — kept.** The repaint never opens a line with a
  newline (pinned by a byte test), and the flush flag (`draftWrapped`) that
  search entry trusts is now MEASURED from the prompt's own width instead of
  starting as `false` — a prompt of exactly N×width made the guess wrong right
  where a newline would scroll the screen.

## Fixed (2026-10-30)

`src/editor.ts`: `render()` climbs to the line's first row
(`CSI n A`, `n = floor(draftCaretCells / width)`) and erases to the bottom
(`\r` + `CSI J`) whenever the previous paint occupied more than one row, then
delegates to `paintDraft()`, which records `draftPaintCells` /
`draftCaretCells` / `draftWrapped` from what it actually wrote. The one-row
path keeps today's minimal repaint (`\r` + paint + `CSI K`, no cursor motion).
The initial prompt write and both `setPrompt` call sites record the same state
(honest flush flag included).

Measured, pre-fix binary → post-fix binary, same 30-column probe
(`~/tmp/g31/probe-g31.sh`), counting the prompt fragment
`Projects/personal/crust` per pane (the shell's own `cd` line contributes one
copy in every count, so the prompt's own copies are count − 1):

```
                 pre-fix        post-fix
after start      2 (1 prompt)   2 (1 prompt)
after `echo`     3 (2 prompts)  2 (1 prompt)
after ` hi`      4 (3 prompts)  2 (1 prompt)
after Enter      4              3 (shell line + submitted row + fresh prompt)
the line RAN in both states — display-only, as predicted
```

The post-fix screen keeps exactly ONE copy of the prompt through every
keystroke, and the line still runs.

Tests: `tests/editor-wrapped-prompt.test.ts` — 5 byte-level tests (climb +
erase on a wrapping prompt; the climb counted in CELLS; the one-row control;
no newline before the first erase; the flush flag at initial paint). Full
suite after: 1387 pass / 2 skip / 0 fail across 52 files (the skips are the
pre-existing `$CRUST_PG_URL`-gated Postgres case and its twin); `tsc --noEmit`
clean; biome 0 errors.

Mutation matrix (each site removed or weakened, G31 file re-run): M1 climb
never emitted — 2 died; M2 no erase-to-bottom — 2 died; M3 wrapped path taken
for every line (control) — 1 died; M4 caret offset counted in characters —
1 died; M5 flush flag guessed `false` (both sites) — 2 died; M6 one-row path
forgets the CR — 1 died; M7 paint cells never recorded — 1 died. Every one of
the seven new sites is load-bearing.

**Excluded, filed as G37:** moving the CARET left across a wrap row of a
wrapped draft clamps at column 0 of the line's end row (a terminal's CUB does
not climb rows), and the next repaint then re-smears from the wrong row.
Measured with the calibrated probe the G31 work required
(`~/tmp/g31/probe-caret.sh`); see
`docs/audit/gaps/G37-caret-crossing-wrap-row.md`. This fix does not touch
`place()` and does not claim to cover it.

## Docs / website / KB

The "until fixed" obligation is discharged: since the fix shipped, **no
Limits bullet** is needed (display-only, the G32 rule — a fixed bug needs no
documentation), so neither `docs/USAGE.md` nor the website changes.
KB (crust-agent submodule, local-only commits): the round-5 seam addendum
gains the draft-line twin of the search-line rules, and the §10 note in
`round-10-limits-measured.md` is closed. G37 gets its KB entry when it is
fixed, not now.

## Commit

`fix(repl): repaint a wrapped prompt line from its first row`
