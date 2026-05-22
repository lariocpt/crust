import { test, expect, describe } from "bun:test";
import { Pipeline } from "../src/pipeline";
import { range, glob, read, GET } from "../src/sources";

describe("range", () => {
  test("inclusive integer range", async () => {
    expect(await range(0, 4).collect()).toEqual([0, 1, 2, 3, 4]);
  });

  test("single-item range", async () => {
    expect(await range(7, 7).collect()).toEqual([7]);
  });

  test("empty when start > end", async () => {
    expect(await range(5, 3).collect()).toEqual([]);
  });

  test("returns a Pipeline (so it composes)", () => {
    expect(range(0, 4)).toBeInstanceOf(Pipeline);
  });
});

describe("glob", () => {
  test("matches files in the test directory", async () => {
    const files = await glob("tests/*.test.ts").collect();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true);
  });

  test("supports ** double-star", async () => {
    const files = await glob("src/**/*.ts").collect();
    expect(files.length).toBeGreaterThan(0);
  });

  test("empty pipeline on zero matches", async () => {
    expect(await glob("nonexistent-dir/*.zzz").collect()).toEqual([]);
  });
});

describe("read", () => {
  test("reads a file as concatenated text", async () => {
    const text = await read("package.json").text();
    expect(text).toContain('"name": "crust"');
  });

  test("read.json parses", async () => {
    const json = await read("package.json").json<{ name: string }>();
    expect(json.name).toBe("crust");
  });
});

describe("GET", () => {
  test("emits a single Response item", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    try {
      const responses = await GET(`http://localhost:${server.port}/`).collect();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(await responses[0]!.text()).toBe("ok");
    } finally {
      server.stop();
    }
  });
});
