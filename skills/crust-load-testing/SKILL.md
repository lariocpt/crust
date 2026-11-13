---
name: crust-load-testing
description: Load-test and soak-test HTTP services with crust — the load rate source, parallel workers, timed verbs, stats windows, CI threshold gates via assert, and baseline comparison with stats --out. Use for smoke-load, latency percentiles, rps checks, performance regression gates in CI, or "is this endpoint fast/degrading" questions.
---

# crust load testing

One line gives you a paced load run with real percentiles and a CI-ready
exit code. Tick pacing batches due slots per wakeup, so the generator
sustains 5000+ ticks/s — your real ceiling is downstream (`parallel` pool ×
service time). Single-process smoke-load and soak tooling, not a
distributed rig.

## The shapes

```crust
# fixed volume: N requests, K at a time
range(0, 999) | parallel 50 | GET :3000/health | expect 200 | stats

# paced: arrival RATE for a DURATION (load 30s 100/s), concurrency capped by parallel
load 30s 100/s | parallel 50 | GET :3000/health | expect 200 | stats

# ramp: comma-separated phases, one stats stream across all of them
load 10s 50/s, 30s 200/s | parallel 100 | GET :3000/health | stats --every 5

# POST load: ticks are {n, phase, scheduledAt, lagMs} — build bodies from them
load 10s 20/s | (t => ({name: "user" + t.n})) | parallel 8 | POST :3000/users | expect 2xx | stats
```

> **Report availability:** `expect` throws at drain, so an `expect` placed
> BEFORE `stats` that fails prevents the summary from ever being emitted
> (the first two shapes above are illustrative of syntax, not of CI
> reporting). When the summary/report must survive a status failure, put
> `stats` (and `stats --out report.json`) before the gates and gate status
> on the summary instead — see CI gates below.

- `parallel` puts ANY http verb in load mode: output is `{status, ms, url}`
  timing records, bodies drained, network errors become `status: 0` records
  (they show in the histogram instead of killing the run). So a run whose
  every request was refused prints `{"status":{"0":40}}` and still exits 0
  unless a gate is present — `expect 200` over a dead port exits 1. `stats`
  reports, it does not gate.
- **Completion ≠ success — three separate outcomes:** the run *completed*
  (exit 0, no fatal stage error), *request correctness passed* (explicit
  gates accepted the outcomes), *performance passed* (latency/throughput
  thresholds held). A gate that only checks latency can be satisfied by fast
  error responses — a 500 in 2ms is under any p95 budget. Latency-only
  examples are NOT the definition of a passing load test; gate status too.
- The summary carries failure tallies `timedOut` and `redirectRefused`
  (always present, 0 on a clean run): a `--timeout` budget hit or a
  `--redirect error` refusal is a `{status: 0, timedOut/redirectRefused:
  true}` RECORD, not a failure exit. Gate them — `expect 200` (status 0
  fails it) or `stats | assert (s => s.redirectRefused === 0)`; exit 0
  alone is never request success in load mode.
- Rate (`load`) and concurrency (`parallel N`) are independent knobs.
  Little's law sizes the pool: `N ≥ rate × p99-in-seconds`.
- Durations `ms|s|m`; rates `N/s` or `N/m`, decimals allowed.

Canonical, version-pinned result-shape table: https://lariocpt.github.io/crust-website/docs/http-result-shapes/.

## Honesty guarantees (read before quoting numbers)

- A gate that measured NOTHING fails: `stats` over an empty stream is tagged
  `empty: true` and `assert` refuses it. `{count: 0, p95: 0}` used to satisfy
  `s => s.p95 < 200`, so a run that issued zero requests reported success.
- Percentiles are bucketed (0.1ms below 100ms, 1ms below 1s) and report the
  bucket's upper bound — never faster than reality. `count` and `meanMs` are
  exact. Memory is constant, so a multi-hour soak is safe.

- `stats.rps` is MEASURED, never the target. If downstream saturates, stale
  slots are skipped (never burst) and reported on stderr:
  `load: target 3000 ticks — emitted 2868, dropped 132 … achieved 95.6/s`.
  A drop report means the target rate was NOT sustained — raise `parallel N`
  or lower the rate before quoting percentiles.
