#!/usr/bin/env bun
// The crust-site CLI — `crust-site build [configFile]` and
// `crust-site dev [configFile]`.
//
// Exit codes 0/1/2 (the parseFlags convention the crust binary uses: 2 for
// argument errors, 1 for runtime failure, 0 for success and --help).
//
//   build — run the SSG pipeline. Warnings (if any) print as formatted
//           diagnostics; a success prints one summary line (pages / assets /
//           duration → output directory) and exits 0. A failed build prints
//           EVERY collected diagnostic (`severity[code]: message` +
//           `--> sourcePath:line:col`, ANSI only when stderr is a TTY) and
//           exits 1. Diagnostics never go to stdout: stdout carries the
//           machine-consumed summary (and nothing else on failure).
//   dev   — the dev server. The CLI is a thin SUPERVISOR: it spawns a
//           worker child (this same file re-execed with the
//           CRUST_SITE_DEV_WORKER=1 environment marker) and RESTARTS it when
//           it exits with the sentinel code 75 (a code/config change — a
//           fresh process is the only way to re-import transitively imported
//           code). Ctrl-C and SIGTERM are forwarded to the worker and the
//           wrapper exits with the worker's code (130 for a SIGINT death —
//           measured: Bun resolves `exited` with 128+signal for signal
//           deaths). A worker death for ANY other reason (initial build
//           failure, port in use, a crash) ends the wrapper with that code —
//           a failing build must never respawn in a loop.
//
// The parser here is self-contained on purpose: this package is shipped to
// npm and must not import from the crust source tree (which stays
// zero-dependency). Later chunks extend the shape, not the convention.

import { build } from "./build.ts";
import { startDev } from "./dev.ts";
import { BuildError, type Diagnostic, formatDiagnostics } from "./diagnostics.ts";

const USAGE = `crust-site — the crust site generator (run under Bun)
usage:
  crust-site build [configFile]   render the site into output.directory
  crust-site dev [configFile]     start the dev server (rebuilds on change)
  crust-site --help               show this help

configFile defaults to ./site.config.ts
exit codes: 0 ok/help, 1 runtime failure, 2 argument error
`;

