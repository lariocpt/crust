// `--redirect` on http stages: follow (default), error (refuse a 3xx with a
// labelled failure), manual (yield the 3xx so `expect 301` can assert it).
// Fixtures get the same modes via `input.redirect`.
//
// Every case here was impossible before the flag: a .pipes suite had no way
// to refuse a redirect the way a native fixture's `fetch(..., {redirect:
// "error"})` does, and a typo'd mode would have reached fetch with an
// unrecognised value — a connection-shaped complaint about a transport
// decision. The honest-failure controls at the end exist so the refusal can
// never exit 0, and the default-follow cases so the new flag can't swallow
// the redirect behaviour that predates it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/lexer";
import { parse } from "../src/parser";
import { runFixtures } from "../src/testFixture/runner";
import { runPipes } from "../src/testPipes/runner";
import type { Context, StageKind } from "../src/types";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

const ctx = () => ({ aliases: new Map(), functions: new Map(), history: [] }) as unknown as Context;

// A real line through the real entry: exit code + combined output.
async function check(line: string) {
  const proc = Bun.spawn(["bun", ENTRY, "-c", line], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CRUST_CONFIG: "/dev/null" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: stdout + stderr };
}

function httpKind(line: string): Extract<StageKind, { kind: "http" }> {
  const kind = classify(line);
  if (kind.kind !== "http") throw new Error(`test setup: ${line} did not classify as http`);
  return kind;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let cwd: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/moved") {
        return new Response("moved", { status: 301, headers: { location: "/landed" } });
      }
      if (url.pathname === "/landed") {
        return Response.json({ path: "/landed" });
      }
      return new Response("{}", { status: 200 });
    },
  });
  base = `http://localhost:${server.port}`;
  cwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "crust-http-redirect-"));
  process.chdir(dir);
});

afterAll(async () => {
  server.stop(true);
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("lexer: --redirect on http stages", () => {
  test("space form parses", () => {
    expect(httpKind(`GET ${base}/moved --redirect error`).redirect).toBe("error");
  });

  test("equals form parses", () => {
    expect(httpKind(`GET ${base}/moved --redirect=manual`).redirect).toBe("manual");
  });

  test("follow parses (explicit default)", () => {
    expect(httpKind(`GET ${base}/moved --redirect follow`).redirect).toBe("follow");
  });

  test("unset stays undefined (fetch default)", () => {
    expect(httpKind(`GET ${base}/moved`).redirect).toBeUndefined();
  });

  test("composes with -H and --timeout", () => {
    const k = httpKind(
      `GET ${base}/moved -H "authorization: Bearer t" --timeout 5s --redirect manual`,
    );
    expect(k.headers).toEqual(["authorization: Bearer t"]);
    expect(k.timeoutMs).toBe(5000);
    expect(k.redirect).toBe("manual");
  });

  test("missing value is loud", () => {
    expect(() => classify(`GET ${base}/moved --redirect`)).toThrow(/--redirect requires/);
  });

  test("unknown mode is loud, not passed to fetch", () => {
    expect(() => classify(`GET ${base}/moved --redirect bogus`)).toThrow(
      /--redirect expects follow, error or manual/,
    );
  });

  test("unknown flags list --redirect now", () => {
    expect(() => classify(`GET ${base}/moved -Z`)).toThrow(/supported: -H, --timeout, --redirect/);
  });
});

describe("pipeline: redirect modes against a live 301", () => {
  test("default follows the redirect (pre-existing behaviour)", async () => {
    const out = await parse(`GET ${base}/moved | (r => r.status)`)().collect();
    expect(out).toEqual([200]);
  });

  test("--redirect manual yields the 3xx itself", async () => {
    const out = await parse(`GET ${base}/moved --redirect manual | (r => r.status)`)().collect();
    expect(out).toEqual([301]);
  });

  test("--redirect error refuses with a labelled error", async () => {
    await expect(parse(`GET ${base}/moved --redirect error`)().collect()).rejects.toThrow(
      /redirect refused \(--redirect error\)/,
    );
  });

  test("GET in transform position: the load record is marked, not a bare 0", async () => {
    const out = await parse(
      `range(1,2) | GET ${base}/moved --redirect error | (h => h.redirectRefused === true)`,
    )().collect();
    expect(out).toEqual([true, true]);
  });

  test("parallel + verb: the load record is marked, not a bare 0", async () => {
    const out = await parse(
      `range(1,2) | parallel 2 | GET ${base}/moved --redirect error | (h => h.redirectRefused === true)`,
    )().collect();
    expect(out).toEqual([true, true]);
  });

  test("manual + expect 301 asserts the redirect exists", async () => {
    const out = await parse(`GET ${base}/moved --redirect manual | expect 301`)().collect();
    expect(out.length).toBe(1);
  });
});

describe("test-pipes: --redirect end to end", () => {
  test("manual passes, error fails with the labelled message", async () => {
    await writeFile(
      join(dir, "redir.setup.ts"),
      `export default function () { process.env.BASE = "${base}"; }\n`,
    );
    await writeFile(
      join(dir, "redir.pipes"),
      `# manual can assert the 3xx exists\nGET $BASE/moved --redirect manual | expect 301\n# error refuses it — the line must fail, not follow\nGET $BASE/moved --redirect error\n`,
    );
    const report = await runPipes({ target: join(dir, "redir.pipes") });
    expect(report.totals).toEqual({ pass: 1, fail: 1, files: 1 });
    expect(report.results[0]!.status).toBe("pass");
    expect(report.results[1]!.status).toBe("fail");
    expect(report.results[1]!.error).toContain("redirect refused (--redirect error)");
  });
});

describe("test-fixture: input.redirect", () => {
  test("manual records the 3xx status", async () => {
    const file = join(dir, "manual.crust.ts");
    await writeFile(
      file,
      `export default {
        name: "manual sees the 3xx",
        input: { url: "${base}/moved", redirect: "manual" },
        output: { status: 301 },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.totals.fail).toBe(0);
    expect(report.results[0]!.status).toBe("pass");
  });

  test("error refuses with the field named", async () => {
    const file = join(dir, "refused.crust.ts");
    await writeFile(
      file,
      `export default {
        name: "error refuses the 3xx",
        input: { url: "${base}/moved", redirect: "error" },
        output: { status: 200 },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.results[0]!.status).toBe("error");
    expect(report.results[0]!.error?.message).toContain(
      'redirect refused (input.redirect: "error")',
    );
  });

  test("an unknown mode is a fixture error, not a fetch mystery", async () => {
    const file = join(dir, "badmode.crust.ts");
    await writeFile(
      file,
      `export default {
        name: "bogus mode",
        input: { url: "${base}/moved", redirect: "bogus" },
        output: { status: 200 },
      };\n`,
    );
    const report = await runFixtures({ target: file, threads: 1 });
    expect(report.results[0]!.status).toBe("error");
    expect(report.results[0]!.error?.message).toContain(
      "fixture input.redirect: expected follow, error or manual",
    );
  });
});

describe("honest failure: a refused redirect never exits 0", () => {
  test("--redirect error fails the line (default-follow control passes)", async () => {
    const refused = await check(`GET ${base}/moved --redirect error | (r => r.status)`);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("redirect refused (--redirect error)");

    const followed = await check(`GET ${base}/moved | (r => r.status)`);
    expect(followed.code).toBe(0);
    expect(followed.out).toContain("200");
  });
});
