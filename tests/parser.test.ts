import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

  test("objects reach shell stages as JSON lines, not [object Object]", async () => {
    const p = parse('{"a": 1} | cat')();
    expect(await p.collect()).toEqual(['{"a":1}']);
  });
});

describe("parser — registered functions (crust.fn)", () => {
  test("dispatches a registered function as a per-item transform", async () => {
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...args: unknown[]) => unknown>([
        ["upper", (s: unknown) => String(s).toUpperCase()],
      ]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("echo hello | upper")(ctx).collect();
    expect(out).toContain("HELLO");
  });

  test("passes static args after the function name", async () => {
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...args: unknown[]) => unknown>([
        ["wrap", (item: unknown, prefix: unknown, suffix: unknown) => `${prefix}${item}${suffix}`],
      ]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("echo hi | wrap [ ]")(ctx).collect();
    expect(out).toContain("[hi]");
  });

  test("registered name takes precedence over shell command name", async () => {
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...args: unknown[]) => unknown>([
        ["echo", (s: unknown) => `[fn] ${s}`],
      ]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("range(0, 1) | echo")(ctx).collect();
    expect(out).toEqual(["[fn] 0", "[fn] 1"]);
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
