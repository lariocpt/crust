import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline";
import { dest, stats, write } from "../src/sinks";

describe("write", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-write-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes each item as a line", async () => {
    const path = join(dir, "out.txt");
    await Pipeline.of(["a", "b", "c"]).to(write(path));
    const text = await readFile(path, "utf8");
    expect(text).toBe("a\nb\nc\n");
  });

  test("creates parent directories", async () => {
    const path = join(dir, "nested/dir/out.txt");
    await Pipeline.of(["x"]).to(write(path));
    expect(await readFile(path, "utf8")).toBe("x\n");
  });
});

describe("dest", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-dest-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes vinyl-like items to dir keyed by basename", async () => {
    await Pipeline.of([
      { path: "a.txt", contents: "alpha" },
      { path: "subdir/b.txt", contents: "bravo" },
    ]).to(dest(dir));
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["a.txt", "b.txt"]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("bravo");
  });
});

describe("stats", () => {
  test("returns count and status histogram", async () => {
    const responses = [
      new Response("a", { status: 200 }),
      new Response("b", { status: 200 }),
      new Response("c", { status: 404 }),
    ];
    const s = await Pipeline.of(responses).to(stats());
    expect(s.count).toBe(3);
    expect(s.status).toEqual({ 200: 2, 404: 1 });
  });

  test("includes timing percentiles", async () => {
    const s = await Pipeline.of([new Response("ok", { status: 200 })]).to(stats());
    expect(typeof s.p50).toBe("number");
    expect(typeof s.p95).toBe("number");
    expect(typeof s.p99).toBe("number");
    expect(typeof s.durationMs).toBe("number");
  });

  test("empty pipeline produces zero stats", async () => {
    const s = await Pipeline.of<Response>([]).to(stats());
    expect(s.count).toBe(0);
    expect(s.status).toEqual({});
  });
});
