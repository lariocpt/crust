import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { JobManager } from "../src/mcp/jobs";
import { toolByName } from "../src/mcp/tools";
import { preflightProc, procArgv, validateProcLaunch } from "../src/procLaunch";
import { shellEnv } from "../src/shellPath";
import { type ProcSpec, procs } from "../src/sources";
import type { Context } from "../src/types";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing test value");
  return value;
}

const startTool = required(toolByName("crust_procs_start"));
const pwsh = Bun.which("pwsh");

async function runPowerShell(script: string, errorPolicy: "native" | "strict") {
  const child = Bun.spawn(procArgv({ shell: "pwsh", script, errorPolicy, pwsh: required(pwsh) }), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("structured process launches", () => {
  test("preserves POSIX command behavior", () => {
    expect(procArgv({ cmd: "echo $HOME | cat" })).toEqual(["sh", "-c", "echo $HOME | cat"]);
  });

  test("passes literal arguments, cwd and env without a shell", async () => {
    const args = [
      "",
      "two words",
      'a"b',
      "C:\\Users\\Alice\\project\\",
      "|&;$HOME%PATH%",
      "日本語",
    ];
    const lines = await procs({
      echo: {
        executable: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.CRUST_ARG_TEST}))",
          ...args,
        ],
        cwd: tmpdir(),
        env: { CRUST_ARG_TEST: "$literal & value" },
      },
    }).collect();
    const result = JSON.parse(required(lines.find((line) => line.stream === "stdout")).line);
    expect(result).toEqual({ args, cwd: tmpdir(), env: "$literal & value" });
    expect(lines.find((line) => line.stream === "exit")?.line).toBe("exited with code 0");
  });

  test("resolves local tools from the child cwd rather than Crust's cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-child-path-"));
    try {
      const bin = join(dir, "node_modules", ".bin");
      await mkdir(bin, { recursive: true });
      expect(required(shellEnv(dir).PATH).split(delimiter)[0]).toBe(bin);
      if (process.platform === "win32") return;
      const tool = `crust-cwd-tool-${process.pid}`;
      await writeFile(
        join(bin, tool),
        `#!${process.execPath}\nconsole.log("child-local-tool");\n`,
        {
          mode: 0o755,
        },
      );
      const lines = await procs({ child: { executable: tool, cwd: dir } }).collect();
      expect(lines.some((line) => line.line === "child-local-tool")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed launch forms synchronously before any process starts", () => {
    const invalid = [
      {},
      null,
      [],
      { cmd: "" },
      { executable: "" },
      { cmd: "echo ok", executable: "echo" },
      { cmd: "echo ok", args: [] },
      { executable: "echo", args: [1] },
      { executable: "echo", args: ["bad\0argument"] },
      { executable: "npm.cmd" },
      { executable: "script.ps1" },
      { shell: "powershell", script: "echo ok" },
      { shell: "pwsh", script: "" },
      { shell: "pwsh", script: "echo ok", errorPolicy: "typo" },
      { executable: "echo", cwd: 1 },
      { executable: "echo", env: { BAD: 42 } },
      { executable: "echo", typo: true },
    ];
    for (const spec of invalid) {
      expect(() => validateProcLaunch(spec)).toThrow();
      expect(() => procs({ first: "echo must-not-run", bad: spec as ProcSpec })).toThrow();
    }
  });

  test("encodes PowerShell source verbatim without POSIX parsing", () => {
    const script = '$x = "C:\\Users\\Alice"; $x | ForEach-Object { "$_ & 日本語" }';
    const argv = procArgv({ shell: "pwsh", script, pwsh: "/custom/pwsh" });
    expect(argv.slice(0, -1)).toEqual([
      "/custom/pwsh",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(required(argv.at(-1)), "base64").toString("utf16le")).toBe(script);
  });

  test("strict wrapper requires stable native error handling, not stale LASTEXITCODE", () => {
    const script = "exit 23";
    const argv = procArgv({ shell: "pwsh", script, errorPolicy: "strict" });
    const wrapper = Buffer.from(required(argv.at(-1)), "base64").toString("utf16le");
    expect(wrapper).toContain("[version]'7.4'");
    expect(wrapper).toContain("$ErrorActionPreference = 'Stop'");
    expect(wrapper).toContain("$PSNativeCommandUseErrorActionPreference = $true");
    expect(wrapper).toContain(Buffer.from(script, "utf16le").toString("base64"));
    expect(wrapper).not.toContain("$LASTEXITCODE");
  });

  test("preflight passes source as data to the selected interpreter", async () => {
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
      stderr: required(new Response("").body),
    } as never);
    try {
      const script = "Write-Output 'not executed'";
      await preflightProc(
        {
          shell: "pwsh",
          script,
          pwsh: "/custom/pwsh",
          cwd: tmpdir(),
          env: { CRUST_PREFLIGHT_TEST: "value" },
        },
        "ps",
      );
      const [argv, options] = spawn.mock.calls[0] as unknown as [
        string[],
        { stdin: Buffer; cwd: string; env: Record<string, string> },
      ];
      expect(argv[0]).toBe("/custom/pwsh");
      const parser = Buffer.from(required(argv.at(-1)), "base64").toString("utf16le");
      expect(parser).toContain("::ParseInput(");
      expect(parser).not.toContain(script);
      expect(parser).not.toContain("Invoke-Expression");
      expect(options.stdin.toString()).toBe(script);
      expect(options.cwd).toBe(tmpdir());
      expect(options.env.CRUST_PREFLIGHT_TEST).toBe("value");
    } finally {
      spawn.mockRestore();
    }
  });

  test("a failed preflight prevents all app launches and MCP session allocation", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          exited: Promise.resolve(2),
          stderr: required(new Response("line 1: syntax error").body),
        }) as never,
    );
    const commands: Record<string, ProcSpec> = {
      app: { executable: process.execPath, args: ["-e", "throw Error('must not run')"] },
      ps: { shell: "pwsh", script: "invalid source" },
    };
    try {
      await expect(procs(commands).collect()).rejects.toThrow('procs: "ps": line 1');
      expect(spawn).toHaveBeenCalledTimes(1);
      spawn.mockClear();
      const jm = new JobManager({} as Context);
      await expect(jm.startProcs(commands, 100)).rejects.toThrow("syntax error");
      expect(jm.listStream()).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });

  test("preflight times out and kills a stalled interpreter", async () => {
    const kill = mock(() => {});
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: new Promise(() => {}),
      stderr: required(new Response("").body),
      kill,
    } as never);
    try {
      await expect(preflightProc({ shell: "pwsh", script: "1" }, "stalled", 20)).rejects.toThrow(
        "timed out",
      );
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      spawn.mockRestore();
    }
  });

  test("an already-aborted supervisor never spawns a process", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = spyOn(Bun, "spawn");
    try {
      await expect(
        procs({ app: { executable: process.execPath } }, { signal: controller.signal }).collect(),
      ).rejects.toThrow(/abort/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("abort during preflight kills the parser and prevents every app launch", async () => {
    const controller = new AbortController();
    const exited = Promise.withResolvers<number>();
    const kill = mock(() => exited.resolve(0));
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: exited.promise,
      stderr: required(new Response("").body),
      kill,
    } as never);
    try {
      const collecting = procs(
        {
          app: { executable: process.execPath },
          first: { shell: "pwsh", script: "1" },
          second: { shell: "pwsh", script: "2" },
        },
        { signal: controller.signal },
      ).collect();
      const outcome = collecting.then(
        () => null,
        (error: Error) => error,
      );
      await Promise.resolve();
      expect(spawn).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(required(await outcome).message).toMatch(/abort/i);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });

  test("stopAll cancels pending preflight and blocks starts until teardown completes", async () => {
    const exited = Promise.withResolvers<number>();
    const kill = mock(() => {});
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: exited.promise,
      stderr: required(new Response("").body),
      kill,
    } as never);
    const jm = new JobManager({} as Context);
    try {
      const starting = jm.startProcs(
        {
          ps: { shell: "pwsh", script: "1" },
          app: { executable: process.execPath },
        },
        100,
      );
      const outcome = starting.then(
        () => null,
        (error: Error) => error,
      );
      expect(spawn).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = jm.stopAll().then(() => {
        stopped = true;
      });
      await expect(jm.startProcs({ late: "echo must-not-run" }, 100)).rejects.toThrow(
        "teardown in progress",
      );
      expect(stopped).toBe(false);
      exited.resolve(0);
      await stopping;
      expect(required(await outcome).message).toMatch(/abort/i);
      expect(stopped).toBe(true);
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(jm.listStream()).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      exited.resolve(0);
      await jm.stopAll();
      spawn.mockRestore();
    }
    const job = await jm.startProcs(
      {
        app: { executable: process.execPath, args: ["-e", "console.log('reused')"] },
      },
      100,
    );
    try {
      await job.pumpDone;
      expect(job.sourceError).toBeNull();
      expect(jm.listStream()).toHaveLength(1);
    } finally {
      await jm.stopAll();
    }
  });

  test("stopAll also cancels the preparation-to-registration microtask window", async () => {
    const spawn = spyOn(Bun, "spawn");
    const jm = new JobManager({} as Context);
    try {
      const starting = jm.startProcs({ app: { executable: process.execPath } }, 100);
      const outcome = starting.then(
        () => null,
        (error: Error) => error,
      );
      await jm.stopAll();
      expect(required(await outcome).message).toMatch(/abort/i);
      expect(jm.listStream()).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await jm.stopAll();
      spawn.mockRestore();
    }
  });

  test("missing PowerShell interpreter fails before MCP allocates a session", async () => {
    const jm = new JobManager({} as Context);
    await expect(
      jm.startProcs(
        {
          ps: { shell: "pwsh", script: "1", pwsh: "/nonexistent/crust-test-pwsh" },
        },
        100,
      ),
    ).rejects.toThrow('procs: "ps":');
    expect(jm.listStream()).toEqual([]);
  });

  test("MCP rejects invalid launch before allocating a session", async () => {
    const jm = new JobManager({} as Context);
    await expect(
      startTool.run(jm, {
        commands: { bad: { executable: "echo", cmd: "echo wrong" } },
      }),
    ).rejects.toThrow("conflicting");
    expect(jm.listStream()).toEqual([]);
  });

  test("MCP runs a direct executable through its held session", async () => {
    const jm = new JobManager({} as Context);
    await startTool.run(jm, {
      commands: {
        echo: { executable: process.execPath, args: ["-e", 'console.log("direct MCP")'] },
      },
    });
    const job = required(jm.listStream()[0]);
    try {
      await job.pumpDone;
      expect(job.sourceError).toBeNull();
      const result = await jm.queryStream(job.id, "", {});
      expect(result.items.join("\n")).toContain("direct MCP");
    } finally {
      await jm.stopStream(job.id);
    }
  });
});

