# G11 — no syntax highlighting in the editor

**Doc:** `docs/USAGE.md:2201` (\"No syntax highlighting in the editor. v0.1.5\").

## Verdict

True. `src/editor.ts` repaints `prompt + buf` as one undifferentiated string and
`stripAnsi`s user text to compute cursor columns; there is no token pass and no
colour application.

## Recommendation: **scope it down first, and decide before building**

This is the most expensive gap per unit of user value in the whole list, and it
interacts badly with two other gaps:

- Every colour inserted into the buffer changes the cursor-column arithmetic.
  The round-5 KB note (`knowledge/internals/round-5-repl-and-logs.md`) exists
  because this class of bug already bit once; G09 (search) and G08
  (continuation) both touch the same repaint path. Do this **last**.
- Real highlighting means a **semantic** pass over the line — the lexer already
  gives stage kinds, but only for a line that *parses*. Half-typed input is by
  definition unparseable, so highlighting must be a tolerant tokenizer, not
  `classify()`, or every keystroke mid-edit turns into an error state.

### Option A (recommended, ship this)

Colour from the **existing tolerant lexer/tokenizer only**, three faces:

1. stage separator `|` (dim),
2. quoted runs (`\"…\"`, `'…'`, `` `…` ``) — the thing that actually prevents
   syntax mistakes in crust, and which `tokenize` already tracks,
3. known builtin / stage-kind words at the head of a stage (the list is already
   in `builtins.ts` and the lexer's patterns).

Everything else stays the terminal default. No error/warning faces, no
parsing-based colour, so an invalid half-line cannot flash or lose text. Cheap,
testable, and it degrades exactly to today when disabled.

### Option B (do not do)

Full semantic highlighting with error faces. Rejected: it duplicates the parser
in a second, tolerant implementation whose disagreements with the real one are
user-visible lies, and it makes the cursor arithmetic two problems instead of
one.

### Either way

- Config switch (default on when the TTY is colour, off for `NO_COLOR` /
  non-TTY / `TERM=dumb`) — `~/.config/crust/config.ts` (grep
  `src/config.ts`'s existing toggles for the pattern).
- Cursor-column math must count **visible** cells: reuse the existing
  `stripAnsi`-based path rather than a parallel one, and make highlighting
  *prove* it against the existing wide-character / emoji / combining tests.

## Tests

- Pure colouring function: `colorize(text)` is a no-op on plain text with no
  faces, wraps only the three face classes, and `stripAnsi(colorize(x)) === x`
  for a corpus that must include: quotes inside quotes, escaped quotes
  (`\"a \\\"b\\\" c\"`), a quoted `|`, a `|` inside `$( )`, wide chars and emoji,
  backslash-continuation, and unterminated quote (must not colour to EOL).
- Editor-level: cursor position after `←`/`→`/Home/End on a coloured line equals
  the uncoloured case (the regression this feature is most likely to cause);
  paste-with-ANSI still strips.
- Control: highlighting off (env/TTY) produces byte-identical output to today.

## Docs / website / KB

- `docs/USAGE.md`: keybindings/editor intro (\"crust colours stage separators,
  quoted strings and builtin names as you type; `NO_COLOR` and a pipe disable
  it\"), limits bullet goes.
- `skills/crust-cli/SKILL.md` if it describes the editor.
- Website: quickstart REPL section + a line in the features list if one exists
  (grep `highlight` in `src/`).
- KB: `knowledge/learnings/round-10-limits-measured.md` — record the
  highlighting×cursor-column trap so it isn't re-discovered.

## Commit

`feat(editor): colour stage separators, quoted runs and builtin names`

## CLOSED 2026-10-29 — deliberate absence, costed first (operator decision)

The recommendation was to decide before building. The costing probe
(`/tmp/opencode/g11-probe.ts`, `g11-caret.sh`, `g11-locale.sh`) then falsified two
of this file's own premises and confirmed the reason:

- **Not CPU.** `tokenize` + `classify` over a 2000-character line: **0.1 ms**.
  At 10 keystrokes/s that is 0.05 % of a core. Any "too slow for a REPL" argument
  is dead.
- **Not the SGR bytes.** Colour sequences do not advance the cursor, so painting
  `buf` with colours does not move it either — `place()` is only wrong if a site
  starts measuring the *painted* string instead of the buffer. The editor already
  strips ANSI for `promptLen`, so this is an audit-the-sites task, not an
  impossibility.
- **The real cost is the half-typed line.** `classify()` is total but
  parse-oriented: on every realistic line the first stage reads as `shell` until
  the head token closes, so a classify-based highlighter changes colour **4–5
  times per line** while typing (`GET :3000/… -H "…$TOKEN" | expectStatus 200`:
  5 flips; `range(1,3) | map (x => x * 2) | stats`: 5; `procs({…}) | grep ERROR`:
  4), and `parse(prefix, true)` throws on 3 %, 6 %, 8 % and 11 % of prefixes
  across five sample lines. Colour that disagrees with what is on screen is worse
  than no colour, so it needs a tolerant tokenizer with an explicit
  "incomplete" state — a second grammar, maintained forever, for a REPL whose
  user is typing one line at a time.
- **And it lands on the arithmetic that is already wrong.** Measuring the caret
  turned up **G32** (`gaps/G32-wide-glyph-caret-drift.md`): `place()` emits
  `CSI n D` from a **character** count where a terminal moves **columns**, so the
  caret lands `(cells − chars)` columns too far right — `echo 日本` by **+2**,
  `echo a✅b` by **+1**, `echo 日本語日本x` by **+5** (8/8 buffers match that
  formula, ASCII exact, locale-independent, and the buffer itself is always
  correct). The paint is right every time — only the editor's own back-tab is
  wrong. Highlighting multiplies the number of paint
  sites that must agree in cells, on the same path G31's wrapped-repaint bug and
  Ctrl-R's three-probe search paint already occupy.

**Decision:** close the claim as a deliberate absence, with the measurement in the
user-facing sentence (`docs/USAGE.md` → "Limits in v0.2", `docs/PLAN.md`), and
keep the note that *if* the cell arithmetic lands (G32, next to G31), highlighting
becomes cheap — that ordering is now written down instead of assumed.
