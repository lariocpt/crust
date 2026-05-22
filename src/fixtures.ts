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

export function diff(path: string, expected: unknown, actual: unknown): FixtureFailure[] {
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