- Percentiles come only from timed records; they include body download (a
  route that drips its body over 100ms reports p50 102, not 0.4).
- With `--every`, a slow request lands in the window it FINISHED in — and
  because stats waits for a completion before it can flush, a window's
  `wallMs` can exceed N (measured: `--every 2` → window 1 `wallMs: 3006`).
- `--out` takes `.json` only — any other extension is a loud error, never a
  text file written under a json-looking name.

## CI gates — thresholds are assert composition

The primary shape gates **status first, then performance**, with `stats`
(and the report) upstream of every gate so the summary survives a failing
gate. When failure artifacts must survive request-status failures, collect
statistics and write the report BEFORE applying aggregate gates:

```crust
load 30s 100/s | parallel 50 | GET :3000/health | stats --out load/last.json | assert (s => Object.keys(s.status).every(k => k.startsWith("2"))) | assert (s => s.timedOut === 0) | assert (s => s.redirectRefused === 0) | assert (s => s.p95 < 200) | assert (s => s.rps > 80)
```

One assert per threshold: the failure names the predicate and prints the
actual summary, and the line exits 1 (`crust -c` stops there). The gates
above cover all four things a load gate must mean: every response was 2xx
(a fast 500 is not a pass), no timeout or redirect-refusal records, the
latency budget held, and the achieved rate held. An empty run is refused by
`assert` itself (`empty: true`), so "measured nothing" never passes.
`rps` is the ACHIEVED rate — if the target was not sustained, stderr already
said so (`emitted … dropped … achieved …`); a drop report means the number
below the rate gate is the honest one.

Baseline gate — `--out` writes a versioned artifact
(`{crustStats: 1, startedAt, urls, summary, windows?}`), an async assert
reads it back:

```crust
load 10s 100/s | parallel 50 | GET :3000/health | stats --out load/last.json | assert (async s => { const b = await Bun.file("load/baseline.json").json(); return s.p95 < 2 * b.summary.p95 })
```

The artifact is written BEFORE the gate runs, so a failed gate still leaves
the file for CI upload.

Soak with fail-fast windows (`--every N` emits `{window: k, …}` deltas then
`{final: true, …}`; a bare predicate gates every one of them):

```crust
load 60s 25/s | parallel 25 | GET :3000/health | stats --every 5 | assert (s => !s.window || s.p95 < 400)
```

Guard `!s.window ||` scopes a threshold to window objects, `!s.final ||` to
the final summary — and a guard needs the object it guards. Without `--every`
the plain summary carries neither key, so `!s.window` is true and `||`
short-circuits: the threshold never runs. `stats | assert (s => !s.window ||
s.p95 < 0.1)` exits 0 with p95 at 4.2. Drop the guard when you drop `--every`.

## Warmup

A separate line in the same script — its stats simply aren't gated:

```crust
range(0, 99) | parallel 10 | GET :3000/health | stats
load 30s 100/s | parallel 50 | GET :3000/health | stats | assert (s => s.p95 < 200)
```

## TS API equivalent

The same surface as globals inside `init.ts` (and crust-run config code) —
`load`, `parallel`, `timedGet`, `timedHttpItem`, `statsStage`, `Pipeline`:

```ts
const out = await load([{ durMs: 10_000, rps: 100 }])
  .pipe(parallel(50, timedGet("http://localhost:3000/health")))
  .pipe(statsStage(undefined, "load/last.json"))
  .collect();
```

`timedHttpItem(method, url, opts?)` is the any-verb per-item timer when you
need POST bodies from upstream items.

## Version and evidence

Behavior here was verified against **crust v0.3.5** — summary schema
(`{count, wallMs, rps, status, timedOut, redirectRefused, p50, p95, p99,
meanMs}`, `empty: true` on a zero-request run) and the `--out`-before-gates
write order are source-verified; throughput claims (5000+ ticks/s) are
single-process measurements on the author's hardware — environment-dependent,
not a promise. Pick the lightest correct layer for the job (see the
crust-api-testing skill's shared principle), and keep approved targets and
execution restrictions in repository policy, not in this skill.
