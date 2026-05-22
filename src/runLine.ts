import { builtins, isBuiltin } from "./builtins";
import { parse } from "./parser";
import { tokenize, classify } from "./lexer";
import type { Context } from "./types";

export async function runLine(line: string, ctx: Context): Promise<number> {
  const trimmed = line.trim();
  if (!trimmed) return 0;

  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const aliasExp = ctx.aliases.get(head);
  const expanded = aliasExp
    ? aliasExp + (firstSpace === -1 ? "" : trimmed.slice(firstSpace))
    : trimmed;

  const exFirstSpace = expanded.indexOf(" ");
  const exHead = exFirstSpace === -1 ? expanded : expanded.slice(0, exFirstSpace);
  if (isBuiltin(exHead) && !/[|&;<>]/.test(expanded)) {
    const args = exFirstSpace === -1 ? "" : expanded.slice(exFirstSpace + 1);
    try {
      const result = await builtins[exHead]!(args, ctx);
      return result ?? 0;
    } catch (err) {
      process.stderr.write(`crust: ${(err as Error).message}\n`);
      return 1;
    }
  }

  try {
    const tokens = tokenize(expanded);
    const isPureShell = tokens.every((t) => {
      const kind = classify(t.text);
      if (kind.kind !== "shell") return false;
      const h = t.text.trim().split(/\s+/)[0]!;
      return !ctx.functions.has(h);
    });

    if (isPureShell) {
      const proc = Bun.spawn(["sh", "-c", expanded], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
      return proc.exitCode ?? 0;
    } else {
      const pipeline = parse(expanded)(ctx);
      for await (const item of pipeline.lines()) {
        process.stdout.write(formatItem(item) + "\n");
      }
      return 0;
    }
  } catch (err) {
    process.stderr.write(`crust: ${(err as Error).message}\n`);
    return 1;
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
