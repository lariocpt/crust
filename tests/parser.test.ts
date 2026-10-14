import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltinFns } from "../src/builtinFns";
import { HelpExit, parse } from "../src/parser";
import type { Context } from "../src/types";

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

  // Shell grouping (`{ …; }`) and the test bracket (`[ … ]`) are how a shell
  // script feeds one stream to another and how it asks a question. Both start
  // with a bracket, so both used to be swallowed by the JSON-literal rule —
  // `{ echo hi; } | cat` said `JSON Parse error: Expected '}'`. They are shell
  // stages now, which means sh gives them the meaning they have everywhere.
  test("a brace group runs as shell, quoted or not", async () => {
    expect(await parse("{ echo a; echo b; } | cat")().collect()).toEqual(["a", "b"]);
    // a quoted brace group: the quotes are what made it look like JSON
    expect(await parse('{ echo "hi"; }')().collect()).toEqual(["hi"]);
  });

  test("the shell test bracket answers true, and sh's own code answers false", async () => {
    expect(await parse("[ -f package.json ] && echo found")().collect()).toEqual(["found"]);
    // A false test is exit 1 from sh, and crust propagates a shell stage's
    // nonzero exit rather than reporting a quiet pass. What matters here is
    // *which* error: sh's status, never a JSON parse error for a line with no
    // JSON in it.
    let threw: unknown;
    try {
      await parse("[ -f no-such-file-here ] && echo found")().collect();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(String(threw)).not.toMatch(/JSON/i);
  });

  test("control: a brace group's output reaches crust's stages, not just sh", async () => {
    expect(await parse("{ echo a; echo b; } | (s => s.toUpperCase())")().collect()).toEqual([
      "A",
      "B",
    ]);
  });

  test("control: a JSON literal is still a one-item source", async () => {
    expect(await parse('{"a":1}')().collect()).toEqual([{ a: 1 }]);
    // one item, the parsed value — the array is the item, not two items
    expect(await parse("[1,2]")().collect()).toEqual([[1, 2]]);
    // and a half-typed one is still the JSON error, never a shell exec
    expect(() => parse('{"a": }')()).toThrow(/JSON/);
  });

  // `$VAR` is expanded after the stage is classified, so these lines are
  // literals by shape, not by parse. The first cut of the bracket rule decided
  // by parse alone and all three fell through to the glob source — which with
  // nothing to match is an empty stream and exit 0. Silent, not an error, and
  // the shipped binary had answered `[1,5]`, `[5]` and `{"n":5}`.
  test("control: a literal with a variable in it still runs as a literal", async () => {
    process.env.CRUST_TEST_N = "5";
    try {
      expect(await parse("[1,$CRUST_TEST_N]")().collect()).toEqual([[1, 5]]);
      expect(await parse("[$CRUST_TEST_N]")().collect()).toEqual([[5]]);
      expect(await parse('{"n":$CRUST_TEST_N}')().collect()).toEqual([{ n: 5 }]);
    } finally {
      delete process.env.CRUST_TEST_N;
    }
    // unset, the same line is the loud thing it was before: a JSON error
    expect(() => parse("[1,$CRUST_TEST_N]")()).toThrow(/JSON/);
  });

  test("the documented gap: a spaced array reads as the shell's test", async () => {
    // `[ $N ]` is indistinguishable from `[ -n "$N" ]`, which is shell and the
    // point of the bracket rule. Writing arrays tight (`[1,$N]`) is the fix, so
    // pin the reading rather than leave it discovered as an empty run.
    process.env.CRUST_TEST_N = "5";
    try {
      expect(await parse("[ $CRUST_TEST_N ]")().collect()).toEqual([]);
    } finally {
      delete process.env.CRUST_TEST_N;
    }
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

describe("filter stage", () => {
  test("keeps items whose predicate is truthy", async () => {
    const p = parse("range(1, 6) | filter (n => n % 2 === 0)")();
    expect(await p.collect()).toEqual([2, 4, 6]);
  });

  test("plain truthiness: 0 is dropped, unlike a mapping lambda", async () => {
    const p = parse("range(0, 3) | filter (n => n)")();
    expect(await p.collect()).toEqual([1, 2, 3]);
  });

  test("awaits async predicates", async () => {
    const p = parse("range(1, 3) | filter (async n => n > 1)")();
    expect(await p.collect()).toEqual([2, 3]);
  });

  test("empty result passes silently — selection, not assertion", async () => {
    const p = parse("range(1, 3) | filter (n => n > 99)")();
    expect(await p.collect()).toEqual([]);
  });

  test("cannot be a source", () => {
    expect(() => parse("filter (x => x)")()).toThrow("filter cannot be a source");
  });

  test("DELETE opens a pipeline; body verbs still cannot", () => {
    // DELETE carries no body, so requiring `{} | DELETE $URL` was a papercut
    // with no meaning behind it. POST/PUT/PATCH genuinely have nothing to send
    // until an item arrives, and now say so.
    expect(() => parse("DELETE :9/gone")()).not.toThrow();
    expect(() => parse("GET :9/thing")()).not.toThrow();
    for (const verb of ["POST", "PUT", "PATCH"]) {
      expect(() => parse(`${verb} :9/thing`)()).toThrow(
        `${verb} cannot be a source — it sends a body`,
      );
    }
  });

  test("does not consume the parallel modifier", () => {
    expect(() => parse("range(0, 3) | parallel 2 | filter (x => x)")()).toThrow(
      "parallel 2: only applies to http, lambda, or function stages — got filter",
    );
  });

  test("a throwing predicate names the item and source", async () => {
    const p = parse("range(1, 3) | filter (n => n.missing.deep)")();
    await expect(p.collect()).rejects.toThrow(/filter: item 1 threw in \(n => n\.missing\.deep\)/);
  });
});

describe("parallel modifier", () => {
  test("errors loudly before a non-consuming stage", () => {
    expect(() => parse("range(0, 3) | parallel 2 | stats")()).toThrow(
      "parallel 2: only applies to http, lambda, or function stages — got stats",
    );
  });

  test("errors when trailing", () => {
    expect(() => parse("range(0, 3) | parallel 2")()).toThrow(
      "parallel: must be followed by an http, lambda, or function stage",
    );
  });

  test("fans out lambda stages", async () => {
    const out = await parse("range(0, 9) | parallel 4 | (x => x * 2)")().collect();
    expect([...(out as number[])].sort((a, b) => a - b)).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18,
    ]);
  });

  test("fans out registered functions, capping in-flight at N", async () => {
    let inFlight = 0;
    let peak = 0;
    const ctx = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...args: unknown[]) => unknown>([
        [
          "slowfn",
          async (x: unknown) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(15);
            inFlight--;
            return x;
          },
        ],
      ]),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    const out = await parse("range(0, 9) | parallel 3 | slowfn")(ctx).collect();
    expect(out).toHaveLength(10);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
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

// A lambda is compiled with `new Function`, which cannot produce an async arrow,
// so `await` in a body used to be refused at parse time — including in the
// documented `ls *.json | (s => JSON.parse(await Bun.file(s).text()))` idiom.
// Such bodies are now recompiled `async`; the pipeline already awaited every
// stage result, so nothing downstream had to change.
describe("lambda — await in a body", () => {
  const run = async (line: string) => parse(line)().collect();
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-await-"));
    file = join(dir, "a.json");
    await Bun.write(file, JSON.stringify({ id: "abc" }));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("the awaited value is what downstream sees, not a Promise", async () => {
    expect(await run("range(0, 0) | (_ => await Promise.resolve(7))")).toEqual([7]);
  });

  test("reads a real file per item — the documented idiom", async () => {
    expect(
      await run(`range(0, 0) | (_ => JSON.parse(await Bun.file("${file}").text()).id)`),
    ).toEqual(["abc"]);
  });

  test("works under `parallel`, where one request per item is the point", async () => {
    expect(await run("range(0, 4) | parallel 2 | (_ => await Promise.resolve(1))")).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  test("filter and assert await their predicates", async () => {
    expect(await run("range(0, 3) | filter (x => await Promise.resolve(x % 2 === 0))")).toEqual([
      0, 2,
    ]);
    expect(await run("range(0, 0) | assert (x => await Promise.resolve(x === 0))")).toEqual([0]);
    await expect(run("range(0, 0) | assert (x => await Promise.resolve(false))")).rejects.toThrow(
      // the ORIGINAL text is echoed, not the asyncified body
      /assert:.*x => await Promise\.resolve\(false\)/s,
    );
  });

  test("an explicitly async body still compiles (this always worked)", async () => {
    expect(await run("range(0, 0) | (async _ => await Promise.resolve(9))")).toEqual([9]);
  });

  test("a genuine syntax error keeps its own diagnostic", async () => {
    await expect(run("range(0, 0) | (x => x +)")).rejects.toThrow(/Unexpected/);
    // head is not a parameter list -> no async rewrite, same original message
    await expect(run("range(0, 0) | (f(x) => await x)")).rejects.toThrow(/Unexpected/s);
  });
});

describe("parser — registered fn --help (F42)", () => {
  // The tool builtins got uniform --help through parseFlags; the registered
  // fns are dispatched in the parser with no flag parsing at all, so --help
  // arrived as DATA and each handler did whatever it does with data (sql: a
  // SQL complaint, base64 on 0.2.4: the flag encoded). The fix answers it at
  // parse time — in the builder, before any stage exists to run — so
  // `http … | sql --help` prints usage without making the request and
  // `touch f | sql --help` leaves no file behind (both measured).
  function builtinCtx(overrides = new Map<string, (...a: unknown[]) => unknown>()): Context {
    const ctx: Context = {
      aliases: new Map<string, string>(),
      functions: new Map<string, (...args: unknown[]) => unknown>(),
      history: [],
      exit: (() => {}) as never,
      dotenv: { history: [], snapshot: null },
      signalHandlers: new Map(),
    };
    registerBuiltinFns(ctx);
    for (const [name, fn] of overrides) ctx.functions.set(name, fn);
    return ctx;
  }

  const BUILTIN_NAMES = ["base64", "salt", "jwt", "bundle", "sql", "wait"] as const;

  test("every builtin answers --help in the source position", () => {
    for (const name of BUILTIN_NAMES) {
      expect(() => parse(`${name} --help`)(builtinCtx()), `${name} --help`).toThrow(HelpExit);
    }
  });

  test("every builtin answers --help mid-pipeline, and -h is the same request", () => {
    for (const name of BUILTIN_NAMES) {
      expect(() => parse(`range(1, 1) | ${name} --help`)(builtinCtx()), `${name} mid`).toThrow(
        HelpExit,
      );
      expect(() => parse(`${name} -h`)(builtinCtx()), `${name} -h`).toThrow(HelpExit);
    }
  });

  test("sql --help is a HelpExit, not a SQL or connection error", () => {
    // Pre-fix: `Query contained no valid SQL statement` (rc 1) with a database,
    // `no connection` without — the flag was a query, not a request for help.
    expect(() => parse("sql --help")(builtinCtx())).toThrow(HelpExit);
  });

  test("after -- the flag is data again", async () => {
    const out = await parse("base64 -- --help")(builtinCtx()).collect();
    expect(out).toEqual(["LS1oZWxw"]);
  });

  test("a piped --help is data: only line arguments sit in an option slot", async () => {
    const out = await parse("echo --help | base64")(builtinCtx()).collect();
    expect(out).toEqual(["LS1oZWxw"]);
  });

  test("a crust.fn override keeps --help as an argument to ITS handler", async () => {
    const seen: unknown[][] = [];
    const handler = (...a: unknown[]): string => {
      seen.push([...a]);
      return "mine";
    };
    const ctx = builtinCtx(new Map([["base64", handler]]));
    expect(await parse("base64 --help")(ctx).collect()).toEqual(["mine"]);
    expect(await parse("range(7, 7) | base64 --help")(ctx).collect()).toEqual(["mine"]);
    expect(seen).toEqual([["--help"], [7, "--help"]]);
  });

  test("a user fn that was never a builtin passes --help straight through", async () => {
    const ctx = builtinCtx(new Map([["mine", (...a: unknown[]) => `args:${a.join(",")}`]]));
    expect(await parse("mine --help")(ctx).collect()).toEqual(["args:--help"]);
  });
});
