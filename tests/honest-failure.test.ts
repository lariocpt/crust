// crust must never report a false pass.
//
// Every case here failed before the honest-failure work: a throwing lambda
// under `parallel` was dropped and the run exited 0; a shell stage that failed
// mid-pipeline was discarded and the run exited 0; a quoted `&` in an `export`
// value silently set nothing; and a misspelled fixture `output` key PASSED.
// The controls matter as much as the failures — a fix that makes everything
// fail is not a fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-honest-test-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

const line = (l: string) => runCli(["-c", l]);

describe("parallel propagates worker failures", () => {
  test("every item throwing fails the line, not exit 0", async () => {
    const r = await line('range(0,4) | parallel 2 | (x => { throw new Error("boom") })');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom");
  });

  test("one item throwing fails the line and does not silently drop it", async () => {
    const r = await line(
      'range(0,4) | parallel 2 | (x => { if (x === 2) throw new Error("boom"); return x })',
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom");
  });

  test("results that already settled are still emitted before the failure", async () => {
    // Mirrors the non-parallel path, where `range | (x => throw at 3)` prints
    // 0,1,2 and then fails.
    const r = await line(
      'range(0,4) | parallel 1 | (x => { if (x === 3) throw new Error("boom"); return x })',
    );
    expect(r.code).toBe(1);
    expect(r.stdout.trim().split("\n")).toEqual(["0", "1", "2"]);
  });

  test("control: a clean parallel stage still passes every item through", async () => {
    const r = await line("range(0,4) | parallel 2 | (x => x)");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").sort()).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("control: a downstream that stops early is not a failure", async () => {
    const r = await line("range(0,100) | parallel 4 | (x => x) | head -3");
    expect(r.code).toBe(0);
  });
});

describe("shell stages propagate exit codes", () => {
  test("a missing command mid-pipeline exits 127, like the pure-shell line", async () => {
    expect((await line("range(0,3) | nosuchcmd_xyz_zz")).code).toBe(127);
    expect((await line("nosuchcmd_xyz_zz")).code).toBe(127);
  });

  test("a failing command mid-pipeline exits 1", async () => {
    expect((await line("range(0,3) | false")).code).toBe(1);
  });

  test("the child's own code is preserved, not flattened to 1", async () => {
    expect((await line('range(0,3) | sh -c "exit 3"')).code).toBe(3);
  });

  test("a shell stage as the SOURCE propagates too", async () => {
    expect((await line("nosuchcmd_xyz_zz | (n => n)")).code).toBe(127);
  });

  test("sh's own diagnostic is not doubled with a crust: prefix", async () => {
    const r = await line("range(0,3) | nosuchcmd_xyz_zz");
    expect(r.stderr).toContain("not found");
    expect(r.stderr).not.toContain("crust: shell stage exited");
  });

  test("control: `| head -N` closing the pipe early stays exit 0", async () => {
    // head exits 0 after N lines; propagation must not break the idiom.
    const r = await line("range(0,100) | head -3");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["0", "1", "2"]);
  });

  test("control: native grep matching nothing is a filter, not an error", async () => {
    // In-process grep is a stream stage with no exit code of its own, unlike
    // grep(1) which exits 1 on no match.
    const r = await line("range(0,10) | grep 99");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("control: successful shell stages stay exit 0", async () => {
    expect((await line("range(1,2) | wc -l")).code).toBe(0);
    expect((await line("range(0,10) | grep 5")).code).toBe(0);
  });
});

describe("builtin dispatch is quote-aware", () => {
  test("export keeps a value containing & — the shape of every connection string", async () => {
    const r = await line(
      ["export V='postgres://u:p@h/db?sslmode=require&pool=5'", 'echo "[$V]"'].join("\n"),
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("[postgres://u:p@h/db?sslmode=require&pool=5]");
  });

  test.each([";", "<", ">", "|"])("export keeps a quoted %s in its value", async (ch) => {
    const r = await line([`export V='a${ch}b'`, 'echo "[$V]"'].join("\n"));
    expect(r.stdout.trim()).toBe(`[a${ch}b]`);
  });

  test("an alias whose value is a whole pipeline is actually defined", async () => {
    const r = await line(["alias two='range(1,2) | (n => n * 2)'", "alias"].join("\n"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alias two='range(1,2) | (n => n * 2)'");
  });

  test("control: an UNQUOTED metacharacter still routes the line to sh", async () => {
    const r = await line("export V=a; echo after-semicolon");
    expect(r.stdout).toContain("after-semicolon");
  });
});

describe("fixture output keys", () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "up" }) });
    port = server.port ?? 0;
    dir = await mkdtemp(join(tmpdir(), "crust-honest-"));
  });
  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  const fixture = async (name: string, output: string): Promise<string> => {
    const p = join(dir, `${name}.crust.ts`);
    await writeFile(
      p,
      `export default { input: { method: "GET", url: "http://localhost:${port}/health" },\n` +
        `  output: ${output} };\n`,
    );
    return p;
  };

  test("a misspelled output key is an error, not a pass", async () => {
    const p = await fixture("typo", "{ status: 200, dta: (d) => true }");
    const r = await line(`test-fixture --target '${p}'`);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('output.dta: unknown key — did you mean "data"?');
    expect(r.stdout).not.toContain("1 pass");
  });

  test("output.body points at output.data — the request/response slip", async () => {
    const p = await fixture("body", "{ status: 200, body: (b) => true }");
    const r = await line(`test-fixture --target '${p}'`);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('the response body is "data"');
  });

  test("a matcher that throws is reported as thrown, not as a mismatch", async () => {
    const p = await fixture("threw", "{ status: 200, data: (d) => d.nope.deeper === 1 }");
    const r = await line(`test-fixture --target '${p}'`);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("<predicate threw:");
  });

  test("control: a correct fixture still passes", async () => {
    const p = await fixture("good", '{ status: 200, data: (d) => d.status === "up" }');
    const r = await line(`test-fixture --target '${p}'`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 pass");
  });
});
