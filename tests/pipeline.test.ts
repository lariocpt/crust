import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(
      await Pipeline.of([1, 2, 3])
        .map((x) => x * 2)
        .collect(),
    ).toEqual([2, 4, 6]);
  });

  test("filter", async () => {
    expect(
      await Pipeline.of([1, 2, 3, 4])
        .filter((x) => x % 2 === 0)
        .collect(),
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
    expect(await Pipeline.of(['{"x":1}']).json<{ x: number }>()).toEqual({ x: 1 });
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

describe("load pipeline stages", () => {
  test("range | parallel | GET | expect | stats end-to-end", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    try {
      const { runLine } = await import("../src/runLine");
      const { parse } = await import("../src/parser");
      const pipeline = parse(
        `range(0, 49) | parallel 10 | GET http://localhost:${server.port}/x | expect 200 | stats`,
      )();
      const out: unknown[] = [];
      for await (const item of pipeline.lines()) out.push(item);
      expect(out.length).toBe(1);
      const s = out[0] as { count: number; status: Record<string, number>; p50: number };
      expect(s.count).toBe(50);
      expect(s.status["200"]).toBe(50);
      expect(s.p50).toBeGreaterThan(0);
      void runLine;
    } finally {
      server.stop();
    }
  });

  test("load | parallel | GET | expect | stats end-to-end", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    try {
      const { parse } = await import("../src/parser");
      const p = parse(
        `load 150ms 60/s | parallel 8 | GET http://localhost:${server.port}/x | expect 200 | stats`,
      )();
      const out: unknown[] = [];
      for await (const item of p.lines()) out.push(item);
      expect(out).toHaveLength(1);
      const s = out[0] as { count: number; status: Record<string, number>; p50: number };
      expect(s.count).toBeGreaterThanOrEqual(4);
      expect(s.count).toBeLessThanOrEqual(12);
      expect(s.status["200"]).toBe(s.count);
      expect(s.p50).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });

  test("parallel N | POST yields timing records — percentiles are real", async () => {
    const server = Bun.serve({
      port: 0,
      // Measurable latency: sub-0.05ms localhost responses round p50 to 0.0
      // via toFixed(1), which made this flake on fast machines.
      fetch: async () => {
        await Bun.sleep(2);
        return new Response("{}", { status: 201 });
      },
    });
    try {
      const { parse } = await import("../src/parser");
      const p = parse(
        `range(0, 9) | parallel 2 | POST http://localhost:${server.port}/x | expect 201 | stats`,
      )();
      const out: unknown[] = [];
      for await (const item of p.lines()) out.push(item);
      const s = out[0] as { count: number; p50: number };
      expect(s.count).toBe(10);
      expect(s.p50).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });

  test("stats | assert gates thresholds; --out artifact survives a failing gate", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    const dir = await mkdtemp(join(tmpdir(), "crust-stats-"));
    try {
      const { parse } = await import("../src/parser");
      const base = `http://localhost:${server.port}/x`;

      const okFile = join(dir, "run.json");
      const ok = parse(
        `range(0, 4) | GET ${base} | stats --out ${okFile} | assert (s => s.p95 < 10000) | assert (s => s.count === 5)`,
      )();
      const items: unknown[] = [];
      for await (const it of ok.lines()) items.push(it);
      expect(items).toHaveLength(1);
      const doc = (await Bun.file(okFile).json()) as {
        crustStats: number;
        urls: string[];
        summary: { count: number; p95: number };
      };
      expect(doc.crustStats).toBe(1);
      expect(doc.summary.count).toBe(5);
      expect(doc.urls).toEqual([base]);

      const failFile = join(dir, "fail.json");
      const bad = parse(
        `range(0, 4) | GET ${base} | stats --out ${failFile} | assert (s => s.p95 < 0)`,
      )();
      let msg = "";
      try {
        for await (const _ of bad.lines()) {
          // drain
        }
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain("assert: item 1 failed (s => s.p95 < 0)");
      expect(await Bun.file(failFile).exists()).toBe(true);

      // A WINDOW-level gate abandons statsStage mid-stream — the artifact
      // must still exist (cumulative-so-far summary).
      const winFile = join(dir, "win.json");
      const winGate = parse(
        `load 300ms 40/s | (t => ({status: 200, ms: 1})) | stats --every 1 --out ${winFile} | assert (s => !s.window || s.p50 < 0)`,
      )();
      let winMsg = "";
      try {
        for await (const _ of winGate.lines()) {
          // drain
        }
      } catch (err) {
        winMsg = (err as Error).message;
      }
      // The trailing partial window trips the gate before the final summary.
      expect(winMsg).toContain("assert");
      expect(await Bun.file(winFile).exists()).toBe(true);
      const winDoc = (await Bun.file(winFile).json()) as { crustStats: number };
      expect(winDoc.crustStats).toBe(1);

      // Async baseline predicate: the mechanized ">2x p95 is a finding" gate.
      const gate = parse(
        `range(0, 4) | GET ${base} | stats | assert (async s => { const b = await Bun.file("${okFile}").json(); return s.p95 < 2000 * (b.summary.p95 + 1) })`,
      )();
      const gated: unknown[] = [];
      for await (const it of gate.lines()) gated.push(it);
      expect(gated).toHaveLength(1);
    } finally {
      server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("expect fails the pipeline on status mismatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 503 }),
    });
    try {
      const { parse } = await import("../src/parser");
      const pipeline = parse(`range(0, 4) | GET http://localhost:${server.port}/x | expect 200`)();
      let threw = "";
      try {
        for await (const _ of pipeline.lines()) {
          // drain
        }
      } catch (err) {
        threw = (err as Error).message;
      }
      expect(threw).toContain("expect 200");
      expect(threw).toContain("5/5");
    } finally {
      server.stop();
    }
  });
});
