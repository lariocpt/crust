import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Pipeline } from "../src/pipeline";
import { GET, range } from "../src/sources";
import {
  captureEnv,
  DELETE,
  ExpectError,
  expect as expectStage,
  expectStatus,
  POST,
  parallel,
  statsStage,
  timedHttpItem,
} from "../src/transforms";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/users" && req.method === "POST") {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      if (url.pathname === "/echo" && req.method === "POST") {
        return new Response(await req.text(), { status: 200 });
      }
      if (url.pathname.startsWith("/users/") && req.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop());

describe("POST", () => {
  test("posts each upstream string as text body", async () => {
    const responses = await Pipeline.of(["a", "b", "c"])
      .pipe(POST(`${baseUrl}/echo`))
      .collect();
    expect(responses).toHaveLength(3);
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(texts).toEqual(["a", "b", "c"]);
  });

  test("posts each upstream object as JSON body", async () => {
    const responses = await Pipeline.of([{ a: 1 }, { a: 2 }])
      .pipe(POST(`${baseUrl}/users`))
      .collect();
    expect(responses.every((r) => r.status === 201)).toBe(true);
  });
});

describe("DELETE", () => {
  test("issues DELETE per upstream item", async () => {
    const responses = await range(1, 3)
      .map((i) => i) // pretend ids
      .pipe(DELETE(`${baseUrl}/users/:id`))
      .collect();
    expect(responses.every((r) => r.status === 204)).toBe(true);
  });
});

describe("expect", () => {
  test("passes when all responses match exact status", async () => {
    const out = await GET(`${baseUrl}/health`).pipe(expectStage<Response>(200)).collect();
    expect(out).toHaveLength(1);
  });

  test("rejects on status mismatch", async () => {
    const p = GET(`${baseUrl}/nonexistent`).pipe(expectStage<Response>(200)).collect();
    await expect(p).rejects.toBeInstanceOf(ExpectError);
  });

  test("supports 2xx shorthand", async () => {
    const out = await GET(`${baseUrl}/health`).pipe(expectStage<Response>("2xx")).collect();
    expect(out).toHaveLength(1);
  });

  test("supports predicate matcher", async () => {
    const out = await GET(`${baseUrl}/health`)
      .pipe(expectStage<Response>((r) => r.status < 300))
      .collect();
    expect(out).toHaveLength(1);
  });

  test("predicate failure reports failing index", async () => {
    try {
      await Pipeline.of([1, 2, 3])
        .pipe(expectStage<number>((n) => n !== 2))
        .collect();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpectError);
      expect((err as ExpectError<number>).index).toBe(1);
      expect((err as ExpectError<number>).item).toBe(2);
    }
  });
});

