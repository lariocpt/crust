// Note on `new Function`: this is an interactive shell that explicitly
// evaluates user-typed TypeScript lambdas in pipeline stages (e.g.
// `ls | (s => s.toUpperCase())`). The eval surface is the user's own
// terminal session — same trust boundary as bash sourcing a script the
// user typed. Not a code-injection risk; it's the design.

import { expandEnv, splitArgs } from "./args";
import { formatItem } from "./format";
import { classify, tokenize } from "./lexer";
import { Pipeline } from "./pipeline";
import * as sources from "./sources";
import * as transforms from "./transforms";
import type { Context, StageKind } from "./types";

export function parse(line: string): (ctx?: Context) => Pipeline<unknown> {
  const tokens = tokenize(line);
  return (ctx) => {
    // `time "label"` is a prefix-only decorator: it doesn't participate in
    // the data flow, it just wraps the resulting pipeline with a timing
    // transform that fires when the iterator drains (success or error).
    let startIdx = 0;
    let timeLabel: string | null = null;
    const head = resolveKind(tokens[0]!.text, ctx);
    if (head.kind === "time") {
      if (tokens.length < 2) {
        throw new Error('time: must be followed by a pipeline (e.g. `time "x" | range(0, 10)`)');
      }
      timeLabel = head.label;
      startIdx = 1;
    }

    let pipeline: Pipeline<unknown> | null = null;
    // `parallel N` is a modifier for the NEXT stage, not a stage of its own —
    // it sets the fan-out for the per-item work that follows. Only http,
    // lambda, and function stages can consume it; anything else is a loud
    // error (it used to be a silent drop, which read as "worked").
    let pendingParallel: number | null = null;
    for (let i = startIdx; i < tokens.length; i++) {
      const kind = resolveKind(tokens[i]!.text, ctx);
      if (kind.kind === "time") {
        throw new Error("time: only allowed as the first stage of a pipeline");
      }
      if (kind.kind === "parallel") {
        if (pipeline === null) throw new Error("parallel: needs an upstream stage");
        pendingParallel = kind.n;
        continue;
      }
      if (pendingParallel !== null && !CONSUMES_PARALLEL.has(kind.kind)) {
        throw new Error(
          `parallel ${pendingParallel}: only applies to http, lambda, or function stages — got ${kind.kind}`,
        );
      }
      if (pipeline === null) {
        pipeline = buildSource(kind, ctx);
      } else {
        pipeline = applyStage(pipeline, kind, ctx, pendingParallel);
        pendingParallel = null;
      }
    }
    if (pendingParallel !== null) {
      throw new Error("parallel: must be followed by an http, lambda, or function stage");
    }
    if (!pipeline) throw new Error("parser: empty pipeline");
    if (timeLabel !== null) {
      pipeline = pipeline.pipe(transforms.time(timeLabel) as never) as Pipeline<unknown>;
    }
    return pipeline;
  };
}

const CONSUMES_PARALLEL = new Set<StageKind["kind"]>(["http", "lambda", "function"]);

// Demote a shell stage to a function stage when its first word is a
// crust.fn()-registered name. The lexer is intentionally pure (no ctx),
// so we resolve registered names here.
function resolveKind(text: string, ctx?: Context): StageKind {
  const kind = classify(text);
  if (kind.kind === "shell" && ctx) {
    // Quote-aware and quote-stripping: `sql "SELECT count(*) FROM x" 42`
    // must reach the fn as ONE query string + one param.
    const parts = splitArgs(text.trim());
    const head = parts[0]!;
    if (ctx.functions.has(head)) {
      // Env-expand fn args so `sql "..." "prefix $RUN_ID"` works in .pipes
      // files. SQL positional params ($1, $2) survive — a digit can't start
      // an env var name.
      return { kind: "function", name: head, args: parts.slice(1).map(expandEnv) };
    }
  }
  return kind;
}

function httpOpts(headers: string[]): RequestInit | undefined {
  if (headers.length === 0) return undefined;
  const h = new Headers();
  for (const raw of headers) {
    // Expand the WHOLE raw string first so -H "$AUTH_HEADER" can hold a
    // complete `authorization: Bearer …` line (generated flows rely on it).
    const expanded = expandEnv(raw);
    const idx = expanded.indexOf(":");
    if (idx === -1) throw new Error(`-H expects "Key: value", got "${raw}"`);
    h.set(expanded.slice(0, idx).trim(), expanded.slice(idx + 1).trim());
  }
  return { headers: h };
}

