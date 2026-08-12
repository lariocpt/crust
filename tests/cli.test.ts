import { describe, expect, test } from "bun:test";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
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

describe("crust CLI", () => {
  test("--version prints version, exit 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  test("--help prints usage, exit 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage:");
    expect(r.stdout).toContain("-c");
  });

  test("--help lists the builtins", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("builtins");
    expect(r.stdout).toContain("verify-web-links");
    expect(r.stdout).toContain("mock-server");
    expect(r.stdout).toContain("test-fixture");
  });

  test("-c with no arg errors and exits 2", async () => {
    const r = await runCli(["-c"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("-c");
  });

  test("unsupported argument exits 2", async () => {
    const r = await runCli(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unsupported");
  });

  test("-c '' exits 0 with no output", async () => {
    const r = await runCli(["-c", ""]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("-c runs a range pipeline", async () => {
    const r = await runCli(["-c", "range(0,2)"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0\n1\n2\n");
  });

  test("-c runs a range + lambda pipeline", async () => {
    const r = await runCli(["-c", "range(0,2) | (n => n*10)"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0\n10\n20\n");
  });

  test("-c 'exit 7' exits 7", async () => {
    const r = await runCli(["-c", "exit 7"]);
    expect(r.code).toBe(7);
  });

  test("-c propagates shell exit code", async () => {
    const r = await runCli(["-c", "false"]);
    expect(r.code).not.toBe(0);
  });

  test("-c with multiple lines exits with last line status", async () => {
    const r = await runCli(["-c", "true\nexit 4"]);
    expect(r.code).toBe(4);
  });

  test("-c 'tail <path>' streams the last N lines through the pipeline", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-tail-"));
    try {
      const log = join(dir, "app.log");
      await writeFile(log, "INFO ok\nERROR boom\nINFO ok\nERROR oops\n");
      const r = await runCli(["-c", `tail -n 100 ${log} | grep ERROR`]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("ERROR boom\nERROR oops\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("-c 'tail logs/*.log' glob-expands across multiple files", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-multitail-"));
    try {
      await writeFile(join(dir, "alpha.log"), "A1\nA2\n");
      await writeFile(join(dir, "beta.log"), "B1\nB2\n");
      const r = await runCli(["-c", `tail -n 100 ${dir}/*.log | grep -E "A|B"`]);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(new Set(lines)).toEqual(new Set(["A1", "A2", "B1", "B2"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("-c 'tail a.log b.log' tails multiple files explicitly", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-multitail-explicit-"));
    try {
      const a = join(dir, "a.log");
      const b = join(dir, "b.log");
      await writeFile(a, "X1\nX2\n");
      await writeFile(b, "Y1\nY2\n");
      const r = await runCli(["-c", `tail -n 100 ${a} ${b}`]);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(new Set(lines)).toEqual(new Set(["X1", "X2", "Y1", "Y2"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
