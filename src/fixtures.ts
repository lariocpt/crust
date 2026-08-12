import { resolve } from "node:path";
import { Glob } from "bun";

export interface FixtureFailure {
  path: string;
  expected: unknown;
  actual: unknown;
}

export async function expandTarget(target: string): Promise<string[]> {
  const looksGlob = /[*?[\]{}]/.test(target);
  if (!looksGlob) {
    const abs = resolve(process.cwd(), target);
    const f = Bun.file(abs);
    if (await f.exists()) {
      if (!abs.endsWith(".crust.ts")) {
        throw new Error(`${abs}: not a .crust.ts file`);
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

function isThenable(v: unknown): v is Promise<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function diff(path: string, expected: unknown, actual: unknown): FixtureFailure[] {
  if (typeof expected === "function") {
    const fn = expected as (a: unknown) => unknown;
    if (fn.length >= 1) {
      let ok = false;
      try {
        const r = fn(actual);
        // A Promise is always truthy — silently passing an async predicate in
        // a sync context would be a false positive. Fail loudly instead; use
        // diffAsync (the test-fixture runner does) for async matchers.
        if (isThenable(r)) {
          return [{ path, expected: "<async predicate in sync diff — use diffAsync>", actual }];
        }
        ok = !!r;
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

// Async-aware variant used by the test-fixture runner: predicates may return
// a Promise<boolean> (e.g. a fixture asserting a DB side effect), and every
// predicate additionally receives the fixture's setup context as its second
// argument. Sync predicates and plain value comparison behave exactly as
// diff().
export async function diffAsync(
  path: string,
  expected: unknown,
  actual: unknown,
  ctx?: unknown,
): Promise<FixtureFailure[]> {
  if (typeof expected === "function") {
    const fn = expected as (a: unknown, c?: unknown) => unknown;
    if (fn.length >= 1) {
      let ok = false;
      try {
        const r = fn(actual, ctx);
        ok = !!(isThenable(r) ? await r : r);
      } catch {
        ok = false;
      }
      return ok ? [] : [{ path, expected: "<predicate>", actual }];
    }
  }
  if (expected === actual) return [];
  if (expected === null || actual === null) return [{ path, expected, actual }];
  if (typeof expected !== typeof actual) return [{ path, expected, actual }];
  if (typeof expected !== "object") return [{ path, expected, actual }];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [{ path, expected, actual }];
    const failures: FixtureFailure[] = [];
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      failures.push(...(await diffAsync(`${path}[${i}]`, expected[i], actual[i], ctx)));
    }
    return failures;
  }
  const failures: FixtureFailure[] = [];
  const exp = expected as Record<string, unknown>;
  const act = actual as Record<string, unknown>;
  for (const k of Object.keys(exp)) {
    failures.push(...(await diffAsync(`${path}.${k}`, exp[k], act[k], ctx)));
  }
  return failures;
}
