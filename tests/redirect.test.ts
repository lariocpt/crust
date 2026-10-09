// `<` / `>` are not crust syntax — only a SHELL stage has a redirect, because
// the whole stage text is what gets handed to `sh -c`. Everywhere else a
// redirect tail used to do something else entirely, and none of it was a
// useful answer:
//
//   range(3) | (x => x + 1) > out.txt   crust: Invalid regular expression: invalid flags
//   GET :3000/x             > out.json  the request ran, nothing was written, exit 0
//   sql "SELECT 1 AS v"     > out.txt   `>` and the path became SQL parameters
//
// Every case here failed before the fix. The controls exist so the refusal
// can't swallow the redirects that genuinely work.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/builtinFns/sql";
import { classify } from "../src/lexer";
import { parse } from "../src/parser";
import type { Context } from "../src/types";

const ctx = () => ({ aliases: new Map(), functions: new Map(), history: [] }) as unknown as Context;

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function check(line: string) {
  const proc = Bun.spawn(["bun", ENTRY, "--check", line], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CRUST_CONFIG: "/dev/null" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: stdout + stderr };
}

describe("a redirect on a crust stage refuses loudly", () => {
  test("lambda stage", () => {
    expect(() => classify("(x => x + 1) > /tmp/out.txt")).toThrow(/redirect/);
  });

  test("assert stage", () => {
    expect(() => classify("assert (x => x >= 0) > /tmp/out.txt")).toThrow(/redirect/);
  });

  test("filter stage", () => {
    expect(() => classify("filter (x => x !== 0) >> /tmp/out.txt")).toThrow(/redirect/);
  });

  test("capture stage", () => {
    expect(() => classify("capture N (x => x) > /tmp/out.txt")).toThrow(/redirect/);
  });

  test("http stage — this one used to parse fine and drop the redirect in silence", () => {
    expect(() => classify("GET http://localhost:3000/x > /tmp/out.json")).toThrow(/redirect/);
  });

  test("http stage, `<` direction", () => {
    expect(() => classify("GET http://localhost:3000/x < /tmp/body.json")).toThrow(/redirect/);
  });

  test("registered-fn stage — `> path` used to land in the SQL parameter list", () => {
    // Registered fns are demoted from shell stages in the parser (the lexer is
    // ctx-free), so this one is checked where that happens.
    const c = ctx();
    c.functions.set("sql", sql as (...a: unknown[]) => unknown);
    expect(() => parse('sql "SELECT 1 AS v" > /tmp/out.txt')(c)).toThrow(/redirect/);
    // The same fn, no redirect: still builds.
    expect(() => parse('sql "SELECT 1 AS v" 2')(c)).not.toThrow();
  });

  test("the refusal names the fix, not just the failure", async () => {
    const r = await check("range(0,3) | (x => x + 1) > /tmp/out.txt");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/redirect/);
    // Pointing at a shell stage is the actual answer: `cat` is a real binary,
    // it gets the upstream items on stdin, and its redirect is real.
    expect(r.out).toMatch(/cat > \/tmp\/out\.txt/);
  });

  test("CONTROL: comparison operators inside a stage are not redirects", () => {
    for (const line of [
      "(x => x > 1)",
      "(x => x < 1 || x >= 2)",
      "assert (x => x >= 0 && x !== 1)",
      "filter (x => x > 1)",
      "capture N (x => x < 3 ? 1 : 2)",
    ]) {
      expect(() => classify(line)).not.toThrow();
    }
  });

  test("CONTROL: a redirect character inside quotes is not a redirect", () => {
    for (const line of [
      '{"note":"a > b"}',
      '{"q":"x < y"} | POST http://localhost:3000/x',
      'grep "a > b"',
      '(x => x === ">")',
    ]) {
      expect(() => classify(line)).not.toThrow();
    }
  });

  test("CONTROL: shell stages keep their redirects, quoted or not", () => {
    for (const line of [
      "cat > /tmp/out.txt",
      "grep ERROR > combined.log",
      "sort -u < /tmp/a.txt",
      "head -3 >> /tmp/out.txt",
    ]) {
      expect(() => classify(line)).not.toThrow();
      expect(classify(line).kind).toBe("shell");
    }
  });

  test("CONTROL: the documented shell-redirect pipeline still parses", async () => {
    const r = await check("tail logs/*.log | grep ERROR > combined.log");
    expect(r.code).toBe(0);
    const r2 = await check("range(0,3) | cat > /tmp/out.txt");
    expect(r2.code).toBe(0);
  });
});

