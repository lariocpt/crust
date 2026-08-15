// crust tests crust.
//
// The suites in tests/self/*.pipes are written in crust's own grammar and run
// by crust's own .pipes runner against crust's own mock server. That is the
// point: a regression in the lexer, the parser, a stage, the fixture runner or
// the mock server shows up here as a failing LINE OF CRUST, not as a failing
// TypeScript assertion about crust.
//
// Deliberately cheap: the whole file is well under a second against an ~9s
// suite, and readiness comes from crust's own `wait` (measured 23ms) rather
// than a fixed sleep.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerBuiltinFns } from "../src/builtinFns";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { startServer } from "../src/mockServer/server";
import { parse } from "../src/parser";
import { runPipes } from "../src/testPipes/runner";
import type { Context } from "../src/types";

let server: Awaited<ReturnType<typeof startServer>>;
let base: string;
let prevBase: string | undefined;

beforeAll(async () => {
  const spec = JSON.parse(
    await Bun.file(`${import.meta.dir}/self/spec.json`).text(),
  ) as OpenApiSpec;
  server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    spec,
    stateful: true,
    log: () => {},
  });
  base = `http://127.0.0.1:${server.port}`;
  prevBase = process.env.BASE;
  process.env.BASE = base;
});

afterAll(async () => {
  if (prevBase === undefined) delete process.env.BASE;
  else process.env.BASE = prevBase;
  await server.stop();
});

const report = (r: Awaited<ReturnType<typeof runPipes>>): string =>
  r.results
    .filter((x) => x.status === "fail")
    .map((x) => `${x.file}:${x.lineNo} ${x.line}\n    ${x.error}`)
    .join("\n");

describe("crust runs its own grammar", () => {
  test("tests/self/grammar.pipes — every line drains clean", async () => {
    const r = await runPipes({ target: `${import.meta.dir}/self/grammar.pipes` });
    expect(report(r)).toBe("");
    expect(r.totals.fail).toBe(0);
    expect(r.totals.pass).toBeGreaterThan(10);
  });

  test("tests/self/http.pipes — against a crust mock server", async () => {
    // `wait` is crust's own readiness probe: dogfooding the thing that exists
    // precisely so CI never needs `sleep 2`.
    const ctx = { aliases: new Map(), functions: new Map(), history: [] } as unknown as Context;
    registerBuiltinFns(ctx);
    for await (const _ of parse(`wait ${base}/health --timeout 10s`)(ctx).lines()) {
      // drain: throws if the server never comes up
    }

    const r = await runPipes({ target: `${import.meta.dir}/self/http.pipes` });
    expect(report(r)).toBe("");
    expect(r.totals.fail).toBe(0);
    expect(r.totals.pass).toBeGreaterThan(8);
  });
});

describe("the suite can actually fail", () => {
  // A green self-test proves nothing unless red is reachable. These are the
  // Wave 0 bugs expressed as crust lines; each one FAILED before the fix.
  const mustFail = async (line: string): Promise<string> => {
    const ctx = { aliases: new Map(), functions: new Map(), history: [] } as unknown as Context;
    registerBuiltinFns(ctx);
    try {
      for await (const _ of parse(line)(ctx).lines()) {
        // drain
      }
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };

  test("a wrong assertion fails, in crust's own grammar", async () => {
    expect(await mustFail("range(1,3) | assert (n => n > 99)")).toMatch(/assert: item 1 failed/);
  });

  test("an expectation against a non-response fails", async () => {
    expect(await mustFail("range(1,3) | expect 200")).toMatch(/did not match/);
  });

  test("a throwing lambda under parallel fails instead of vanishing", async () => {
    expect(await mustFail('range(0,4) | parallel 2 | (x => { throw new Error("boom") })')).toMatch(
      /boom/,
    );
  });

  test("an assertion nothing reached fails rather than passing vacuously", async () => {
    expect(await mustFail("range(1,3) | filter (n => false) | assert (n => true)")).toMatch(
      /no items reached/,
    );
  });
});
