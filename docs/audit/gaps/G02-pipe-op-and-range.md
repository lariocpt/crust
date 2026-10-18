# G02 — `|>` operator and `[0..9]` range literal: close the claim

**Doc:** `docs/USAGE.md:2200` ("Need a Bun loader; v0.2."). Also
`docs/PLAN.md:70,127,376` and `docs/spec/v0.1-contract.md:128`.

## Verdict

Still absent — grep finds the two names **only in docs**, never in
`src/lexer.ts`/`src/parser.ts`. Nothing was ever built.

## Recommendation: close as won't-fix, and say why

Neither belongs in crust's grammar; keeping the promise is what makes the bullet
rot:

- **`|>` is meaningless in crust.** `|` already *is* the pipe operator. `|>`
  was a wish for TypeScript host code (`x |> f`), where the honest answer is
  `.pipe()` / nesting — a crust-level operator would be a second spelling of a
  pipe that already exists, which is exactly what design rule 3 forbids.
- **`[0..9]` collides with two live syntaxes.** `[1,$N]` is a JSON-array literal
  (`src/lexer.ts` `looksJsonish`, whose comment exists precisely because a wrong
  verdict there is a silent empty glob), and `[ … ]` spaced is the shell's test
  command. A range literal would be resolved by precedence rules on top of both.
  `range(a,b)` already covers it, plus `seq` as a shell stage and
  `load 10s 100/s` for rate-shaped work.
- **A Bun loader is a real cost, not a TODO.** It means compiling crust with a
  custom transform pipeline over user files, which the compiled-binary
  constraint already limits (fixtures can't resolve npm packages at runtime).

## Fix

Docs-only, three places:

- `docs/USAGE.md`: replace the bullet with a short "Syntax we deliberately did
  not add" note: crust's `|` is the pipe; ranges are `range(a, b)` / `seq`;
  in TS use `.pipe()`. Move it out of "Limits" if G12 restructures that section.
- `docs/PLAN.md`: mark the three parked entries **decided — won't fix** with the
  collision reason (one line each), so it stops reading as pending work.
- `docs/spec/v0.1-contract.md:128`: same, in the stretch list.

## Tests

None (no behaviour change). If the reworded examples include crust lines they
must pass `bun src/index.ts --check` — `tests/docs-lint.test.ts` enforces that.

## Website / KB

- Website: no page advertises `|>` or `[0..9]` today (grep first: `grep -rn
  '|>\|\[0\.\.' src`); if any copy does, correct it in the same PR.
- KB: fold into `round-10-limits-measured.md` as an explicit
  "considered and rejected" note — future rounds re-litigate decided things
  otherwise.

## Commit

`docs(syntax): close the |> and [0..9] wishes as decided — crust's | is the pipe`
