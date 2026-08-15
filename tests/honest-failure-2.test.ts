// Round 2 of "crust must never mislead the user".
//
// Each case below was a real, reproducible defect: a CI gate that issued zero
// requests reported success; a mistyped `-t 1ms` was silently ignored so the
// request ran untimed; `sql` mid-pipeline threw away the piped item and
// returned []; `bundle --outdir --minify` created a directory literally named
// "--minify"; `procs` deleted blank lines from its children's output; and two
// globals the docs promised did not exist.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../src/builtinFns/bundle";
import { parse } from "../src/parser";
import { Pipeline } from "../src/pipeline";
import { readLines } from "../src/sources";
import { statsStage } from "../src/transforms";
import type { Context } from "../src/types";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function cli(line: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", ENTRY, "-c", line], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-r2-none",
      ...env,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: stdout + stderr, stdout };
}

const ctx = () => ({ aliases: new Map(), functions: new Map(), history: [] }) as unknown as Context;
const drain = async (line: string): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const item of parse(line)(ctx()).lines()) out.push(item);
  return out;
};

describe("a summary of nothing is not a pass", () => {
  test("a zero-request gate FAILS instead of reporting green", async () => {
    // {count: 0, p95: 0} used to satisfy `s => s.p95 < 200`.
    const r = await cli("src/*.nope | stats | assert (s => s.p95 < 200)");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/EMPTY summary/);
  });

  test("a filter that drops everything also fails the gate", async () => {
    const r = await cli("range(1,5) | filter (n => false) | stats | assert (s => s.count >= 0)");
    expect(r.code).toBe(1);
  });

  test("control: an exploratory `| stats` is still not fatal", async () => {
    const r = await cli("src/*.nope | stats");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"empty":true');
  });

  test("control: a real gate still passes", async () => {
    const r = await cli(
      "range(1,10) | (i => ({status:200, ms:i})) | stats | assert (s => s.count === 10)",
    );
    expect(r.code).toBe(0);
  });
});

describe("http stage flags are loud", () => {
  test.each([
    ["-t 1ms", /unknown flag "-t"/],
    ['-h "authorization: Bearer T"', /unknown flag "-h"/],
    ["-X POST", /unknown flag "-X"/],
  ])("a single-dash flag %s is rejected, not dropped", async (flag, pattern) => {
    const r = await cli(`GET :3000/x ${flag}`);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(pattern);
  });

  test("-H with no value is rejected rather than vanishing", async () => {
    const r = await cli("GET :3000/x -H");
    expect(r.out).toMatch(/-H requires a "Key: value" header/);
  });

  test("control: the supported flags still work", async () => {
    for (const line of [
      'GET :3000/x -H "authorization: Bearer T"',
      "GET :3000/x --timeout 2s",
      "GET :3000/x --timeout=2s",
      "GET https://ex.com/a-b/c-d?x=1",
    ]) {
      expect(() => parse(line)(ctx())).not.toThrow();
    }
  });
});

describe("sql binds the piped item", () => {
  let dir: string;
  let db: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-sql-"));
    db = `sqlite://${join(dir, "t.sqlite")}`;
    await cli('sql "CREATE TABLE t (id INTEGER, name TEXT)"', { DATABASE_URL: db });
    await cli(`sql "INSERT INTO t VALUES (1, 'alpha'), (2, 'beta')"`, { DATABASE_URL: db });
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  test("the upstream item becomes the first parameter", async () => {
    // This returned [] before: the item was dropped and the query ran unbound,
    // which reads exactly like "no rows matched".
    const r = await cli('range(2,2) | sql "SELECT name FROM t WHERE id = ?"', { DATABASE_URL: db });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("beta");
  });

  test("an explicitly declared parameter still wins", async () => {
    const r = await cli('range(2,2) | sql "SELECT name FROM t WHERE id = ?" 1', {
      DATABASE_URL: db,
    });
    expect(r.stdout).toContain("alpha");
  });

  test("rows flatten the same in both positions", async () => {
    const asSource = await cli('sql "SELECT * FROM t"', { DATABASE_URL: db });
    const midPipe = await cli('range(0,0) | sql "SELECT * FROM t"', { DATABASE_URL: db });
    // Two rows => two items, not one item that is an array.
    expect(asSource.stdout.trim().split("\n")).toHaveLength(2);
    expect(midPipe.stdout.trim().split("\n")).toHaveLength(2);
    expect(midPipe.stdout).not.toContain("[{");
  });

  test("a chained assertion sees a ROW, not an array", async () => {
    const r = await cli(
      '{"id":2} | (o => o.id) | sql "SELECT name FROM t WHERE id = ?" | assert (r => r.name === "beta")',
      { DATABASE_URL: db },
    );
    expect(r.code).toBe(0);
  });
});

