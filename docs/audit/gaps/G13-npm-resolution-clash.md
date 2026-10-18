# G13 — npm-packages page: `init.ts` npm imports vs the compiled-binary constraint

**Doc:** website `src/pages/docs/npm-packages.mdx` L208–221 (audit W129) and
L240–257 (audit W131).

## Measured

- W129 shows a user `.ts` doing `import "crust"; // loads init.ts which created
  the two SQL clients` — i.e. the npm package as an **importable entry** with a
  side effect of loading `init.ts`.
- W131 shows `init.ts` registering DuckDB/ClickHouse shims:
  `import { Database } from "duckdb-async"; …`, a `Bun.SQL`-shaped client per
  driver.
- AGENTS.md hard constraint (verbatim): the shipped artifact is a compiled Bun
  binary; code that dynamically imports USER files "can only import relative
  modules and Bun builtins — **NO third-party npm resolution at runtime**.
  Never add a feature that requires fixtures to import npm packages; point
  users at `Bun.SQL`, `Bun.file`, etc."
- R1 (audit): BOTH install channels (`install.sh`, `npm i -g @lariocpt/crust`)
  resolve the same prebuilt binary — so the constraint holds on the npm channel
  too.

## Questions (the code reads this item runs; audit's code-review step was
deferred 2026-10-18, so these stay explicit tasks here)

1. `npm/package.json` exports: does an importable `crust` entry exist at all,
   and would `import "crust"` load `init.ts` as a side effect?
2. `src/config.ts` `loadConfig`: the path a compiled binary takes to load
   `init.ts` — can `duckdb-async` / `@clickhouse/client` EVER resolve there?
3. Is the W131 pattern valid for any channel (e.g. plain `bun` running a user
   script, where npm resolution works)? If yes, the page must say which
   channel, not imply all of them.

## Fix (depends on the decision)

- If unresolvable everywhere: rewrite the page's TS examples to the
  `Bun.SQL`-only pattern the constraint points at; keep `init.ts` for
  `crust.fn`/`alias`/prompt/hooks (no npm imports).
- If valid on a channel: state the channel explicitly in the page.
- Design rule: never document behavior not run through the binary.

## Docs / website / KB

- Website: `npm-packages.mdx` (both TS blocks) + `db-drivers.mdx` if it repeats
  the shim pattern (audit SK60/W107 sql-parity family cross-ref).
- KB: `knowledge/learnings/round-10-limits-measured.md`.

## Commit

`docs(npm-packages): …` (site) — no crust code expected; if a code answer
changes, that's a separate item.