const COMMANDS = new Set(["build", "dev"]);
/** The worker marker: set by the wrapper on the child's environment. */
const WORKER_ENV = "CRUST_SITE_DEV_WORKER";
/** The worker's sentinel exit: "code/config changed — restart me". */
const RESTART_EXIT = 75;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One diagnostics block on stderr, ANSI only when stderr is a TTY. */
function printDiagnostics(diags: readonly Diagnostic[]): void {
  process.stderr.write(`${formatDiagnostics(diags, { color: process.stderr.isTTY === true })}\n`);
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

async function runBuild(configFile: string | undefined): Promise<number> {
  try {
    const result = await build({ configFile: configFile ?? "" });
    if (result.warnings.length > 0) printDiagnostics(result.warnings);
    const assets = Object.keys(result.assets).length;
    process.stdout.write(
      `crust-site: built ${result.pages.length} page${result.pages.length === 1 ? "" : "s"}, ` +
        `${assets} asset${assets === 1 ? "" : "s"}, ${result.durationMs} ms → ${result.outputDirectory}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof BuildError) {
      printDiagnostics(e.diagnostics);
      return 1;
    }
    process.stderr.write(`crust-site: build failed: ${messageOf(e)}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// dev: wrapper ↔ worker
// ---------------------------------------------------------------------------

/**
 * The WORKER: start the dev server in-process. A code/config change ends the
 * process with the RESTART_EXIT sentinel (the wrapper re-execs it); every
 * other failure (config load, initial build, port in use) exits 1 with the
 * formatted diagnostics — a failing build never respawns in a loop.
 */
async function runDevWorker(configFile: string | undefined): Promise<number> {
  let server: Awaited<ReturnType<typeof startDev>>;
  try {
    server = await startDev({
      configFile: configFile ?? "",
      onCodeChange: () => process.exit(RESTART_EXIT),
    });
  } catch (e) {
    if (e instanceof BuildError) {
      process.stderr.write(`crust-site: dev failed: ${e.message}\n`);
      printDiagnostics(e.diagnostics);
    } else {
      process.stderr.write(`crust-site: dev failed: ${messageOf(e)}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `crust-site dev: serving http://${server.hostname}:${server.port}/ — ` +
      `Ctrl-C to stop (edits to content rebuild in place, code/config changes restart the worker)\n`,
  );
  // Signal deaths: a clean stop (watcher + server + staging) and the
  // conventional 128+signal code (SIGINT → 130, SIGTERM → 143). The stop is
  // best-effort: a fallback timer exits anyway if it hangs.
  let stopping = false;
  const stopAndExit = (code: number): void => {
    if (stopping) return;
    stopping = true;
    const fallback = setTimeout(() => process.exit(code), 2000);
    fallback.unref?.();
    void server.stop().then(
      () => {
        clearTimeout(fallback);
        process.exit(code);
      },
      () => process.exit(code),
    );
  };
  process.on("SIGINT", () => stopAndExit(130));
  process.on("SIGTERM", () => stopAndExit(143));
  // Run until onCodeChange exits the process or a signal arrives.
  await new Promise<never>(() => {});
  return 130; // unreachable
}

/**
 * The WRAPPER: spawn this file as the worker, forward SIGINT/SIGTERM, and
 * restart on the sentinel. `process.argv[1]` is this script (the bin entry),
 * so the re-exec is `bun <this file> dev [configFile]`.
 */
async function runDevWrapper(configFile: string | undefined): Promise<number> {
  const script = process.argv[1];
  if (typeof script !== "string" || script === "") {
    process.stderr.write("crust-site: cannot re-exec the dev worker (no script path)\n");
    return 1;
  }
  const args = ["dev", ...(configFile === undefined ? [] : [configFile])];
  for (;;) {
    let shuttingDown = false;
    // Installed BEFORE the spawn: a signal in the spawn window must not
    // orphan a starting worker.
    const forward = (signal: "SIGINT" | "SIGTERM"): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        child.kill(signal);
      } catch {
        // the child already exited
      }
    };
    const onInt = (): void => forward("SIGINT");
    const onTerm = (): void => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn(["bun", script, ...args], {
        env: { ...process.env, [WORKER_ENV]: "1" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (e) {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.stderr.write(`crust-site: could not spawn the dev worker: ${messageOf(e)}\n`);
      return 1;
    }
    const code = await child.exited;
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    // Restart ONLY on the sentinel and only if a signal did not cause the
    // exit: a Ctrl-C that raced the sentinel must end the session, not
    // respawn a server the user asked to stop. (Signal deaths arrive as
    // 128+signal codes — measured: Bun resolves `exited` with 130 for
    // SIGINT, 137 for SIGKILL — so a real exit code is always a number.)
    if (!shuttingDown && code === RESTART_EXIT) {
      process.stderr.write("crust-site dev: code or config changed — restarting the dev worker\n");
      continue;
    }
    return code;
  }
}

async function runDev(configFile: string | undefined): Promise<number> {
  if (process.env[WORKER_ENV] === "1") return runDevWorker(configFile);
  return runDevWrapper(configFile);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): number | Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    // A bare invocation has no subcommand — nothing ran, so the answer is
    // the usage and a nonzero code, never a success exit.
    process.stderr.write(USAGE);
    return 2;
  }

  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    process.stderr.write(
      `crust-site: unknown subcommand "${command}" (valid: build, dev)\n\n${USAGE}`,
    );
    return 2;
  }

  // `--help`/`-h` alongside a command is still a help request: the usage
  // goes to stdout and the exit is 0 (the parseFlags convention — help is a
  // success, not an argument error). Checked BEFORE the arity rules so
  // `build --help` is help, not "takes at most one argument".
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  // `build`/`dev` take AT MOST one positional (the config file). A second
  // one, or a flag-shaped one, is refused rather than dropped: a silently
  // ignored argument is a false pass wearing a success exit.
  if (rest.length > 1 || (rest.length === 1 && rest[0]!.startsWith("-"))) {
    process.stderr.write(
      `crust-site: ${command} takes at most one argument (configFile)\n\n${USAGE}`,
    );
    return 2;
  }

  if (command === "build") return runBuild(rest[0]);
  return runDev(rest[0]);
}

void (async () => {
  const result = main();
  const code = typeof result === "number" ? result : await result;
  process.exit(code);
})();
