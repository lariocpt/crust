# G25 — USAGE.md builtins table: two tool rows omit flags the CLIs' own usage lines document

**Doc:** crust repo `docs/USAGE.md` builtins table (L1089–1108, the
`| Builtin | Behaviour |` table). Audit U61 (flag-table half X), code
review group (d), 2026-10-19.

## Measured (table vs each CLI's `SPEC` + usage line, all read 2026-10-18)

All six tool-builtin rows cross-checked against their `SPEC`s:

| Row | SPEC | Verdict |
|---|---|---|
| `test-fixture <glob> [-o p] [-j N] [-n N] [-t ms] [-b]` | testFixture/cli.ts L30–37 | exact match (positional is `file\|glob`; `<glob>` is a fine summary) |
| `test-pipes <glob> [-b] [-t ms] [-s m]` | testPipes/cli.ts L29–35 | **omits `[-o <path>]`** — SPEC L31; the CLI's own usage line (L6) is `test-pipes <file\|glob> [-o <path>] [-b] [-t <ms>] [-s <module>]`; `--out <path>` (`.json` raw / `.xml` JUnit) is documented in the linked `### test-pipes` section |
| `gen-fixtures <spec> [-o d] [-s m] [--no-flows]` | genFixtures/cli.ts L36–41 | exact match |
| `mock-server <spec> [-p N] [-b addr] [--stateful] [--state …] [--seed …] [--validate] [--strict] [--proxy <upstream>]` | mockServer/cli.ts L48–60 | **omits `--proxy-timeout` (default 30000) + `--report <path>`** — SPEC L58–59; the CLI's own usage nests them under `[--proxy <upstream> [--proxy-timeout ms] [--report path]]`; both documented in the linked `### mock-server` Flags line |
| `verify-web-links <url\|sitemap> [-c N] [-t ms] [--fixtures g] [--exclude s]` | verifyWebLinks/cli.ts L258–279 | legitimate summary — the CLI's own synopsis is just `[options]` (17 flags total, all in the linked `### verify-web-links` section) |
| `skills <list\|install> [-g] [-f] [--all] [--select a,b]` | skillsCli.ts L22–27 | exact match (`--select` repeatable) |

The table's implicit promise — a complete per-builtin flag synopsis, kept
verbatim against the CLI usage lines in the other rows — is broken in
exactly these two rows. Both omitted flags are CI-relevant (`test-pipes -o`
= the JUnit report path; `mock-server --report` = the violations NDJSON
file), and neither is reachable from the table without following the
`See […]` link down to the section.

## Impact

Low severity, docs-only: a user reading only the builtins table misses two
working flags. No behavioral contradiction — every listed flag is correct;
the rows are incomplete. Same class as the W235 roster drift (docs-vs-code
in the reference table), smaller blast radius.

## Out of scope for this gap (cross-refs, NOT closed here)

The U61 probe items (alias single-pass termination; history file path;
`cd -`) stay in the (b) queue. The session-builtin rows of the same table
(`cd`/`export`/`alias`/… behaviour prose) were settled in (a) and are not
flag-synopsis claims.

## Fix

`docs/USAGE.md` builtins table, two rows:

- `test-pipes` → `test-pipes <glob> [-o <path>] [-b] [-t ms] [-s m]`
- `mock-server` → append `[--proxy <upstream> [--proxy-timeout ms] [--report path]]` (keep the existing flat row style: `… [--validate] [--strict] [--proxy <upstream> [--proxy-timeout ms] [--report path]]`)

Verification: `tests/docs-lint.test.ts` (the table row is prose, so the
parse-only suite is the floor), `bun test` before pushing; re-diff each row
against its CLI's `--help` output after the edit.

## Commit

`docs(builtins): table rows for test-pipes and mock-server list the full flag sets (audit U61)` (crust).
