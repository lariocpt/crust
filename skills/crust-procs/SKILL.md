---
name: crust-procs
description: Run and supervise dev processes with crust — procs() merges multiple long-lived commands into one pipeable stream with per-proc env, restart backoff, readiness probes (ready:), dependency ordering (after:), and process-group teardown; wait blocks until a port/URL is up. Use for dev runners ("start db, api, web in order"), readiness gating in CI, tailing multiple services, or mining merged process logs.
---

# crust procs & wait

## procs() — the one-tail dev runner

```crust
procs({web: "bun run dev", api: "bun api.ts"}) | (l => l.proc + " | " + l.line)
```

Every stdout/stderr line becomes `{proc, stream, line}` — a PIPELINE ITEM,
not text. Grep it, transform it, count it. Streams: `stdout`, `stderr`,
`exit`, `ready`, `live`.

Full spec form:

```crust
procs({ db: {cmd: "docker compose up pg", ready: "port:5432"}, api: {cmd: "bun api.ts", after: "db", ready: ":3001/health", live: {url: ":3001/health", failures: 3}, restart: {max: 3}}, web: {cmd: "bun run dev", after: "api", env: {PORT: "3001"}} })
```

- `env` — per-proc overlay on the inherited environment.
- `restart: true` — respawn on unexpected exit (backoff 250ms→2s; >10s
  uptime while READY resets it — a proc that hangs un-ready until its
  ready-timeout kill never does, and with `live:` uptime ends when a fatal
  probe streak BEGAN, so a proc that wedges right after ready still accrues
  strikes). `restart: {max: N}` gives up after N consecutive restarts.
  Ctrl-C never respawns. **Giving up is not a failure**: `giving up after N
  restart(s)` is an `exit`-stream line and the line still exits 0 (same for a
  child that exits nonzero with no `restart:` — its stream just ends). Gate it
  in CI: `| (l => { if (/giving up|unhealthy/.test(l.line)) throw new Error(l.line); return null })`.
- `ready:` — `":3001/health"` / `"http(s)://…"` (any 2xx) or `"port:5432"`
  (TCP connect). Long form `{url?, port?, timeoutMs?, intervalMs?,
  probeTimeoutMs?}` (defaults 30s / 250ms; each probe capped at
  `min(intervalMs*4, 2s)` unless `probeTimeoutMs` raises it). `timeoutMs`
  belongs INSIDE the ready object: as a sibling of `cmd` it is ignored
  silently — `{cmd: "sleep 40", ready: "port:4199", timeoutMs: 1200}` waits
  the full default 30s. Timeout: a restartable proc is killed and respawned
  (readiness re-awaited each spawn); a non-restartable one FAILS the whole
  pipeline — CI semantics.
- `live:` — liveness for the unhealthy-but-alive case. Same target forms;
  long form `{url?, port?, intervalMs?, probeTimeoutMs?, failures?,
  graceMs?}` (defaults 5s / 3 failures / 0 grace). Use `url:` here: a
  `port:` probe is a TCP connect, so it cannot see a wedged listener — a
  server answering 503 for four seconds with `live: {port, failures: 3}`
  logged nothing and the run exited 0. Arms once the proc is up
  (after `ready:`, else at spawn); `live`-stream lines: `probe failed
  (k/N)`, `recovered after k failed probe(s)`, `unhealthy after N
  consecutive failed probe(s)`. Fatal streak: restartable → killed +
  respawned (re-arms after next ready); non-restartable → FAILS the
  pipeline, like a ready-timeout.
- `after:` — name or list; the proc spawns only once its dependencies are
  READY (no `ready:` on the dep = ready at spawn). One-shot gate; a dep
  that dies before ever becoming ready fails the pipeline. Unknown names /
  self-deps / cycles throw before anything spawns.
- Teardown: children run in their own process groups; SIGTERM to all, 3s
  grace, then SIGKILL — grandchildren from `sh -c` don't survive.

## Log mining on the merged stream

```crust
procs({api: "bun api.ts", worker: "bun worker.ts"}) | (l => { try { return JSON.parse(l.line) } catch { return { level: 30, msg: l.line, proc: l.proc } } }) | filter (e => e.level >= 40) | (e => "WARN+ " + (e.msg ?? ""))
```

(`filter` drops the sub-WARN entries; a plain lambda with `: null` would
print a literal `null` line for every one of them.)

Objects printed to stdout are JSON lines — pipe the whole thing into
`pino-pretty` via a shell stage, or count errors with `grep`/`wc`.

To iterate on these filters WITHOUT restarting the dev stack, hold it in a
`logs` session instead: `logs procs({api: "bun api.ts", worker: "bun
worker.ts"})` keeps the group running and buffers its recent output; each
line you type (`filter (l => l.proc === "api")`, `(l => l.line) | grep -i
error`) runs over the buffer, then live until Ctrl-C. Items stay `{proc,
stream, line}` objects. `exit`/Ctrl-D tears the group down (SIGTERM→SIGKILL).

## wait — readiness as a one-liner (CI's friend)

```crust
wait :3001/api/health --timeout 40s --interval 2s
```

Blocks until the target answers (URL = any 2xx; `port:5432` = TCP connect),
then emits `{target, ready: true, ms, attempts}` and exits 0. Not ready in
time → error, exit 1. Durations: `300ms`, `30s`, `2m` (defaults 30s/500ms).
`--probe-timeout 5s` raises the per-probe cap (default `min(interval*4, 2s)`)
for targets that take longer than that to first byte.
Works in the REPL, `crust -c` (replaces hand-rolled curl-sleep retry loops
in CI), and `.pipes` files. Env-expanded args work:
`wait "$BASE_URL/health" --timeout 40s`.

## Traps

- procs is source-only (first stage). Spec keys are JS object-literal keys, so
  a duplicate collapses BEFORE crust sees it (`{a: "x", a: "y"}` runs only
  `y`) — nothing warns you.
- The merged stream never ends while a `restart: true` child keeps
  respawning — consume it with `for await`/pipe, bound it with a downstream
  condition, or stop it with Ctrl-C: at the REPL that cancels the running
  line and tears the whole process group down (SIGTERM, then SIGKILL).
- `FORCE_COLOR=0` is forced on children so lines stay parseable.
- To capture the stream, END with a shell stage: `procs({…}) | cat > file`
  writes each item as its JSON line. A bare `procs(...) > file` is refused —
  crust has no redirect on its own stages (the `>` would be read as data by a
  pipeline stage); the outer shell can still wrap the whole invocation.
