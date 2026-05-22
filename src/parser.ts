// Note on `new Function`: this is an interactive shell that explicitly
// evaluates user-typed TypeScript lambdas in pipeline stages (e.g.
// `ls | (s => s.toUpperCase())`). The eval surface is the user's own
// terminal session — same trust boundary as bash sourcing a script the
// user typed. Not a code-injection risk; it's the design.

import { tokenize, classify } from "./lexer";
import { Pipeline } from "./pipeline";
import * as sources from "./sources";
import * as transforms from "./transforms";
import type { Context, StageKind } from "./types";

export function parse(line: string): (ctx?: Context) => Pipeline<unknown> {
  const tokens = tokenize(line);
  return (ctx) => {
    let pipeline: Pipeline<unknown> | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const kind = resolveKind(tokens[i]!.text, ctx);
      pipeline = i === 0 ? buildSource(kind, ctx) : applyStage(pipeline!, kind, ctx);
    }
    if (!pipeline) throw new Error("parser: empty pipeline");
    return pipeline;
  };
}

// Demote a shell stage to a function stage when its first word is a
// crust.fn()-registered name. The lexer is intentionally pure (no ctx),
// so we resolve registered names here.
function resolveKind(text: string, ctx?: Context): StageKind {
  const kind = classify(text);
  if (kind.kind === "shell" && ctx) {
    const parts = text.trim().split(/\s+/);
    const head = parts[0]!;
    if (ctx.functions.has(head)) {
      return { kind: "function", name: head, args: parts.slice(1) };
    }
  }
  return kind;
}

function buildSource(kind: StageKind, ctx?: Context): Pipeline<unknown> {
  switch (kind.kind) {
    case "range":
      return sources.range(kind.start, kind.end) as Pipeline<unknown>;
    case "glob":
      return sources.glob(kind.pattern) as Pipeline<unknown>;
    case "http":
      if (kind.verb === "GET") return sources.GET(kind.url) as Pipeline<unknown>;
      throw new Error(`${kind.verb} cannot be a source — needs upstream items`);
    case "shell":
      return shellSource(kind.text);
    case "lambda":
      throw new Error("lambda cannot be a source — needs upstream items");
    case "function": {
      const fn = ctx?.functions.get(kind.name);
      if (!fn) throw new Error(`function "${kind.name}" not registered`);
      // Function-as-source: invoke fn(...staticArgs). If it returns (or resolves
      // to) an Array, stream each element as its own item — this is what makes
      // `sql "..."` behave as a row-streaming source. Anything else is yielded
      // as a single item.
      return Pipeline.of(
        (async function* () {
          const result = await fn(...kind.args);
          if (Array.isArray(result)) {
            for (const r of result) yield r;
          } else {
            yield result;
          }
        })(),
      );
    }
  }
}

function applyStage(
  input: Pipeline<unknown>,
  kind: StageKind,
  ctx?: Context,
): Pipeline<unknown> {
  switch (kind.kind) {
    case "lambda":
      return input.pipe(evalLambda(kind.source));
    case "shell":
      return shellTransform(input, kind.text);
    case "http": {
      if (kind.verb === "GET") {
        throw new Error("GET cannot be a transform — use POST/PUT/PATCH/DELETE for per-item HTTP");
      }
      return input.pipe(transforms[kind.verb](kind.url) as never) as Pipeline<unknown>;
    }
    case "range":
    case "glob":
      throw new Error(`${kind.kind} cannot appear as a non-first stage`);
    case "function": {
      const fn = ctx?.functions.get(kind.name);
      if (!fn) throw new Error(`function "${kind.name}" not registered`);
      return input.pipe((item: unknown) => fn(item, ...kind.args));
    }
  }
}

function evalLambda(source: string): (x: unknown) => unknown {
  const compiled = new Function("x", `return (${source})(x);`) as (x: unknown) => unknown;
  return compiled;
}

function shellSource(cmd: string): Pipeline<unknown> {
  return Pipeline.of(
    (async function* () {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const decoder = new TextDecoder();
      let buf = "";
      // @ts-expect-error — Bun.spawn returns a ReadableStream on stdout
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      buf += decoder.decode();
      if (buf) yield buf;
      await proc.exited;
    })(),
  );
}

function shellTransform(input: Pipeline<unknown>, cmd: string): Pipeline<unknown> {
  return Pipeline.of(
    (async function* () {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      const writePromise = (async () => {
        const writer = proc.stdin as FileSink;
        for await (const item of input.lines()) {
          writer.write(String(item) + "\n");
        }
        await writer.end();
      })();

      const decoder = new TextDecoder();
      let buf = "";
      // @ts-expect-error — Bun.spawn returns a ReadableStream on stdout
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      buf += decoder.decode();
      if (buf) yield buf;
      await proc.exited;
      await writePromise;
    })(),
  );
}

interface FileSink {
  write(data: string | Uint8Array): number;
  end(): Promise<number>;
}
