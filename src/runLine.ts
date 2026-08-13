import { builtins, isBuiltin } from "./builtins";
import { formatItem } from "./format";
import { classify, tokenize } from "./lexer";
import { parse } from "./parser";
import type { Context } from "./types";

// Run a block of lines — a script file, piped stdin, multi-line -c, or a
// `source`d .crust file. Fail-fast: stop at the first failing line and
// return ITS code. Blank lines and `#` comments are skipped, which also
// covers a `#!/usr/bin/env crust` shebang on line 1.
// (builtins.ts imports this while this module imports builtins.ts — the
// cycle is call-time-only, so it's safe under ESM.)
export async function runLines(source: string, ctx: Context): Promise<number> {
  let last = 0;
  for (const l of source.split("\n")) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    last = await runLine(l, ctx);
    if (last !== 0) break;
  }
  return last;
}

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
      // grep counts as shell here: a pure shell line (`ps aux | grep node`)
      // must keep inherit-stdio `sh -c` byte-for-byte. The native stage only
      // engages mid-pipeline in MIXED pipelines — where block-buffering bites.
      if (kind.kind !== "shell" && kind.kind !== "grep") return false;
      const h = t.text.trim().split(/\s+/)[0]!;
      return !ctx.functions.has(h);
    });

    if (isPureShell) {
      const proc = Bun.spawn(["sh", "-c", expanded], {
        stdio: ["inherit", "inherit", "inherit"],
        // Live env, not the startup snapshot — `capture` writes process.env
        // at run time and later shell lines must see $NAME.
        env: { ...process.env },
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
