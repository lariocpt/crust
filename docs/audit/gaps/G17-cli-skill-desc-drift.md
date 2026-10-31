# G17 — agent-skills index: the crust-cli description in the `skills list` block lags the SKILL.md frontmatter

**FIXED 2026-10-31** — site `075ca30` (one page:
`src/pages/docs/agent-skills/index.mdx`, one line) · T1 `X` stands and is
annotated — the drift confirmed, the site block now verbatim with the
frontmatter (re-probe 2026-10-31: **10/10 identical**, `~/tmp/g17/`) ·
X-census entry annotated · audit (this commit) · KB (crust-agent submodule,
local commit only — ingest is operator-controlled, `07c7350d`):
`round-9-cli-contract.md` gains §8 (hand-copied duplicates drift; the
frontmatter wins) and corrects the nine-skills note to ten. **MCP reviewed —
no overlap**: the fix makes a site text block match the canonical SKILL.md
frontmatter; no functional usage changed (the binary's own `skills list`
output was always the frontmatter — the site was the stale copy), so the
nine `crust_*` tools and `skills/crust-mcp/SKILL.md` stay as-is (the standing
order's display-only case, recorded not skipped).

## The gap (as filed — site `src/pages/docs/agent-skills/index.mdx` L28–29, audit T1, parity check 2026-10-18)

The page's ` ```text ` block (what `skills list` prints) was diffed
entry-by-entry against the `skills/*/SKILL.md` frontmatter `description:`
fields:

- **8/9 verbatim identical** (accurate for the audit's date — the set had
  nine skills on 2026-10-18) — crust-api-testing, crust-builtins,
  crust-load-testing, crust-logs, crust-mock-server, crust-pipelines,
  crust-procs, crust-verify-web-links.
- **crust-cli drifts**: the site block reads
  `the run modes (\`-c\`, script file, piped stdin, REPL), what each exit code…`
  while the frontmatter reads
  `the run modes (\`-c\`, script file, piped stdin, REPL, tool subcommands like \`crust skills install\`), what each exit code…`
  The clause landed in the frontmatter in crust `1581fcd` (2026-10-15,
  "docs: tool builtins are commands, and `skills install` now asks which
  ones" — the frontmatter hunk adds exactly the clause). The site-side sync
  commit `dbc6fed` (same day, "docs: the tool verbs are commands, and
  `skills install` asks which skills") touched index.mdx (34 lines) but every
  line of its index.mdx diff is prose about the install menu — the text block
  is absent from it (verified 2026-10-31: `git show dbc6fed -- …/index.mdx |
  grep -c 'tool subcommands'` → 0) — the hand-copied duplicate was missed.
  A user comparing the two surfaces (page vs `skills list` output) sees the
  drift.

All five claims re-verified 2026-10-31 against the real repo state; the
only correction is a count, in place: the skill set is now **ten** —
`crust-mcp` landed post-audit (crust `03b1337`, site `2a1d592`, both
2026-10-30, "the tenth skill") — so the verbatim ratio is **9/10**, not
8/9, with `crust-cli` the only drift in either count. (The as-filed
line refs L28–29 were already right: entry name L28, description L29.)

## Measured (re-probed 2026-10-31, `~/tmp/g17/probe.mjs` → `probe.log` red, `probe-green.log` after the fix)

Mechanical diff of all ten: the probe extracts the ` ```text ` block after
"## See what's embedded" (L23–44) entry-by-entry and compares each against
`skills/<name>/SKILL.md` frontmatter `description:`; name sets compared
first (10 = 10, no missing, no extras).

**Red (pre-fix):**

```
crust-cli: DRIFT
    frontmatter-only: ", tool subcommands like `crust skills install`"
    site-only       : ""
    common-prefix: "…the run modes (`-c`, script file, piped stdin, REPL"
    common-suffix: "), what each exit code actually means (0/1/2/127/130, and wh…"
verdict: 1 of 10 drift/missing   (the other nine — incl. crust-mcp — IDENTICAL)
```

**Green (post-fix):**

```
crust-api-testing … crust-verify-web-links: IDENTICAL ×10
verdict: ALL IDENTICAL
```

The drift is exactly the one clause, exactly where filed (after `REPL`,
before `), what each exit code`) — no other delta anywhere in the block.

## The fix

`index.mdx`, the `crust-cli` entry of the ` ```text ` block: the run-modes
parenthetical now reads "(`-c`, script file, piped stdin, REPL, tool
subcommands like `crust skills install`)" — the frontmatter verbatim.
SKILL.md is canonical (embedded in the binary, linted by
`tests/skills.test.ts`, and it is what `crust -c 'skills list'` prints) —
the site block follows it, not the other way round. One line in, one line
out; the edit is inside a text block, so no example count moves.

Site gates at `075ca30`: build 31 pages, lint-examples 362 checked / 0
failed, check-links 1313 (41 with an anchor) / 0 dead — all at baseline.

## T1 resolution (this commit, `full-audit.md`)

- **T1** (L1427): the **X** verdict stands and is annotated — the site
  block lagged the canonical frontmatter (the site is BEHIND; the block is
  hand-copied with no generation step, per the website Jenkinsfile Grammar
  comment, and `crust --check` never diffs prose), fixed 2026-10-31 via
  site `075ca30`. The row's nine-skills / 8-of-9 count stands as filed —
  accurate for its 2026-10-18 measurement date — and the annotation
  records the 2026-10-31 re-verification over all ten skills (9 of 10
  verbatim with `crust-cli` the only drift; 10/10 after the fix,
  `~/tmp/g17/`).
- **X census** (L103): `T1 (agent-skills index: crust-cli `skills list`
  block lags SKILL.md frontmatter → G17)` annotated with the resolution —
  `FIXED 2026-10-31 via site `075ca30`` (the R24/W235 "FIXED" convention
  for closed census entries).

## Commit

- site `075ca30` — `docs(agent-skills): sync the crust-cli description with the SKILL.md frontmatter` (1 insertion / 1 deletion)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the T1 row/X-census in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `07c7350d`) — `round-9-cli-contract.md` gains "## 8. The site's `skills list` block is hand-copied — it drifts, and the frontmatter wins" and corrects the §7 nine-skills note to ten
