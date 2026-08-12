import { Pipeline, type PipelineStage, pipelineStage } from "./pipeline";

async function httpRequest(
  url: string,
  method: string,
  body: unknown,
  opts?: RequestInit,
): Promise<Response> {
  const init: RequestInit = { ...opts, method };

  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      init.body = body;
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      init.body = body as BodyInit;
    } else {
      init.body = JSON.stringify(body);
      const headers = new Headers(opts?.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      init.headers = headers;
    }
  }

  return fetch(url, init);
}

function makeHttp(method: "POST" | "PUT" | "PATCH" | "DELETE") {
  return <T>(url: string, opts?: RequestInit): PipelineStage<T, Response> =>
    pipelineStage<T, Response>((input) =>
      Pipeline.of(
        (async function* () {
          for await (const item of input.lines()) {
            yield await httpRequest(url, method, item, opts);
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
): (item: unknown) => Promise<Response> {
  return (item) => httpRequest(url, method, item, opts);
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
        const wake = () => {
          notify?.();
          notify = null;
        };

        const start = (item: T) => {
          let task!: Promise<void>;
          task = (async () => {
            const r = await fn(item);
            settled.push(r);
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
        while (!sourceDone || inFlight.size > 0 || settled.length > 0 || pendingNext !== null) {
          // Drain finished results first — this is what streams them.
          while (settled.length > 0) {
            yield settled.shift()!;
          }
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
}

// Per-item GET against a fixed URL: the incoming item is only a trigger.
// Returns a lightweight timing record instead of a Response so `stats` can
// report real latency percentiles without holding bodies alive.
export function timedGet(url: string, opts?: RequestInit): (x: unknown) => Promise<TimedHit> {
  return async (_x: unknown) => {
    const t0 = performance.now();
    try {
      const r = await fetch(url, opts);
      // Drain so keep-alive sockets recycle and timing includes the body.
      await r.arrayBuffer();
      return { status: r.status, ms: performance.now() - t0, url };
    } catch {
      return { status: 0, ms: performance.now() - t0, url };
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
): (item: unknown) => Promise<TimedHit> {
  return async (item) => {
    const t0 = performance.now();
    try {
      const r = await httpRequest(url, method, item, opts);
      await r.arrayBuffer();
      return { status: r.status, ms: performance.now() - t0, url };
    } catch {
      return { status: 0, ms: performance.now() - t0, url };
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

interface StatsAcc {
  latencies: number[];
  status: Record<string, number>;
  count: number;
}

function summarize(acc: StatsAcc, wallMs: number): Record<string, unknown> {
  const sorted = [...acc.latencies].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted.length === 0
      ? 0
      : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
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
        const total: StatsAcc = { latencies: [], status: {}, count: 0 };
        const urls = new Set<string>();
        const windows: Record<string, unknown>[] = [];
        let win: StatsAcc = { latencies: [], status: {}, count: 0 };
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
          await Bun.write(out, `${JSON.stringify(doc, null, 2)}\n`);
        };
        for await (const item of input.lines()) {
          const u = (item as { url?: unknown }).url;
          if (typeof u === "string") urls.add(u);
          for (const acc of [total, win]) {
            acc.count++;
            acc.status[item.status] = (acc.status[item.status] ?? 0) + 1;
            if (typeof item.ms === "number") acc.latencies.push(item.ms);
          }
          if (everySec && performance.now() - winStart >= everySec * 1000) {
            winNo++;
            const w = { window: winNo, ...summarize(win, performance.now() - winStart) };
            windows.push(w);
            await flush();
            yield w;
            win = { latencies: [], status: {}, count: 0 };
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
        yield everySec ? { final: true, ...summary } : summary;
      })(),
    ),
  );
}
