import { describe, expect, test } from "bun:test";
import { classify } from "../src/lexer";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
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

describe("stdin source — classification", () => {
  test("bare stdin and - classify as the stdin source", () => {
    expect(classify("stdin")).toEqual({ kind: "stdin" });
    expect(classify("-")).toEqual({ kind: "stdin" });
    expect(classify("  stdin  ")).toEqual({ kind: "stdin" });
  });

  test("only the bare words claim it", () => {
    expect(classify("stdin foo").kind).toBe("shell");
    expect(classify("stdinx").kind).toBe("shell");
    expect(classify("- foo").kind).toBe("shell");
  });
});

describe("stdin source — CLI round-trips", () => {
  test("-c 'stdin | lambda' streams piped lines through the pipeline", async () => {
    const r = await runCli(["-c", "stdin | (l => l.toUpperCase())"], "alpha\nbeta\ngamma\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ALPHA\nBETA\nGAMMA\n");
  });

  test("trailing partial line (no final newline) is flushed", async () => {
    const r = await runCli(["-c", "stdin | (l => `<${l}>`)"], "one\ntwo\npartial");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("<one>\n<two>\n<partial>\n");
  });

  test("composes with native grep and filter", async () => {
    const input =
      '{"level":50,"msg":"boom"}\n{"level":30,"msg":"fine"}\n{"level":50,"msg":"again"}\n';
    const r = await runCli(
      ["-c", "stdin | (l => JSON.parse(l)) | filter (e => e.level >= 40) | (e => e.msg)"],
      input,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("boom\nagain\n");
  });

  test("stdin inside a bare-pipe script errors loudly instead of hanging", async () => {
    // `echo 'stdin | …' | crust` reads the pipe to EOF as the SCRIPT — the
    // stage must say so, not block on a drained pipe.
    const r = await runCli([], "stdin | (l => l)\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already read");
    expect(r.stderr).toContain("-c");
  });

  test("mid-pipeline stdin is rejected", async () => {
    const r = await runCli(["-c", "range(1, 3) | stdin"], "unused\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stdin cannot appear as a non-first stage");
  });
});
