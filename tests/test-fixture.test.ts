import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/testFixture/cli";
import { runFixtures } from "../src/testFixture/runner";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let dir: string;
let originalCwd: string;
let mode: "ok" | "wrong-status" = "ok";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/users/42") {
        if (mode === "wrong-status") {
          return new Response(JSON.stringify({ id: 42, name: "Lario" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: 42, name: "Lario" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/echo-header") {
        return new Response(JSON.stringify({ token: req.headers.get("x-token") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/sleep") {
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response("ok", { status: 200 })), 50),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
  originalCwd = process.cwd();
  dir = await realpath(await mkdtemp(join(tmpdir(), "crust-fixture-")));
  process.chdir(dir);
});

afterAll(async () => {
  server.stop();
  process.chdir(originalCwd);
  await rm(dir, { recursive: true, force: true });
});

async function writeFixture(rel: string, body: string): Promise<string> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body, "utf8");
  return full;
}

describe("test-fixture runner", () => {
  test("passing fixture", async () => {
    mode = "ok";
    const file = await writeFixture(
      "pass.crust.ts",
      `export default {
        name: "GET /users/42",
        input: { url: "${baseUrl}/users/42" },
        output: { status: 200, data: { id: 42, name: "Lario" } },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.fail).toBe(0);
    expect(report.totals.error).toBe(0);
    expect(report.results[0]!.status).toBe("pass");
  });

  test("failing fixture surfaces failure path", async () => {
    mode = "wrong-status";
    const file = await writeFixture(
      "fail.crust.ts",
      `export default {
        input: { url: "${baseUrl}/users/42" },
        output: { status: 200 },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.fail).toBe(1);
    const r = report.results[0]!;
    expect(r.status).toBe("fail");
    expect(r.failures[0]!.path).toBe("output.status");
    expect(r.failures[0]!.expected).toBe(200);
    expect(r.failures[0]!.actual).toBe(500);
  });

  test("async matcher predicates are awaited (pass and fail)", async () => {
    mode = "ok";
    const file = await writeFixture(
      "async-matcher.crust.ts",
      `export default [
        {
          name: "async matcher that resolves true",
          input: { url: "${baseUrl}/users/42" },
          output: { status: 200, data: async (d) => { await new Promise(r => setTimeout(r, 5)); return d.id === 42; } },
        },
        {
          name: "async matcher that resolves false must FAIL",
          input: { url: "${baseUrl}/users/42" },
          output: { status: 200, data: async (d) => { await new Promise(r => setTimeout(r, 5)); return d.id === 999; } },
        },
      ];\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    // Before diffAsync, a returned Promise was truthy and this silently passed.
    expect(report.totals.fail).toBe(1);
    expect(report.results[1]!.failures[0]!.path).toBe("output.data");
  });

  test("input as a function receives the setup context", async () => {
    mode = "ok";
    const file = await writeFixture(
      "ctx-input.crust.ts",
      `export default {
        name: "setup token reaches the request",
        setup: async () => ({ token: "ctx-" + "42" }),
        input: (ctx) => ({
          url: "${baseUrl}/echo-header",
          headers: { "x-token": ctx.token },
        }),
        output: { status: 200, data: { token: "ctx-42" } },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.error).toBe(0);
  });

  test("unary input FIELD functions receive the setup context", async () => {
    mode = "ok";
    const file = await writeFixture(
      "ctx-field.crust.ts",
      `export default {
        setup: () => ({ token: "field-ctx" }),
        input: {
          url: "${baseUrl}/echo-header",
          headers: (ctx) => ({ "x-token": ctx.token }),
        },
        output: { status: 200, data: { token: "field-ctx" } },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.error).toBe(0);
  });

  test("output matchers receive the setup context as second argument", async () => {
    mode = "ok";
    const file = await writeFixture(
      "ctx-matcher.crust.ts",
      `export default {
        setup: () => ({ expectedName: "Lario" }),
        input: { url: "${baseUrl}/users/42" },
        output: { status: 200, data: (d, ctx) => d.name === ctx.expectedName },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.error).toBe(0);
  });

  test("thunk in input is resolved at run time", async () => {
    mode = "ok";
    const file = await writeFixture(
      "thunk.crust.ts",
      `export default {
        input: {
          url: "${baseUrl}/echo-header",
          headers: async () => ({ "x-token": "abc-" + (await Promise.resolve("xyz")) }),
        },
        output: { status: 200, data: { token: "abc-xyz" } },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
  });

  test("predicate matcher (1-arg fn) in output", async () => {
    mode = "ok";
    const file = await writeFixture(
      "matcher.crust.ts",
      `export default {
        input: { url: "${baseUrl}/users/42" },
        output: {
          status: (s) => s >= 200 && s < 300,
          data: { id: (v) => typeof v === "number", name: "Lario" },
        },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.fail).toBe(0);
  });

  test("glob across folders, sorted, .crust.ts filter", async () => {
    mode = "ok";
    await writeFixture(
      "a/x.crust.ts",
      `export default { input: { url: "${baseUrl}/users/42" }, output: { status: 200 } };\n`,
    );
    await writeFixture(
      "b/y.crust.ts",
      `export default { input: { url: "${baseUrl}/users/42" }, output: { status: 200 } };\n`,
    );
    await writeFixture("b/not-a-fixture.ts", `export default {};\n`);
    const report = await runFixtures({ target: `${dir}/**/*.crust.ts`, threads: 1 });
    const files = report.results.map((r) => r.file).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => f.endsWith("a/x.crust.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b/y.crust.ts"))).toBe(true);
    expect(files.every((f) => f.endsWith(".crust.ts"))).toBe(true);
  });

  test("--threads runs in parallel", async () => {
    mode = "ok";
    const files: string[] = [];
    for (let i = 0; i < 6; i++) {
      files.push(
        await writeFixture(
          `parallel/p${i}.crust.ts`,
          `export default { input: { url: "${baseUrl}/sleep" }, output: { status: 200 } };\n`,
        ),
      );
    }
    const start = performance.now();
    const report = await runFixtures({
      target: `${dir}/parallel/*.crust.ts`,
      threads: 6,
    });
    const elapsed = performance.now() - start;
    expect(report.totals.pass).toBe(6);
    expect(elapsed).toBeLessThan(250);
  });

  test("import failure produces an error result, does not throw", async () => {
    const file = await writeFixture("broken.crust.ts", `throw new Error("nope");\n`);
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.error).toBe(1);
    expect(report.results[0]!.error?.message).toContain("nope");
  });

  test("--count repeats each fixture N times and surfaces a stress bucket", async () => {
    mode = "ok";
    const file = await writeFixture(
      "stress/repeat.crust.ts",
      `export default { input: { url: "${baseUrl}/users/42" }, output: { status: 200 } };\n`,
    );
    const report = await runFixtures({ target: file, threads: 4, count: 10 });
    expect(report.results).toHaveLength(10);
    expect(report.totals.pass).toBe(10);
    expect(report.stress).toBeDefined();
    expect(report.stress!.length).toBe(1);
    const b = report.stress![0]!;
    expect(b.count).toBe(10);
    expect(b.pass).toBe(10);
    expect(b.p50).toBeGreaterThanOrEqual(0);
    expect(b.p95).toBeGreaterThanOrEqual(b.p50);
    expect(b.statusCodes["200"]).toBe(10);
  });

  test("--count tags each result with its iter index", async () => {
    mode = "ok";
    const file = await writeFixture(
      "stress/iter.crust.ts",
      `export default { input: { url: "${baseUrl}/users/42" }, output: { status: 200 } };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1, count: 3 });
    const iters = report.results.map((r) => r.iter).sort();
    expect(iters).toEqual([1, 2, 3]);
  });

  test("random helper varies inputs across iterations", async () => {
    mode = "ok";
    const randomPath = `${import.meta.dir}/../src/testFixture/random`;
    const file = await writeFixture(
      "stress/rand.crust.ts",
      `import { random } from "${randomPath}";
       const tokens = ["a", "b", "c", "d"];
       export default {
         input: {
           url: "${baseUrl}/echo-header",
           headers: () => ({ "x-token": random.choice(tokens) }),
         },
         output: { status: 200 },
       };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1, count: 8 });
    expect(report.totals.pass).toBe(8);
  });
});

describe("test-fixture cli", () => {
  test("--out report.json writes a valid JSON RunReport", async () => {
    mode = "ok";
    const file = await writeFixture(
      "cli/ok.crust.ts",
      `export default { input: { url: "${baseUrl}/users/42" }, output: { status: 200 } };\n`,
    );
    const outPath = join(dir, "report.json");
    const code = await runCli(["--target", file, "--out", outPath]);
    expect(code).toBe(0);
    const data = JSON.parse(await Bun.file(outPath).text());
    expect(data.totals.pass).toBe(1);
    expect(Array.isArray(data.results)).toBe(true);
  });

  test("empty glob match exits 2", async () => {
    const code = await runCli(["--target", `${dir}/nothing-here/*.crust.ts`]);
    expect(code).toBe(2);
  });

  test("missing --target exits 2", async () => {
    const code = await runCli([]);
    expect(code).toBe(2);
  });
});

describe("--timeout and --bail", () => {
  test("timeout turns a slow fixture into an actionable error", async () => {
    const file = await writeFixture(
      "timeout.crust.ts",
      `export default {
        name: "slow endpoint",
        input: { url: "${baseUrl}/sleep" },
        output: { status: 200 },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1, timeoutMs: 10 });
    expect(report.totals.error).toBe(1);
    expect(report.results[0]!.error?.message).toContain("timed out after 10ms");
    const ok = await runFixtures({ target: file, threads: 1, timeoutMs: 5000 });
    expect(ok.totals.pass).toBe(1);
  });

  test("bail stops scheduling after the first failure", async () => {
    mode = "wrong-status";
    const file = await writeFixture(
      "bail.crust.ts",
      `export default [
        { name: "f1", input: { url: "${baseUrl}/users/42" }, output: { status: 200 } },
        { name: "f2", input: { url: "${baseUrl}/users/42" }, output: { status: 200 } },
        { name: "f3", input: { url: "${baseUrl}/users/42" }, output: { status: 200 } },
      ];\n`,
    );
    const bailed = await runFixtures({ target: file, threads: 1, bail: true });
    expect(bailed.bailed).toBe(true);
    expect(bailed.scheduled).toBe(3);
    expect(bailed.results.length).toBeLessThan(3);
    const full = await runFixtures({ target: file, threads: 1 });
    expect(full.results.length).toBe(3);
    mode = "ok";
  });
});

describe("output.schema (reserved key)", () => {
  test("conforming response passes; violation fails with a pointer path", async () => {
    const file = await writeFixture(
      "schema-ok.crust.ts",
      `export default [
        {
          name: "conforms",
          input: { url: "${baseUrl}/users/42" },
          output: {
            status: 200,
            schema: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string", minLength: 2 } } },
          },
        },
        {
          name: "violates",
          input: { url: "${baseUrl}/users/42" },
          output: {
            status: 200,
            schema: { type: "object", required: ["missing_field"], properties: { name: { type: "string", maxLength: 3 } } },
          },
        },
      ];`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    const ok = report.results.find((r) => r.name === "conforms")!;
    const bad = report.results.find((r) => r.name === "violates")!;
    expect(ok.status).toBe("pass");
    expect(bad.status).toBe("fail");
    const paths = bad.failures.map((f) => f.path).join("\n");
    expect(paths).toContain("output.data");
    expect(bad.failures.some((f) => String(f.expected).includes("required"))).toBe(true);
    expect(bad.failures.some((f) => String(f.expected).includes("maxLength"))).toBe(true);
  });

  test("functions inside a schema object are never invoked", async () => {
    const file = await writeFixture(
      "schema-shield.crust.ts",
      `export default {
        name: "shielded",
        input: { url: "${baseUrl}/users/42" },
        output: {
          status: 200,
          schema: { type: "object", default: () => { throw new Error("schema default invoked"); } },
        },
      };`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.results[0]!.status).toBe("pass");
  });

  test("fixtures without schema behave exactly as before", async () => {
    const file = await writeFixture(
      "schema-absent.crust.ts",
      `export default {
        name: "plain",
        input: { url: "${baseUrl}/users/42" },
        output: { status: 200, data: { id: 42 } },
      };`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.results[0]!.status).toBe("pass");
  });
});
