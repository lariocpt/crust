import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pipeline } from "../src/pipeline";
import { GET, range } from "../src/sources";
import { DELETE, ExpectError, expect as expectStage, POST, parallel } from "../src/transforms";

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

  test("preserves input order in output", async () => {
    const out = await range(0, 4)
      .pipe(
        parallel(5, async (i: number) => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          return i * 2;
        }),
      )
      .collect();
    expect(out).toEqual([0, 2, 4, 6, 8]);
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