function buildSource(kind: StageKind, ctx?: Context): Pipeline<unknown> {
  switch (kind.kind) {
    case "range":
      return sources.range(kind.start, kind.end) as Pipeline<unknown>;
    case "glob":
      return sources.glob(kind.pattern) as Pipeline<unknown>;
    case "tail":
      return sources.tail(kind.paths, {
        lines: kind.lines,
        follow: kind.follow,
      }) as Pipeline<unknown>;
    case "http":
      if (kind.verb === "GET") {
        return sources.GET(
          normalizeUrl(expandEnv(kind.url)),
          httpOpts(kind.headers),
          kind.timeoutMs,
        ) as Pipeline<unknown>;
      }
      throw new Error(`${kind.verb} cannot be a source — needs upstream items`);
    case "shell":
      return shellSource(kind.text);
    case "json": {
      // One item: the parsed JSON literal (env vars expanded first, so
      // {"token":"$TOKEN"} works in shorthand fixtures).
      const parsed = JSON.parse(expandEnv(kind.source)) as unknown;
      return Pipeline.of([parsed]);
    }
    case "readsrc":
      return sources.readAll(kind.pattern) as Pipeline<unknown>;
    case "load":
      return sources.load(kind.phases) as Pipeline<unknown>;
    case "procs": {
      // Evaluate the full `procs({...})` expression with the real source in
      // scope — same trusted-eval stance as evalLambda below.
      const build = new Function("procs", `return (${kind.source});`) as (
        p: typeof sources.procs,
      ) => Pipeline<unknown>;
      return build(sources.procs);
    }
    case "lambda":
      throw new Error("lambda cannot be a source — needs upstream items");
    case "parallel":
    case "expect":
    case "stats":
    case "assert":
    case "filter":
    case "capture":
      throw new Error(`${kind.kind} cannot be a source — needs upstream items`);
    case "time":
      throw new Error("time: only allowed as the first stage of a pipeline");
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
  concurrency?: number | null,
): Pipeline<unknown> {
  switch (kind.kind) {
    case "lambda": {
      const fn = evalLambda(kind.source);
      if (concurrency !== null && concurrency !== undefined) {
        return input.pipe(transforms.parallel(concurrency, fn) as never) as Pipeline<unknown>;
      }
      return input.pipe(fn);
    }
    case "shell":
      return shellTransform(input, kind.text);
    case "http": {
      const url = normalizeUrl(expandEnv(kind.url));
      const opts = httpOpts(kind.headers);
      if (kind.verb === "GET") {
        // Per-item timed GET — each upstream item triggers one request.
        // `parallel N` upstream sets the fan-out.
        const fn = transforms.timedGet(url, opts, kind.timeoutMs);
        const n = concurrency ?? 1;
        return input.pipe(transforms.parallel(n, fn) as never) as Pipeline<unknown>;
      }
      if (concurrency !== null && concurrency !== undefined) {
        // The `parallel` modifier (any N, including 1) puts a verb in load
        // mode: {status, ms, url} timing records, bodies drained.
        return input.pipe(
          transforms.parallel(
            concurrency,
            transforms.timedHttpItem(kind.verb, url, opts, kind.timeoutMs),
          ) as never,
        ) as Pipeline<unknown>;
      }
      return input.pipe(
        transforms[kind.verb](url, opts, kind.timeoutMs) as never,
      ) as Pipeline<unknown>;
    }
    case "expect":
      return input.pipe(transforms.expectStatus(kind.matcher) as never) as Pipeline<unknown>;
    case "capture":
      return input.pipe(
        transforms.captureEnv(
          kind.name,
          kind.source ? (evalLambda(kind.source) as (x: unknown) => unknown) : undefined,
          kind.source ?? undefined,
        ) as never,
      ) as Pipeline<unknown>;
    case "assert": {
      // A predicate that FAILS the pipeline on falsy — unlike a plain lambda,
      // which maps. `| sql "SELECT ..." | assert (r => r[0].c === 1)`.
      // A full stage (not a per-item pipe) so an EMPTY upstream also fails:
      // an assertion nothing reached is a silent false positive — the
      // sql-returned-zero-rows trap.
      const fn = new Function("x", `return (${kind.source})(x);`) as (x: unknown) => unknown;
      const upstream = input;
      return Pipeline.of(
        (async function* () {
          let idx = 0;
          for await (const item of upstream.lines()) {
            idx++;
            const ok = await fn(item);
            if (!ok) {
              throw new Error(
                `assert: item ${idx} failed ${kind.source} — got ${JSON.stringify(item)?.slice(0, 200)}`,
              );
            }
            yield item;
          }
          if (idx === 0) {
            throw new Error(`assert: no items reached ${kind.source} — upstream was empty`);
          }
        })(),
      );
    }
    case "filter":
      return input.pipe(
        transforms.filterStage(evalLambda(kind.source), kind.source) as never,
      ) as Pipeline<unknown>;
    case "stats":
      return input.pipe(
        transforms.statsStage(kind.everySec, kind.out ? expandEnv(kind.out) : undefined) as never,
      ) as Pipeline<unknown>;
    case "range":
    case "glob":
    case "tail":
    case "procs":
    case "parallel":
    case "json":
    case "readsrc":
    case "load":
      throw new Error(`${kind.kind} cannot appear as a non-first stage`);
    case "time":
      throw new Error("time: only allowed as the first stage of a pipeline");
    case "function": {
      const fn = ctx?.functions.get(kind.name);
      if (!fn) throw new Error(`function "${kind.name}" not registered`);
      const apply = (item: unknown) => fn(item, ...kind.args);
      if (concurrency !== null && concurrency !== undefined) {
        return input.pipe(transforms.parallel(concurrency, apply) as never) as Pipeline<unknown>;
      }
      return input.pipe(apply);
    }
  }
}

// The docs' `:3000/health` shorthand — a bare port-path expands to localhost.
function normalizeUrl(url: string): string {
  return url.startsWith(":") ? `http://localhost${url}` : url;
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
        // Live env so `capture`d $VARs from earlier lines reach sh.
        env: { ...process.env },
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
        // Live env so `capture`d $VARs from earlier lines reach sh.
        env: { ...process.env },
      });

      const writePromise = (async () => {
        const writer = proc.stdin as FileSink;
        for await (const item of input.lines()) {
          writer.write(formatItem(item) + "\n");
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
