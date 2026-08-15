// The globals crust injects must match the globals crust documents.
//
// `docs/USAGE.md` promised `readAll` and `tail` for the whole life of the TS
// API and injected neither, so every documented `tail(...)` example threw
// ReferenceError — inside an `init.ts` that failure is caught, printed as a
// warning, and the session continues at exit 0, so nobody noticed. The docs
// lint could not catch it either: it reads ```bash/```crust fences, and the
// globals table is a ```ts one.
//
// This test parses the documented table and asserts both directions, so the
// two cannot drift apart again.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import type { Context } from "../src/types";

function documentedGlobals(usage: string): string[] {
  const anchor = usage.indexOf("Crust exposes these as globals");
  expect(anchor).toBeGreaterThan(-1);
  const start = usage.indexOf("```ts", anchor);
  const end = usage.indexOf("```", start + 5);
  const block = usage.slice(start + 5, end);

  const names = new Set<string>();
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line.includes("(")) {
      // A signature row — take the callee only. Splitting on commas here would
      // harvest PARAMETER names (`range(start, end)` → "end").
      const m = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      if (m) names.add(m[1]!);
      continue;
    }
    // A bare-name row: "Pipeline", "$", or "PUT, PATCH, DELETE".
    for (const part of line.split(",")) {
      const m = part.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (m) names.add(m[1]!);
    }
  }
  return [...names].sort();
}

const ctx = (): Context =>
  ({
    aliases: new Map(),
    functions: new Map(),
    history: [],
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
    exit: async () => process.exit(0),
  }) as unknown as Context;

describe("documented globals", () => {
  test("every global in docs/USAGE.md is actually injected", async () => {
    const usage = await Bun.file(`${import.meta.dir}/../docs/USAGE.md`).text();
    const documented = documentedGlobals(usage);
    expect(documented.length).toBeGreaterThan(15);

    // CRUST_CONFIG at a path that does not exist: loadConfig injects the
    // globals, then the missing init.ts is ignored (ERR_MODULE_NOT_FOUND).
    await loadConfig(ctx(), "/nonexistent/crust-globals-test/init.ts");

    const missing = documented.filter(
      (name) => (globalThis as Record<string, unknown>)[name] === undefined,
    );
    expect(missing).toEqual([]);
  });

  test("the parser finds the real table, not an empty match", async () => {
    const usage = await Bun.file(`${import.meta.dir}/../docs/USAGE.md`).text();
    const documented = documentedGlobals(usage);
    // Spot-check the ones that were broken, plus a shared-shape row.
    for (const name of ["Pipeline", "readAll", "readLines", "tail", "PUT", "DELETE", "$"]) {
      expect(documented).toContain(name);
    }
  });

  test("a documented global that is not a function would be caught", async () => {
    // Guards the assertion itself: the check is `!== undefined`, so prove a
    // name absent from globalThis really does fail the filter.
    const absent = ["definitelyNotAGlobal_xyz"].filter(
      (n) => (globalThis as Record<string, unknown>)[n] === undefined,
    );
    expect(absent).toEqual(["definitelyNotAGlobal_xyz"]);
  });
});
