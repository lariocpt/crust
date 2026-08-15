import { rename } from "node:fs/promises";
import { formatItem } from "./format";
import { Pipeline, type PipelineStage, pipelineStage } from "./pipeline";

// Native `grep` over pipeline items — line-buffered where sh grep block-
// buffers into a pipe. The sh path wrote formatItem(item)+"\n" to grep's
// stdin, where embedded newlines were REAL line boundaries — so a
// multi-line item (a `read` whole-file item) must be split and matched per
// LINE, yielding matching lines, or `read x | grep -v y` silently inverts
// per file instead of per line. No `g` flag: grep is a per-line boolean,
// and a sticky lastIndex would make it stateful.
export function grepStage(opts: {
  pattern: string;
  ignoreCase: boolean;
  invert: boolean;
  fixed: boolean;
}): PipelineStage<unknown, string> {
  let test: (line: string) => boolean;
  if (opts.fixed) {
    const needle = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    test = (line) => (opts.ignoreCase ? line.toLowerCase() : line).includes(needle);
  } else {
    const re = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
    test = (line) => re.test(line);
  }
  return pipelineStage<unknown, string>((input) =>
    Pipeline.of(
      (async function* () {
        for await (const item of input.lines()) {
          // Split exactly as the sh child's stdin did: no trailing-empty
          // pop — "a\nb\n" reached grep as lines "a", "b", "" and an
          // inverted match emits that blank line there too.
          for (const line of formatItem(item).split("\n")) {
            if (test(line) !== opts.invert) yield line;
          }
        }
      })(),
    ),
  );
}

// Split multi-line items into one item per line: `read f.json | lines`.
// This is grepStage's splitting half without the predicate — it is the reason
// `read **/*.log | grep ERROR | filter (…)` works while swapping grep and
// filter silently does not. Drops a trailing empty line (matching read() and
// the `lines` source); grep deliberately keeps it, because grep mirrors what
// the sh child saw on its stdin.
export function linesStage(): PipelineStage<unknown, string> {
  return pipelineStage<unknown, string>((input) =>
    Pipeline.of(
      (async function* () {
        for await (const item of input.lines()) {
          const ls = formatItem(item).split("\n");
          if (ls.length > 0 && ls[ls.length - 1] === "") ls.pop();
          for (const line of ls) yield line;
        }
      })(),
    ),
  );
}

