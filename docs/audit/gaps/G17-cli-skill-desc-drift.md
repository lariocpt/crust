# G17 — agent-skills index: the crust-cli description in the `skills list` block lags the SKILL.md frontmatter

**Doc:** website `src/pages/docs/agent-skills/index.mdx` L28–29
(audit T1, parity check 2026-10-18).

## Measured (mechanical diff, 2026-10-18)

The page's ` ```text ` block (what `skills list` prints) was diffed entry-by-entry
against the nine `skills/*/SKILL.md` frontmatter `description:` fields:

- **8/9 verbatim identical** — crust-api-testing, crust-builtins,
  crust-load-testing, crust-logs, crust-mock-server, crust-pipelines,
  crust-procs, crust-verify-web-links.
- **crust-cli drifts**: the site block reads
  `the run modes (\`-c\`, script file, piped stdin, REPL), what each exit code…`
  while the frontmatter reads
  `the run modes (\`-c\`, script file, piped stdin, REPL, tool subcommands like \`crust skills install\`), what each exit code…`
  The clause landed in the frontmatter in crust `1581fcd`
  ("docs: tool builtins are commands, and `skills install` now asks which ones").
  The site-side sync commit `dbc6fed` ("docs: the tool verbs are commands, and
  `skills install` asks which skills") touched index.mdx (34 lines) but the text
  block is absent from its diff — the hand-copied duplicate was missed.
  A user comparing the two surfaces (page vs `skills list` output) sees the drift.

## Fix

Website: in `src/pages/docs/agent-skills/index.mdx`, add the missing
`tool subcommands like \`crust skills install\`` clause to the crust-cli entry of
the `skills list` text block so it matches the frontmatter verbatim. SKILL.md is
canonical (embedded in the binary, linted by `tests/skills.test.ts`) — the site
block follows it, not the other way round.

Website commit + gates (`bun run build`, `bun scripts/lint-examples.mjs …`,
`bun run check-links` — counts unchanged: the edit is inside a text block).

## Commit

`docs(agent-skills): sync the crust-cli description with the SKILL.md frontmatter` (site).
