#!/usr/bin/env bun
import { readLine } from "./editor";
import { defaultPrompt } from "./prompt";
import { loadHistory, appendHistory } from "./history";
import { loadConfig } from "./config";
import { builtins, isBuiltin } from "./builtins";
import { parse } from "./parser";
import { tokenize, classify } from "./lexer";
import type { Context } from "./types";

interface UserCrustGlobals {
  prompt?: (cwd: string, git: string | null) => string;
}

async function main(): Promise<void> {
  const ctx: Context = {
    aliases: new Map(),
    functions: new Map(),
    history: await loadHistory(),
    exit: (code) => process.exit(code ?? 0),
  };

  await loadConfig(ctx, process.env.CRUST_CONFIG);

  while (true) {
    const userCrust = (globalThis as { crust?: UserCrustGlobals }).crust;
    const prompt = userCrust?.prompt
      ? userCrust.prompt(process.cwd(), null)
      : defaultPrompt();

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

    const trimmed = line.trim();
    if (!trimmed) continue;

    await appendHistory(line, ctx.history);

    // Alias expand (first word only — v0.1 limit)
    const firstSpace = trimmed.indexOf(" ");
    const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const aliasExp = ctx.aliases.get(head);
    const expanded = aliasExp
      ? aliasExp + (firstSpace === -1 ? "" : trimmed.slice(firstSpace))
      : trimmed;

    // Builtin?
    const exFirstSpace = expanded.indexOf(" ");
    const exHead = exFirstSpace === -1 ? expanded : expanded.slice(0, exFirstSpace);
    if (isBuiltin(exHead) && !/[|&;<>]/.test(expanded)) {
      const args = exFirstSpace === -1 ? "" : expanded.slice(exFirstSpace + 1);
      try {
        await builtins[exHead]!(args, ctx);
      } catch (err) {
        process.stderr.write(`crust: ${(err as Error).message}\n`);
      }
      continue;
    }

    // Pure-shell pipeline → spawn with inherited stdio (preserves colors, prompts, etc.)
    // Mixed pipeline (incl. any stage that resolves to a registered crust.fn) →
    // run through the parser and stream lines to stdout
    try {
      const tokens = tokenize(expanded);
      const isPureShell = tokens.every((t) => {
        const kind = classify(t.text);
        if (kind.kind !== "shell") return false;
        const head = t.text.trim().split(/\s+/)[0]!;
        return !ctx.functions.has(head);
      });

      if (isPureShell) {
        const proc = Bun.spawn(["sh", "-c", expanded], {
          stdio: ["inherit", "inherit", "inherit"],
        });
        await proc.exited;
      } else {
        const pipeline = parse(expanded)(ctx);
        for await (const item of pipeline.lines()) {
          process.stdout.write(formatItem(item) + "\n");
        }
      }
    } catch (err) {
      process.stderr.write(`crust: ${(err as Error).message}\n`);
    }
  }
}

function formatItem(x: unknown): string {
  if (x instanceof Response) {
    return `${x.status} ${x.statusText} ${x.url}`;
  }
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

main().catch((err) => {
  process.stderr.write(`crust: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
