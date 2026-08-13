import { builtins, isBuiltin } from "./builtins";
import { formatItem } from "./format";
import * as interrupt from "./interrupt";
import { classify, tokenize } from "./lexer";
import { parse } from "./parser";
import type { Context } from "./types";

// REPL terminal hooks, passed only by the interactive loop. Scripts, -c and
// piped stdin never construct one, so those paths are structurally unchanged.
export interface ReplTty {
  /** Arm a Ctrl-C watcher (raw-mode 0x03, not SIGINT). Returns dispose. */
  onInterrupt(cb: () => void): () => void;
  /** Cooked mode + paused editor for inherit-stdio children. Returns restore. */
  suspend(): () => void;
}

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

export async function runLine(line: string, ctx: Context, tty?: ReplTty): Promise<number> {
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
    // At the REPL, Ctrl-C reaches builtins as a synthetic in-process SIGINT —
    // that's what mock-server's and procs' "wait for SIGINT" handlers listen
    // for, and raw mode means no real signal ever arrives. Builtins that hold
    // the terminal (logs) arm their own watcher first thing, shadowing this.
    let fired = false;
    const dispose = tty?.onInterrupt(() => {
      fired = true;
      process.stdout.write("^C\n");
      process.emit("SIGINT");
    });
    try {
      const result = await builtins[exHead]!(args, ctx);
      return fired ? 130 : (result ?? 0);
    } catch (err) {
      process.stderr.write(`crust: ${(err as Error).message}\n`);
      return 1;
    } finally {
      dispose?.();
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
      // At the REPL, hand the child a real terminal: cooked mode so the tty
      // itself delivers Ctrl-C (SIGINT to the foreground process group — the
      // child AND crust; we ignore ours) and interactive children (less, vim)
      // stop fighting the raw-mode editor for bytes.
      const restore = tty?.suspend();
      const ignoreSigint = (): void => {};
      if (tty) process.on("SIGINT", ignoreSigint);
      try {
        const proc = Bun.spawn(["sh", "-c", expanded], {
          stdio: ["inherit", "inherit", "inherit"],
          // Live env, not the startup snapshot — `capture` writes process.env
          // at run time and later shell lines must see $NAME.
          env: { ...process.env },
        });
        await proc.exited;
        return proc.exitCode ?? 0;
      } finally {
        if (tty) process.off("SIGINT", ignoreSigint);
        restore?.();
      }
    } else if (tty) {
      // REPL pipeline: race the drain against the interrupt bus. On Ctrl-C
      // fire the bus (kills registered children, wakes parked poll sleeps),
      // queue the generator's return, and DON'T await the drain — the bus
      // guarantees unwind within a poll tick, and the prompt must come back
      // immediately.
      interrupt.beginRun();
      const dispose = tty.onInterrupt(() => {
        process.stdout.write("^C\n");
        process.emit("SIGINT");
        interrupt.fire();
      });
      try {
        const gen = parse(expanded)(ctx).lines()[Symbol.asyncIterator]();
        const drain = (async () => {
          let res = await gen.next();
          while (!res.done) {
            process.stdout.write(formatItem(res.value) + "\n");
            res = await gen.next();
          }
        })();
        const outcome = await Promise.race([
          drain.then(() => "done" as const),
          interrupt.interruptPromise().then(() => "interrupted" as const),
        ]);
        if (outcome === "interrupted") {
          // Late unwind errors are the cancellation, not news.
          drain.catch(() => {});
          void gen.return?.(undefined);
          return 130;
        }
        return 0;
      } finally {
        dispose();
        interrupt.endRun();
      }
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
