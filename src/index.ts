#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { hasUnquotedShellMeta, splitArgs, stripTrailingComment } from "./args";
import { registerBuiltinFns } from "./builtinFns";
import {
  dotenvLoad,
  isBuiltin,
  notACommandReason,
  renderBuiltinList,
  standaloneTools,
} from "./builtins";
import { checkBuiltinLine } from "./checkBuiltin";
import { type CrustGlobal, loadConfig } from "./config";
import { onInterrupt, onSuspend, readLine, suspendEditor } from "./editor";
import { appendHistory, loadHistory } from "./history";
import { resumeStoppedJobs } from "./jobs";
import { shellSyntaxPreflight, tokenize } from "./lexer";
import { HelpExit, parse } from "./parser";
import { setPositionals } from "./positionals";
import { defaultPrompt } from "./prompt";
import { runLine, runLines, splitLines } from "./runLine";
import { markStdinConsumed } from "./sources";
import type { Context } from "./types";

interface UserCrustGlobals {
  prompt?: (cwd: string, git: string | null, ctx?: Context) => string;
}

const USAGE = `crust ${pkg.version} — the whole test stack, baked into one binary
usage:
  crust                    start interactive REPL
  crust <tool> <args…>     run one tool as a command (skills, mock-server,
                           verify-web-links, gen-fixtures, test-fixture,
                           test-pipes) — the same verbs as at the REPL. The
                           session verbs (cd, export, alias, source, dotenv,
                           logs) are not: they need a running session.
  crust <file.crust>       run a script file and exit
  crust -c <line>          run one line and exit
  crust --check <line>     parse without running (lint documented examples)
  crust mcp                serve the Model Context Protocol over stdio —
                           every crust capability as a direct MCP tool; the
                           host owns stdin/stdout, so this is a shell
                           command, never a line at the REPL.
  cmd | crust              run lines piped on stdin and exit
  crust --env-file <path>  load a .env before running (any run mode; missing
                           file exits 2 — loudly, never a silent no-op)
  crust -h | --help        show this help
  crust -V | --version     show version

${renderBuiltinList()}`;

async function shutdown(code: number): Promise<never> {
  // A STOPPED job that outlives crust stays in `T` forever: SIGSTOP survives
  // reparenting, and no shell resumes a process it did not stop itself, so an
  // orphan suspended here is a leaked process until someone reboots. RUNNING jobs
  // are deliberately left alone — outliving the session is what `&` means, and the
  // docs say so. Stopped ones get resumed and named, which is the honest version
  // of zsh's "you have stopped jobs" warning: it says what happened, not just what
  // the user is about to lose.
  const stranded = resumeStoppedJobs();
  if (stranded.length > 0) {
    process.stderr.write(
      `crust: resumed ${stranded.length} stopped job(s) so they would not be orphaned suspended:` +
        ` ${stranded.map((j) => `[${j.index}] ${j.label}`).join(", ")}\n`,
    );
  }
  const userCrust = (globalThis as { crust?: CrustGlobal }).crust;
  if (userCrust?.onExit) {
    try {
      await userCrust.onExit(code);
    } catch (err) {
      process.stderr.write(`crust: onExit error: ${(err as Error).message}\n`);
    }
  }
  process.exit(code);
}

function newContext(history: string[]): Context {
  const ctx: Context = {
    aliases: new Map(),
    functions: new Map(),
    history,
    exit: (code) => shutdown(code ?? 0),
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
  };
  return ctx;
}

