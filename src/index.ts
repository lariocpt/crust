#!/usr/bin/env bun
import { readLine } from "./editor";
import { defaultPrompt } from "./prompt";
import { loadHistory, appendHistory } from "./history";
import { loadConfig } from "./config";
import { runLine } from "./runLine";
import pkg from "../package.json" with { type: "json" };
import type { Context } from "./types";

interface UserCrustGlobals {
  prompt?: (cwd: string, git: string | null, ctx?: Context) => string;
}

const USAGE = `crust ${pkg.version}
usage:
  crust                    start interactive REPL
  crust -c <line>          run one line and exit
  crust -h | --help        show this help
  crust -V | --version     show version
`;

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
      const ctx: Context = {
        aliases: new Map(),
        functions: new Map(),
        history: [],
        exit: (code) => process.exit(code ?? 0),
        dotenv: { history: [], snapshot: null },
      };
      await loadConfig(ctx, process.env.CRUST_CONFIG);
      const source = argv[1]!;
      const lines = source.split("\n");
      let last = 0;
      for (const l of lines) {
        if (l.trim()) last = await runLine(l, ctx);
      }
      process.exit(last);
    }
    process.stderr.write(`crust: unsupported argument: ${flag}\n`);
    process.exit(2);
  }

  const ctx: Context = {
    aliases: new Map(),
    functions: new Map(),
    history: await loadHistory(),
    exit: (code) => process.exit(code ?? 0),
    dotenv: { history: [], snapshot: null },
  };

  await loadConfig(ctx, process.env.CRUST_CONFIG);

  while (true) {
    const userCrust = (globalThis as { crust?: UserCrustGlobals }).crust;
    const prompt = userCrust?.prompt
      ? userCrust.prompt(process.cwd(), null, ctx)
      : defaultPrompt(ctx);

    let line: string | null;
    try {
      line = await readLine({ prompt, history: ctx.history });
    } catch (err) {
      process.stderr.write(`crust: editor error: ${(err as Error).message}\n`);
      continue;
    }

    if (line === null) {
      // Ctrl-D on empty buffer
      process.exit(0);
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