describe.skipIf(!pwsh)("real PowerShell", () => {
  test("native policy preserves explicit exits and allows recovery after errors", async () => {
    expect((await runPowerShell("exit 23", "native")).code).toBe(23);
    const result = await runPowerShell("Write-Error 'failure'; Write-Output 'continued'", "native");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("continued");
  }, 30_000);

  test("parser rejects malformed syntax before any script side effects", async () => {
    await expect(
      preflightProc(
        {
          shell: "pwsh",
          script: "throw 'must never execute'; Write-Output 'unterminated",
          pwsh: required(pwsh),
        },
        "syntax",
      ),
    ).rejects.toThrow("line 1");
    await preflightProc(
      {
        shell: "pwsh",
        script: "throw 'valid syntax but must never execute'",
        pwsh: required(pwsh),
      },
      "parse-only",
    );
  }, 15_000);

  test("strict policy accepts supported versions and rejects older runtimes", async () => {
    const versionResult = await runPowerShell("$PSVersionTable.PSVersion.ToString()", "native");
    expect(versionResult.code).toBe(0);
    const [major, minor] = versionResult.stdout.trim().split(".").map(Number);
    const supportsStrict = required(major) > 7 || (major === 7 && required(minor) >= 4);
    if (!supportsStrict) {
      const result = await runPowerShell("Write-Output 'must-not-run'", "strict");
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("requires 7.4+");
      expect(result.stdout).not.toContain("must-not-run");
      await expect(
        preflightProc(
          {
            shell: "pwsh",
            script: "1",
            pwsh: required(pwsh),
            errorPolicy: "strict",
          },
          "version",
        ),
      ).rejects.toThrow("requires 7.4+");
      return;
    }
    await preflightProc(
      {
        shell: "pwsh",
        script: "1",
        pwsh: required(pwsh),
        errorPolicy: "strict",
      },
      "supported",
    );
    expect((await runPowerShell("exit 23", "strict")).code).toBe(23);
    const error = await runPowerShell("Write-Error 'failure'; 'must-not-run'", "strict");
    expect(error.code).toBe(1);
    expect(error.stdout).not.toContain("must-not-run");
    const executable = process.execPath.replaceAll("'", "''");
    const script = `& '${executable}' -e 'process.exit(7)'; Write-Output 'continued'`;
    const strict = await runPowerShell(script, "strict");
    expect(strict.code).toBe(1);
    expect(strict.stdout).not.toContain("continued");
    expect((await runPowerShell(script, "native")).code).toBe(0);
    expect((await runPowerShell("try { throw 'handled' } catch {}; 'ok'", "strict")).code).toBe(0);
  }, 30_000);
});
