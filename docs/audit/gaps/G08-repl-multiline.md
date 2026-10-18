# G08 — no multi-line input / heredocs at the REPL (and a message that lies)

**Doc:** `docs/USAGE.md:2183` (\"No multi-line input / heredocs in the REPL
editor\"), keybindings table `docs/USAGE.md:1983-2055`.

## Measured (pty, `script -qec`)

Typing `range(1,3) \\` + Enter at the REPL **runs the line** → `sh: -c: line 1:
syntax error near unexpected token \\`1,3'`. The next line `| wc -l` is then
refused with:

```
crust: empty stage: a pipeline starts with a source — remove the leading `|`,
or if this line belongs to the one above it, end that line with a trailing `\`
```

That advice is **about a mechanism the REPL does not have** (`splitLines`,
`src/runLine.ts:28-62`, is only used for scripts / piped stdin / multi-line
`-c`). A message that points at a nonexistent escape hatch is the worst kind of
error.

## Design (editor-level, no grammar change — design rule 3 satisfied)

Continuation is a *line-assembly* concern, so it belongs to the editor/REPL loop
(`src/editor.ts` + the loop in `src/index.ts`), not to the lexer.

- Trailing unquoted `\\` at the REPL → switch to a **secondary prompt** (`…  `
  in the prompt colour, no history write), accumulate, and submit the joined
  buffer when a line arrives without a trailing `\\`. Reuse `splitLines`'
  continuation rule (its strip-then-join semantics) so REPL and script agree
  character-for-character; feed the joined text through the *same* `runLine`.
- Same handling for an **unbalanced** quote/bracket (`\"`, `'`, `(`, `` ` ``) —
  a paste of a multi-line JSON literal should continue, not error. Keep this
  conservative: only continue when the text is genuinely unbalanced, so a
  mistyped `range(1,3)` still errors immediately.
- **Ctrl-C at the secondary prompt** aborts the whole pending buffer (back to a
  clean primary prompt, nothing appended to history).
- History stores the assembled multi-line entry as one item, and `↑` recalls it
  whole (matching zsh).
- **Heredocs:** no new crust syntax. Once the editor can assemble a multi-line
  line, `sh` receives the whole text and `<<EOF … EOF` works inside a *shell
  stage* for free. Verify and document that; refuse a heredoc whose body is
  unterminated (sh already errors — pin the exit code).
- Piped-stdin REPL mode (`cmd | crust`) must be unaffected: it already reads
  lines and `splitLines` handles continuations there.

Also fix the lying message while in here: `empty stage` should only suggest the
`\\` continuation when continuation is actually available (scripts, `-c`,
piped stdin), and at the REPL say \"this REPL continues a line ending with
`\\`\" once G08 lands — pin both wordings with tests.

## Tests

- Unit over the new assembler (`src/editor.ts` export, e.g.
  `needsContinuation(buf)` / `joinContinued(lines)`): trailing `\\`, `\\\\`
  (escaped backslash, must NOT continue), unbalanced `\"`, unbalanced `(`,
  balanced-but-mismatched (`` ` `` closed by `'`) → not continuing, and a
  JSON-literal paste → continuing.
- REPL integration: drive the editor with injected keystrokes (the pattern
  `tests/` already use for the editor — look at the round-5 editor tests) and
  assert `range(1,3) \\` + `| wc -l` + Enter yields `3` and one history entry.
- Ctrl-C during a pending buffer clears it and runs nothing.
- Heredoc through a shell stage: `sh \"cat <<EOF\\nhi\\nEOF\"`-shaped input writes
  `hi`; unterminated heredoc exits nonzero with sh's error, no false pass.
- Control: `-c 'a \\` + newline + `b'` behaves exactly as before, and a script
  file's continuation is unchanged (`tests/pipeline.test.ts` controls).
- Control: the `empty stage` message still fires for a genuinely leading `|`.

## Docs / website / KB

- `docs/USAGE.md`: keybindings section gains \"`\\` at the end of a line continues
  it (`…` prompt); an unbalanced quote or bracket does too; Ctrl-C cancels the
  buffer\"; the limits bullet goes; add one multi-line example (JSON literal is
  the best demo) — it must pass `--check`.
- `skills/crust-cli/SKILL.md:68` (\"more than one line, in a script, in piped
  stdin or in a multi-line `-c`\") — add \"or continued at the REPL\".
- Website: `src/pages/docs/quickstart.mdx` (REPL section) and
  `src/pages/docs/agent-skills/cli.mdx`.
- KB: `knowledge/learnings/round-10-limits-measured.md`; also update
  `knowledge/internals/round-5-repl-and-logs.md` — the editor seam changed.

## Commit

`feat(repl): multi-line input — backslash and unbalanced-quote continuation`