// A builtin line with a redirect doesn't reach the builtin dispatch at all —
// the gate steps aside for shell metacharacters — so the whole line went to
// `sh -c` and answered `sh: line 1: mock-server: command not found` (exit 127),
// which reads as crust not having mock-server. Capturing a mock's boot log is a
// thing users do, so say what is actually true and give the spelling that works.
describe("a redirect on a builtin line says so instead of exec-ing", () => {
  async function run(
    line: string,
    opts: { cwd?: string; path?: string } = {},
  ): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", ENTRY, "-c", line], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: {
        ...process.env,
        CRUST_CONFIG: "/dev/null",
        CRUST_GLOBAL_PREFIX: "/tmp/crust-redirect-none",
        PATH: opts.path ?? process.env.PATH,
      },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { code: proc.exitCode ?? -1, out: stdout + stderr };
  }

  test("mock-server: refuses, points at redirecting the whole invocation", async () => {
    const file = "/tmp/crust-redirect-mock.log";
    const fs = await import("node:fs");
    fs.rmSync(file, { force: true });
    const r = await run(`mock-server /nonexistent/spec.json > ${file}`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/mock-server is a crust builtin/);
    expect(r.out).toMatch(/crust -c 'mock-server \/nonexistent\/spec\.json' > /);
    // Not the old lie.
    expect(r.out).not.toMatch(/command not found/);
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test("CONTROL: a shell-word builtin keeps sh's redirect", async () => {
    // `export`/`source`/`cd` are words sh implements too; crust only takes them
    // over when the line has no shell metacharacters. Don't touch that.
    const r = await run("export CRUST_REDIRECT_OK=1 > /dev/null");
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/cannot redirect/);
  });

  test("CONTROL: a real binary by a builtin's name still runs", async () => {
    // Rule 3: crust must not shadow a real binary. If the user has installed
    // `verify-web-links` for real, `verify-web-links … > f` is theirs.
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync("/tmp/crust-redirect-bin-");
    const exe = `${dir}/verify-web-links`;
    fs.writeFileSync(exe, "#!/bin/sh\necho real-binary-ran\n", { mode: 0o755 });
    const r = await run("verify-web-links --whatever > ran.txt", {
      cwd: dir,
      path: `${dir}:${process.env.PATH}`,
    });
    expect(r.out).not.toMatch(/cannot redirect/);
    expect(await Bun.file(`${dir}/ran.txt`).text()).toContain("real-binary-ran");
  });
});

// The same class, one step wider: a builtin NAME inside a shell context —
// `mock-server spec.json | grep ok`, `logs tail -F app.log | grep ERROR`,
// `range(0,2) | test-fixture a.ts`. Shell metacharacters make crust hand the
// stage to `sh -c`, and sh answered `command not found` (127) for a tool crust
// runs in-process. The message said crust did not have the builtin.
describe("a crust builtin reaching sh refuses by name", () => {
  async function run(
    line: string,
    opts: { cwd?: string; path?: string; checkOnly?: boolean } = {},
  ): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", ENTRY, opts.checkOnly ? "--check" : "-c", line], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: {
        ...process.env,
        CRUST_CONFIG: "/dev/null",
        CRUST_GLOBAL_PREFIX: "/tmp/crust-redirect-none",
        PATH: opts.path ?? process.env.PATH,
      },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { code: proc.exitCode ?? -1, out: stdout + stderr };
  }

  test("builtin at the head of a shell pipeline", async () => {
    const r = await run("mock-server /nonexistent/spec.json | grep ok");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/mock-server is a crust builtin/);
    expect(r.out).not.toMatch(/command not found/);
  });

  test("logs: the refusal says where its filters actually go", async () => {
    const r = await run("logs tail -F /nonexistent/app.log | grep ERROR");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/logs is a crust builtin/);
    expect(r.out).toMatch(/logs>` prompt/);
  });

  test("builtin mid-pipeline (after a crust stage) — the parser path", async () => {
    const r = await run("range(0,2) | test-fixture /nonexistent/a.ts");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/test-fixture is a crust builtin/);
    expect(r.out).not.toMatch(/command not found/);
  });

  test("builtin mid-pipeline behind a lambda", async () => {
    const r = await run("range(0,2) | (x => x) | gen-fixtures /nonexistent/spec.json");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gen-fixtures is a crust builtin/);
  });

  test("CONTROL: an ordinary shell pipeline still runs", async () => {
    const r = await run("range(0,2) | wc -l");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("3");
  });

  test("CONTROL: --check keeps parsing the documented logs line", async () => {
    // The guard must not fire at parse time — docs-lint and the website's
    // Grammar stage --check `logs tail -n 0 -F app.log` on every commit.
    const r = await run("logs tail -n 0 -F app.log", { checkOnly: true });
    expect(r.code).toBe(0);
  });

  test("CONTROL: a real binary by a builtin's name runs mid-pipeline", async () => {
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync("/tmp/crust-builtin-shadow-");
    fs.writeFileSync(`${dir}/test-fixture`, "#!/bin/sh\necho real-binary-ran\n", { mode: 0o755 });
    const r = await run("range(0,1) | test-fixture whatever.ts", {
      cwd: dir,
      path: `${dir}:${process.env.PATH}`,
    });
    expect(r.out).not.toMatch(/is a crust builtin/);
    expect(r.out).toContain("real-binary-ran");
  });
});