describe("parallel", () => {
  test("runs N workers concurrently — wall time < serial", async () => {
    const start = Date.now();
    await range(0, 9)
      .pipe(
        parallel(10, async (i: number) => {
          await new Promise((r) => setTimeout(r, 100));
          return i;
        }),
      )
      .collect();
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("streams every result in completion order", async () => {
    // Deliberate contract since the windowed-stats work: results surface the
    // moment they settle (order NOT preserved) so downstream stages see a
    // live stream, not an end-of-run dump.
    const out = await range(0, 4)
      .pipe(
        parallel(5, async (i: number) => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return i * 2;
        }),
      )
      .collect();
    expect([...out].sort((a, b) => (a as number) - (b as number))).toEqual([0, 2, 4, 6, 8]);
  });

  test("respects concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await range(0, 19)
      .pipe(
        parallel(3, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
        }),
      )
      .collect();
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("expectStatus", () => {
  test("class matcher passes any status in the class", async () => {
    const out = await Pipeline.of([{ status: 201 }, { status: 299 }])
      .pipe(expectStatus("2xx"))
      .collect();
    expect(out).toHaveLength(2);
  });

  test("class matcher fails at drain with mismatch counts", async () => {
    const p = Pipeline.of([{ status: 201 }, { status: 404 }])
      .pipe(expectStatus("2xx"))
      .collect();
    await expect(p).rejects.toThrow("expect 2xx: 1/2 responses did not match");
  });

  test("exact matcher unchanged", async () => {
    const p = Pipeline.of([{ status: 200 }, { status: 201 }])
      .pipe(expectStatus(200))
      .collect();
    await expect(p).rejects.toThrow("expect 200: 1/2 responses did not match");
  });

  test("bad matcher string throws at build time", () => {
    expect(() => expectStatus("20x")).toThrow("bad matcher");
  });
});

describe("captureEnv", () => {
  afterEach(() => {
    delete process.env.CAP_T;
  });

  test("captures via lambda, last item wins, passes items through", async () => {
    const out = await Pipeline.of([{ id: "a" }, { id: "b" }])
      .pipe(captureEnv("CAP_T", (x: { id: string }) => x.id))
      .collect();
    expect(out).toEqual([{ id: "a" }, { id: "b" }]);
    expect(process.env.CAP_T).toBe("b");
  });

  test("no lambda captures the item; non-strings JSON-stringified", async () => {
    await Pipeline.of(["plain"]).pipe(captureEnv("CAP_T")).collect();
    expect(process.env.CAP_T).toBe("plain");
    await Pipeline.of([{ a: 1 }])
      .pipe(captureEnv("CAP_T"))
      .collect();
    expect(process.env.CAP_T).toBe('{"a":1}');
    await Pipeline.of([42]).pipe(captureEnv("CAP_T")).collect();
    expect(process.env.CAP_T).toBe("42");
  });

  test("awaits async capture lambdas", async () => {
    await Pipeline.of([{ id: "z" }])
      .pipe(captureEnv("CAP_T", async (x: { id: string }) => x.id))
      .collect();
    expect(process.env.CAP_T).toBe("z");
  });

  test("nullish captured value throws naming the source", async () => {
    const p = Pipeline.of([{ id: "a" }])
      .pipe(captureEnv("CAP_T", (x: { idd?: string }) => x.idd, "(x => x.idd)"))
      .collect();
    await expect(p).rejects.toThrow("capture CAP_T: got undefined from (x => x.idd) — item 1");
  });

  test("empty upstream throws", async () => {
    const p = Pipeline.of([]).pipe(captureEnv("CAP_T")).collect();
    await expect(p).rejects.toThrow("capture CAP_T: no items reached capture — upstream was empty");
  });
});

describe("timedHttpItem", () => {
  test("times a POST with the item as JSON body", async () => {
    const hit = await timedHttpItem("POST", `${baseUrl}/users`)({ name: "x" });
    expect(hit.status).toBe(201);
    expect(hit.ms).toBeGreaterThan(0);
    expect(hit.url).toBe(`${baseUrl}/users`);
  });

  test("network error yields a status-0 record instead of throwing", async () => {
    const hit = await timedHttpItem("POST", "http://127.0.0.1:1/x")({ a: 1 });
    expect(hit.status).toBe(0);
    expect(hit.ms).toBeGreaterThan(0);
  });
});

describe("statsStage windows", () => {
  test("yields window objects then a {final: true} cumulative summary", async () => {
    const src = Pipeline.of(
      (async function* () {
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(20);
          yield { status: 200, ms: 5 };
        }
      })(),
    );
    const out = await src.pipe(statsStage(0.05)).collect();
    const windows = out.filter((o) => typeof (o as { window?: number }).window === "number");
    const finals = out.filter((o) => (o as { final?: boolean }).final === true);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(finals).toHaveLength(1);
    expect((finals[0] as { count: number }).count).toBe(6);
  });

  test("--out rejects non-json extensions at build time", () => {
    expect(() => statsStage(undefined, "results.txt")).toThrow("only .json is supported");
  });
});

describe("parallel with a paced source", () => {
  test("streams completions during pacing gaps instead of buffering to the end", async () => {
    // Source: 6 items, one every 30ms (~180ms total). fn completes in ~1ms.
    // Broken behavior buffers everything until the source drains; fixed
    // behavior yields each result well before the source is done.
    const paced = Pipeline.of(
      (async function* () {
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(30);
          yield i;
        }
      })(),
    );
    const t0 = performance.now();
    const arrivals: number[] = [];
    for await (const _ of paced.pipe(parallel(4, async (x: number) => x)).lines()) {
      arrivals.push(performance.now() - t0);
    }
    expect(arrivals).toHaveLength(6);
    // The third result must arrive while the source still has items left
    // (< 150ms), not in a final dump after ~180ms.
    expect(arrivals[2]!).toBeLessThan(150);
  });
});
