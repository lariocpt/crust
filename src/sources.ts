import { stat } from "node:fs/promises";
import { file, Glob } from "bun";
import { Pipeline } from "./pipeline";
import { awaitReady, formatReadyTarget, parseReadyTarget, type ReadyTarget } from "./readiness";
import { HttpTimeoutError, isTimeoutError, labelBodyTimeout } from "./transforms";

export function range(start: number, end: number): Pipeline<number> {
  return Pipeline.of(
    (async function* () {
      for (let i = start; i <= end; i++) yield i;
    })(),
  );
}

export function glob(pattern: string): Pipeline<string> {
  const g = new Glob(pattern);
  return Pipeline.of(
    (async function* () {
      for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
        yield f;
      }
    })(),
  );
}

export function read(path: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      const text = await file(path).text();
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) yield line;
    })(),
  );
}

// Whole-file contents, one item per matched file (vs read(), which streams
// lines of a single file). `read fixtures/*.json | POST …` posts each file's
// full text as a request body.
export function readAll(pattern: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      const looksGlob = /[*?[\]{}]/.test(pattern);
      const paths: string[] = [];
      if (looksGlob) {
        const g = new Glob(pattern);
        for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
          paths.push(f);
        }
        paths.sort();
      } else {
        paths.push(pattern);
      }
      if (paths.length === 0) throw new Error(`read: no files matched ${pattern}`);
      for (const p of paths) {
        yield await Bun.file(p).text();
      }
    })(),
  );
}

export interface TailOptions {
  lines?: number;
  follow?: boolean;
  pollMs?: number;
}

// Polling cadence under follow. Aggressive enough for an interactive log
// stream, gentle enough not to flood a slow disk. Override per call with
// `pollMs` if you need something tighter.
const DEFAULT_TAIL_POLL_MS = 200;

export function tail(paths: string | string[], opts: TailOptions = {}): Pipeline<string> {
  const initialLines = opts.lines ?? 10;
  const follow = opts.follow ?? false;
  const pollMs = opts.pollMs ?? DEFAULT_TAIL_POLL_MS;
  const inputs = Array.isArray(paths) ? paths : [paths];

  return Pipeline.of(
    (async function* () {
      const resolved = await expandTailPaths(inputs);
      if (resolved.length === 0) {
        if (!follow) throw new Error(`tail: no files matched ${inputs.join(", ")}`);
        return;
      }
      if (resolved.length === 1) {
        yield* tailOne(resolved[0]!, initialLines, follow, pollMs);
        return;
      }
      yield* mergeAsync(resolved.map((p) => tailOne(p, initialLines, follow, pollMs)));
    })(),
  );
}

async function expandTailPaths(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (/[*?[]/.test(input)) {
      const g = new Glob(input);
      const matches: string[] = [];
      for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
        matches.push(f);
      }
      matches.sort();
      for (const m of matches) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    } else if (!seen.has(input)) {
      seen.add(input);
      out.push(input);
    }
  }
  return out;
}

async function* tailOne(
  path: string,
  initialLines: number,
  follow: boolean,
  pollMs: number,
): AsyncGenerator<string> {
  let offset = 0;
  let currentIno: number | null = null;
  let buf = "";

  try {
    const s0 = await stat(path);
    const text = await file(path).slice(0, s0.size).text();
    offset = s0.size;
    currentIno = s0.ino;
    if (initialLines > 0) {
      const all = text.split("\n");
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      for (const line of all.slice(-initialLines)) yield line;
    }
  } catch (err) {
    if (!follow) throw err;
  }

  if (!follow) return;

  while (true) {
    await Bun.sleep(pollMs);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(path);
    } catch {
      continue;
    }
    // Rotate-and-recreate: a new inode replaced the old file. Reset
    // and read from the top. Truncate-in-place: same inode but file
    // shrank below our offset. Reset and read from the top.
    if (currentIno !== null && s.ino !== currentIno) {
      offset = 0;
      buf = "";
    } else if (s.size < offset) {
      offset = 0;
      buf = "";
    }
    currentIno = s.ino;

    if (s.size > offset) {
      const chunk = await file(path).slice(offset, s.size).text();
      offset = s.size;
      buf += chunk;
      const split = buf.split("\n");
      buf = split.pop() ?? "";
      for (const line of split) yield line;
    }
  }
}