describe("bundle uses the shared flag parser", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-bundle-"));
    await writeFile(join(dir, "e.ts"), "export const x = 1;\n");
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  test("--outdir refuses to swallow the next flag, and creates no directory", async () => {
    await expect(bundle(join(dir, "e.ts"), "--outdir", "--minify")).rejects.toThrow(
      /--outdir needs a value/,
    );
    expect(await readdir(process.cwd())).not.toContain("--minify");
  });

  test("an unknown flag lists the valid ones", async () => {
    await expect(bundle(join(dir, "e.ts"), "--bogus")).rejects.toThrow(/unknown argument/);
  });

  test("an invalid enum value is named", async () => {
    await expect(bundle(join(dir, "e.ts"), "--target", "bogus")).rejects.toThrow(
      /--target must be/,
    );
  });

  test("control: the documented forms still build", async () => {
    const out = (await bundle(join(dir, "e.ts"), "--outfile", join(dir, "o.js"))) as {
      outfile: string;
      bytes: number;
    };
    expect(out.bytes).toBeGreaterThan(0);
    // bare --sourcemap has always meant "linked"
    await expect(bundle(join(dir, "e.ts"), "--outdir", dir, "--sourcemap")).resolves.toBeDefined();
  });
});

describe("sources tell the truth about what they found", () => {
  test("procs keeps blank lines, like every other splitter", async () => {
    const r = await cli(`procs({p: "printf 'a\\n\\nb\\n'"}) | (l => "[" + l.line + "]")`);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toContain("[]"); // the blank line between a and b
    expect(lines).toContain("[a]");
    expect(lines).toContain("[b]");
  });

  test("a glob is sorted, so a run is reproducible", async () => {
    const r = await cli("src/mockServer/*.ts");
    const got = r.stdout.trim().split("\n");
    expect(got).toEqual([...got].sort());
  });

  test("an absolute pattern over a missing dir gets the same message as a relative one", async () => {
    const abs = await cli("read /nonexistent/deeper/*.json");
    const rel = await cli("read nonexistent/deeper/*.json");
    expect(abs.out).toMatch(/no files matched/);
    expect(rel.out).toMatch(/no files matched/);
    expect(abs.out).not.toMatch(/ENOENT/);
  });

  test("lines streams a file rather than holding it", async () => {
    // Correctness half of the streaming change; the memory half is measured
    // out-of-band (982MB -> 113MB on a 224MB log).
    const dir = await mkdtemp(join(tmpdir(), "crust-stream-"));
    const p = join(dir, "f.log");
    await writeFile(p, `${Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n")}\n`);
    expect(await readLines(p).collect()).toHaveLength(5000);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("stats percentiles stay honest under the histogram", () => {
  test("percentiles land within a bucket of the exact value, and the mean is exact", async () => {
    const n = 20000;
    const latencies = Array.from({ length: n }, (_, i) =>
      Number(((i % 400) * 0.5 + 0.2).toFixed(2)),
    );
    const sorted = [...latencies].sort((a, b) => a - b);
    const exact = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * n) - 1)]!;
    const exactMean = latencies.reduce((a, b) => a + b, 0) / n;

    // Feed the stage directly — embedding 20k samples in a lambda source would
    // measure the JS parser, not the histogram.
    async function* src() {
      for (const ms of latencies) yield { status: 200, ms };
    }
    const out: Record<string, number>[] = [];
    for await (const item of (Pipeline.of(src() as never) as unknown as Pipeline<unknown>)
      .pipe(statsStage() as never)
      .lines()) {
      out.push(item as Record<string, number>);
    }
    const s = out[out.length - 1]!;

    for (const p of [50, 95, 99] as const) {
      // Reported value is the bucket's upper bound: never faster than reality.
      expect(s[`p${p}`]!).toBeGreaterThanOrEqual(exact(p));
      expect(s[`p${p}`]! - exact(p)).toBeLessThan(1.0);
    }
    expect(Math.abs(s.meanMs! - exactMean)).toBeLessThan(0.1);
  });

  test("p99 of 100 samples is no longer just the maximum", async () => {
    // The old index was Math.floor((p/100) * n), biased high.
    const out = (await drain("range(1,100) | (i => ({status: 200, ms: i})) | stats")) as Record<
      string,
      number
    >[];
    const s = out[out.length - 1]!;
    expect(s.p99).toBeLessThan(100);
    expect(s.p99).toBeGreaterThanOrEqual(99);
  });
});
