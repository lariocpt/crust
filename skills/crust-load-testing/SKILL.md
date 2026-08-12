---
name: crust-load-testing
description: Load-test and soak-test HTTP services with crust — the load rate source, parallel workers, timed verbs, stats windows, CI threshold gates via assert, and baseline comparison with stats --out. Use for smoke-load, latency percentiles, rps checks, performance regression gates in CI, or "is this endpoint fast/degrading" questions.
---

# crust load testing

One line gives you a paced load run with real percentiles and a CI-ready
exit code. This is smoke-load and soak tooling (honest ceiling ~500–1000
requests/s per process) — not a distributed rig.

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

- `parallel` puts ANY http verb in load mode: output is `{status, ms, url}`
  timing records, bodies drained, network errors become `status: 0` records
  (they show in the histogram instead of killing the run).
- Rate (`load`) and concurrency (`parallel N`) are independent knobs.
  Little's law sizes the pool: `N ≥ rate × p99-in-seconds`.
- Durations `ms|s|m`; rates `N/s` or `N/m`, decimals allowed.

## Honesty guarantees (read before quoting numbers)

- `stats.rps` is MEASURED, never the target. If downstream saturates, stale
  slots are skipped (never burst) and reported on stderr:
  `load: target 3000 ticks — emitted 2868, dropped 132 … achieved 95.6/s`.
  A drop report means the target rate was NOT sustained — raise `parallel N`
  or lower the rate before quoting percentiles.
- Percentiles come only from timed records; they include body download.
- With `--every`, a slow request lands in the window it FINISHED in.

## CI gates — thresholds are assert composition

```crust
load 30s 100/s | parallel 50 | GET :3000/health | stats | assert (s => s.p95 < 200) | assert (s => s.rps > 80)
```

One assert per threshold: the failure names the predicate and prints the
actual summary, and the line exits 1 (`crust -c` stops there).

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
the final summary; both are also correct without `--every`.

## Warmup

A separate line in the same script — its stats simply aren't gated:

```crust
range(0, 99) | parallel 10 | GET :3000/health | stats
load 30s 100/s | parallel 50 | GET :3000/health | stats | assert (s => s.p95 < 200)
```

## TS API equivalent

```ts
const out = await load([{ durMs: 10_000, rps: 100 }])
  .pipe(parallel(50, timedGet("http://localhost:3000/health")))
  .pipe(statsStage(undefined, "load/last.json"))
  .collect();
```

`timedHttpItem(method, url, opts?)` is the any-verb per-item timer when you
need POST bodies from upstream items.
