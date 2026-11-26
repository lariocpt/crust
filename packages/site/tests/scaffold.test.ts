// The scaffold contract (chunk 1 of the v1 build):
//
//  - the public module imports and pins contractVersion 1
//  - the CLI argument contract is final: build/dev take at most one
//    positional (configFile); unknown subcommands, extra positionals and
//    flag-shaped args exit 2 with the usage; --help exits 0.
//
// The build/dev BEHAVIOUR (summary line, diagnostics, the dev loop) is
// pinned by cli.test.ts. The CLI is spawned as the shipped entry point
// (bun <package>/src/cli.ts), so the contract is tested the way an
// installer would hit it.
import { describe, expect, test } from "bun:test";

const CLI = `${import.meta.dir}/../src/cli.ts`;

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("the public module", () => {
  test("index.ts imports and pins contractVersion 1", async () => {
    const mod = await import("../src/index");
    expect(mod.contractVersion).toBe(1);
  });
});

describe("crust-site argument errors", () => {
  test("an unknown subcommand prints the usage and exits 2", async () => {
    const r = await cli("deploy");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "deploy"');
    expect(r.stderr).toContain("usage:");
  });

  test("a bare invocation prints the usage and exits 2", async () => {
    const r = await cli();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("a flag-shaped second argument is refused, not treated as a configFile", async () => {
    const r = await cli("build", "--bogus");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("at most one argument");
  });

  test("--help prints the usage and exits 0", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("crust-site");
    expect(r.stdout).toContain("usage:");
  });
});
