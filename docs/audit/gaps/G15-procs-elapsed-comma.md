# G15 — procs page: `elapsed: 1,842 ms` pin vs `toFixed(0)`

**Doc:** website `src/pages/docs/recipes/dev-tail.mdx` ("One dev tail"),
L128–158 "## What you'll see" (audit W586).

## Measured

- The pinned output block shows `elapsed: 1,842 ms` — a grouping comma.
- Audit's code read: the line prints `elapsedMs.toFixed(0)`, which **never
  groups** (`1842 ms`).
- The sibling `nodes` line uses `toLocaleString()`, so ITS comma is
  code-consistent — only the elapsed pin is in doubt.

## Probe (first task)

Run the page's W584 rig with a suite longer than 1s so `elapsedMs >= 1000`
at print time. Capture the line:
- `1842 ms` (no comma) → the page pin is wrong → fix the pin (site).
- `1,842 ms` (comma) → the audit's code read missed a formatter → fix in
  crust (red-first test pinning the grouping, CHANGELOG as fix).

## Fix

Whichever side the probe condemns. Site: one-line pin edit + gates.
Crust: red-first test in the procs test file, one commit, full gates.

## Commit

`docs(procs): …` (site) or `fix(procs): …` (crust).
