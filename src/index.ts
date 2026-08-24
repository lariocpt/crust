#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { hasUnquotedShellMeta, splitArgs, stripTrailingComment } from "./args";
import { registerBuiltinFns } from "./builtinFns";
import { dotenvLoad, isBuiltin, renderBuiltinList } from "./builtins";
import { checkBuiltinLine } from "./checkBuiltin";
import { type CrustGlobal, loadConfig } from "./config";
import { onInterrupt, readLine, suspendEditor } from "./editor";
import { appendHistory, loadHistory } from "./history";
import { parse } from "./parser";
import { defaultPrompt } from "./prompt";
import { runLine, runLines } from "./runLine";
import { markStdinConsumed } from "./sources";
import type { Context } from "./types";

interface UserCrustGlobals {
  prompt?: (cwd: string, git: string | null, ctx?: Context) => string;
}

const USAGE = `crust ${pkg.version} — pipeline-first devops toolkit on Bun
usage:
  crust                    start interactive REPL
  crust <file.crust>       run a script file and exit
  crust -c <line>          run one line and exit
  crust --check <line>     parse without running (lint documented examples)
  cmd | crust              run lines piped on stdin and exit
  crust --env-file <path>  load a .env before running (any run mode; missing
                           file exits 2 — loudly, never a silent no-op)
  crust -h | --help        show this help
  crust -V | --version     show version

${renderBuiltinList()}`;

async function shutdown(code: number): Promise<never> {
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
      process.stdout.write(`${pkg.version}\n`);
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
    // pipeline touches no filesystem and spawns nothing — every source is a
    // lazy generator — so an example referencing fixtures/*.json or :3000 checks
    // clean on a machine that has neither. That is what lets a SEPARATE repo
    // (the website) validate its own code blocks: it cannot import crust's
    // lexer, but it can run the binary it already has.
    if (flag === "--check") {
      if (argv.length < 2) {
        process.stderr.write("crust: --check requires a line\n");
        process.exit(2);
      }
      const ctx = newContext([]);
      registerBuiltinFns(ctx);
      let checked = 0;
      for (const raw of argv[1]!.split("\n")) {
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
          checked++;
        } catch (err) {
          process.stderr.write(`crust: ${(err as Error).message}\n  in: ${line}\n`);
          process.exit(1);
        }
      }
      process.stdout.write(`ok: ${checked} line(s) parse\n`);
      process.exit(0);
    }
    if (flag.startsWith("-")) {
      process.stderr.write(`crust: unsupported argument: ${flag}\n`);
      process.exit(2);
    }
    // Script mode: `crust file.crust`. Positional args are not supported —
    // rejecting (not ignoring) them keeps `crust deploy.crust prod` from
    // silently doing nothing prod-related, and surfaces shebang operands.
    if (argv.length > 1) {
      process.stderr.write(`crust: script arguments are not supported — got "${argv[1]}"\n`);
      process.exit(2);
    }
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
    await runLine(line, ctx, { onInterrupt, suspend: suspendEditor });
  }
}

main().catch((err) => {
  process.stderr.write(`crust: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