// Merge N async generators into one stream. Yields each value as soon as any
// upstream produces it (non-deterministic order across sources). Used by
// multi-file tail so `tail a.log b.log` behaves like `tail -f a.log b.log`.
async function* mergeAsync<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
  type Slot = {
    idx: number;
    gen: AsyncGenerator<T>;
    pending: Promise<{ idx: number; res: IteratorResult<T> }>;
  };
  const slots: Slot[] = gens.map((gen, idx) => ({
    idx,
    gen,
    pending: gen.next().then((res) => ({ idx, res })),
  }));
  const active = new Set(slots);
  try {
    while (active.size > 0) {
      const winner = await Promise.race([...active].map((s) => s.pending));
      const slot = slots[winner.idx]!;
      if (winner.res.done) {
        active.delete(slot);
        continue;
      }
      yield winner.res.value;
      slot.pending = slot.gen.next().then((res) => ({ idx: slot.idx, res }));
    }
  } finally {
    for (const s of slots) {
      void s.gen.return?.(undefined as unknown as T);
    }
  }
}

export function GET(url: string, opts?: RequestInit, timeoutMs?: number): Pipeline<Response> {
  return Pipeline.of(
    (async function* () {
      const init: RequestInit = { ...opts, method: "GET" };
      // Minted at generator start (one request per source); a caller signal
      // wins, and only a MINTED signal's abort is ever labeled a timeout.
      let minted = false;
      if (timeoutMs !== undefined && !opts?.signal) {
        init.signal = AbortSignal.timeout(timeoutMs);
        minted = true;
      }
      try {
        const res = await fetch(url, init);
        // The budget keeps governing the body stream downstream — label
        // body-phase timeouts too instead of a bare "operation timed out".
        yield minted ? labelBodyTimeout(res, "GET", url, timeoutMs!) : res;
      } catch (err) {
        if (minted && isTimeoutError(err)) {
          throw new HttpTimeoutError("GET", url, timeoutMs!);
        }
        throw err;
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// procs — run several long-lived commands and merge their output into one
// tagged stream. Built for the "one dev tail" use case: spawn the web app,
// the mobile bundler and a tsc watch, and pipe every line (labelled with its
// process name) through a single formatter.
// ---------------------------------------------------------------------------

export interface ProcLine {
  /** Name of the process this line came from (the spec key). */
  proc: string;
  stream: "stdout" | "stderr" | "exit" | "ready";
  line: string;
}

export interface ReadySpec {
  /** ":3001/api/health" | "http(s)://…" | "port:3001" */
  url?: string;
  /** TCP-connect probe on localhost:<port> (alternative to url) */
  port?: number;
  /** give up after this long (default 30s) */
  timeoutMs?: number;
  /** probe cadence (default 250ms) */
  intervalMs?: number;
  /** per-probe cap (default min(intervalMs*4, 2s)) — raise for slow-to-accept targets */
  probeTimeoutMs?: number;
}

export interface ProcSpec {
  cmd: string;
  /** extra env for THIS process (merged over the inherited environment) */
  env?: Record<string, string>;
  /**
   * respawn on unexpected exit (backoff 250ms -> 2s); user kill never
   * respawns. `{max: N}` gives up after N consecutive restarts (a stretch of
   * >10s uptime WHILE READY resets the counter; procs without ready: count
   * as ready at spawn).
   */
  restart?: boolean | { max?: number };
  /** readiness probe — the proc counts as "up" only once this answers */
  ready?: string | ReadySpec;
  /** spawn only after these procs are READY (their spec keys) */
  after?: string | string[];
}

const READY_DEFAULT_TIMEOUT_MS = 30_000;
const READY_DEFAULT_INTERVAL_MS = 250;
// SIGTERM -> SIGKILL escalation grace, shared by teardown, Ctrl-C and the
// ready-timeout restart path.
const KILL_GRACE_MS = 3000;
// A restarted proc that stayed READY at least this long counts as a healthy
// stretch and clears the restart strike counter.
const RESTART_HEALTHY_UPTIME_MS = 10_000;

interface NormalizedReady {
  target: ReadyTarget;
  timeoutMs: number;
  intervalMs: number;
  probeTimeoutMs?: number;
}

function normalizeReady(name: string, r: string | ReadySpec): NormalizedReady {
  if (typeof r === "string") {
    return {
      target: parseReadyTarget(r),
      timeoutMs: READY_DEFAULT_TIMEOUT_MS,
      intervalMs: READY_DEFAULT_INTERVAL_MS,
    };
  }
  let target: ReadyTarget;
  if (r.url != null) {
    target = parseReadyTarget(r.url);
  } else if (r.port != null) {
    target = parseReadyTarget(`port:${r.port}`);
  } else {
    throw new Error(`procs: "${name}" ready spec needs a url or port`);
  }
  return {
    target,
    timeoutMs: r.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS,
    intervalMs: r.intervalMs ?? READY_DEFAULT_INTERVAL_MS,
    probeTimeoutMs: r.probeTimeoutMs,
  };
}

// null = never restart; Infinity = restart forever; N = give up after N
// consecutive restarts.
function restartMax(restart: ProcSpec["restart"]): number | null {
  if (!restart) return null;
  if (restart === true) return Infinity;
  return restart.max ?? Infinity;
}

// SIGTERM/SIGKILL the child's whole process group (children are spawned
// detached, i.e. setsid group leaders), falling back to a plain child kill
// when the group is already gone.
function killGroup(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export interface ProcsOpts {
  /** SIGTERM -> SIGKILL escalation grace in ms (default 3s) — injectable for tests */
  killGraceMs?: number;
  /** ready uptime that clears the restart strike counter (default 10s) — injectable for tests */
  healthyUptimeMs?: number;
}

export function procs(
  specs: Record<string, string | ProcSpec>,
  opts: ProcsOpts = {},
): Pipeline<ProcLine> {
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const healthyUptimeMs = opts.healthyUptimeMs ?? RESTART_HEALTHY_UPTIME_MS;
  const entries = Object.entries(specs).map(([name, v]) => ({
    name,
    spec: typeof v === "string" ? { cmd: v } : v,
  }));
  if (entries.length === 0) throw new Error("procs: no processes given");

  // -- upfront validation: bad wiring should throw before anything spawns ----
  const names = new Set(entries.map((e) => e.name));
  const afterOf = new Map<string, string[]>();
  const readyOf = new Map<string, NormalizedReady>();
  for (const { name, spec } of entries) {
    const deps = spec.after == null ? [] : Array.isArray(spec.after) ? spec.after : [spec.after];
    for (const d of deps) {
      if (d === name) throw new Error(`procs: "${name}" cannot come after itself`);
      if (!names.has(d)) throw new Error(`procs: "${name}" comes after unknown proc "${d}"`);
    }
    afterOf.set(name, deps);
    if (spec.ready != null) readyOf.set(name, normalizeReady(name, spec.ready));
  }
  // cycle check — tiny DFS with an in-stack color
  {
    const state = new Map<string, 1 | 2>(); // 1 = in stack, 2 = done
    const visit = (n: string, path: string[]) => {
      const st = state.get(n);
      if (st === 1) throw new Error(`procs: dependency cycle: ${[...path, n].join(" -> ")}`);
      if (st === 2) return;
      state.set(n, 1);
      for (const d of afterOf.get(n) ?? []) visit(d, [...path, n]);
      state.set(n, 2);
    };
    for (const e of entries) visit(e.name, []);
  }

  return Pipeline.of(
    (async function* () {
      // One mutable slot per proc so kill() always reaches the CURRENT child,
      // including one spawned by a restart.
      const current = new Map<string, ReturnType<typeof Bun.spawn>>();
      let killed = false;

      // One readiness latch per proc, created upfront. Resolves when the proc
      // is ready (or on first spawn when it has no ready:), rejects when the
      // proc ends for good without ever becoming ready. The no-op .catch keeps
      // un-awaited latches from tripping the unhandled-rejection reporter.
      const latches = new Map<string, PromiseWithResolvers<void>>();
      for (const { name } of entries) {
        const latch = Promise.withResolvers<void>();
        latch.promise.catch(() => {});
        latches.set(name, latch);
      }
      const killSignal = Promise.withResolvers<void>();

      // SIGTERM the given groups, give them killGraceMs to die, then SIGKILL
      // the stragglers. The grace timer is always cleared — nothing dangling.
      const terminate = async (children: ReturnType<typeof Bun.spawn>[]) => {
        if (children.length === 0) return;
        for (const c of children) killGroup(c, "SIGTERM");
        const allExited = Promise.all(children.map((c) => c.exited.then(() => {})));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timedOut = await Promise.race([
            allExited.then(() => false),
            new Promise<boolean>((r) => {
              timer = setTimeout(() => r(true), killGraceMs);
            }),
          ]);
          if (timedOut) {
            for (const c of children) killGroup(c, "SIGKILL");
            await allExited;
          }
        } finally {
          clearTimeout(timer);
        }
      };

      // kill() OWNS the whole escalation: the generator's finally never runs
      // while a SIGTERM-ignoring child keeps the merged stream wedged, so the
      // Ctrl-C path can't rely on it for the SIGKILL. Idempotent — a second
      // Ctrl-C (or the teardown finally after one) reuses the in-flight
      // escalation instead of stacking timers.
      let killEscalation: Promise<void> | null = null;
      const kill = (): Promise<void> => {
        if (killEscalation) return killEscalation;
        killed = true;
        killSignal.resolve();
        killEscalation = terminate([...current.values()]);
        return killEscalation;
      };
      process.on("SIGINT", kill);
      process.on("SIGTERM", kill);

      async function* streamOf(
        name: string,
        stream: "stdout" | "stderr",
        readable: ReadableStream<Uint8Array>,
      ): AsyncGenerator<ProcLine> {
        const decoder = new TextDecoder();
        let buf = "";
        // biome-ignore lint/suspicious/noExplicitAny: ReadableStream async iteration
        for await (const chunk of readable as any) {
          buf += decoder.decode(chunk, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.length > 0) yield { proc: name, stream, line };
            nl = buf.indexOf("\n");
          }
        }
        if (buf.length > 0) yield { proc: name, stream, line: buf };
      }

      // Probe readiness alongside the child's output streams. Every poll
      // sleep races child.exited so the probe can never outlive the child —
      // the per-spawn merge only completes when ALL its gens finish, so a
      // dangling probe would wedge the restart path.
      async function* readyGen(
        name: string,
        ready: NormalizedReady,
        child: ReturnType<typeof Bun.spawn>,
        restartable: boolean,
        onReady: () => void,
      ): AsyncGenerator<ProcLine> {
        let exited = false;
        const exitedP = child.exited.then(() => {
          exited = true;
        });
        const label = formatReadyTarget(ready.target);
        const res = await awaitReady(ready.target, {
          intervalMs: ready.intervalMs,
          timeoutMs: ready.timeoutMs,
          probeTimeoutMs: ready.probeTimeoutMs,
          abort: () => exited || killed,
          waitBetween: (ms) => Promise.race([Bun.sleep(ms), exitedP]),
        });
        if (res) {
          onReady();
          latches.get(name)!.resolve();
          yield { proc: name, stream: "ready", line: `ready after ${res.ms}ms (${label})` };
          return;
        }
        // The child dying (or teardown) aborts the wait quietly — the exit
        // path owns what happens next.
        if (exited || killed) return;
        yield {
          proc: name,
          stream: "ready",
          line: `not ready after ${ready.timeoutMs}ms (${label})`,
        };
        if (restartable) {
          // Put the proc down; exitGen completes the merge and the restart
          // loop respawns it (readiness is re-awaited after EVERY restart).
          // Full escalation, same as teardown: a child that ignores SIGTERM
          // must not wedge the restart loop.
          await terminate([child]);
          return;
        }
        // Not restartable: fail the whole pipeline loudly — CI semantics.
        throw new Error(`procs: "${name}" not ready after ${ready.timeoutMs}ms (${label})`);
      }

      // One self-restarting generator per proc: mergeAsync's slot set is
      // fixed at start, so respawning must happen INSIDE a single generator
      // rather than by adding new ones mid-flight.
      async function* runProc(name: string, spec: ProcSpec): AsyncGenerator<ProcLine> {
        const latch = latches.get(name)!;
        const ready = readyOf.get(name);
        const deps = afterOf.get(name) ?? [];
        const max = restartMax(spec.restart);
        try {
          if (deps.length > 0) {
            yield { proc: name, stream: "ready", line: `waiting for ${deps.join(", ")}` };
            // A rejected dep latch propagates out of the race → the pipeline
            // errors → the outer finally tears everything down. Dependents
            // gate ONCE — a dependency restarting later never re-blocks them.
            await Promise.race([
              Promise.all(deps.map((d) => latches.get(d)!.promise)),
              killSignal.promise,
            ]);
            if (killed) return;
          }
          let backoff = 250;
          let restarts = 0;
          for (;;) {
            const child = Bun.spawn(["sh", "-c", spec.cmd], {
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env, FORCE_COLOR: "0", ...(spec.env ?? {}) },
              // Own process group (setsid leader) so kills reach grandchildren.
              detached: true,
            });
            current.set(name, child);
            const spawnedAt = performance.now();
            // Procs without ready: count as ready at spawn. With ready:, only
            // a successful probe THIS spawn marks it — wall-clock uptime alone
            // would count a proc that hung un-ready until the ready-timeout
            // kill as "healthy", and {max} would never trip.
            let becameReady = !ready;
            if (!ready) latch.resolve();
            const exitGen = (async function* (): AsyncGenerator<ProcLine> {
              const code = await child.exited;
              yield { proc: name, stream: "exit", line: `exited with code ${code}` };
            })();
            const gens = [
              streamOf(name, "stdout", child.stdout as ReadableStream<Uint8Array>),
              streamOf(name, "stderr", child.stderr as ReadableStream<Uint8Array>),
              exitGen,
            ];
            if (ready)
              gens.push(
                readyGen(name, ready, child, max !== null, () => {
                  becameReady = true;
                }),
              );
            yield* mergeAsync(gens);
            current.delete(name);
            if (max === null || killed) return;
            // A healthy stretch clears the strike count — {max} guards
            // against crash LOOPS, not against ever crashing twice.
            if (becameReady && performance.now() - spawnedAt > healthyUptimeMs) {
              backoff = 250;
              restarts = 0;
            }
            if (restarts >= max) {
              yield { proc: name, stream: "exit", line: `giving up after ${restarts} restart(s)` };
              return;
            }
            restarts++;
            yield {
              proc: name,
              stream: "exit",
              line: `restarting in ${backoff}ms`,
            };
            await new Promise((r) => setTimeout(r, backoff));
            if (killed) return;
            backoff = Math.min(backoff * 2, 2000);
          }
        } finally {
          // Proc is over for good (done, gave up, killed, or errored). If it
          // never became ready, fail anyone gated on it. No-op when resolved.
          latch.reject(new Error(`procs: dependency "${name}" exited before becoming ready`));
        }
      }

      try {
        yield* mergeAsync(entries.map(({ name, spec }) => runProc(name, spec)));
      } finally {
        process.off("SIGINT", kill);
        process.off("SIGTERM", kill);
        // kill() carries the full SIGTERM -> grace -> SIGKILL escalation (or,
        // after a Ctrl-C, is already carrying it) — await it so teardown only
        // returns once every group is gone.
        await kill();
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// load — a paced arrival schedule for load runs. `load 30s 100/s` yields one
// tick per scheduled slot; ramps are phase lists (`load 10s 50/s, 30s 200/s`).
//
// Open-loop honesty: slots are anchored to absolute times (no drift). Each
// wakeup emits EVERY due slot (catch-up of due slots IS the schedule, not a
// burst), so the generator sustains multi-thousand-tick rates. A due slot is
// dropped only when consumer backpressure made it older than maxLagMs
// (default 1s) or the phase clock ran out — counted, and reported to stderr
// on drain. Downstream `stats` reports the MEASURED rate only, so the tool
// structurally cannot claim an arrival rate it didn't sustain.
// ---------------------------------------------------------------------------

export interface LoadTick {
  /** global tick index across all phases */
  n: number;
  /** phase index this tick belongs to */
  phase: number;
  /** performance.now() timestamp of the tick's ideal slot */
  scheduledAt: number;
  /** how late the tick actually left its slot */
  lagMs: number;
}

export interface LoadOpts {
  /** shortfall report sink — injectable for tests (default stderr) */
  warn?: (s: string) => void;
  /** drop a due slot only when consumer backpressure made it older than this (default 1000) */
  maxLagMs?: number;
}

export function load(
  phases: { durMs: number; rps: number }[],
  opts: LoadOpts = {},
): Pipeline<LoadTick> {
  if (phases.length === 0) throw new Error("load: needs at least one phase");
  const warn = opts.warn ?? ((s: string) => process.stderr.write(s));
  return Pipeline.of(
    (async function* () {
      const t0 = performance.now();
      let n = 0;
      let target = 0;
      let dropped = 0;
      const maxLagMs = opts.maxLagMs ?? 1000;
      for (let p = 0; p < phases.length; p++) {
        const { durMs, rps } = phases[p]!;
        const interval = 1000 / rps;
        const phaseTarget = Math.max(1, Math.round((durMs * rps) / 1000));
        target += phaseTarget;
        const phaseStart = performance.now();
        const phaseEnd = phaseStart + durMs;
        let k = 0;
        while (k < phaseTarget) {
          const ideal = phaseStart + k * interval;
          let now = performance.now();
          if (now >= phaseEnd) {
            // Phase clock ran out with slots left — all of them are drops.
            dropped += phaseTarget - k;
            break;
          }
          if (now < ideal) {
            await Bun.sleep(ideal - now);
            now = performance.now();
          }
          // Emit EVERY due slot before sleeping again — one ~1ms wakeup can
          // carry many ticks, so the generator no longer caps the rate. A due
          // slot is dropped only when CONSUMER backpressure let it go stale
          // beyond maxLagMs (emitting due slots is the schedule, not a burst;
          // `now` is re-read after each yield because the consumer's pull
          // time is exactly where honest lag accrues).
          while (k < phaseTarget) {
            const slot = phaseStart + k * interval;
            if (slot > now) break;
            if (now - slot > maxLagMs) {
              dropped++;
              k++;
              continue;
            }
            yield {
              n: n++,
              phase: p,
              scheduledAt: slot,
              lagMs: Math.max(0, now - slot),
            };
            k++;
            now = performance.now();
            if (now >= phaseEnd) break;
          }
        }
      }
      if (dropped > 0) {
        const wallS = (performance.now() - t0) / 1000;
        const achieved = wallS > 0 ? (n / wallS).toFixed(1) : "0";
        warn(
          `load: target ${target} ticks — emitted ${n}, dropped ${dropped} ` +
            `(downstream saturated; raise parallel N?), achieved ${achieved}/s\n`,
        );
      }
    })(),
  );
}
