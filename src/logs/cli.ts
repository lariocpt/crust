import { onInterrupt, readLine } from "../editor";
import { classify } from "../lexer";
import { buildSource } from "../parser";
import type { Pipeline } from "../pipeline";
import { shellEnv } from "../shellPath";
import type { Context } from "../types";
import { DEFAULT_CAPACITY, MAX_CAPACITY } from "./ring";
import { LogsSession } from "./session";

const USAGE = `usage: logs [--buffer N] <source>
  logs tail -n 0 -F app.log          follow a file (or a glob of files)
  logs procs({web: "bun run dev"})   hold a process group's output
  logs docker logs -f my-container   any shell command's stdout
Interactive: each typed line is a pipeline fragment (grep ERROR, filter (…),
stats --every 5) run over the buffered recent past, then the live stream.
No pipes/redirections in the logs line itself; put complex commands in a script.
`;

export async function runLogs(rawArgs: string, ctx: Context): Promise<number> {
  // Arm a no-op watcher FIRST, before any await: runLine's builtin watcher
  // emits a synthetic SIGINT on ^C, which would trip procs' handler and kill
  // the held source. This guard shadows it for the whole session; queries
  // nest their own watcher over it.
  const disposeGuard = onInterrupt(() => {});
  try {
    return await runLogsInner(rawArgs.trim(), ctx);
  } finally {
    disposeGuard();
  }
}

async function runLogsInner(rawArgs: string, ctx: Context): Promise<number> {
  const stderr = (s: string): void => void process.stderr.write(s);
  if (!process.stdin.isTTY) {
    stderr(
      "logs: interactive session needs a tty — for piped data use `cmd | crust -c 'stdin | …'`\n",
    );
    return 2;
  }

  let bufferSize = DEFAULT_CAPACITY;
  let spec = rawArgs;
  const bufMatch = spec.match(/^--buffer(?:=|\s+)(\S+)\s*/);
  if (bufMatch) {
    const n = Number(bufMatch[1]);
    if (!Number.isInteger(n) || n < 1) {
      stderr(`logs: --buffer must be a positive integer — got "${bufMatch[1]}"\n`);
      return 2;
    }
    if (n > MAX_CAPACITY) {
      stderr(`logs: --buffer capped at ${MAX_CAPACITY}\n`);
      bufferSize = MAX_CAPACITY;
    } else {
      bufferSize = n;
    }
    spec = spec.slice(bufMatch[0].length).trim();
  }
  if (!spec) {
    stderr(USAGE);
    return 2;
  }

  // The source spec is the REST OF THE LINE, verbatim — splitArgs would
  // mangle the procs({...}) literal and quoted shell commands.
  const kind = classify(spec);
  let source: AsyncIterable<unknown>;
  let teardown: (() => void | Promise<void>) | undefined;
  let note: string | undefined;

  switch (kind.kind) {
    case "stdin":
      stderr(
        "logs: piped data and the keyboard can't share stdin — use `cmd | crust -c 'stdin | …'` (non-interactive) instead\n",
      );
      return 2;
    case "glob":
      stderr(
        `logs: a bare glob yields file PATHS, not contents — try \`logs tail -n 0 -F ${spec}\` or \`logs read ${spec}\`\n`,
      );
      return 2;
    case "shell": {
      // Spawn the command ourselves (not via the parser's shell source) so
      // `exit` can kill it — the held child must not outlive the session.
      const proc = Bun.spawn(["sh", "-c", kind.text], {
        stdout: "pipe",
        stderr: "inherit",
        env: shellEnv(),
      });
      source = (async function* () {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) yield line;
        }
        buf += decoder.decode();
        if (buf) yield buf;
        await proc.exited;
      })();
      teardown = () => {
        proc.kill();
      };
      break;
    }
    case "tail": {
      // Built directly (not via buildSource) so teardown can ABORT the
      // follow loop — a queued iter.return can't wake its poll sleep, and
      // the session's Ctrl-C fires the interrupt bus, which a held source
      // must ignore (the signal opts the tail out of the bus race).
      const controller = new AbortController();
      const { tail } = await import("../sources");
      const pipeline = tail(kind.paths, {
        lines: kind.lines,
        follow: kind.follow,
        signal: controller.signal,
      });
      const iter = pipeline.lines()[Symbol.asyncIterator]();
      source = { [Symbol.asyncIterator]: () => iter };
      teardown = () => {
        controller.abort();
        iter.return?.(undefined)?.catch(() => {});
      };
      break;
    }
    case "procs": {
      let pipeline: Pipeline<unknown>;
      try {
        pipeline = buildSource(kind, ctx);
      } catch (err) {
        stderr(`logs: ${(err as Error).message}\n`);
        return 2;
      }
      const iter = pipeline.lines()[Symbol.asyncIterator]();
      source = { [Symbol.asyncIterator]: () => iter };
      // procs' own SIGINT handler is the teardown path: SIGTERM → SIGKILL
      // escalation, then its streams end and the pump completes.
      teardown = () => {
        process.emit("SIGINT");
        iter.return?.(undefined)?.catch(() => {});
      };
      note =
        'items are {proc, stream, line} objects — try (l => l.line) or filter (l => l.proc === "web")';
      break;
    }
    default: {
      // tail, read, a registered function, GET … anything the grammar can
      // build as a source. Source-invalid kinds (lambda, stats…) throw here.
      let pipeline: Pipeline<unknown>;
      try {
        pipeline = buildSource(kind, ctx);
      } catch (err) {
        stderr(`logs: ${(err as Error).message}\n`);
        return 2;
      }
      const iter = pipeline.lines()[Symbol.asyncIterator]();
      source = { [Symbol.asyncIterator]: () => iter };
      teardown = () => {
        iter.return?.(undefined)?.catch(() => {});
      };
      break;
    }
  }

  const session = new LogsSession({
    source,
    sourceLabel: spec,
    bufferSize,
    color: process.stdout.isTTY === true,
    readInput: readLine,
    write: (s) => void process.stdout.write(s),
    writeErr: stderr,
    onInterrupt,
    ctx,
    note,
    teardown,
  });
  return await session.run();
}
