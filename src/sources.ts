import { stat } from "node:fs/promises";
import { file, Glob } from "bun";
import { interruptPromise, isInterrupted } from "./interrupt";
import { Pipeline } from "./pipeline";
import {
  awaitReady,
  formatReadyTarget,
  parseReadyTarget,
  probeOnce,
  type ReadyTarget,
} from "./readiness";
import { shellEnv } from "./shellPath";
import { HttpTimeoutError, isTimeoutError, labelBodyTimeout } from "./transforms";

// Set when index.ts consumes stdin as a SCRIPT (the bare `cmd | crust`
// form reads the pipe to EOF before running a line) so a `stdin |` stage in
// that script gets a targeted error instead of hanging on a drained pipe.
let stdinConsumedBy: string | null = null;
export function markStdinConsumed(reason: string): void {
  stdinConsumedBy = reason;
}

export function stdin(): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      if (process.stdin.isTTY) {
        throw new Error(
          "stdin: nothing is piped — this source reads a pipe, e.g. `docker logs -f app | crust -c 'stdin | grep ERROR'`",
        );
      }
      if (stdinConsumedBy) {
        throw new Error(
          `stdin: already read to EOF as ${stdinConsumedBy} — pipe the DATA in and pass the program via -c or a script file: \`cmd | crust -c 'stdin | …'\``,
        );
      }
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of Bun.stdin.stream()) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      buf += decoder.decode();
      if (buf) yield buf;
    })(),
  );
}

export function range(start: number, end: number): Pipeline<number> {
  return Pipeline.of(
    (async function* () {
      for (let i = start; i <= end; i++) yield i;
    })(),
  );
}

// One scan for every glob surface, so they agree on ordering and on what a
// missing directory means.
//
// Sorted: a pipeline over a glob has to be reproducible run to run — the bare
// glob source used to emit raw directory order while `read`/`lines` sorted.
// A missing directory yields NOTHING rather than throwing: Bun's Glob raises a
// bare `ENOENT … open '/nonexistent/deeper/ '` (note the mangled pattern) for
// an absolute path, while the relative form just came back empty — so the same
// mistake produced a friendly "no files matched" or a cryptic ENOENT depending
// only on whether you typed a leading slash.
async function scanGlob(pattern: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for await (const f of new Glob(pattern).scan({ cwd: process.cwd(), absolute: false })) {
      paths.push(f);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  paths.sort();
  return paths;
}

export function glob(pattern: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      for (const f of await scanGlob(pattern)) yield f;
    })(),
  );
}

// Stream a file's lines without ever holding the whole file.
//
// `text()` + `split("\n")` materialised the file as one string AND as an array
// of every line — measured at ~1.4x the file size, so a 224MB log peaked at
// 329MB and `lines f | grep …` at 982MB, where the equivalent shell pipeline
// used 6MB. Chunked slice() reads are flat in file size (8/91/90 MB for
// 20/224/448 MB) and are also 25% FASTER than the old form (0.152s vs 0.204s
// on 224MB), so there is no tradeoff to weigh. `Bun.file().stream()` was the
// obvious alternative and measured worse (98MB, 0.264s).
const READ_CHUNK = 256 * 1024;
// JSC's max string length is ~2GB; refuse well before the unhelpful failure.
const MAX_WHOLE_FILE = 512 * 1024 * 1024;

async function* fileLines(path: string): AsyncGenerator<string> {
  const f = file(path);
  const size = f.size;
  const decoder = new TextDecoder();
  let buf = "";
  for (let off = 0; off < size; off += READ_CHUNK) {
    const bytes = new Uint8Array(
      await f.slice(off, Math.min(off + READ_CHUNK, size)).arrayBuffer(),
    );
    buf += decoder.decode(bytes, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const part of parts) yield part;
  }
  buf += decoder.decode();
  // Trailing empty string means the file ended with a newline — that is a
  // terminator, not a line.
  if (buf.length > 0) yield buf;
}

export function read(path: string): Pipeline<string> {
  return Pipeline.of(fileLines(path));
}

// Reading zero files IS a mistake — unlike a bare glob, which legitimately
// enumerates nothing — so this is the surface that turns an empty scan into an
// error, and now does so for absolute patterns too.
async function matchFiles(pattern: string, label: string): Promise<string[]> {
  if (!/[*?[\]{}]/.test(pattern)) return [pattern];
  const paths = await scanGlob(pattern);
  if (paths.length === 0) throw new Error(`${label}: no files matched ${pattern}`);
  return paths;
}

