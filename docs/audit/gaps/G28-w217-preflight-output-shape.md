# G28 — cli skill page: the shell-stage failure block is not the output shape, and there is no separate `sh:` line

**Doc:** website `src/pages/docs/agent-skills/cli.mdx` L121–132 (the
`--check` failure-format block + "the `sh:` line after that" sentence).
Audit W217 (code half X), code review group (g), 2026-10-19.

## Measured (page line vs the code, both read 2026-10-19)

Page block (verbatim, ```text fence):

```text
crust: shell stage does not parse (stage: head -()
  in: range(1,3) | head -(
```

followed by: "The `sh:` line after that is whatever your `/bin/sh` says, in
its own words and its own capitalisation — bash calls it `syntax error near
unexpected token '('`, dash (what CI usually has) says `Syntax error: word
unexpected (expecting ")")`. crust passes it through unchanged, so grep for
`shell stage does not parse`."

The actual format, on BOTH paths, is one write of two lines, with sh's first
stderr line appended to the END of the first line:

1. **The format string.** `crust: shell stage does not parse${where}:
   ${problem.first}\n  in: ${line}\n` — check path `src/index.ts` L212–214
   (exit 1, L215), exec path `src/runLine.ts` L204–206 (`return 2`, L207).
   `where` is ` (stage: ${problem.stage})` for a proper sub-stage, empty when
   the failing stage is the whole line (`index.ts` L211; `runLine.ts` L203).
   So for `range(1,3) | head -(` the real first line is
   `crust: shell stage does not parse (stage: head -(): <sh's first line>` —
   the page's block shows that first line TRUNCATED where sh's text begins.
2. **There is no separate `sh:` line.** The preflight spawns
   `sh -n -c <stage>` with stderr `"pipe"` (`src/lexer.ts` L241–245) — sh's
   stderr is CAPTURED, not passed through to the terminal, and only its first
   line is kept (`L249`: `first: shErr.trim().split("\n")[0] || "syntax
   error"`). Nothing after the `in:` line is ever written by crust for this
   failure. "The `sh:` line after that" describes a third line that the code
   cannot produce.

What the page gets right (recorded C on the W217 row): "names the stage"
(the `where` clause, same lines) and "passes it through unchanged" as to
WORDING — `problem.first` is sh's own first stderr line, unmodified
(`lexer.ts` L219–220: "its diagnosis is the diagnosis"), and the bash/dash
wordings quoted are sh's own (C-by-delegation; the (b) probe captures both).

## Impact

A user who hits a shell-stage syntax error and follows the page looks for a
`sh:` line after the two-line block, and a `grep -n "sh:"` on the captured
output finds the diagnostic only mid-way through line 1 — while the page's
block itself, pasted into a test or a doc diff, does not byte-match the real
first line. The grep hint the page ends on (`shell stage does not parse`)
IS correct and useful; only the shape description and the block's first line
are off.

## Out of scope for this gap (cross-refs, NOT closed here)

- The W217 verbatim capture — `crust --check 'range(1,3) | head -('` full
  2-line output + exit code, plus the exec-path twin
  (`touch f | base64 | head -(` → exit 2, `f` absent) from W218's probe —
  stays in the (b) queue; it will capture the exact real shape to diff the
  rewritten block against.
- The bash-vs-dash wording differences are sh behavior (C-by-delegation);
  only their presence verbatim in `problem.first` is crust's.

## Fix

Website, `cli.mdx` L121–132 — rewrite the block and the sentence to match
the coded format:

- Print the REAL block for `range(1,3) | head -(` under the authoring shell
  (capture it in the (b) probe first): line 1 =
  `crust: shell stage does not parse (stage: head -(): ` + sh's first line;
  line 2 = `  in: range(1,3) | head -(`. No third line.
- Replace "the `sh:` line after that" with the actual placement: sh's first
  error line is appended to the end of the `crust:` line, in sh's own words
  and capitalisation (bash: `syntax error near unexpected token '('`; dash:
  `Syntax error: word unexpected (expecting ")")`), and it is the only
  diagnostic crust prints for the stage — the rest of sh's output, if any,
  is dropped after that first line.
- Keep "grep for `shell stage does not parse`" — that half is correct.

Verification: the (b) probe capture (check path + exec path) byte-matches
the rewritten block; website `bun run build` +
`bun scripts/lint-examples.mjs ../crust/bin/crust` + `bun run check-links`.

## Commit

`fix(docs): the shell-stage failure block showed a line crust never prints (audit W217)` (website).
