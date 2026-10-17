import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Positional script arguments — `crust file.crust a b` — and where the
// tokens DO and DO NOT reach. The expansion lives in expandEnv
// (src/args.ts) and is fed by the positionals module (src/positionals.ts),
// so the same tokens work everywhere crust already expands $-names:
// JSON-literal sources, fn-args, URLs, -H values, tool-builtin args.
// Shell stages never call expandEnv: there $1 is sh's own, and under
// `sh -c` it is always empty. The REPL, `-c`, and piped stdin keep the
// positionals EMPTY ($0/$N expand to "", $# to "0").

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(
  args: string[],
  stdin?: string,
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: opts.cwd,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-cli-test-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("positional script arguments", () => {
  let dir: string;
  const probe = (): string => join(dir, "probe.crust");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crust-script-args-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeProbe = (body: string): string => {
    writeFileSync(probe(), `${body}\n`);
    return probe();
  };

  // Crust source, not a JS template: ${2:-dev} is the exact syntax under test.
  const PROBE =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${...} IS the fixture
    '{"zero": "$0", "one": "$1", "two": "$2", "def": "${2:-dev}", "n": "$#", "all": "$@", "star": "$*"}';

  test("the full sh table: $0 $1 $2, default fallback, $# $@ $*", async () => {
    const script = writeProbe(PROBE);
    const r = await runCli([script, "prod", "staging"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `${JSON.stringify({
        zero: script,
        one: "prod",
        two: "staging",
        def: "staging",
        n: "2",
        all: "prod staging",
        star: "prod staging",
      })}\n`,
    );
  });

  test("with no args: $N are empty, the default fallback applies, $# is 0", async () => {
    const script = writeProbe(PROBE);
    const r = await runCli([script]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `${JSON.stringify({ zero: script, one: "", two: "", def: "dev", n: "0", all: "", star: "" })}\n`,
    );
  });

  test("a quoted operand is ONE argument, not two", async () => {
    const script = writeProbe('{"n": "$#", "one": "$1", "two": "$2"}');
    const r = await runCli([script, "a b"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ n: "1", one: "a b", two: "" })}\n`);
  });

  test("$10 is $1 followed by 0, as in sh", async () => {
    const script = writeProbe('{"ten": "$10"}');
    const r = await runCli([script, "ab"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ ten: "ab0" })}\n`);
  });

  test("a captured value carries the expansion into later lines", async () => {
    const script = writeProbe('{"v": "$1"} | (x => x.v) | capture ONE\n{"out": "$ONE"}');
    const r = await runCli([script, "prod"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`prod\n${JSON.stringify({ out: "prod" })}\n`);
  });

  test("-- separates crust's argv from the script's", async () => {
    const script = writeProbe('{"one": "$1", "n": "$#"}');
    const r = await runCli([script, "--", "ab"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ one: "ab", n: "1" })}\n`);
  });

  test("a shell stage sees sh's own $1 (empty), not the script's", async () => {
    const script = writeProbe("echo sh-sees[$1]");
    const r = await runCli([script, "prod"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("sh-sees[]\n");
  });

  test("a line that names $1 with none passed fails loudly, not silently", async () => {
    // $1 expands to "" inside the URL, so the line dies on the empty host —
    // the failure shows the expansion happened, and the exit code is the
    // line's, not 0.
    const script = writeProbe("GET $1");
    const r = await runCli([script]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("crust: GET http://");
    expect(r.stderr).toContain("URL is invalid");
  });

  test("read's file pattern is not env-expanded (pre-existing), so it fails loud on the literal", async () => {
    const script = writeProbe("read $1");
    const r = await runCli([script]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such file or directory");
    expect(r.stderr).toContain("$1");
  });

  test("source swaps in the sourced file's $0/$1 and restores the caller's after", async () => {
    const inner = join(dir, "inner.crust");
    writeFileSync(inner, '{"inner_zero": "$0", "inner_one": "$1"}\n');
    const outer = join(dir, "outer.crust");
    writeFileSync(outer, `source ${inner} B\n{"outer_zero": "$0", "outer_one": "$1"}\n`);
    const r = await runCli([outer, "A"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `${JSON.stringify({ inner_zero: inner, inner_one: "B" })}\n${JSON.stringify({
        outer_zero: outer,
        outer_one: "A",
      })}\n`,
    );
  });

  test("controls: -c keeps its one-line rule and its empty positionals", async () => {
    const two = await runCli(["-c", "a", "b"]);
    expect(two.code).toBe(2);
    expect(two.stderr).toContain("takes one line");

    const one = await runCli(["-c", '{"n": "$#", "one": "$1"}']);
    expect(one.code).toBe(0);
    expect(one.stdout).toBe(`${JSON.stringify({ n: "0", one: "" })}\n`);
  });

  test("piped stdin keeps the positionals empty too", async () => {
    const r = await runCli([], '{"n": "$#", "one": "$1"}\n');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${JSON.stringify({ n: "0", one: "" })}\n`);
  });
});