// Whole-file contents, one item per matched file (vs read(), which streams
// lines of a single file). `read fixtures/*.json | POST …` posts each file's
// full text as a request body.
export function readAll(pattern: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      for (const p of await matchFiles(pattern, "read")) {
        const f = Bun.file(p);
        // readAll's contract IS one whole-file item (`read fixtures/*.json |
        // POST …` posts each file as a body), so this one cannot stream. Say
        // which file blew up and point at the streaming source, instead of
        // failing later with a bare "Out of memory" naming nothing.
        if (f.size > MAX_WHOLE_FILE) {
          throw new Error(
            `read: ${p} is ${(f.size / 1024 / 1024).toFixed(0)}MB — too large to hold as one item; ` +
              "use `lines` to stream it line by line",
          );
        }
        yield await f.text();
      }
    })(),
  );
}

// One item per LINE across every matched file — what `lines **/*.log` builds.
// The shell `read` stage yields whole files, which reads identically on a
// terminal but means a downstream `filter (l => …)` sees one giant string; this
// is the source to reach for when you want lines. Trailing empty line is
// dropped, matching read().
export function readLines(pattern: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      for (const p of await matchFiles(pattern, "lines")) {
        yield* fileLines(p);
      }
    })(),
  );
}

export interface TailOptions {
  lines?: number;
  follow?: boolean;
  pollMs?: number;
  /**
   * Cancels a follow loop from outside: a queued iterator .return() cannot
   * wake a generator parked on its poll sleep, but aborting this signal
   * does. When a signal is provided the holder owns cancellation and the
   * loop does NOT race the REPL interrupt bus (the `logs` builtin holds
   * tails across queries whose Ctrl-C fires the bus).
   */
  signal?: AbortSignal;
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
        yield* tailOne(resolved[0]!, initialLines, follow, pollMs, opts.signal);
        return;
      }
      yield* mergeAsync(resolved.map((p) => tailOne(p, initialLines, follow, pollMs, opts.signal)));
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

const TAIL_SCAN_BLOCK_BYTES = 64 * 1024;

// Find the byte offset where the last-n-lines window starts, reading fixed
// blocks backward from EOF. Byte-safe for UTF-8 (0x0A never appears in a
// continuation byte); a newline at size-1 terminates the last line rather
// than starting one, so it is skipped. Returns 0 at BOF; `size` when n<=0.
export async function findTailWindowStart(
  path: string,
  size: number,
  n: number,
  blockBytes = TAIL_SCAN_BLOCK_BYTES,
): Promise<number> {
  if (n <= 0 || size === 0) return size;
  let end = size;
  let seen = 0;
  let skipLast = true; // the trailing newline of a terminated final line
  while (end > 0) {
    const start = Math.max(0, end - blockBytes);
    const bytes = new Uint8Array(await file(path).slice(start, end).arrayBuffer());
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] !== 0x0a) continue;
      if (skipLast && start + i === size - 1) {
        skipLast = false;
        continue;
      }
      seen++;
      if (seen === n) return start + i + 1;
    }
    end = start;
  }
  return 0;
}

