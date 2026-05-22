import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtures } from "../src/testFixture/runner";
import { runCli } from "../src/testFixture/cli";

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
        return new Response(
          JSON.stringify({ token: req.headers.get("x-token") }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
