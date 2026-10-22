// `$(…)` and backticks do two completely different things depending on which
// side of a `|` they land on, and crust used to blur that line in the worst
// direction: it built data from the literal text.
//
//   GET $(echo httpbin.org)/get    getaddrinfo ENOTFOUND $(echo   ← reads as a network problem
//   range(1,$(echo 3))             sh: syntax error near unexpected token `1,$(echo 3)'
//
// The rule the lexer must settle on: sh substitutes once, at the head of a
// shell stage, and that stays. Everywhere else `$(…)` is refused with a message
// that names the two ways that work — end the line with a shell stage, or
// capture into a variable first. The capture route is the feature, and its
// round-trip (including the trailing newline shells always emit) is pinned
// here, not assumed.
//
// Every case in the "refuses" block failed before the fix (no refusal message,
// or sh's syntax error instead). Every case in "controls" works today and must
// keep working byte-for-byte — the refusal must not swallow the `$(` that
// genuinely belongs to sh.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; out: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-substitution-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr, out: stdout + stderr };
}

const run = (program: string) => runCli(["-c", program]);

/** Unique names: these tests mutate a shared process.env, like the session does. */
let seq = 0;
const v = () => `G07_VAR_${seq++}`;

// The message the gap file names; the … is a literal unicode ellipsis, as
// written in the spec.
const REFUSAL = /\$\(…\) runs in a shell stage/;

let server: ReturnType<typeof Bun.serve>;
let hits = 0;

beforeAll(() => {
  hits = 0;
  server = Bun.serve({
    port: 0,
    fetch: () => {
      hits++;
      return new Response("ok", { status: 200 });
    },
  });
});

afterAll(() => {
  server.stop();
});

describe("a $(…) on a crust stage refuses loudly", () => {
  test("GET with a substituted host refuses and performs no request", async () => {
    const before = hits;
    const r = await run(`GET $(echo 127.0.0.1:${server.port})/get`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    // The old lie: crust built the URL from the literal text and got a
    // getaddrinfo for host `$(echo` — a network-shaped answer to a parse-level
    // refusal.
    expect(r.out).not.toMatch(/ENOTFOUND \$\(echo/);
    // "Performs no request" — the server on the same host in this file must
    // not see one.
    expect(hits).toBe(before);
    expect(r.stdout).toBe("");
  });

  test("a real GET on the same host still succeeds", async () => {
    const before = hits;
    const r = await run(`GET http://127.0.0.1:${server.port}/get`);
    expect(r.code).toBe(0);
    expect(hits).toBeGreaterThan(before);
    expect(r.stdout).toContain("200 OK");
  });

  test("range(1,$(echo 3)) refuses instead of sh's syntax error", async () => {
    const r = await run("range(1,$(echo 3))");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    expect(r.out).not.toMatch(/syntax error near unexpected token/);
  });
});

describe("a $(…) in a non-shell mid-stage refuses too", () => {
  test("lambda stage — with an upstream, so the lambda is a stage, not a source", async () => {
    const r = await run("range(0,1) | (x => x + $(date))");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(REFUSAL);
  });

  test("grep as a crust stage refuses", async () => {
    const r = await run("grep $(echo p)");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(REFUSAL);
    expect(r.stdout).toBe("");
  });

  test("CONTROL: grep mid-pipeline with a $(…) still goes to sh and runs", async () => {
    // The `$` anywhere in a grep stage demotes it to the shell path — that
    // escape is what keeps `range(0,1) | grep $(echo 1)` working, and the
    // refusal must not swallow it.
    const r = await run("range(0,1) | grep $(echo 1)");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("1");
  });
});

describe("capture is the named route, and it round-trips", () => {
  test("printf '7\\n' | capture N then echo \"[$N]\" → [7], no trailing newline", async () => {
    const N = v();
    const r = await run(`printf '7\\n' | capture ${N}\necho "[$${N}]"`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("[7]");
  });

  test("echo 7 | capture N round-trips the same", async () => {
    const N = v();
    const r = await run(`echo 7 | capture ${N}\necho "[$${N}]"`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("[7]");
  });

  test("a trailing newline the stage emits is trimmed from the captured value", async () => {
    // Shell-stage items are lines — the trailing newline is already gone — so
    // a lambda is the only way to hand captureEnv a value that carries one.
    // Today the value arrives as `7\n` and $N prints two lines; the fix trims
    // trailing newlines in captureEnv.
    const N = v();
    const r = await run(`range(1,2) | (x => '7' + '\\n') | capture ${N}\necho "[$${N}]"`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").at(-1)).toBe("[7]");
  });

  test("a downstream shell stage sees $N expanded — sh expands it once, at spawn", async () => {
    // The value captured here is `a$(echo b)` — a literal, because the lambda
    // never runs a shell. If the downstream `echo` re-ran the `$(…)` it would
    // print [ab]; sh expands $N at spawn and does not rescan the value, so the
    // bracketed line pins which of the two sides did the expanding.
    const N = v();
    const r = await run(`range(0,1) | (x => 'a$(echo b)') | capture ${N}\necho "[$${N}]"`);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("[a$(echo b)]");
  });
});

describe("controls: the $(…) that belongs to sh", () => {
  test("a shell stage's head substitution still runs", async () => {
    const r = await run("echo $(seq 3) | wc -w");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("3");
  });

  test("a quoted $(nope) inside a shell stage stays literal — no spawn", async () => {
    const N = v();
    const r = await run(`echo 'G07_NOPE_ANYWHERE=$(nope)' | capture ${N}\necho "[$${N}]"`);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/command not found/);
    const lines = r.stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("[G07_NOPE_ANYWHERE=$(nope)]");
  });

  test("a template literal with a $ in a lambda body is untouched by the guard", async () => {
    const r = await run("range(0,1) | (x => `n=${x}`)");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["n=0", "n=1"]);
  });
});
