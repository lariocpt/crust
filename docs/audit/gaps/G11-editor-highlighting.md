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
