import { test, expect, describe } from "bun:test";
import { Pipeline } from "../src/pipeline";

describe("Pipeline.of — construction", () => {
  test("accepts an array", async () => {
    const p = Pipeline.of([1, 2, 3]);
    expect(await p.collect()).toEqual([1, 2, 3]);
  });

  test("accepts an async iterable", async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    expect(await Pipeline.of(gen()).collect()).toEqual([1, 2, 3]);
  });

  test("empty array yields empty pipeline", async () => {
    expect(await Pipeline.of<number>([]).collect()).toEqual([]);
  });
});

describe("Pipeline.pipe — TS lambda stages", () => {
  test("single lambda transforms items", async () => {
    const out = await Pipeline.of([1, 2, 3])
      .pipe((x) => x * 2)
      .collect();
    expect(out).toEqual([2, 4, 6]);
  });

  test("chained lambdas compose", async () => {
    const out = await Pipeline.of([1, 2, 3])
      .pipe((x) => x * 2)
      .pipe((x) => x + 1)
      .collect();
    expect(out).toEqual([3, 5, 7]);
  });

  test("async lambda is awaited per item", async () => {
    const out = await Pipeline.of([1, 2, 3])
      .pipe(async (x) => x * 10)
      .collect();
    expect(out).toEqual([10, 20, 30]);
  });
});

describe("Pipeline.map / filter / reduce", () => {
  test("map", async () => {
    expect(await Pipeline.of([1, 2, 3]).map((x) => x * 2).collect()).toEqual([2, 4, 6]);
  });

  test("filter", async () => {
    expect(
      await Pipeline.of([1, 2, 3, 4]).filter((x) => x % 2 === 0).collect(),
    ).toEqual([2, 4]);
  });

  test("reduce", async () => {
    expect(await Pipeline.of([1, 2, 3]).reduce((a, b) => a + b, 0)).toBe(6);
  });
});

describe("Pipeline — terminal ops", () => {
  test("text() joins string items with newlines", async () => {
    expect(await Pipeline.of(["a", "b", "c"]).text()).toBe("a\nb\nc");
  });

  test("lines() yields each item", async () => {
    const out: string[] = [];
    for await (const line of Pipeline.of(["a", "b"]).lines()) {
      out.push(line);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("json() parses concatenated stream", async () => {
    expect(await Pipeline.of(['{"x":1}']).json()).toEqual({ x: 1 });
  });
});

describe("Pipeline — laziness", () => {
  test("map fn is not called until a terminal op runs", async () => {
    let called = 0;
    const p = Pipeline.of([1, 2, 3]).map((x) => {
      called++;
      return x;
    });
    expect(called).toBe(0);
    await p.collect();
    expect(called).toBe(3);
  });
});
