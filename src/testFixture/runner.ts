import { diffAsync, expandTarget as expandTargetShared } from "../fixtures";
import type { Fixture, FixtureResult, RunOpts, RunReport, StressBucket } from "./types";

export async function runFixtures(opts: RunOpts): Promise<RunReport> {
  const threads = Math.max(1, Math.floor(opts.threads || 1));
  if (opts.threads < 1) {
    process.stderr.write(`test-fixture: --threads ${opts.threads} clamped to 1\n`);
  }
  const count = Math.max(1, Math.floor(opts.count ?? 1));
  if ((opts.count ?? 1) < 1) {
    process.stderr.write(`test-fixture: --count ${opts.count} clamped to 1\n`);
  }
  const files = await expandTarget(opts.target);
  const tasks: Array<() => Promise<FixtureResult>> = [];

  for (const file of files) {
    let mod: { default?: unknown };
    try {
      mod = await import(file);
    } catch (err) {
      const e = err as Error;
      tasks.push(async () => ({
        file,
        name: file,
        status: "error",
        durationMs: 0,
        failures: [],
        error: { message: `import failed: ${e.message}`, stack: e.stack },
      }));
      continue;
    }
    let raw = mod.default;
    if (typeof raw === "function") {
      try {
        raw = await (raw as () => unknown)();
      } catch (err) {
        const e = err as Error;
        tasks.push(async () => ({
          file,
          name: file,
          status: "error",
          durationMs: 0,
          failures: [],
          error: { message: `default function threw: ${e.message}`, stack: e.stack },
        }));
        continue;
      }
    }
    if (raw === undefined || raw === null) {
      tasks.push(async () => ({
        file,
        name: file,
        status: "error",
        durationMs: 0,
        failures: [],
        error: { message: "fixture has no default export" },
      }));
      continue;
    }
    const fxs = Array.isArray(raw) ? (raw as Fixture[]) : [raw as Fixture];
    fxs.forEach((fx, i) => {
      for (let iter = 1; iter <= count; iter++) {
        const iterArg = count > 1 ? iter : undefined;
        tasks.push(() => runOne(file, fx, i, iterArg));
      }
    });
  }

  const results: FixtureResult[] = new Array(tasks.length);
  const inFlight = new Set<Promise<void>>();
  for (let i = 0; i < tasks.length; i++) {
    while (inFlight.size >= threads) await Promise.race(inFlight);
    const idx = i;
    let t!: Promise<void>;
    t = (async () => {
      results[idx] = await tasks[idx]!();
    })().finally(() => {
      inFlight.delete(t);
    });
    inFlight.add(t);
  }
  await Promise.all(inFlight);

  const totals = { pass: 0, fail: 0, error: 0, ms: 0 };
  for (const r of results) {
    totals[r.status]++;
    totals.ms += r.durationMs;
  }
  const report: RunReport = { results, totals };
  if (count > 1) report.stress = buildStressBuckets(results);
  return report;
}

function buildStressBuckets(results: FixtureResult[]): StressBucket[] {
  const groups = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const key = `${r.file}::${r.name.replace(/#\d+$/, "")}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: StressBucket[] = [];
  for (const [key, runs] of groups) {
    const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
    const statusCodes: Record<string, number> = {};
    let pass = 0;
    let fail = 0;
    let errCount = 0;
    let sum = 0;
    for (const r of runs) {
      sum += r.durationMs;
      if (r.status === "pass") pass++;
      else if (r.status === "fail") fail++;
      else errCount++;
      const code = r.responseStatus != null ? String(r.responseStatus) : "n/a";
      statusCodes[code] = (statusCodes[code] ?? 0) + 1;
    }
    out.push({
      fixture: key,
      count: runs.length,
      pass,
      fail,
      error: errCount,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      minMs: durations[0] ?? 0,
      maxMs: durations[durations.length - 1] ?? 0,
      meanMs: sum / runs.length,
      statusCodes,
    });
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export async function expandTarget(target: string): Promise<string[]> {
  try {
    return await expandTargetShared(target);
  } catch (err) {
    const e = err as Error;
    if (e.message.includes("not a .crust.ts file")) {
      throw new Error(`test-fixture: ${e.message}`);
    }
    throw err;
  }
}

async function runOne(
  file: string,
  fx: Fixture,
  idx: number,
  iter?: number,
): Promise<FixtureResult> {
  const baseName = fx.name ?? `${file}#${idx}`;
  const name = iter != null ? `${baseName} #${iter}` : baseName;
  const start = performance.now();
  let setupCtx: unknown;
  let teardownErr: Error | null = null;
  let responseStatus: number | undefined;
  try {
    if (fx.setup) setupCtx = await fx.setup();
    // input/output may be functions of the setup context — the only way a
    // fixture can put a setup-created credential or id into the request.
    const rawInput = typeof fx.input === "function" ? await fx.input(setupCtx as never) : fx.input;
    const rawOutput =
      typeof fx.output === "function" && (fx.output as Function).length >= 1
        ? await (fx.output as (c: unknown) => unknown)(setupCtx)
        : fx.output;
    const input = (await resolveDeep(rawInput, setupCtx, true)) as Record<string, unknown>;
    const expected = (await resolveDeep(rawOutput, setupCtx, false)) as Record<string, unknown>;
    const actual = await performRequest(input);
    responseStatus = actual.status;
    const failures = await diffAsync("output", expected, actual, setupCtx);
    const r: FixtureResult = {
      file,
      name,
      status: failures.length ? "fail" : "pass",
      durationMs: performance.now() - start,
      failures,
      responseStatus,
    };
    if (iter != null) r.iter = iter;
    return r;
  } catch (err) {
    const e = err as Error;
    const r: FixtureResult = {
      file,
      name,
      status: "error",
      durationMs: performance.now() - start,
      failures: [],
      error: { message: e.message, stack: e.stack },
    };
    if (responseStatus != null) r.responseStatus = responseStatus;
    if (iter != null) r.iter = iter;
    return r;
  } finally {
    if (fx.teardown) {
      try {
        await fx.teardown(setupCtx);
      } catch (err) {
        teardownErr = err as Error;
      }
    }
    if (teardownErr) {
      process.stderr.write(`test-fixture: teardown of ${name} threw: ${teardownErr.message}\n`);
    }
  }
}

// callUnary distinguishes the two sides: in INPUT, a 1-arg function is a
// ctx-consumer and gets called with the setup context; in OUTPUT it is a
// matcher predicate and must be left alone for diffAsync (which calls it with
// (actual, ctx)). 0-arg functions resolve on both sides, as before.
async function resolveDeep(value: unknown, ctx: unknown, callUnary: boolean): Promise<unknown> {
  if (typeof value === "function") {
    if ((value as Function).length === 0) {
      return await (value as () => unknown)();
    }
    if (callUnary && (value as Function).length === 1) {
      return await (value as (c: unknown) => unknown)(ctx);
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await resolveDeep(v, ctx, callUnary));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = await resolveDeep(v, ctx, callUnary);
  }
  return out;
}

async function performRequest(input: Record<string, unknown>): Promise<{
  status: number;
  headers: Record<string, string>;
  data: unknown;
}> {
  const url = input.url;
  if (typeof url !== "string") throw new Error("fixture input.url must be a string");
  const init: RequestInit = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "url") continue;
    (init as Record<string, unknown>)[k] = v;
  }
  if (init.method === undefined) init.method = "GET";
  const r = await fetch(url, init);
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let data: unknown;
  const text = await r.text();
  try {
    data = text === "" ? "" : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, headers, data };
}
