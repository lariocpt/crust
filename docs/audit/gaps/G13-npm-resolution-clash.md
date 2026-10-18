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
- AGENTS.md hard constraint (verbatim, the line this item now knows to be
  stale): the shipped artifact is a compiled Bun binary; code that dynamically
  imports USER files "can only import relative modules and Bun builtins — **NO
  third-party npm resolution at runtime**. Never add a feature that requires
  fixtures to import npm packages; point users at `Bun.SQL`, `Bun.file`, etc."
- R1 (audit): BOTH install channels (`install.sh`, `npm i -g @lariocpt/crust`)
  resolve the same prebuilt binary — so whatever the runtime does, it does on
  both.

## Questions — ANSWERED 2026-10-18 (investigation unit, user-directed; probes
P1a/P1b/P2/P3a/P4/P5 + controls C1/C2 recorded in full-audit.md §(b) "G13
investigation probes", fresh build `bin/crust-bin` sha256 `947d2f4dd62e6705…`,
Bun v1.4.3)

1. **`npm/package.json` exports: does an importable `crust` entry exist at
   all, and would `import "crust"` load `init.ts` as a side effect?** — **NO.**
   The staged package has no `exports`, no `main`/`module`, no `index` file
   (fields: name/version/description/type/license/author/repository/homepage/
   bugs/keywords/`bin`/`crust`/files/scripts/engines/os/cpu/publishConfig;
   `bin: { "crust": "./bin/crust" }` is the ONLY entry; files = bin/lib/scripts/
   skills/README.md; `postinstall` only fetches the binary). No launcher JS
   loads init.ts — that is the binary bootstrap's job (config.ts L101–108).
   Empirical: P5 `import("crust")` against a real copy of the staged package →
   `Cannot find package 'crust'`, byte-identical to the C2 no-entry control
   (`Cannot find package 'fakecrust'`), distinct from the C1 control
   (`import("left-pad")` → `LOADED, type: function`). → **W129(1) X
   CONFIRMED.**
2. **`src/config.ts` `loadConfig`: can `duckdb-async` / `@clickhouse/client`
   EVER resolve in init.ts under the compiled binary?** — **YES.** Both
   user-file load paths are plain dynamic `import(absolutePath)`
   (`testFixture/runner.ts` L20; `config.ts` L101–108) and the freshly compiled
   binary does standard node_modules resolution walking UP from the user file's
   location: P2 (init.ts `import leftPad from "left-pad"` + `crust.fn` loads
   under the binary; `lp hi` → `000hi`, exit 0), P1b (same-shape `.crust.ts`
   fixture PASSES `test-fixture`, exit 0). P4 pins the standard
   location-dependent failure (`import failed: Cannot find package
   'no-such-pkg-g13' imported from <fixture path>`), surfaced LOUD
   (`import failed: …`, runner L29) — design rule 1. The AGENTS.md line is
   stale, not the page.
3. **Is the pattern valid for any channel?** — **ALL of them.** Both shipped
   install channels are the same prebuilt binary (R1) → both green (P1b/P2);
   source mode green (P3a, `bun src/index.ts` → `000hi`). "Install crust as an
   npm module" changes nothing (the npm package is a ~4KB launcher exec'ing
   that binary) — and is moot now that the binary resolves. The page's "which
   channel" worry was never a real constraint.

## New facts from the investigation (for the fix, not re-litigated here)

- **CJS named-import caveat (P1a):** a CJS single-default package (left-pad's
  `module.exports = fn`) REFUSES named imports even though the module resolves
  (`import { leftPad } from "left-pad"` → `import failed: Export named
  'leftPad' not found in module '…/node_modules/left-pad/index.js'`). Default
  imports always work. The page's `import { Database } from "duckdb-async"` /
  `import { createClient } from "@clickhouse/client"` work **iff** those
  packages' export shapes expose detectable named exports (true ESM, or CJS Bun
  can statically detect); the page should note the fallback.
- **Install-location gap (the page's real hole):** the packages must be
  installed where the USER FILE lives (a `node_modules` reachable upward from
  it — the project dir, or `~/.config/crust/` for init.ts). The page never says
  where.
- **AGENTS.md is in scope now:** the stale hard-constraint line (quoted above)
  and its "Never add a feature…" corollary contradict measured behavior on Bun
  v1.4.3 and must be rewritten as part of this fix.

## Fix (revised 2026-10-18 — original branch: "if unresolvable everywhere:
rewrite to `Bun.SQL`-only; if valid on a channel: state the channel")

1. **crust repo — AGENTS.md** ("Hard constraints"): rewrite the compiled-binary
   bullet to the empirical truth — the crust bundle itself stays zero-dependency;
   USER files (fixtures, init.ts) do standard node_modules resolution from
   their own location under the binary (Bun v1.4.3, probes P1b/P2/P4); delete
   the "Never add a feature…" corollary. (`docs(agents): …` or fold into the
   site-side commit's crust counterpart.)
2. **website — `npm-packages.mdx` L208–221 (W129):** replace the
   `import "crust"; // loads init.ts …` line with the real mechanism: running
   crust (its REPL or any line) loads `~/.config/crust/init.ts` at startup —
   there is no importable module (no exports/main/index; P5/C1/C2).
3. **website — `npm-packages.mdx` L240–257 (W131):** keep the DuckDB/ClickHouse
   shim pattern (it works, every channel) and ADD: (a) install the drivers where
   init.ts lives (`bun add duckdb-async @clickhouse/client` in the project, or
   `~/.config/crust/`); (b) the named-import caveat from the new facts (default
   import if a driver's shape doesn't expose names).
4. **website — `db-drivers.mdx`** if it repeats the same `import "crust"`/shim
   pattern (audit SK60/W107 sql-parity family cross-ref) — same two edits.
5. Design rule: never document behavior not run through the binary — the probes
   in full-audit.md §(b) are the evidence both blocks now describe.

## Docs / website / KB

- Website: `npm-packages.mdx` (both TS blocks) + `db-drivers.mdx` if it repeats
  the shim pattern.
- Repo: `AGENTS.md` (hard-constraint bullet), `docs/USAGE.md` if it carries the
  same "no npm resolution" clause.
- KB: `knowledge/learnings/round-10-limits-measured.md` (the constraint that
  turned out to be stale).

## Commit

- crust: `docs(agents): …` (constraint line) — NO code expected.
- website: `docs(npm-packages): …` (both blocks) — separate PR, same as the
  W129/W131 page fixes; verify with the website's own gates (`bun run build`,
  `lint-examples`, `check-links`).
