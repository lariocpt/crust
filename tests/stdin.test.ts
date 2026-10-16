import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The drain is a property of `cmd | crust` — the mode where the PROGRAM arrives
// on stdin — and of nothing else. The limits section used to claim "script/piped
// mode", which told people that `crust file.crust` also starves its shell
// stages. It doesn't: crust never touches stdin there, so a shell stage inherits
// the pipe and reads it. These pin the distinction the docs now draw.
describe("stdin is drained only when the program itself is piped", () => {
  const dir = mkdtempSync(join(tmpdir(), "crust-stdin-mode-"));

  test("piped program: a shell stage sees EOF, because stdin WAS the program", async () => {
    const r = await runCli([], "echo start\nwc -l\n");
    expect(r.stdout).toBe("start\n0\n");
  });

  test("script file with piped data: the shell stage inherits the pipe", async () => {
    const file = join(dir, "inherit.crust");
    writeFileSync(file, "echo start\nwc -l\n");
    const r = await runCli([file], "DATA1\nDATA2\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("start\n2\n");
  });

  test("script file with piped data: the `stdin` source also reads it", async () => {
    // Nothing drained it, so the source works here — which is exactly why a
    // script must not do BOTH this and a stdin-eating shell stage.
    const file = join(dir, "source.crust");
    writeFileSync(file, "stdin | wc -l\n");
    const r = await runCli([file], "DATA1\nDATA2\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\n");
  });

  test("-c with piped data: the shell stage reads the data (nothing is drained)", async () => {
    const r = await runCli(["-c", "wc -l"], "DATA1\nDATA2\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\n");
  });
});
