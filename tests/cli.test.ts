import { test, expect, describe } from "bun:test";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CRUST_CONFIG: "/dev/null" },
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
});
