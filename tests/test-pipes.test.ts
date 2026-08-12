import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipes } from "../src/testPipes/runner";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let cwd: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/auth") {
        const ok = req.headers.get("authorization") === "Bearer pipes-secret";
        return new Response("{}", { status: ok ? 201 : 401 });
      }
      if (url.pathname === "/slow") {
        await new Promise((r) => setTimeout(r, 300));
        return new Response("{}", { status: 200 });
      }
      if (url.pathname === "/items" && req.method === "POST") {
        return Response.json({ item: { id: "itm-42" } }, { status: 201 });
      }
      if (url.pathname.startsWith("/items/")) {
        const found = url.pathname === "/items/itm-42";
        return new Response("{}", { status: found ? 200 : 404 });
      }
      return new Response("{}", { status: 200 });
    },
  });
  base = `http://localhost:${server.port}`;
  cwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "crust-pipes-"));
  process.chdir(dir);
});

afterAll(async () => {
  server.stop();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("test-pipes runner", () => {
  test("passes, fails, skips comments/blanks; per-line results", async () => {
    await writeFile(
      join(dir, "mix.pipes"),
      `# a comment\n\n{"a":1} | POST ${base}/ok | expect 200\n{"c":2} | assert (r => r.c === 1)\n`,
    );
    const report = await runPipes({ target: join(dir, "mix.pipes") });
    expect(report.totals).toEqual({ pass: 1, fail: 1, files: 1 });
    expect(report.results[0]!.lineNo).toBe(3);
    expect(report.results[1]!.status).toBe("fail");
    expect(report.results[1]!.error).toContain("assert");
  });

  test("sibling setup module seeds env for $VAR interpolation", async () => {
    await writeFile(
      join(dir, "auth.setup.ts"),
      `export default function () { process.env.PIPES_T = "pipes-secret"; }\n`,
    );
    await writeFile(
      join(dir, "auth.pipes"),
      `{"x":1} | POST ${base}/auth -H "authorization: Bearer $PIPES_T" | expect 201\n`,
    );
    const report = await runPipes({ target: join(dir, "auth.pipes") });
    expect(report.totals.fail).toBe(0);
    expect(report.totals.pass).toBe(1);
  });

  test("--bail stops at the first failure", async () => {
    await writeFile(
      join(dir, "bail.pipes"),
      `{"c":2} | assert (r => r.c === 1)\n{"c":1} | assert (r => r.c === 1)\n`,
    );
    const report = await runPipes({ target: join(dir, "bail.pipes"), bail: true });
    expect(report.bailed).toBe(true);
    expect(report.results.length).toBe(1);
  });

  test("--timeout fails a slow line", async () => {
    await writeFile(join(dir, "slow.pipes"), `{"x":1} | POST ${base}/slow | expect 200\n`);
    const report = await runPipes({
      target: join(dir, "slow.pipes"),
      timeoutMs: 50,
    });
    expect(report.totals.fail).toBe(1);
    expect(report.results[0]!.error).toContain("timed out after 50ms");
  });

  test("capture chains a POSTed id into the next line", async () => {
    await writeFile(
      join(dir, "chain.pipes"),
      [
        `{"name":"x"} | POST ${base}/items | assert (r => r.status === 201) | (r => r.json()) | capture PIPES_ITEM (j => j.item.id)`,
        `GET ${base}/items/$PIPES_ITEM | expect 200`,
        "",
      ].join("\n"),
    );
    const report = await runPipes({ target: join(dir, "chain.pipes") });
    expect(report.totals).toEqual({ pass: 2, fail: 0, files: 1 });
    // Hermeticity: the capture must not leak out of the run.
    expect(process.env.PIPES_ITEM).toBeUndefined();
  });

  test("env is restored per file — captures and setup vars do not cross", async () => {
    const sub = join(dir, "isolation");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "a-cap.pipes"),
      `{"v":"hello"} | capture PIPES_LEAK (r => r.v) | assert (r => r.v === "hello")\n`,
    );
    // $PIPES_LEAK expands to "" here if (and only if) file A's capture was rolled back.
    await writeFile(join(sub, "b-iso.pipes"), `{"v":"$PIPES_LEAK"} | assert (r => r.v === "")\n`);
    const report = await runPipes({ target: `${sub}/*.pipes` });
    expect(report.totals).toEqual({ pass: 2, fail: 0, files: 2 });
    expect(process.env.PIPES_LEAK).toBeUndefined();
  });

  test("glob target picks up only .pipes files", async () => {
    const sub = join(dir, "globonly");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "g1.pipes"), `{"a":1} | assert (r => r.a === 1)\n`);
    await writeFile(join(sub, "g2.pipes"), `{"b":1} | assert (r => r.b === 1)\n`);
    await writeFile(join(sub, "not-me.txt"), `{"x":0} | assert (r => r.x === 1)\n`);
    const report = await runPipes({ target: `${sub}/*` });
    expect(report.totals.files).toBe(2);
    expect(report.totals.fail).toBe(0);
  });
});
