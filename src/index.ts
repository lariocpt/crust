#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { renderBuiltinList } from "./builtins";
import { type CrustGlobal, loadConfig } from "./config";
import { readLine } from "./editor";
import { appendHistory, loadHistory } from "./history";
import { defaultPrompt } from "./prompt";
import { runLine, runLines } from "./runLine";
import type { Context } from "./types";

interface UserCrustGlobals {
  prompt?: (cwd: string, git: string | null, ctx?: Context) => string;
}

const USAGE = `crust ${pkg.version} — pipeline-first devops toolkit on Bun
usage:
  crust                    start interactive REPL
  crust <file.crust>       run a script file and exit
  crust -c <line>          run one line and exit
  cmd | crust              run lines piped on stdin and exit
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

async function bootstrapCtx(history: string[] = []): Promise<Context> {
  const ctx = newContext(history);
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
      const ctx = await bootstrapCtx();
      // Fail fast: stop at the first failing line and exit with ITS code —
      // previously a later success masked an earlier failure.
      await shutdown(await runLines(argv[1]!, ctx));
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
    const ctx = await bootstrapCtx();
    await shutdown(await runLines(source, ctx));
  }

  if (!process.stdin.isTTY) {
    // Piped stdin: `echo 'range(1,3)' | crust`. Read to EOF FIRST, then run —
    // pure-shell lines inherit fd 0, so draining the pipe up front means
    // child sh processes see EOF instead of eating script text. The editor
    // never installs its stdin listener on this path.
    const source = await Bun.stdin.text();
    const ctx = await bootstrapCtx();
    await shutdown(await runLines(source, ctx));
  }

  const ctx = await bootstrapCtx(await loadHistory());

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
    await runLine(line, ctx);
  }
}

main().catch((err) => {
  process.stderr.write(`crust: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
