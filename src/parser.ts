// Note on `new Function`: this is an interactive shell that explicitly
// evaluates user-typed TypeScript lambdas in pipeline stages (e.g.
// `ls | (s => s.toUpperCase())`). The eval surface is the user's own
// terminal session — same trust boundary as bash sourcing a script the
// user typed. Not a code-injection risk; it's the design.

import { tokenize, classify } from "./lexer";
import { Pipeline } from "./pipeline";
import * as sources from "./sources";
import * as transforms from "./transforms";
import type { StageKind } from "./types";

export function parse(line: string): () => Pipeline<unknown> {
  const tokens = tokenize(line);
  return () => {
    let pipeline: Pipeline<unknown> | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const kind = classify(tokens[i]!.text);
      pipeline = i === 0 ? buildSource(kind) : applyStage(pipeline!, kind);
    }
    if (!pipeline) throw new Error("parser: empty pipeline");
    return pipeline;
  };
}

function buildSource(kind: StageKind): Pipeline<unknown> {
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
    case "function":
      throw new Error(`function "${kind.name}" as source not yet supported (v0.1.5)`);
  }
}

function applyStage(input: Pipeline<unknown>, kind: StageKind): Pipeline<unknown> {
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
    case "function":
      throw new Error(`function "${kind.name}" as transform not yet supported (v0.1.5)`);
  }
}

function evalLambda(source: string): (x: unknown) => unknown {
  // Compile the user's lambda once and reuse it per item.
  // Trust boundary: this is the user's own shell session.
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
