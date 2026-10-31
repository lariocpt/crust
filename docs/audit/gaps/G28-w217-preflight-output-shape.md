# G28 — cli skill page: the shell-stage failure block is not the output shape, and there is no separate `sh:` line

**FIXED 2026-10-31** — site `a184bab` (one page: `src/pages/docs/agent-skills/cli.mdx` — the ```text block now shows the captured real bytes and the sentence describes the real placement) · W217 `?` closes as **X** and is annotated — the row's subject was the block's format, the confirmed X, now corrected; the row's (b) capture ran as part of this unit (and cross-consumed W218's sharpest (b) probe item) · X-census entry annotated · audit (this commit) · KB (crust-agent submodule, local commit only — ingest is operator-controlled, `5296c8e5`): `round-9-cli-contract.md` §2 gains the preflight-refusal shape (both paths, one two-line message, sh's first line appended, captured not passed through). **MCP reviewed — no overlap**: the fix is docs-only — one site page; the preflight's behaviour is the binary's existing state, now no longer contradicted by the page, so `src/mcp/` and the skill files stay as-is (the standing order's display-only case, recorded not skipped).

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
   ${problem.first}\n  in: ${line}\n` — check path `src/index.ts` L229–234
   (format string L232, exit 1 L234), exec path `src/runLine.ts` L322–328
   (`return 2`, L328). (As filed: index.ts L212–214 / runLine.ts L204–206 —
   refs drifted with the files' growth, corrected in place 2026-10-31.)
   `where` is ` (stage: ${problem.stage})` for a proper sub-stage, empty when
   the failing stage is the whole line (`index.ts` L230; `runLine.ts` L323).
   So for `range(1,3) | head -(` the real first line is
   `crust: shell stage does not parse (stage: head -(): <sh's first line>` —
   the page's block showed that first line TRUNCATED where sh's text begins.
2. **There is no separate `sh:` line.** The preflight spawns
   `sh -n -c <stage>` with stderr `"pipe"` (`src/lexer.ts` L354–365 — as
   filed L241–249; drift corrected in place) — sh's stderr is CAPTURED, not
   passed through to the terminal, and only its first line is kept
   (L365: `first: shErr.trim().split("\n")[0] || "syntax error"`). Nothing
   after the `in:` line is ever written by crust for this failure. "The `sh:`
   line after that" described a third line the code cannot produce.

What the page gets right (recorded C on the W217 row): "names the stage"
(the `where` clause, same lines) and "passes it through unchanged" as to
WORDING — `problem.first` is sh's own first stderr line, unmodified
(`lexer.ts` doc above `shellSyntaxPreflight`: "its diagnosis is the
diagnosis"), and the bash/dash wordings quoted are sh's own
(C-by-delegation; see Measured for what this box could and could not capture).

## Impact

A user who hits a shell-stage syntax error and follows the page looks for a
`sh:` line after the two-line block, and a `grep -n "sh:"` on the captured
output finds the diagnostic only mid-way through line 1 — while the page's
block itself, pasted into a test or a doc diff, does not byte-match the real
first line. The grep hint the page ends on (`shell stage does not parse`)
IS correct and useful; only the shape description and the block's first line
were off.

## Measured (probed 2026-10-31, `~/tmp/g28/` — `probe.sh` → `probe.log`)

**A (check path, exit 1)** — `crust --check 'range(1,3) | head -('`:

```
crust: shell stage does not parse (stage: head -(): sh: -c: line 1: syntax error near unexpected token `('
  in: range(1,3) | head -(
```

Exactly two lines. Note sh's own prefix rides along: argv[0] is `sh` under
the preflight, so even with `/bin/sh` → bash on this box the line reads
`sh: -c: line 1: …` (raw `bash -n -c 'head -('` prints `bash: -c: line 1: …`).

**A2 (whole-line variant, exit 1)** — `crust --check 'head -('`: first line
`crust: shell stage does not parse: sh: -c: line 1: …` — the `(stage: …)`
clause omitted, exactly as the `where` code says.

**B (exec-path twin, exit 2)** — `crust -c 'touch f | base64 | head -('`
after `rm -f f`: exit 2, `f` ABSENT (nothing ran), stderr byte-identical in
format to the check path with `in: touch f | base64 | head -(`. This is
W218's sharpest (b) probe item, cross-consumed here.

**C (raw sh wordings)** — this box: `/bin/sh` → bash 5.3, prints
`syntax error near unexpected token '('` (prefixed `sh: -c: line 1:` under
crust). **dash is NOT installed on this box**, so the page's dash wording
(`Syntax error: word unexpected (expecting ")")`) stays C-by-delegation —
it is sh's own behavior, not crust's, and the audit already classified it so.

## The fix

Site `cli.mdx`, the `--check` failure block + sentence:

- The block now shows the captured real bytes under the authoring shell
  (bash-as-`/bin/sh`): line 1 = `crust: shell stage does not parse
  (stage: head -(): sh: -c: line 1: syntax error near unexpected token '('`,
  line 2 = `  in: range(1,3) | head -(`. No third line.
- The sentence now describes the real placement: the first line ENDS with
  your `/bin/sh`'s own first error line — its own prefix included — and
  crust captures the preflight's stderr and keeps only that first line,
  passing its wording through unchanged; there is no third line. The
  bash/dash wordings are kept as the two examples of "its own words" (the
  dash half explicitly as what CI usually has, unchanged in status:
  C-by-delegation).
- "grep for `shell stage does not parse`" kept — that half was correct.

The paragraph directly below (the runtime-preflight twin, "exits 2 with the
message above") needed no change — the probe confirmed the exec path prints
the identical bytes, so "the message above" is now accurate. Its "(as of
PR #60; in 0.2.4 only `--check` has it)" clause is G29's target, untouched
here.

Site gates at `a184bab`: build 31 pages; lint-examples 362 checked / 0 failed
(the ```text fence is not a crust example, count unchanged); check-links 1313
(41 with an anchor) / 0 dead — all at baseline. No crust code changed — the
binary was already right; the crust-side change is docs/audit only.

## W217 resolution (this commit, `full-audit.md`)

- **W217** (L864): the row's `?` closes as **X** (the row's subject was the
  block's format — the confirmed X, now fixed) and the tail is annotated —
  fixed 2026-10-31 via site `a184bab`; the (b) capture ran (check path +
  whole-line variant + exec twin, `f` absent), cross-consuming W218's
  sharpest (b) item; dash absent on this box, dash wording stays
  C-by-delegation.
- **X census** (L137–144): `W217 (cli skill page `--check` failure block: …
  → G28)` annotated `— FIXED 2026-10-31 via site \`a184bab\``.

## Commit

- site `a184bab` — `fix(docs): the shell-stage failure block showed a line crust never prints (audit W217)` (8 insertions / 5 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W217 row and X-census entry in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `5296c8e5`) — `round-9-cli-contract.md` §2 gains the preflight-refusal shape
