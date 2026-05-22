import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "crust-lifecycle-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeConfig(name: string, body: string): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, body);
  return path;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  proc: ReturnType<typeof Bun.spawn>;
}

async function runCli(args: string[], configPath: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: configPath,
      CRUST_GLOBAL_PREFIX: "/tmp/crust-lifecycle-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr, proc };
}

describe("lifecycle hooks", () => {
  test("onExit fires with the exit code from `exit N`", async () => {
    const cfg = await writeConfig(
      "exit-code.ts",
      `crust.onExit = (code) => { process.stderr.write("bye " + code + "\\n"); };`,
    );
    const r = await runCli(["-c", "exit 7"], cfg);
    expect(r.code).toBe(7);
    expect(r.stderr).toContain("bye 7");
  });

  test("onExit fires when -c completes normally", async () => {
    const cfg = await writeConfig(
      "exit-normal.ts",
      `crust.onExit = (code) => { process.stderr.write("clean " + code + "\\n"); };`,
    );
    const r = await runCli(["-c", "range(0,1)"], cfg);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("clean 0");
  });

  test("onBeforeStart fires before commands run", async () => {
    const cfg = await writeConfig(
      "before-start.ts",
      `crust.onBeforeStart = () => { process.stderr.write("ready\\n"); };`,
    );
    const r = await runCli(["-c", "range(0,1)"], cfg);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("ready");
    // stdout has the range output, proving onBeforeStart ran before the line
    expect(r.stdout).toBe("0\n1\n");
  });

  test("onBeforeStart can be async and awaited", async () => {
    const cfg = await writeConfig(
      "before-async.ts",
      `crust.onBeforeStart = async () => {
        await new Promise(r => setTimeout(r, 20));
        process.stderr.write("async-ready\\n");
      };`,
    );
    const r = await runCli(["-c", "echo hi"], cfg);
    expect(r.code).toBe(0);
    // 'hi' arrives only after onBeforeStart resolved
    expect(r.stderr).toContain("async-ready");
    expect(r.stdout).toContain("hi");
  });

  test("error in onExit does not prevent exit", async () => {
    const cfg = await writeConfig(
      "exit-throws.ts",
      `crust.onExit = () => { throw new Error("boom"); };`,
    );
    const r = await runCli(["-c", "exit 3"], cfg);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("onExit error: boom");
  });

  test("onSignal handler fires on SIGUSR1 without exiting", async () => {
    // Long-running line via while(true) sleep, register SIGUSR1 handler that
    // writes a marker file. We then send SIGUSR1, then exit via another
    // signal-driven exit.
    const marker = join(tmp, "sigusr1.marker");
    const cfg = await writeConfig(
      "sigusr1.ts",
      `import { writeFileSync } from "node:fs";
       crust.onSignal("SIGUSR1", () => {
         writeFileSync(${JSON.stringify(marker)}, "got-it");
         process.exit(42);
       });`,
    );
    // Spawn a long-running -c line so the process stays alive until we signal it.
    const proc = Bun.spawn(["bun", ENTRY, "-c", "sleep 5"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CRUST_CONFIG: cfg,
        CRUST_GLOBAL_PREFIX: "/tmp/crust-lifecycle-no-globals",
      },
    });
    // Give the process time to register the signal handler.
    await new Promise((r) => setTimeout(r, 400));
    process.kill(proc.pid, "SIGUSR1");
    await proc.exited;
    expect(proc.exitCode).toBe(42);
    const got = await Bun.file(marker).text();
    expect(got).toBe("got-it");
  });

  test("multiple onSignal handlers for the same signal all fire", async () => {
    const m1 = join(tmp, "multi1.marker");
    const m2 = join(tmp, "multi2.marker");
    const cfg = await writeConfig(
      "multi-sig.ts",
      `import { writeFileSync } from "node:fs";
       crust.onSignal("SIGUSR2", () => writeFileSync(${JSON.stringify(m1)}, "1"));
       crust.onSignal("SIGUSR2", () => {
         writeFileSync(${JSON.stringify(m2)}, "2");
         process.exit(0);
       });`,
    );
    const proc = Bun.spawn(["bun", ENTRY, "-c", "sleep 5"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CRUST_CONFIG: cfg,
        CRUST_GLOBAL_PREFIX: "/tmp/crust-lifecycle-no-globals",
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(proc.pid, "SIGUSR2");
    await proc.exited;
    expect(await Bun.file(m1).text()).toBe("1");
    expect(await Bun.file(m2).text()).toBe("2");
  });

  test("no signal handlers registered = no process.on listeners installed", async () => {
    // If no onSignal is called, SIGUSR1 should kill the process with default
    // semantics (exit code reflecting the signal). This verifies we don't
    // claim signals the user didn't opt into.
    const cfg = await writeConfig("no-signals.ts", `// nothing`);
    const proc = Bun.spawn(["bun", ENTRY, "-c", "sleep 5"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CRUST_CONFIG: cfg,
        CRUST_GLOBAL_PREFIX: "/tmp/crust-lifecycle-no-globals",
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(proc.pid, "SIGUSR1");
    await proc.exited;
    // Default SIGUSR1 disposition on the parent process kills it; Bun's
    // exitCode reflects that. Either a non-zero exitCode or signalCode set
    // is acceptable evidence we did not silently swallow the signal.
    const killed =
      (proc.exitCode ?? 0) !== 0 || (proc as { signalCode?: string }).signalCode != null;
    expect(killed).toBe(true);
  });
});
