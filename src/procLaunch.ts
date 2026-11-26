import { shellEnv } from "./shellPath";

export type ProcLaunch =
  | {
      cmd: string;
      executable?: never;
      args?: never;
      shell?: never;
      script?: never;
      pwsh?: never;
      errorPolicy?: never;
    }
  | {
      executable: string;
      args?: string[];
      cmd?: never;
      shell?: never;
      script?: never;
      pwsh?: never;
      errorPolicy?: never;
    }
  | {
      shell: "pwsh";
      script: string;
      pwsh?: string;
      errorPolicy?: "native" | "strict";
      cmd?: never;
      executable?: never;
      args?: never;
    };

const launchKeys = ["cmd", "executable", "args", "shell", "script", "pwsh", "errorPolicy"];
const commonKeys = ["cwd", "env", "restart", "ready", "live", "after"];

const strictVersionCheck =
  "if ($PSVersionTable.PSVersion -lt [version]'7.4') { [Console]::Error.WriteLine('crust: strict PowerShell requires 7.4+'); exit 2 }";

/** Parse source as data, never invoke it. Checks finish before any app spawns. */
export async function preflightProc(
  spec: ProcLaunch & { cwd?: string; env?: Record<string, string> },
  name: string,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (spec.shell !== "pwsh") return;
  const source = [
    spec.errorPolicy === "strict" ? strictVersionCheck : "",
    "[Console]::InputEncoding = [Text.Encoding]::UTF8",
    "$source = [Console]::In.ReadToEnd()",
    "$tokens = $null; $parseErrors = $null",
    "$null = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)",
    "if ($parseErrors.Count -gt 0) {",
    "  foreach ($item in $parseErrors) { [Console]::Error.WriteLine(('line {0}: {1}' -f $item.Extent.StartLineNumber, $item.Message)) }",
    "  exit 2",
    "}",
    "exit 0",
  ].join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const child = Bun.spawn(
      [
        spec.pwsh ?? "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(source, "utf16le").toString("base64"),
      ],
      {
        cwd: spec.cwd,
        env: { ...shellEnv(spec.cwd), FORCE_COLOR: "0", ...spec.env },
        stdin: Buffer.from(spec.script, "utf8"),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const diagnostics = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of child.stderr) {
        if (text.length < 65_536) text += decoder.decode(chunk, { stream: true });
      }
      return text.slice(0, 65_536);
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`PowerShell preflight timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        child.kill("SIGKILL");
        void child.exited.then(() => reject(new Error("PowerShell preflight aborted")), reject);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const [code, stderr] = await Promise.race([
      Promise.all([child.exited, diagnostics]),
      deadline,
      aborted,
    ]);
    signal?.throwIfAborted();
    if (code !== 0)
      throw new Error(stderr.trim() || `PowerShell preflight exited with code ${code}`);
  } catch (error) {
    throw new Error(`procs: "${name}": ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

/** Validate before spawning anything; argv is never tokenized or interpolated. */
export function validateProcLaunch(value: unknown, name = "process"): asserts value is ProcLaunch {
  const fail = (detail: string): never => {
    throw new Error(`procs: "${name}": ${detail}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected a process spec");
  const spec = value as Record<string, unknown>;
  for (const key of Object.keys(spec)) {
    if (![...launchKeys, ...commonKeys].includes(key)) fail(`unknown field "${key}"`);
  }
  const mode = "cmd" in spec ? "cmd" : "executable" in spec ? "executable" : "shell";
  const allowed =
    mode === "cmd"
      ? ["cmd"]
      : mode === "executable"
        ? ["executable", "args"]
        : ["shell", "script", "pwsh", "errorPolicy"];
  for (const key of launchKeys) {
    if (key in spec && !allowed.includes(key)) fail(`conflicting launch field "${key}"`);
  }
  if (mode === "cmd") {
    if (!text(spec.cmd)) fail("cmd must be a nonempty string without NUL");
  } else if (mode === "executable") {
    if (!text(spec.executable)) fail("executable must be a nonempty string without NUL");
    if (/\.(cmd|bat|ps1)$/i.test(spec.executable as string))
      fail("scripts require an explicit interpreter executable");
    if (
      spec.args !== undefined &&
      (!Array.isArray(spec.args) ||
        !spec.args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0")))
    )
      fail("args must be an array of strings without NUL");
  } else {
    if (spec.shell !== "pwsh" || !text(spec.script))
      fail('expected {shell: "pwsh", script: nonempty string}');
    if (spec.pwsh !== undefined && !text(spec.pwsh))
      fail("pwsh must be an executable name or path");
    if (
      spec.errorPolicy !== undefined &&
      spec.errorPolicy !== "native" &&
      spec.errorPolicy !== "strict"
    )
      fail("errorPolicy must be native or strict");
  }
  if (spec.cwd !== undefined && !text(spec.cwd)) fail("cwd must be a nonempty path");
  if (
    spec.env !== undefined &&
    (!spec.env ||
      typeof spec.env !== "object" ||
      Array.isArray(spec.env) ||
      !Object.entries(spec.env).every(
        ([key, val]) =>
          text(key) && !key.includes("=") && typeof val === "string" && !val.includes("\0"),
      ))
  )
    fail("env must map valid environment names to strings");
}

/**
 * Native mode leaves PowerShell semantics untouched. Strict mode deliberately
 * requires 7.4+ (stable PSNativeCommandUseErrorActionPreference), fails on
 * unhandled cmdlet/native errors, and maps caught failures to 1. Explicit exit
 * remains the script's decision; caught/suppressed errors can still succeed.
 */
export function procArgv(spec: ProcLaunch): string[] {
  if (spec.cmd !== undefined) return ["sh", "-c", spec.cmd];
  if (spec.executable !== undefined) return [spec.executable, ...(spec.args ?? [])];
  let source = spec.script;
  if (spec.errorPolicy === "strict") {
    const encoded = Buffer.from(source, "utf16le").toString("base64");
    source = [
      strictVersionCheck,
      "$ErrorActionPreference = 'Stop'",
      "$PSNativeCommandUseErrorActionPreference = $true",
      "try {",
      `  & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`,
      "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
    ].join("\n");
  }
  return [
    spec.pwsh ?? "pwsh",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64"),
  ];
}