async function* tailOne(
  path: string,
  initialLines: number,
  follow: boolean,
  pollMs: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let offset = 0;
  let currentIno: number | null = null;
  let buf = "";

  try {
    const s0 = await stat(path);
    offset = s0.size;
    currentIno = s0.ino;
    if (initialLines > 0) {
      // Bounded initial cut: scan backward for the window start instead of
      // reading the whole file (a multi-GB log used to become a multi-GB
      // string here). lines:0 reads nothing at all.
      const from = await findTailWindowStart(path, s0.size, initialLines);
      const text = await file(path).slice(from, s0.size).text();
      const all = text.split("\n");
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      // slice(-N) stays as a belt-and-braces guard: correctness must not
      // depend on the scanner being exact at block edges.
      for (const line of all.slice(-initialLines)) yield line;
    }
  } catch (err) {
    if (!follow) throw err;
  }

  if (!follow) return;

  // One abort promise for the whole loop (a fresh listener per tick would
  // accumulate); already-aborted signals resolve immediately.
  const aborted = signal
    ? signal.aborted
      ? Promise.resolve()
      : new Promise<void>((res) => signal.addEventListener("abort", () => res(), { once: true }))
    : null;

  while (true) {
    // Race the poll sleep against cancellation: a queued `.return()` can't
    // wake a parked generator, so Ctrl-C (the REPL bus) or the holder's
    // abort must. With a signal the HOLDER owns cancellation and the bus is
    // ignored — a logs query's Ctrl-C must not kill the held source.
    await Promise.race([Bun.sleep(pollMs), aborted ?? interruptPromise()]);
    if (signal ? signal.aborted : isInterrupted()) return;
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
// Fan several async generators into one stream, in arrival order.
//
// Each pull attaches EXACTLY ONE continuation, which pushes its result onto a
// ready queue and wakes a single shared waiter. The previous shape re-ran
// `Promise.race([...active].map(s => s.pending))` on every iteration, attaching
// a fresh `.then` to every slot each time — including slots that never settle.
// That is the normal shape of `procs`, which merges [stdout, stderr, exit] and
// whose exit slot cannot settle while the process runs, so one reaction record
// accumulated per line per idle slot and was retained until that promise
// settled. Measured on a consumer that kept nothing: +46MB heap at 50k lines,
// +63MB at 200k, +113MB at 400k — unbounded growth in the two features
// (`procs`, `logs procs {…}`) designed to run for days.
export async function* mergeAsync<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const ready: { idx: number; res: IteratorResult<T> }[] = [];
  let wake: (() => void) | null = null;
  let live = gens.length;

  const pull = (idx: number): void => {
    gens[idx]!.next().then(
      (res) => {
        ready.push({ idx, res });
        wake?.();
        wake = null;
      },
      (err) => {
        ready.push({ idx, res: { done: true, value: undefined as never } });
        pendingError ??= err;
        wake?.();
        wake = null;
      },
    );
  };
  let pendingError: unknown;

  try {
    for (let i = 0; i < gens.length; i++) pull(i);
    while (live > 0) {
      while (ready.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
      }
      const { idx, res } = ready.shift()!;
      if (pendingError !== undefined) throw pendingError;
      if (res.done) {
        live--;
        continue;
      }
      yield res.value;
      pull(idx);
    }
  } finally {
    for (const g of gens) {
      // Deliberately NOT awaited: a generator parked on a poll sleep (tailOne,
      // readyGen) only settles its return() when that sleep ends, so awaiting
      // here deadlocks teardown. But `void promise` leaves a rejection
      // unhandled, which exits the process 1 on an otherwise successful run —
      // so attach a catch and drop it.
      const closing = g.return?.(undefined as unknown as T);
      if (closing) closing.catch(() => {});
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
        // Same labelling as the transform path: name the request that failed.
        const hostHint = url.startsWith("/")
          ? ' — no host in the URL (did an env var expand to ""? use `:3000/path` for localhost)'
          : "";
        throw new Error(`GET ${url}: ${(err as Error).message}${hostHint}`);
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
  stream: "stdout" | "stderr" | "exit" | "ready" | "live";
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

export interface LiveSpec {
  /** ":3001/api/health" | "http(s)://…" | "port:3001" */
  url?: string;
  /** TCP-connect probe on localhost:<port> (alternative to url) */
  port?: number;
  /** probe cadence (default 5s — liveness runs for the proc's whole life) */
  intervalMs?: number;
  /** per-probe cap (default min(intervalMs*4, 2s)) */
  probeTimeoutMs?: number;
  /** consecutive failed probes before the proc is unhealthy (default 3, min 1) */
  failures?: number;
  /** delay after ready before the first probe (default 0) */
  graceMs?: number;
}

export interface ProcSpec {
  cmd: string;
  /** extra env for THIS process (merged over the inherited environment) */
  env?: Record<string, string>;
  /**
   * respawn on unexpected exit (backoff 250ms -> 2s); user kill never
   * respawns. `{max: N}` gives up after N consecutive restarts (a stretch of
   * >10s uptime WHILE READY resets the counter — with live:, uptime ends
   * when a fatal liveness streak began, so a proc that wedges right after
   * ready still accrues strikes; procs without ready: count as ready at
   * spawn).
   */
  restart?: boolean | { max?: number };
  /** readiness probe — the proc counts as "up" only once this answers */
  ready?: string | ReadySpec;
  /**
   * liveness probe — armed once the proc is up (after ready:, or at spawn
   * without one). After `failures` consecutive misses: a restartable proc is
   * terminated so the restart loop respawns it; a non-restartable one fails
   * the whole pipeline loudly (CI semantics, same as a ready-timeout).
   */
  live?: string | LiveSpec;
  /** spawn only after these procs are READY (their spec keys) */
  after?: string | string[];
}

const READY_DEFAULT_TIMEOUT_MS = 30_000;
const READY_DEFAULT_INTERVAL_MS = 250;
// Liveness polls for the life of the proc — readiness's 250ms cadence would
// hammer health endpoints forever, so the default is deliberately slower.
const LIVE_DEFAULT_INTERVAL_MS = 5_000;
const LIVE_DEFAULT_FAILURES = 3;
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

interface NormalizedLive {
  target: ReadyTarget;
  intervalMs: number;
  probeTimeoutMs: number;
  failures: number;
  graceMs: number;
}

function normalizeLive(name: string, l: string | LiveSpec): NormalizedLive {
  const spec: LiveSpec = typeof l === "string" ? { url: l } : l;
  let target: ReadyTarget;
  if (spec.url != null) {
    target = parseReadyTarget(spec.url);
  } else if (spec.port != null) {
    target = parseReadyTarget(`port:${spec.port}`);
  } else {
    throw new Error(`procs: "${name}" live spec needs a url or port`);
  }
  const intervalMs = spec.intervalMs ?? LIVE_DEFAULT_INTERVAL_MS;
  if (!(intervalMs > 0)) throw new Error(`procs: "${name}" live intervalMs must be > 0`);
  const failures = spec.failures ?? LIVE_DEFAULT_FAILURES;
  if (!Number.isInteger(failures) || failures < 1) {
    throw new Error(`procs: "${name}" live failures must be an integer >= 1`);
  }
  const graceMs = spec.graceMs ?? 0;
  if (graceMs < 0) throw new Error(`procs: "${name}" live graceMs must be >= 0`);
  return {
    target,
    intervalMs,
    probeTimeoutMs: spec.probeTimeoutMs ?? Math.min(intervalMs * 4, 2000),
    failures,
    graceMs,
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
export function killGroup(
  child: ReturnType<typeof Bun.spawn>,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
) {
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
  const liveOf = new Map<string, NormalizedLive>();
  for (const { name, spec } of entries) {
    const deps = spec.after == null ? [] : Array.isArray(spec.after) ? spec.after : [spec.after];
    for (const d of deps) {
      if (d === name) throw new Error(`procs: "${name}" cannot come after itself`);
      if (!names.has(d)) throw new Error(`procs: "${name}" comes after unknown proc "${d}"`);
    }
    afterOf.set(name, deps);
    if (spec.ready != null) readyOf.set(name, normalizeReady(name, spec.ready));
    if (spec.live != null) liveOf.set(name, normalizeLive(name, spec.live));
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
          // split/pop, matching stdin(), tailOne() and the shell stages — the
          // hand-rolled indexOf/slice loop this replaces was the only splitter
          // in crust that DROPPED blank lines, which mangles the output of
          // every tool that uses them structurally (vite, tsc --watch, docker
          // compose). grepStage's comment already states blank lines must
          // survive; procs was the outlier.
          const parts = buf.split("\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            yield { proc: name, stream, line: part.replace(/\r$/, "") };
          }
        }
        buf += decoder.decode();
        // A trailing partial line (no final newline) is still a line.
        if (buf.length > 0) yield { proc: name, stream, line: buf.replace(/\r$/, "") };
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

      // Poll liveness for the life of the spawn, arming only once the proc is
      // up. The inverse of readyGen: that one converges on ready and returns;
      // this one loops until the child dies, teardown, or a fatal streak.
      // Every await races exit/kill — a dangling probe loop would wedge the
      // per-spawn merge exactly like a dangling ready probe would.
      async function* liveGen(
        name: string,
        live: NormalizedLive,
        child: ReturnType<typeof Bun.spawn>,
        restartable: boolean,
        armed: Promise<void>,
        state: { liveFailedAt: number | null },
      ): AsyncGenerator<ProcLine> {
        let exited = false;
        const exitedP = child.exited.then(() => {
          exited = true;
        });
        const label = formatReadyTarget(live.target);
        await Promise.race([armed, exitedP, killSignal.promise]);
        if (exited || killed) return;
        if (live.graceMs > 0) {
          await Promise.race([Bun.sleep(live.graceMs), exitedP, killSignal.promise]);
          if (exited || killed) return;
        }
        let misses = 0;
        let firstFailAt: number | null = null;
        for (;;) {
          await Promise.race([Bun.sleep(live.intervalMs), exitedP, killSignal.promise]);
          if (exited || killed) return;
          const ok = await probeOnce(live.target, live.probeTimeoutMs);
          if (exited || killed) return;
          if (ok) {
            if (misses > 0) {
              yield {
                proc: name,
                stream: "live",
                line: `recovered after ${misses} failed probe(s) (${label})`,
              };
            }
            misses = 0;
            firstFailAt = null;
            continue;
          }
          misses++;
          if (firstFailAt === null) firstFailAt = performance.now();
          yield {
            proc: name,
            stream: "live",
            line: `probe failed (${misses}/${live.failures}) (${label})`,
          };
          if (misses < live.failures) continue;
          // Fatal streak. Healthy uptime ended when the streak BEGAN — the
          // restart loop's strike reset reads this, so the time spent failing
          // probes never counts as healthy.
          state.liveFailedAt = firstFailAt;
          yield {
            proc: name,
            stream: "live",
            line: `unhealthy after ${misses} consecutive failed probe(s) (${label})${
              restartable ? " — restarting" : ""
            }`,
          };
          if (restartable) {
            // Same mechanism as a ready-timeout: put it down with the full
            // escalation, the restart loop respawns it, liveness re-arms
            // after the NEXT ready.
            await terminate([child]);
            return;
          }
          // Not restartable: fail the whole pipeline loudly — CI semantics.
          throw new Error(
            `procs: "${name}" unhealthy after ${misses} consecutive failed probe(s) (${label})`,
          );
        }
      }

      // One self-restarting generator per proc: mergeAsync's slot set is
      // fixed at start, so respawning must happen INSIDE a single generator
      // rather than by adding new ones mid-flight.
      async function* runProc(name: string, spec: ProcSpec): AsyncGenerator<ProcLine> {
        const latch = latches.get(name)!;
        const ready = readyOf.get(name);
        const live = liveOf.get(name);
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
              env: { ...shellEnv(), FORCE_COLOR: "0", ...(spec.env ?? {}) },
              // Own process group (setsid leader) so kills reach grandchildren.
              detached: true,
            });
            current.set(name, child);
            const spawnedAt = performance.now();
            // Procs without ready: count as ready at spawn. With ready:, only
            // a successful probe THIS spawn marks it — wall-clock uptime alone
            // would count a proc that hung un-ready until the ready-timeout
            // kill as "healthy", and {max} would never trip. liveFailedAt is
            // set by liveGen when a fatal probe streak begins: healthy uptime
            // ends THERE, not at the eventual kill, so a proc that wedges
            // right after ready still accrues strikes.
            const state = { becameReady: !ready, liveFailedAt: null as number | null };
            const spawnUp = Promise.withResolvers<void>();
            if (!ready) {
              latch.resolve();
              spawnUp.resolve();
            }
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
                  state.becameReady = true;
                  spawnUp.resolve();
                }),
              );
            if (live) gens.push(liveGen(name, live, child, max !== null, spawnUp.promise, state));
            yield* mergeAsync(gens);
            current.delete(name);
            if (max === null || killed) return;
            // A healthy stretch clears the strike count — {max} guards
            // against crash LOOPS, not against ever crashing twice.
            const healthyEnd = state.liveFailedAt ?? performance.now();
            if (state.becameReady && healthyEnd - spawnedAt > healthyUptimeMs) {
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
            // Raced against killSignal like every other sleep here: parked in
            // a backoff, a Ctrl-C could not be seen and the prompt took up to
            // the full 2s to come back.
            await Promise.race([Bun.sleep(backoff), killSignal.promise]);
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
            // Never sleep sub-millisecond. Above 1000/s every slot is less than
            // 1ms away, and Bun.sleep(0.3) degenerates to a minimum-resolution
            // timer — the loop then re-entered as fast as the event loop could
            // turn, burning a whole CPU core at a rate INDEPENDENT of rps
            // (measured: 5.1s of CPU per 6s wall at 1000/s, 3000/s and
            // 10000/s alike, versus 0.42s for the same 36k requests from a
            // burst source). That is not just waste: the client is
            // CPU-saturated, so the latency numbers the load runner exists to
            // produce are wrong.
            //
            // Sleeping a full millisecond instead makes one wake carry
            // ceil(rps/1000) slots, which the inner drain loop below already
            // emits in a batch. The schedule is unchanged — slots are still
            // pinned to phaseStart + k*interval — only the wake granularity is.
            await Bun.sleep(Math.max(1, ideal - now));
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
