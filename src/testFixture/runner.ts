import { Glob } from "bun";
import { resolve } from "node:path";
import type {
  Fixture,
  FixtureFailure,
  FixtureResult,
  RunOpts,
  RunReport,
} from "./types";

export async function runFixtures(opts: RunOpts): Promise<RunReport> {
  const threads = Math.max(1, Math.floor(opts.threads || 1));
  if (opts.threads < 1) {
    process.stderr.write(`test-fixture: --threads ${opts.threads} clamped to 1\n`);
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
    fxs.forEach((fx, i) => tasks.push(() => runOne(file, fx, i)));
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
  return { results, totals };
}

export async function expandTarget(target: string): Promise<string[]> {
  const looksGlob = /[*?[\]{}]/.test(target);
  if (!looksGlob) {
    const abs = resolve(process.cwd(), target);
    const f = Bun.file(abs);
    if (await f.exists()) {
      if (!abs.endsWith(".crust.ts")) {
        throw new Error(`test-fixture: ${abs}: not a .crust.ts file`);
      }
      return [abs];
    }
    return [];
  }
  const g = new Glob(target);
  const out: string[] = [];
  try {
    for await (const f of g.scan({ cwd: process.cwd(), absolute: true })) {
      if (f.endsWith(".crust.ts")) out.push(f);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  out.sort();
  return out;
}

async function runOne(file: string, fx: Fixture, idx: number): Promise<FixtureResult> {
  const name = fx.name ?? `${file}#${idx}`;
  const start = performance.now();
  let setupCtx: unknown;
  let teardownErr: Error | null = null;
  try {
    if (fx.setup) setupCtx = await fx.setup();
    const input = (await resolveDeep(fx.input)) as Record<string, unknown>;
    const expected = (await resolveDeep(fx.output)) as Record<string, unknown>;
    const actual = await performRequest(input);
    const failures = diff("output", expected, actual);
    return {
      file,
      name,
      status: failures.length ? "fail" : "pass",
      durationMs: performance.now() - start,
      failures,
    };
  } catch (err) {
    const e = err as Error;
    return {
      file,
      name,
      status: "error",
      durationMs: performance.now() - start,
      failures: [],
      error: { message: e.message, stack: e.stack },
    };
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

async function resolveDeep(value: unknown): Promise<unknown> {
  if (typeof value === "function") {
    if ((value as Function).length === 0) {
      return await (value as () => unknown)();
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await resolveDeep(v));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = await resolveDeep(v);
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

function diff(path: string, expected: unknown, actual: unknown): FixtureFailure[] {
  if (typeof expected === "function") {
    const fn = expected as (a: unknown) => unknown;
    if (fn.length >= 1) {
      let ok = false;
      try {
        ok = !!fn(actual);
      } catch {
        ok = false;
      }
      return ok ? [] : [{ path, expected: "<predicate>", actual }];
    }
  }
  if (expected === actual) return [];
  if (expected === null || actual === null) {
    return [{ path, expected, actual }];
  }
  if (typeof expected !== typeof actual) {
    return [{ path, expected, actual }];
  }
  if (typeof expected !== "object") {
    return [{ path, expected, actual }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [{ path, expected, actual }];
    const failures: FixtureFailure[] = [];
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      failures.push(...diff(`${path}[${i}]`, expected[i], actual[i]));
    }
    return failures;
  }
  const failures: FixtureFailure[] = [];
  const exp = expected as Record<string, unknown>;
  const act = actual as Record<string, unknown>;
  for (const k of Object.keys(exp)) {
    failures.push(...diff(`${path}.${k}`, exp[k], act[k]));
  }
  return failures;
}
