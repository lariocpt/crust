import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandEnv, splitArgs } from "../src/args";
import { classify } from "../src/lexer";
import { parse } from "../src/parser";
import type { Context } from "../src/types";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let dir: string;
let cwd: string;

function ctx(): Context {
  return { aliases: new Map(), functions: new Map(), history: [] } as never;
}

async function drain(line: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of parse(line)(ctx()).lines()) out.push(item);
  return out;
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/echo") {
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        return Response.json(
          { method: req.method, auth: req.headers.get("authorization"), body },
          { status: 201 },
        );
      }
      return new Response("ok", { status: 200 });
    },
  });
  base = `http://localhost:${server.port}`;
  cwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "crust-shorthand-"));
  process.chdir(dir);
});

afterAll(async () => {
  server.stop();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("args helpers", () => {
  test("splitArgs strips quotes and keeps quoted spaces", () => {
    expect(splitArgs('sql "SELECT count(*) FROM x" 42')).toEqual([
      "sql",
      "SELECT count(*) FROM x",
      "42",
    ]);
    expect(splitArgs("a 'b c' d")).toEqual(["a", "b c", "d"]);
  });

  test("expandEnv handles $NAME, ${NAME}, and missing vars", () => {
    process.env.CRUST_TEST_VAR = "yes";
    expect(expandEnv("v=$CRUST_TEST_VAR/${CRUST_TEST_VAR}/$CRUST_NOPE!")).toBe("v=yes/yes/!");
  });
});

describe("lexer shorthand kinds", () => {
  test("http headers parsed from -H flags", () => {
    const k = classify('POST :3000/users -H "authorization: Bearer x" -H "x-a: b"');
    expect(k).toEqual({
      kind: "http",
      verb: "POST",
      url: ":3000/users",
      headers: ["authorization: Bearer x", "x-a: b"],
    });
  });

  test("JSON literal, assert, read classify", () => {
    expect(classify('{"a":1}').kind).toBe("json");
    expect(classify("[1,2]").kind).toBe("json");
    expect(classify("assert (r => r.ok)").kind).toBe("assert");
    expect(classify("read fixtures/*.json").kind).toBe("readsrc");
  });
});

describe("shorthand pipelines end-to-end", () => {
  test("JSON source | POST with -H header + env expansion", async () => {
    process.env.SH_TOKEN = "tok-123";
    const out = await drain(
      `{"name":"Court"} | POST ${base}/echo -H "authorization: Bearer $SH_TOKEN" | (r => r.json())`,
    );
    const body = out[0] as { auth: string; body: { name: string } };
    expect(body.auth).toBe("Bearer tok-123");
    expect(body.body.name).toBe("Court");
  });

  test("POST with :port shorthand URL normalizes", async () => {
    const port = server.port;
    const out = await drain(`{"a":1} | POST :${port}/echo | (r => r.status)`);
    expect(out[0]).toBe(201);
  });

  test("assert passes truthy through and fails falsy", async () => {
    const ok = await drain('{"c":1} | assert (r => r.c === 1) | (r => "yes")');
    expect(ok[0]).toBe("yes");
    let msg = "";
    try {
      await drain('{"c":2} | assert (r => r.c === 1)');
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("assert: item 1 failed");
  });

  test("read glob posts FILE CONTENTS, not paths", async () => {
    await writeFile(join(dir, "one.fixture.json"), '{"from":"file"}');
    const out = await drain(
      `read *.fixture.json | POST ${base}/echo | (r => r.json()) | (j => j.body.from)`,
    );
    expect(out[0]).toBe("file");
  });

  test("parallel N is honored for POST (all items complete)", async () => {
    const out = await drain(`range(0, 9) | parallel 5 | POST ${base}/echo | (r => r.status)`);
    expect(out.length).toBe(10);
    expect(out.every((s) => s === 201)).toBe(true);
  });

  test("registered fn receives quoted arg as ONE string", async () => {
    const c = ctx();
    const seen: unknown[] = [];
    c.functions.set("capture", (...args: unknown[]) => {
      seen.push(args);
      return [];
    });
    for await (const _ of parse('capture "two words" 42')(c).lines()) {
      // drain
    }
    expect(seen[0]).toEqual(["two words", "42"]);
  });
});

describe("-c fail-fast", () => {
  test("stops at first failing line and exits with its code", async () => {
    const script = '{"c":2} | assert (r => r.c === 1)\n{"x":1} | (x => "NOPE")';
    const proc = Bun.spawn(["bun", join(cwd, "src/index.ts"), "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(1);
    expect(out).not.toContain("NOPE");
  });
});

describe("fn-arg env expansion", () => {
  test("args expand $VARS but keep SQL positional params", async () => {
    process.env.FN_ARG_VAL = "expanded";
    const c = ctx();
    const seen: unknown[] = [];
    c.functions.set("capture2", (...args: unknown[]) => {
      seen.push(args);
      return [];
    });
    for await (const _ of parse('capture2 "WHERE x = $1" "val-$FN_ARG_VAL"')(c).lines()) {
      // drain
    }
    expect(seen[0]).toEqual(["WHERE x = $1", "val-expanded"]);
  });
});

describe("assert on empty upstream", () => {
  test("fails instead of passing vacuously", async () => {
    let msg = "";
    try {
      await drain("range(0, -1) | assert (x => true)");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("no items reached");
  });
});
