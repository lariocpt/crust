import { describe, expect, test } from "bun:test";
import { base64 } from "../src/builtinFns/base64";
import { jwt } from "../src/builtinFns/jwt";
import { salt } from "../src/builtinFns/salt";
import { wait } from "../src/builtinFns/wait";
import { parseDuration } from "../src/readiness";
import { random } from "../src/testFixture/random";

describe("base64", () => {
  test("encodes a plain string", () => {
    expect(base64("hello")).toBe("aGVsbG8=");
  });

  test("decodes with -d flag", () => {
    expect(base64("aGVsbG8=", "-d")).toBe("hello");
  });

  test("decodes with 'decode' subcommand", () => {
    expect(base64("decode", "aGVsbG8=")).toBe("hello");
  });

  test("round-trips utf8", () => {
    const s = "héllo · 世界";
    expect(base64(base64(s), "-d")).toBe(s);
  });

  test("throws on missing input", () => {
    expect(() => base64()).toThrow();
  });
});

describe("salt", () => {
  test("default 16 bytes hex", () => {
    const s = salt();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  test("custom byte count", () => {
    expect(salt("8")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("base64 encoding", () => {
    expect(salt("16", "base64")).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("two salts differ (overwhelmingly)", () => {
    expect(salt()).not.toBe(salt());
  });

  test("rejects non-positive byte count", () => {
    expect(() => salt("0")).toThrow();
    expect(() => salt("-4")).toThrow();
  });
});

describe("jwt", () => {
  test("sign + verify round-trip", () => {
    const token = jwt("sign", '{"sub":"42","role":"admin"}', "--secret", "k") as string;
    expect(token.split(".")).toHaveLength(3);
    const payload = jwt("verify", token, "--secret", "k") as { sub: string; role: string };
    expect(payload.sub).toBe("42");
    expect(payload.role).toBe("admin");
  });

  test("decode without secret", () => {
    const token = jwt("sign", { a: 1 }, "--secret", "k") as string;
    const payload = jwt("decode", token) as { a: number };
    expect(payload.a).toBe(1);
  });

  test("verify rejects tampered token", () => {
    const token = jwt("sign", { a: 1 }, "--secret", "k") as string;
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "b" : "a") + token.slice(-1);
    expect(() => jwt("verify", tampered, "--secret", "k")).toThrow(/signature/);
  });

  test("verify rejects wrong secret", () => {
    const token = jwt("sign", { a: 1 }, "--secret", "right") as string;
    expect(() => jwt("verify", token, "--secret", "wrong")).toThrow();
  });

  test("uses $JWT_SECRET when no --secret given", () => {
    process.env.JWT_SECRET = "env-secret";
    try {
      const token = jwt("sign", { a: 1 }) as string;
      const payload = jwt("verify", token) as { a: number };
      expect(payload.a).toBe(1);
    } finally {
      delete process.env.JWT_SECRET;
    }
  });

  test("malformed token rejected", () => {
    expect(() => jwt("verify", "not.a.jwt.token", "--secret", "k")).toThrow();
    expect(() => jwt("verify", "onlyone", "--secret", "k")).toThrow();
  });

  test("missing secret throws", () => {
    delete process.env.JWT_SECRET;
    expect(() => jwt("sign", { a: 1 })).toThrow(/secret/);
  });
});

describe("random helpers", () => {
  test("int is within bounds", () => {
    for (let i = 0; i < 50; i++) {
      const n = random.int(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  test("choice picks from supplied set", () => {
    const set = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      expect(set).toContain(random.choice(set));
    }
  });

  test("choice throws on empty", () => {
    expect(() => random.choice([])).toThrow();
  });

  test("string has requested length and alphabet", () => {
    const s = random.string(20);
    expect(s).toHaveLength(20);
    expect(s).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  test("uuid produces a v4-shaped id", () => {
    expect(random.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("weighted always returns a key", () => {
    for (let i = 0; i < 50; i++) {
      const v = random.weighted([["a", 1] as const, ["b", 1] as const]);
      expect(["a", "b"]).toContain(v);
    }
  });

  test("shuffle preserves elements", () => {
    const arr = [1, 2, 3, 4, 5];
    const shuf = random.shuffle(arr);
    expect(shuf.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(arr).toEqual([1, 2, 3, 4, 5]);
  });
});

// Concurrent: every test owns its target server, and the probe timeouts
// (100ms dead-target, 50ms flip) would otherwise stack serially.
describe.concurrent("wait", () => {
  test("resolves once an http target flips healthy (shorthand :port/path)", async () => {
    let up = false;
    const timer = setTimeout(() => {
      up = true;
    }, 50);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(up ? "ok" : "starting", { status: up ? 200 : 503 }),
    });
    try {
      const res = await wait(`:${server.port}/`, "--interval", "10ms", "--timeout", "1s");
      expect(res.ready).toBe(true);
      expect(res.target).toBe(`:${server.port}/`);
      expect(res.attempts).toBeGreaterThan(1);
      expect(res.ms).toBeGreaterThanOrEqual(30);
    } finally {
      clearTimeout(timer);
      server.stop(true);
    }
  });

  test("rejects when the target never comes up within --timeout", async () => {
    const l = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
    const dead = l.port;
    l.stop(true);
    await expect(wait(`port:${dead}`, "--timeout", "100ms", "--interval", "10ms")).rejects.toThrow(
      /not ready after 100ms/,
    );
  });

  test("port: form connects to a live tcp listener (--flag=value form)", async () => {
    const listener = Bun.listen({
      hostname: "localhost",
      port: 0,
      socket: {
        data() {},
        open(s) {
          s.end();
        },
      },
    });
    try {
      const res = await wait(`port:${listener.port}`, "--timeout=1s", "--interval=10ms");
      expect(res.ready).toBe(true);
      expect(res.attempts).toBeGreaterThanOrEqual(1);
    } finally {
      listener.stop(true);
    }
  });

  test("bad arguments throw usage-style errors", async () => {
    await expect(wait()).rejects.toThrow(/missing target/);
    await expect(wait("port:1", "--timeout", "soon")).rejects.toThrow(/bad duration/);
    await expect(wait("localhost:80")).rejects.toThrow(/bad target/);
    await expect(wait("port:1", "--frobnicate", "2")).rejects.toThrow(/unknown flag/);
  });

  test("parseDuration accepts ms/s/m and bare numbers, rejects junk", () => {
    expect(parseDuration("300")).toBe(300);
    expect(parseDuration("300ms")).toBe(300);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(() => parseDuration("soon")).toThrow(/bad duration/);
    expect(() => parseDuration("10h")).toThrow(/bad duration/);
  });
});

describe("parser flatten on function-as-source", () => {
  test("Array return streams items, not one item", async () => {
    const { parse } = await import("../src/parser");
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...a: unknown[]) => unknown>([
        ["rows", () => [{ id: 1 }, { id: 2 }, { id: 3 }]],
      ]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("rows | (r => r.id)")(ctx).collect();
    expect(out).toEqual([1, 2, 3]);
  });

  test("non-Array return is yielded as a single item", async () => {
    const { parse } = await import("../src/parser");
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...a: unknown[]) => unknown>([["greet", () => "hello"]]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("greet")(ctx).collect();
    expect(out).toEqual(["hello"]);
  });
});
