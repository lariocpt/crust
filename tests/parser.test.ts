import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { parse } from "../src/parser";

describe("parser — sources", () => {
  test("range produces correct items", async () => {
    const p = parse("range(0, 4)")();
    expect(await p.collect()).toEqual([0, 1, 2, 3, 4]);
  });

  test("range with single space variations", async () => {
    const p = parse("range(0,3)")();
    expect(await p.collect()).toEqual([0, 1, 2, 3]);
  });

  test("shell-command source emits stdout lines", async () => {
    const p = parse("echo hello")();
    const out = await p.collect();
    expect(out).toContain("hello");
  });
});

describe("parser — transforms", () => {
  test("range + lambda doubles items", async () => {
    const p = parse("range(0, 3) | (x => x * 2)")();
    expect(await p.collect()).toEqual([0, 2, 4, 6]);
  });

  test("range + chained lambdas", async () => {
    const p = parse("range(0, 2) | (x => x + 1) | (x => x * 10)")();
    expect(await p.collect()).toEqual([10, 20, 30]);
  });

  test("shell-source + TS lambda transforms each line", async () => {
    const p = parse("echo hello | (s => s.toUpperCase())")();
    expect(await p.collect()).toEqual(["HELLO"]);
  });

  test("shell stage transforms upstream items via sh -c", async () => {
    const p = parse("echo hi | tr a-z A-Z")();
    const out = await p.collect();
    expect(out).toContain("HI");
  });
});

describe("parser — HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    baseUrl = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop());

  test("GET source emits a Response", async () => {
    const p = parse(`GET ${baseUrl}/`)();
    const out = (await p.collect()) as Response[];
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe(200);
  });
});