async function bootstrapCtx(history: string[] = [], envFile?: string): Promise<Context> {
  const ctx = newContext(history);
  // --env-file loads BEFORE init.ts so config code can read the vars. A
  // missing file exits 2 loudly — the point of the flag is replacing shell
  // shims whose silent env failures made runs measure the wrong thing.
  if (envFile !== undefined) {
    const code = await dotenvLoad(ctx, envFile, "overwrite", (s) => void process.stderr.write(s));
    if (code !== 0) process.exit(2);
  }
  await loadConfig(ctx, process.env.CRUST_CONFIG);
  const userCrust = (globalThis as { crust?: CrustGlobal }).crust;
  if (userCrust?.onBeforeStart) {
    try {
      await userCrust.onBeforeStart();
    } catch (err) {
      process.stderr.write(`crust: onBeforeStart error: ${(err as Error).message}\n`);
    }
  }
  return ctx;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Peel --env-file first — it composes with every RUN mode (-c, script,
  // piped stdin, REPL). Not with --check, which is parse-only by contract
  // (the website's CI checks examples on machines with no env files).
  let envFile: string | undefined;
  {
    const i = argv.findIndex((a) => a === "--env-file" || a.startsWith("--env-file="));
    if (i !== -1) {
      const a = argv[i]!;
      if (a.startsWith("--env-file=")) {
        envFile = a.slice("--env-file=".length);
        argv.splice(i, 1);
      } else {
        envFile = argv[i + 1];
        argv.splice(i, 2);
      }
      if (!envFile || envFile.startsWith("-")) {
        process.stderr.write("crust: --env-file requires a path\n");
        process.exit(2);
      }
      if (argv[0] === "--check") {
        process.stderr.write("crust: --env-file does not combine with --check (parse-only)\n");
        process.exit(2);
      }
    }
  }

  if (argv.length > 0) {
    const flag = argv[0]!;
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (flag === "-V" || flag === "--version") {
      // `crust <version>`, not a bare version: CI pastes this line into logs
      // that interleave tools, and a bare `0.2.0-dev` names no tool. Readers
      // updated in the same commit: tests/cli.test.ts, the Jenkinsfile, and
      // .github/workflows/release.yml all compare this line exactly.
      process.stdout.write(`crust ${pkg.version}\n`);
      process.exit(0);
    }
    if (flag === "-c") {
      if (argv.length < 2) {
        process.stderr.write("crust: -c requires an argument\n");
        process.exit(2);
      }
      // Trailing operands used to be dropped in silence while script mode
      // rejected them — so `crust -c 'a' 'b'` ran only `a` and exited 0.
      if (argv.length > 2) {
        process.stderr.write(
          `crust: -c takes one line — got ${argv.length - 1}. ` +
            "Quote the whole pipeline, or separate lines with a newline inside one argument.\n",
        );
        process.exit(2);
      }
      const ctx = await bootstrapCtx([], envFile);
      // Fail fast: stop at the first failing line and exit with ITS code —
      // previously a later success masked an earlier failure.
      await shutdown(await runLines(argv[1]!, ctx));
    }
    // Parse without running: the linter for documented examples. Building a
    // pipeline touches no filesystem and runs nothing — every source is a lazy
    // generator — so an example referencing fixtures/*.json or :3000 checks clean
    // on a machine that has neither. The one exception is sh in NOEXEC mode
    // (`sh -n`), which parses a shell stage's text and cannot execute it.
    // That is what lets a SEPARATE repo (the website) validate its own code
    // blocks: it cannot import crust's lexer, but it can run the binary it
    // already has.
    if (flag === "--check") {
      if (argv.length < 2) {
        process.stderr.write("crust: --check requires a line\n");
        process.exit(2);
      }
      const ctx = newContext([]);
      registerBuiltinFns(ctx);
      let checked = 0;
      // Same line-splitting as the runtime, so what the linter checks is what
      // crust runs — including `\` continuation, which is how the multi-line
      // examples in docs and on the website are written.
      for (const raw of splitLines(argv[1]!)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        // A builtin line is not a pipeline — the parser would classify it as an
        // opaque shell stage and call anything "ok", which is how stale
        // invocations survived in the docs and the shipped skills. Validate it
        // against the CLI's own flag spec instead.
        const head = line.split(/\s+/)[0] ?? "";
        if (isBuiltin(head) && !hasUnquotedShellMeta(line)) {
          const problem = await checkBuiltinLine(
            head,
            splitArgs(stripTrailingComment(line.slice(head.length).trim())),
          );
          if (problem) {
            process.stderr.write(`crust: ${problem}\n  in: ${line}\n`);
            process.exit(1);
          }
          checked++;
          continue;
        }
        try {
          parse(line)(ctx);
        } catch (err) {
          if (err instanceof HelpExit) {
            // `fn --help` is a valid line — the usage prints when it RUNS,
            // not when it is checked — so it checks clean like any other.
            checked++;
            continue;
          }
          process.stderr.write(`crust: ${(err as Error).message}\n  in: ${line}\n`);
          process.exit(1);
        }
        // parse() proved crust's own grammar. A stage that fell through to
        // `shell` is opaque to it — the text is only ever read by sh — so ask
        // sh, in NOEXEC mode. Without this, a line malformed enough to be
        // classified as shell checked "ok" and then exited 2 at runtime —
        // `range(1,` did — which is exactly how a broken documented example
        // reaches the website: the fallback hides the mistake from the one
        // tool meant to catch it. The same preflight now guards the exec path
        // too (src/runLine.ts, F19); check mode keeps its exit 1.
        const problem = await shellSyntaxPreflight(tokenize(line));
        if (problem) {
          const where = problem.stage === line ? "" : ` (stage: ${problem.stage})`;
          process.stderr.write(
            `crust: shell stage does not parse${where}: ${problem.first}\n  in: ${line}\n`,
          );
          process.exit(1);
        }
        checked++;
      }
      process.stdout.write(`ok: ${checked} line(s) parse\n`);
      process.exit(0);
    }
    // `crust mcp` — the Model Context Protocol server. A MODE, not a tool
    // builtin: it takes over stdin/stdout for the JSON-RPC connection, which
    // only makes sense as a whole process the MCP host spawns — a REPL line
    // `mcp` would fight the editor for the terminal (runLine refuses it).
    if (flag === "mcp") {
      const rest = argv.slice(1);
      if (rest[0] === "-h" || rest[0] === "--help") {
        const { MCP_USAGE } = await import("./mcp/server");
        process.stdout.write(MCP_USAGE);
        process.exit(0);
      }
      if (rest.length > 0) {
        process.stderr.write(
          `crust: mcp takes no arguments (it speaks JSON-RPC on stdin) — got ${rest.join(" ")}\n`,
        );
        process.exit(2);
      }
      const { runMcp } = await import("./mcp/server");
      await shutdown(await runMcp({ envFile }));
    }
    if (flag.startsWith("-")) {
      process.stderr.write(`crust: unsupported argument: ${flag}\n`);
      process.exit(2);
    }
    // `crust skills install`, `crust mock-server openapi.json` … — a tool
    // builtin as argv[0] is a COMMAND, not a script path. See `standaloneTools`
    // for which names qualify and why the session builtins do not. Booted the
    // same way `-c` is, so `crust --env-file . env mock-server x` and the init.ts
    // hooks behave identically whichever spelling was used.
    // A real file wins when it is ALL that was given, so an existing script
    // named after a tool (or a builtin) keeps running as a script. With extra
    // arguments present the file reading is not even attempted, so the command
    // reading is the only possible one.
    const asScript = argv.length === 1 && (await Bun.file(flag).exists());
    const tool = standaloneTools[flag];
    if (tool && !asScript) {
      // The tool runners read the process, not the session, but booting the
      // context anyway is what makes `crust --env-file . skills install` work.
      await bootstrapCtx([], envFile);
      await shutdown(await tool(argv.slice(1)));
    }
    // `crust cd /tmp`, `crust export FOO=1`, `crust logs tail app.log` — named
    // at argv[0] but not runnable as a command. Letting script mode answer would
    // say `cannot read export` (127), which reads as a broken installation in a
    // binary that is printing its own name. This is the half of the rule the
    // session builtins need.
    const misuse = notACommandReason(flag);
    if (misuse && !asScript) {
      process.stderr.write(`crust: ${misuse}\n`);
      process.exit(2);
    }
    // Script mode: `crust file.crust a b` — the extras are the script's
    // positional arguments ($0..$#), not a feature we refuse. They are
    // module state read by expandEnv (src/positionals.ts), never process.env.
    // A leading `--` separates crust's argv from the script's, as in sh.
    const posArgv = argv.slice(1);
    if (posArgv[0] === "--") posArgv.splice(0, 1);
    setPositionals(flag, posArgv);
    let source: string;
    try {
      source = await Bun.file(flag).text();
    } catch (err) {
      process.stderr.write(`crust: cannot read ${flag}: ${(err as Error).message}\n`);
      process.exit(127);
    }
    const ctx = await bootstrapCtx([], envFile);
    await shutdown(await runLines(source, ctx));
  }

  if (!process.stdin.isTTY) {
    // Piped stdin: `echo 'range(1,3)' | crust`. Read to EOF FIRST, then run —
    // pure-shell lines inherit fd 0, so draining the pipe up front means
    // child sh processes see EOF instead of eating script text. The editor
    // never installs its stdin listener on this path.
    markStdinConsumed("the script (bare `cmd | crust` treats piped stdin as lines to RUN)");
    const source = await Bun.stdin.text();
    const ctx = await bootstrapCtx([], envFile);
    await shutdown(await runLines(source, ctx));
  }

  const ctx = await bootstrapCtx(await loadHistory(), envFile);

  while (true) {
    const uc = (globalThis as { crust?: UserCrustGlobals }).crust;
    const prompt = uc?.prompt ? uc.prompt(process.cwd(), null, ctx) : defaultPrompt(ctx);

    let line: string | null;
    try {
      line = await readLine({ prompt, history: ctx.history });
    } catch (err) {
      process.stderr.write(`crust: editor error: ${(err as Error).message}\n`);
      continue;
    }

    if (line === null) {
      // Ctrl-D on empty buffer
      await shutdown(0);
      return;
    }

    if (!line.trim()) continue;
    await appendHistory(line, ctx.history);
    await runLine(line, ctx, { onInterrupt, onSuspend, suspend: suspendEditor });
  }
}

main().catch((err) => {
  process.stderr.write(`crust: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