// True when an error came from an AbortSignal.timeout firing.
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Thrown (or rethrown) only when a stage-minted --timeout budget fired. */
export class HttpTimeoutError extends Error {
  constructor(method: string, url: string, timeoutMs: number) {
    super(`${method} ${url}: timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

// A Response can outlive its fetch: the --timeout signal keeps governing the
// body stream, so a budget that fires while a DOWNSTREAM stage reads the body
// would surface as a bare "The operation timed out." with no verb/url. Patch
// the body-consuming methods on the instance so the label survives — only
// called when the stage minted the signal itself.
export function labelBodyTimeout(
  res: Response,
  method: string,
  url: string,
  timeoutMs: number,
): Response {
  const patch = <K extends "text" | "json" | "arrayBuffer" | "blob" | "bytes">(key: K) => {
    const original = (res[key] as () => Promise<unknown>).bind(res);
    (res as unknown as Record<string, unknown>)[key] = async () => {
      try {
        return await original();
      } catch (err) {
        if (isTimeoutError(err)) throw new HttpTimeoutError(method, url, timeoutMs);
        throw err;
      }
    };
  };
  patch("text");
  patch("json");
  patch("arrayBuffer");
  patch("blob");
  patch("bytes");
  return res;
}

async function httpRequest(
  url: string,
  method: string,
  body: unknown,
  opts?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const init: RequestInit = { ...opts, method };
  // Minted PER REQUEST — a signal created at parse time would start its
  // clock at parse and abort every request after the first window. A
  // caller-supplied signal (TS API) always wins, and only a MINTED signal's
  // abort may ever be classified as a timeout (a caller's own abort must
  // never be relabeled as one).
  let minted = false;
  if (timeoutMs !== undefined && !opts?.signal) {
    init.signal = AbortSignal.timeout(timeoutMs);
    minted = true;
  }

  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      init.body = body;
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      init.body = body as Bun.BodyInit;
    } else {
      init.body = JSON.stringify(body);
      const headers = new Headers(opts?.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      init.headers = headers;
    }
  }

  try {
    const res = await fetch(url, init);
    return minted ? labelBodyTimeout(res, method, url, timeoutMs!) : res;
  } catch (err) {
    if (minted && isTimeoutError(err)) {
      throw new HttpTimeoutError(method, url, timeoutMs!);
    }
    // Bun's message ("Unable to connect. Is the computer able to access the
    // url?") names nothing, so a failing pipeline gave no clue WHICH request
    // died. The timeout path above has always been labelled; this matches it.
    const hostHint = url.startsWith("/")
      ? ' — no host in the URL (did an env var expand to ""? use `:3000/path` for localhost)'
      : "";
    throw new Error(`${method} ${url}: ${(err as Error).message}${hostHint}`);
  }
}

function makeHttp(method: "POST" | "PUT" | "PATCH" | "DELETE") {
  return <T>(url: string, opts?: RequestInit, timeoutMs?: number): PipelineStage<T, Response> =>
    pipelineStage<T, Response>((input) =>
      Pipeline.of(
        (async function* () {
          for await (const item of input.lines()) {
            yield await httpRequest(url, method, item, opts, timeoutMs);
          }
        })(),
      ),
    );
}

// Per-item request fn — lets the parser wrap any verb in parallel(n, fn).
export function httpItem(
  method: string,
  url: string,
  opts?: RequestInit,
  timeoutMs?: number,
): (item: unknown) => Promise<Response> {
  return (item) => httpRequest(url, method, item, opts, timeoutMs);
}

export const POST = makeHttp("POST");
export const PUT = makeHttp("PUT");
export const PATCH = makeHttp("PATCH");
export const DELETE = makeHttp("DELETE");

export type ExpectMatcher<T> = number | "2xx" | "3xx" | "4xx" | "5xx" | ((item: T) => boolean);

export class ExpectError<T> extends Error {
  constructor(
    public readonly item: T,
    public readonly index: number,
    public readonly matcher: ExpectMatcher<T>,
  ) {
    super(`expect: item at index ${index} failed matcher ${String(matcher)}`);
    this.name = "ExpectError";
  }
}

function matches<T>(item: T, matcher: ExpectMatcher<T>): boolean {
  if (typeof matcher === "function") return matcher(item);
  if (typeof matcher === "number") {
    return item instanceof Response && item.status === matcher;
  }
  const m = matcher.match(/^(\d)xx$/);
  if (m && item instanceof Response) {
    const cls = parseInt(m[1]!, 10);
    return item.status >= cls * 100 && item.status < (cls + 1) * 100;
  }
  return false;
}

export function expect<T>(matcher: ExpectMatcher<T>): PipelineStage<T, T> {
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        let i = 0;
        for await (const item of input.lines()) {
          if (!matches(item, matcher)) throw new ExpectError(item, i, matcher);
          yield item;
          i++;
        }
      })(),
    ),
  );
}

export function time<T>(
  label: string,
  out: { write(s: string): unknown } = process.stderr,
): PipelineStage<T, T> {
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        const start = performance.now();
        let count = 0;
        try {
          for await (const item of input.lines()) {
            count++;
            yield item;
          }
        } finally {
          const ms = (performance.now() - start).toFixed(1);
          out.write(`[time] ${label}: ${ms}ms (${count} item${count === 1 ? "" : "s"})\n`);
        }
      })(),
    ),
  );
}

// Streams results in COMPLETION order, not input order: downstream stages
// (stats --every windows, expect) see each result the moment it settles. The
// previous barrier variant buffered everything and made windowed soak stats
// meaningless — every item arrived in the final millisecond.
export function parallel<T, U>(n: number, fn: (x: T) => U | Promise<U>): PipelineStage<T, U> {
  // n=0 would make the pool loop below spin forever without ever awaiting.
  if (n < 1) throw new Error(`parallel: N must be >= 1 — got ${n}`);
  return pipelineStage<T, U>((input) =>
    Pipeline.of(
      (async function* () {
        const settled: U[] = [];
        const inFlight = new Set<Promise<void>>();
        let notify: (() => void) | null = null;
        // First worker rejection wins, and it is HELD rather than thrown from
        // the task: nothing awaits these tasks, so a rejecting one used to be
        // dropped on the floor — the item vanished and the run still exited 0
        // (an all-throwing load test reported success). The drain loop rethrows
        // it once the already-settled results have been yielded.
        const state: { failure: { err: unknown } | null } = { failure: null };
        const wake = () => {
          notify?.();
          notify = null;
        };

        const start = (item: T) => {
          let task!: Promise<void>;
          task = (async () => {
            try {
              settled.push(await fn(item));
            } catch (err) {
              state.failure ??= { err };
            }
            // Wake on both paths: a failure must interrupt the pool's parked
            // await exactly like a result does, or the loop sleeps until some
            // other task happens to finish.
            wake();
          })().finally(() => {
            inFlight.delete(task);
          });
          inFlight.add(task);
        };

        const iter = input.lines()[Symbol.asyncIterator]();
        let sourceDone = false;
        // The source pull is raced against completions: with a PACED source
        // (load) and a fast downstream, a bare `await iter.next()` would sit
        // through the pacing sleep while finished results pile up unyielded —
        // collapsing stats --every windows into a final-millisecond dump.
        let pendingNext: Promise<IteratorResult<T>> | null = null;
        try {
          while (!sourceDone || inFlight.size > 0 || settled.length > 0 || pendingNext !== null) {
            // Drain finished results first — this is what streams them.
            while (settled.length > 0) {
              yield settled.shift()!;
            }
            // Then fail. Yielding what already succeeded before rethrowing
            // mirrors the non-parallel path, where `range | (x => throw at 3)`
            // emits 0,1,2 and then fails. Still-running tasks are abandoned.
            if (state.failure) throw state.failure.err;
            if (!sourceDone && inFlight.size < n) {
              pendingNext ??= iter.next();
              const settledFirst = await Promise.race([
                pendingNext.then(() => false),
                new Promise<boolean>((r) => {
                  notify = () => r(true);
                }),
              ]);
              notify = null;
              if (settledFirst) continue; // a result landed — drain it first
              const next = await pendingNext; // already resolved
              pendingNext = null;
              if (next.done) {
                sourceDone = true;
                continue;
              }
              start(next.value);
              continue;
            }
            if (inFlight.size > 0 && settled.length === 0) {
              await new Promise<void>((r) => {
                notify = r;
              });
              notify = null;
            }
          }
        } finally {
          // Release the upstream whether we finished, threw, or the consumer
          // walked away (`| head -3`). Teardown noise must not mask the real
          // error on the way out.
          try {
            await iter.return?.(undefined as never);
          } catch {
            /* upstream already closed or has no return() */
          }
        }
      })(),
    ),
  );
}

// ---------------------------------------------------------------------------
// Load-pipeline stages: per-item timed HTTP, expect, stats. These are what
// make `range(0, 999) | parallel 50 | GET :3001/health | expect 200 | stats`
// work as documented.
// ---------------------------------------------------------------------------

export interface TimedHit {
  status: number;
  ms: number;
  url: string;
  /** present (true) only when the request hit its --timeout budget */
  timedOut?: true;
}

// Per-item GET against a fixed URL: the incoming item is only a trigger.
// Returns a lightweight timing record instead of a Response so `stats` can
// report real latency percentiles without holding bodies alive.
export function timedGet(
  url: string,
  opts?: RequestInit,
  timeoutMs?: number,
): (x: unknown) => Promise<TimedHit> {
  return async (_x: unknown) => {
    const t0 = performance.now();
    const init: RequestInit = { ...opts };
    let minted = false;
    if (timeoutMs !== undefined && !opts?.signal) {
      init.signal = AbortSignal.timeout(timeoutMs);
      minted = true;
    }
    try {
      const r = await fetch(url, init);
      // Drain so keep-alive sockets recycle and timing includes the body.
      await r.arrayBuffer();
      return { status: r.status, ms: performance.now() - t0, url };
    } catch (err) {
      const hit: TimedHit = { status: 0, ms: performance.now() - t0, url };
      // Distinguish a MINTED timeout from a refusal or a caller abort —
      // all are status 0 records, but only the budget firing is a timeout.
      if (minted && isTimeoutError(err)) hit.timedOut = true;
      return hit;
    }
  };
}

// Per-item timed request for ANY verb — what the parser uses when the
// `parallel` modifier puts an http stage in load mode. The upstream item is
// the request body (same conversion rules as POST/PUT/PATCH/DELETE stages);
// the body is drained so keep-alive sockets recycle and timing includes it.
// Network errors become {status: 0} records instead of killing the run.
export function timedHttpItem(
  method: string,
  url: string,
  opts?: RequestInit,
  timeoutMs?: number,
): (item: unknown) => Promise<TimedHit> {
  return async (item) => {
    const t0 = performance.now();
    try {
      const r = await httpRequest(url, method, item, opts, timeoutMs);
      await r.arrayBuffer();
      return { status: r.status, ms: performance.now() - t0, url };
    } catch (err) {
      const hit: TimedHit = { status: 0, ms: performance.now() - t0, url };
      // httpRequest throws HttpTimeoutError ONLY for its own minted budget —
      // typed check, not a message regex (URLs can contain anything).
      if (err instanceof HttpTimeoutError) hit.timedOut = true;
      return hit;
    }
  };
}

// Pass items through; on drain, fail the pipeline if any item's status
// didn't match. Works on TimedHit records and Response objects.
// `expected` is an exact code (201) or a class ("2xx").
export function expectStatus<T extends { status: number }>(
  expected: number | string,
): PipelineStage<T, T> {
  const classMatch = typeof expected === "string" ? expected.match(/^([1-5])xx$/) : null;
  if (typeof expected === "string" && !classMatch) {
    throw new Error(`expect: bad matcher "${expected}" — use a 3-digit code or 1xx…5xx`);
  }
  const lo = classMatch ? parseInt(classMatch[1]!, 10) * 100 : (expected as number);
  const hi = classMatch ? lo + 100 : lo + 1;
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        let mismatches = 0;
        let total = 0;
        for await (const item of input.lines()) {
          total++;
          // Explicit type check: an item with NO numeric status (undefined)
          // must count as a mismatch, not slide through NaN comparisons.
          const s = (item as { status?: unknown }).status;
          if (typeof s !== "number" || s < lo || s >= hi) mismatches++;
          yield item;
        }
        if (mismatches > 0) {
          throw new Error(`expect ${expected}: ${mismatches}/${total} responses did not match`);
        }
      })(),
    ),
  );
}

// `capture NAME (r => r.id)` — write each item's captured value to
// process.env[name] (last item wins) and pass items through. Later shell
// lines see $NAME because crust parses each line right before running it.
// Fails loudly on an empty upstream and on a nullish captured value: a
// capture that silently captured nothing turns into a baffling "" expansion
// three lines later.
export function captureEnv<T>(
  name: string,
  fn?: (x: T) => unknown,
  sourceText?: string,
): PipelineStage<T, T> {
  const from = sourceText ? ` from ${sourceText}` : "";
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        let count = 0;
        for await (const item of input.lines()) {
          count++;
          const value = fn ? await fn(item) : item;
          if (value === null || value === undefined) {
            throw new Error(`capture ${name}: got ${String(value)}${from} — item ${count}`);
          }
          process.env[name] =
            typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
          yield item;
        }
        if (count === 0) {
          throw new Error(`capture ${name}: no items reached capture — upstream was empty`);
        }
      })(),
    ),
  );
}

// `filter (l => ...)` — keep items whose predicate is truthy (plain JS
// truthiness: 0, "", null, undefined, false are dropped). Async predicates
// are awaited. An empty upstream (or an empty result) passes silently —
// filter is selection, not assertion; `assert` is the stage that fails on
// empty.
export function filterStage<T>(fn: (x: T) => unknown, sourceText?: string): PipelineStage<T, T> {
  const src = sourceText ? ` in ${sourceText}` : "";
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        let count = 0;
        for await (const item of input.lines()) {
          count++;
          let keep: unknown;
          try {
            keep = await fn(item);
          } catch (err) {
            throw new Error(`filter: item ${count} threw${src} — ${(err as Error).message}`);
          }
          if (keep) yield item;
        }
      })(),
    ),
  );
}

// Latency percentiles from a bounded histogram rather than every sample.
//
// Retaining each latency cost ~60 bytes/sample held for the whole run (+124MB
// at 3.6M) AND made summarize() copy+sort the CUMULATIVE array on every
// window: 9ms at 100k, 71ms at 1M, 282ms at 3.6M. Per-window that is
// O(windows x n log n) — a 1000rps/30min soak with `--every 5` spent ~25s, and
// a 5000rps/1h soak ~97s, blocking the SAME event loop that issues the requests
// and reads their bodies. A load runner that stalls itself for 1.6s reports
// those stalls as the server's latency, which is the failure the pacer fix in
// the previous round existed to prevent.
//
// Buckets are sub-millisecond up to 100ms, then progressively coarser, so a
// percentile is exact to within one bucket width. Deterministic by
// construction — the same run always reports the same number, which matters
// because these figures gate CI (a reservoir sample would not be).
// ~4000 bounds at 4 bytes each is ~16KB per accumulator — nothing next to the
// 124MB of retained samples it replaces — so resolution is bought generously:
// 0.1ms below 100ms, 1ms below 1s, 10ms below 10s. A reported percentile is the
// bucket's UPPER bound, so it never claims the service was faster than it was.
const BUCKET_BOUNDS: number[] = (() => {
  const b: number[] = [];
  for (let v = 1; v < 1000; v++) b.push(Number((v / 10).toFixed(1))); // 0.1ms → <100ms
  for (let v = 100; v < 1000; v++) b.push(v); // 1ms → <1s
  for (let v = 1000; v < 10_000; v += 10) b.push(v); // 10ms → <10s
  for (let v = 10_000; v <= 300_000; v += 100) b.push(v); // 100ms → 5min
  return b;
})();

function bucketFor(ms: number): number {
  // Binary search for the first bound >= ms.
  let lo = 0;
  let hi = BUCKET_BOUNDS.length - 1;
  if (ms > BUCKET_BOUNDS[hi]!) return BUCKET_BOUNDS.length; // overflow bucket
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BUCKET_BOUNDS[mid]! >= ms) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface StatsAcc {
  /** counts per latency bucket; index BUCKET_BOUNDS.length is the overflow */
  buckets: Int32Array;
  /** exact running total, so the mean stays exact */
  sumMs: number;
  /** how many items carried a numeric .ms */
  samples: number;
  maxMs: number;
  status: Record<string, number>;
  count: number;
}

function newAcc(): StatsAcc {
  return {
    buckets: new Int32Array(BUCKET_BOUNDS.length + 1),
    sumMs: 0,
    samples: 0,
    maxMs: 0,
    status: {},
    count: 0,
  };
}

function observe(acc: StatsAcc, ms: number): void {
  acc.buckets[bucketFor(ms)]!++;
  acc.sumMs += ms;
  acc.samples++;
  if (ms > acc.maxMs) acc.maxMs = ms;
}

function summarize(acc: StatsAcc, wallMs: number): Record<string, unknown> {
  // Nearest-rank over the histogram. The old index was
  // `Math.floor((p/100) * n)`, biased high — p99 of 100 samples was always the
  // maximum, and p50 of 4 was the 3rd value.
  const pct = (p: number): number => {
    if (acc.samples === 0) return 0;
    const target = Math.max(1, Math.ceil((p / 100) * acc.samples));
    let seen = 0;
    for (let i = 0; i < acc.buckets.length; i++) {
      seen += acc.buckets[i]!;
      if (seen >= target) return BUCKET_BOUNDS[i] ?? acc.maxMs;
    }
    return acc.maxMs;
  };
  const mean = acc.samples ? acc.sumMs / acc.samples : 0;
  return {
    count: acc.count,
    wallMs: Math.round(wallMs),
    rps: wallMs > 0 ? Math.round((acc.count / wallMs) * 1000) : 0,
    status: acc.status,
    p50: Number(pct(50).toFixed(1)),
    p95: Number(pct(95).toFixed(1)),
    p99: Number(pct(99).toFixed(1)),
    meanMs: Number(mean.toFixed(1)),
  };
}

// Terminal aggregation: consumes the stream and yields ONE summary (or, with
// everySec, a per-window delta summary every N seconds PLUS a final
// cumulative one tagged {final: true}). Windows are emitted on the item path
// — a fully stalled upstream delays the flush until the next item arrives.
// With `out`, the run is also written to a versioned JSON artifact — BEFORE
// the final yield, so the file exists even when a downstream threshold
// assert fails the pipeline.
export function statsStage(
  everySec?: number,
  out?: string,
): PipelineStage<{ status: number; ms?: number }, unknown> {
  if (out !== undefined && !out.endsWith(".json")) {
    throw new Error(`stats --out: only .json is supported — got ${out}`);
  }
  return pipelineStage((input) =>
    Pipeline.of(
      (async function* () {
        const startedAt = new Date().toISOString();
        const t0 = performance.now();
        const total: StatsAcc = newAcc();
        const urls = new Set<string>();
        const windows: Record<string, unknown>[] = [];
        let win: StatsAcc = newAcc();
        let winStart = t0;
        let winNo = 0;
        // Written after EVERY window flush, not only at the end: a window-
        // level threshold assert abandons this generator mid-stream, and the
        // artifact must still exist for CI upload (summary = cumulative so
        // far in that case).
        const flush = async () => {
          if (!out) return;
          const doc: Record<string, unknown> = {
            crustStats: 1,
            startedAt,
            urls: [...urls].sort(),
            summary: summarize(total, performance.now() - t0),
          };
          if (everySec) doc.windows = windows;
          // Write-then-rename: this file is rewritten on EVERY window and is
          // exactly what CI uploads, so a Ctrl-C (or a window-level threshold
          // assert abandoning the generator) mid-write left invalid JSON there.
          const tmp = `${out}.tmp`;
          await Bun.write(tmp, `${JSON.stringify(doc, null, 2)}\n`);
          await rename(tmp, out);
        };
        for await (const item of input.lines()) {
          const u = (item as { url?: unknown }).url;
          if (typeof u === "string") urls.add(u);
          // Unrolled: `for (const acc of [total, win])` allocated a
          // two-element array per item in the one loop that runs at full
          // request rate (213ms vs 66ms over 3M items).
          const st = String(item.status);
          total.count++;
          win.count++;
          total.status[st] = (total.status[st] ?? 0) + 1;
          win.status[st] = (win.status[st] ?? 0) + 1;
          if (typeof item.ms === "number") {
            observe(total, item.ms);
            observe(win, item.ms);
          }
          if (everySec && performance.now() - winStart >= everySec * 1000) {
            winNo++;
            const w = { window: winNo, ...summarize(win, performance.now() - winStart) };
            windows.push(w);
            await flush();
            yield w;
            win = newAcc();
            winStart = performance.now();
          }
        }
        if (everySec && win.count > 0) {
          winNo++;
          const w = { window: winNo, ...summarize(win, performance.now() - winStart) };
          windows.push(w);
          await flush();
          yield w;
        }
        const summary = summarize(total, performance.now() - t0);
        await flush();
        // A summary of nothing is TAGGED rather than silently plausible. It
        // used to be indistinguishable from a healthy run — {count: 0, p95: 0}
        // sailed through `assert (s => s.p95 < 200)`, so a CI gate that issued
        // zero requests passed green. `assert` rejects an `empty` summary (see
        // parser.ts), which closes that without making an empty stream fatal
        // everywhere: a `logs` query whose retro buffer is empty, or an
        // exploratory `… | stats`, still works.
        const tagged = total.count === 0 ? { ...summary, empty: true } : summary;
        yield everySec ? { final: true, ...tagged } : tagged;
      })(),
    ),
  );
}
