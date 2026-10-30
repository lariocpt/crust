# G34 — `sql` never converts the documented `?` placeholder; every bound query dies (BLOCKER)

**Status: OPEN.** Reported in the 2026-10-30 dogfood (`~/CRUST-BUGS-30-oct.md`, BUG-1),
verified independently on this checkout the same day. Severity: **blocker** — there is
no working way to bind a parameter, on the shape three docs and the CHANGELOG tell
people to write.

## The contract, as documented

`docs/USAGE.md:177` — "**Fn args are positionals, not SQL placeholders**: `sql "…
WHERE name = $1"` expands the script's `$1` into the query; the bound-parameter
placeholder is `?` — `sql "… WHERE name = ?" "Court"`."
`CHANGELOG.md:27` — "`$N` in a registered-fn argument is now a positional, so a SQL
query's placeholder is `?` (`sql "… WHERE name = ?" "Court"`), not `$1`."
`skills/crust-builtins/SKILL.md:100`, `skills/crust-pipelines/SKILL.md:36,50` — same.

So `?` is the contract in prose, in the changelog, and in the skills. It is not the
code.

## The defect

`src/builtinFns/sql.ts:36-43`:

```ts
async function runQuery(query: string, params: unknown[]): Promise<unknown[]> {
  …
  return client.unsafe(query, params);   // ← query reaches the driver untouched
}
```

Bun's Postgres client speaks `$n`. There is no `?` → `$n` conversion anywhere in the
file (grep for `toDollar|placeholder|\$1` finds nothing). Net effect:

| what the docs tell you to write | what the driver receives | result |
|---|---|---|
| `sql "… WHERE email = ?" "a@b.c"` | literal `?` | Postgres rejects it |
| `range(0,0) \| (n => "a@b.c") \| sql "… WHERE email = ?"` | literal `?` | Postgres rejects it |
| the old `sql "… WHERE email = $1" "a@b.c"` | `… WHERE email =` (the `$1` was expanded to empty by the parser) | **"syntax error at end of input"**, produced by crust, pointing at SQL |

Dogfood impact: 9/30 business `.pipes` lines and 8 load lines failed on first contact.

## Measured on this checkout (2026-10-30), without needing a database

The truncation half is a *parser* effect, so it is provable against any registered fn:

```
$ ./bin/crust -c 'base64 "a$1b"'
YWI=            # base64("ab") — the $1 is GONE before the fn sees it
```

`base64("a$1b")` would be `YSRhMWI=`; what came back decodes to `ab`. That is the
exact mechanism that turns a query into `… WHERE email =` and Postgres into "end of
input".

## The fix must be dialect-aware (the dogfood patch is not enough)

`Bun.SQL` here serves **both** sqlite and Postgres — `docs/USAGE.md:1650-1675`
documents `sqlite://` and `postgres://`/`postgresql://` URLs, and the mock-server
state layer switches DDL between them. sqlite's native placeholder **is** `?`.

So an unconditional `?` → `$n` rewrite (the 6-line local patch from the dogfood run)
fixes Postgres and **breaks sqlite**. The conversion must be gated on the dialect:

- `postgres://` / `postgresql://` → rewrite `?` → `$1…$n`, left to right, **skipping
  single-quoted literals** (and `''` escapes inside them).
- anything else (sqlite, mysql) → leave the query exactly as written.
- zero declared params **and** no piped item → leave the query as written, so a
  literal `?` in a constant survives (the docs already promise untouched queries when
  nothing binds).

## Why CI missed it (the actual lesson)

There is **no sql test at all** — `grep -l "sqlSource|unsafe" tests/` finds only
`tests/mock-state.test.ts`, which uses the mock-server's own state client, not the
`sql` stage. 1315 tests pass while the stage's only useful mode is dead. The
regression is untested surface, not a flake.

## Tests (red-first)

1. **Pure**: `toDollarPlaceholders()` — `?`→`$n` ordering; `?` inside `'…'` untouched;
   `''` escape handled; zero params ⇒ untouched.
2. **sqlite end-to-end** (`DATABASE_URL=sqlite://<tmpfile>`, no external service, so
   it runs in CI): insert + `sql "… WHERE name = ?" "Court"` returns the row —
   proves both the binding path and that sqlite is NOT rewritten.
3. **postgres end-to-end**, gated on `$CRUST_PG_URL`, reported as a **skip** when
   unset and labelled why. Deliberate: the suite's contract is 1 skip today, so a
   conditional skip must be counted in `docs/audit/FIX-PROGRESS.md`, never hidden.
   CI with a database gets the coverage that would have caught this.
4. **Regression pin for the parser interaction**: `base64 "a$1b"` must keep encoding
   `ab` (that is correct behaviour and must not be "fixed" by the sql change), and a
   query containing `$1` with zero params must produce crust's new named error, not a
   driver syntax error.

## Docs half (same gap, different file)

`skills/crust-pipelines/SKILL.md:102` demonstrates the dead form:
`sql "SELECT count(*)::int AS c FROM users WHERE email = $1" "a@b.c"` — must become
the `?` form. `:35`'s `sql "SELECT …" $1-params` notation reads as `$1` placeholders
and should say `?` too. `tests/skills.test.ts` only classifies skill fences, so this
needs a manual `crust --check` pass, not just a green suite.

## Diagnostic worth adding

A query that still contains `$n` when it reached the driver with zero params is
almost always this trap. A named error ("`$1` in a query is the script's positional
argument — the bind placeholder is `?`") turns a Postgres-flavoured message into the
fix. Keep it cheap: only when params are empty and `/\$\d/` matches.
