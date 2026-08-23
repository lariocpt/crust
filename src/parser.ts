// Note on `new Function`: this is an interactive shell that explicitly
// evaluates user-typed TypeScript lambdas in pipeline stages (e.g.
// `ls | (s => s.toUpperCase())`). The eval surface is the user's own
// terminal session — same trust boundary as bash sourcing a script the
// user typed. Not a code-injection risk; it's the design.

import { expandEnv, splitArgs } from "./args";
import { formatItem } from "./format";
import { registerChild } from "./interrupt";
import { classify, tokenize } from "./lexer";
import { Pipeline } from "./pipeline";
import { shellEnv } from "./shellPath";
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
    } else if (head.kind === "shell" && /^time\s+\S/.test(head.text) && tokens.length > 1) {
      // `time` needs a QUOTED label, so `time warmup | range(1,3)` classifies
      // as a shell stage and then fails downstream with "range cannot appear as
      // a non-first stage" — an error about the wrong stage entirely. Quotes
      // stay mandatory (a bare-label rule would steal the legitimate shell line
      // `time ls`), so say what to type instead. Only fires when a real crust
      // stage follows: `time ls | grep x` is pure shell and never reaches here.
      const label = head.text.slice(5).trim();
      throw new Error(
        `time: the label must be quoted — did you mean \`time "${label}"\`? ` +
          "(unquoted, it is treated as the shell command `time`)",
      );
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
      // A crust keyword that fell through to `shell` is almost always a
      // malformed stage, and the fallback made it a baffling one: `filter l =>
      // l > 1` became `sh: filter: command not found`, and `parallel abc`
      // actually invoked GNU parallel with the pipeline's items as commands.
      // Same guard as `time` above — this only runs for pipelines that already
      // contain a real crust stage, so a pure-shell line is untouched.
      if (kind.kind === "shell") {
        const hint = malformedStageHint(kind.text);
        if (hint) throw new Error(hint);
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

const SOURCE_ONLY = new Set<StageKind["kind"]>([
  "range",
  "glob",
  "tail",
  "procs",
  "json",
  "readsrc",
  "stdin",
  "load",
]);

// Parse a TRANSFORMS-ONLY fragment (no source position) — the `logs` query
// path. Returns a builder so each invocation constructs FRESH stages: a logs
// query runs twice, retro over the buffer snapshot and forward over the live
// stream, and stages like stats are stateful.
export function parseStages(
  fragment: string,
): (input: Pipeline<unknown>, ctx?: Context) => Pipeline<unknown> {
  const tokens = tokenize(fragment);
  return (input, ctx) => {
    let pipeline = input;
    let pendingParallel: number | null = null;
    for (const tok of tokens) {
      const kind = resolveKind(tok.text, ctx);
      if (kind.kind === "time") {
        throw new Error("time: not available in a logs query");
      }
      if (SOURCE_ONLY.has(kind.kind)) {
        throw new Error(
          `${kind.kind}: logs queries transform the buffered/live stream — start with grep, filter, a lambda, or a shell stage`,
        );
      }
      if (kind.kind === "parallel") {
        pendingParallel = kind.n;
        continue;
      }
      if (pendingParallel !== null && !CONSUMES_PARALLEL.has(kind.kind)) {
        throw new Error(
          `parallel ${pendingParallel}: only applies to http, lambda, or function stages — got ${kind.kind}`,
        );
      }
      pipeline = applyStage(pipeline, kind, ctx, pendingParallel);
      pendingParallel = null;
    }
    if (pendingParallel !== null) {
      throw new Error("parallel: must be followed by an http, lambda, or function stage");
    }
    return pipeline;
  };
}

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

export function buildSource(kind: StageKind, ctx?: Context): Pipeline<unknown> {
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
    case "grep":
      // Source-position grep is a FILE grep (`grep ERROR app.log` reads no
      // stdin) — always the system binary, byte-for-byte.
      return shellSource(kind.raw);
    case "json": {
      // One item: the parsed JSON literal (env vars expanded first, so
      // {"token":"$TOKEN"} works in shorthand fixtures).
      const parsed = JSON.parse(expandEnv(kind.source)) as unknown;
      return Pipeline.of([parsed]);
    }
    case "readsrc":
      if (!kind.pattern) {
        throw new Error(
          "read: needs a file or glob — `read fixtures/*.json` yields whole files; " +
            "use `lines <glob>` for one item per line",
        );
      }
      return sources.readAll(kind.pattern) as Pipeline<unknown>;
    case "lines":
      if (kind.pattern === null) {
        throw new Error("lines: needs a file pattern as a source — or upstream items to split");
      }
      return sources.readLines(kind.pattern) as Pipeline<unknown>;
    case "stdin":
      return sources.stdin() as Pipeline<unknown>;
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
      const fn = compileLambda(kind.source);
      const upstream = input;
      return Pipeline.of(
        (async function* () {
          let idx = 0;
          for await (const item of upstream.lines()) {
            idx++;
            // A `stats` summary of an empty stream is tagged `empty` precisely
            // so this cannot pass vacuously: {count: 0, p95: 0} satisfies
            // `s => s.p95 < 200`, which let a CI gate that issued zero requests
            // report success. Same rule as the empty-upstream check below —
            // an assertion with nothing behind it is not a pass.
            if (typeof item === "object" && item !== null && (item as { empty?: unknown }).empty) {
              throw new Error(
                `assert: ${kind.source} was handed an EMPTY summary (0 items) — ` +
                  "nothing was measured, so this is not a pass " +
                  "(a glob that matched nothing, or a filter that dropped everything?)",
              );
            }
            const ok = await fn(item);
            if (!ok) {
              throw new Error(
                `assert: item ${idx} failed ${kind.source} — got ${describeItem(item)}`,
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
    case "grep":
      return input.pipe(transforms.grepStage(kind) as never) as Pipeline<unknown>;
    case "stats":
      return input.pipe(
        transforms.statsStage(kind.everySec, kind.out ? expandEnv(kind.out) : undefined) as never,
      ) as Pipeline<unknown>;
    case "lines":
      // Bare `lines` splits upstream items; `lines <glob>` is a source and
      // cannot re-open files halfway down a pipeline.
      if (kind.pattern !== null) {
        throw new Error(
          `lines ${kind.pattern}: a file pattern is only valid as the first stage — ` +
            "use bare `lines` to split upstream items",
        );
      }
      return input.pipe(transforms.linesStage() as never) as Pipeline<unknown>;
    case "range":
    case "glob":
    case "tail":
    case "procs":
    case "parallel":
    case "json":
    case "readsrc":
    case "stdin":
    case "load":
      throw new Error(`${kind.kind} cannot appear as a non-first stage`);
    case "time":
      throw new Error("time: only allowed as the first stage of a pipeline");
    case "function": {
      const fn = ctx?.functions.get(kind.name);
      if (!fn) throw new Error(`function "${kind.name}" not registered`);
      const apply = (item: unknown) => fn(item, ...kind.args);
      const mapped =
        concurrency !== null && concurrency !== undefined
          ? (input.pipe(transforms.parallel(concurrency, apply) as never) as Pipeline<unknown>)
          : input.pipe(apply);
      // Same contract as function-as-source above: an Array result streams
      // element by element. Without this the two positions disagreed —
      // `sql "…"` yielded rows as items, while `… | sql "…"` yielded ONE item
      // that was an array, so the natural `… | sql "…" | assert (r => r.name)`
      // chain silently compared against an array.
      return Pipeline.of(
        (async function* () {
          for await (const r of mapped.lines()) {
            if (Array.isArray(r)) {
              for (const x of r) yield x;
            } else {
              yield r;
            }
          }
        })(),
      );
    }
  }
}

// The docs' `:3000/health` shorthand — a bare port-path expands to localhost.
// The docs' `:3000/health` shorthand, generalised to the spellings people
// actually type. Only `:port/path` was handled, so `GET localhost:3000/health`
// parsed `localhost:` as a URL SCHEME and died with "Unable to connect", and
// `GET example.com/x` died with a bare "fetch() URL is invalid" — neither
// naming the URL. curl defaults to http:// for a bare host; so does this.
function normalizeUrl(url: string): string {
  if (url.startsWith(":")) return `http://localhost${url}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url; // already has a scheme
  // A leading "/" is NOT rejected here: `$BASE/api/things` with $BASE unset
  // expands to exactly that, and parse time is precisely when the variable
  // isn't set yet (it is also what `crust --check` and the docs lint see). The
  // labelled fetch error carries the hint instead.
  if (url.startsWith("/")) return url;
  return `http://${url}`;
}

// Evaluate the user's arrow ONCE and keep the resulting function.
//
// The previous body was `return (${source})(x)`, which re-evaluated the arrow
// LITERAL on every call — nominally a fresh closure per item. Measured, it is
// NOT faster: 1M items through a lambda takes 0.236s before and 0.233s after,
// inside the noise, because JSC already handles the repeated literal well. Kept
// because it is the honest shape (compile once, call many) and it surfaces a
// non-function source as a clear error instead of a TypeError per item — not
// because it buys throughput.
// What an item looks like in an error message. JSON.stringify(Response) is
// "{}" — Response has no enumerable own properties — so the most common
// assertion in the docs (`assert (r => r.status === 201)`) used to fail with
// "got {}", which says nothing about what actually came back.
// Recognise a crust stage keyword that failed its own syntax and fell through
// to the shell, and say what was actually wrong.
const STAGE_SHAPES: Record<string, string> = {
  filter: "filter (x => …)",
  assert: "assert (x => …)",
  capture: "capture NAME (x => …)  — NAME must start with a letter or _",
  expect: "expect 200  — a 3-digit status or 2xx/3xx/4xx/5xx",
  parallel: "parallel 50  — a positive integer",
  stats: "stats [--every N] [--out file.json]",
  lines: "lines <glob>  — or bare `lines` to split upstream items",
};

function malformedStageHint(text: string): string | null {
  const head = text.trim().split(/\s+/)[0] ?? "";
  const shape = STAGE_SHAPES[head];
  if (!shape) return null;
  return (
    `${head}: malformed stage — expected \`${shape}\`, got \`${text.trim()}\`. ` +
    `(To run a program actually called "${head}", quote it: \`"${text.trim()}"\`.)`
  );
}

function describeItem(item: unknown): string {
  if (item instanceof Response) return `${item.status} ${item.statusText} ${item.url}`;
  return JSON.stringify(item)?.slice(0, 200) ?? String(item);
}

function compileLambda(source: string): (x: unknown) => unknown {
  const fn = new Function(`return (${source});`)();
  if (typeof fn !== "function") {
    throw new Error(`expected a function, got ${typeof fn}: ${source}`);
  }
  return fn as (x: unknown) => unknown;
}

const evalLambda = compileLambda;

// A spawned shell stage that exited nonzero. Carries the child's code so the
// line can exit with IT (127 for not-found, 3 for `exit 3`) instead of a flat
// 1 — and carries no message, because sh already wrote its own diagnostic to
// the inherited stderr. Before this existed a failing stage inside a MIXED
// pipeline was silently discarded and the line exited 0, so
// `… | expect 201 | tee report.txt` passed CI with no report written.
export class ShellExitError extends Error {
  constructor(
    readonly code: number,
    cmd: string,
  ) {
    super(`shell stage exited ${code}: ${cmd}`);
    this.name = "ShellExitError";
  }
}

// Only a real nonzero exit counts. A null code means the child was signalled —
// which is how BOTH Ctrl-C and our own teardown kill (downstream stopped early,
// e.g. `| head -3`) end a child, and neither is a failure of the line.
function exitFailure(proc: { exitCode: number | null }, cmd: string): ShellExitError | null {
  const code = proc.exitCode;
  return typeof code === "number" && code !== 0 ? new ShellExitError(code, cmd) : null;
}

function shellSource(cmd: string): Pipeline<unknown> {
  return Pipeline.of(
    (async function* () {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        stdout: "pipe",
        stderr: "inherit",
        // Live env so `capture`d $VARs from earlier lines reach sh.
        env: shellEnv(),
        // Own process group (setsid leader) so kills reach grandchildren.
        // `sh -c "sleep 30"` only execs into sleep on shells that optimise the
        // single-command case; dash — /bin/sh on Debian and Ubuntu — FORKS, so
        // killing the direct child left the grandchild running to completion.
        detached: true,
      });
      // REPL Ctrl-C kills the child through the bus; the finally kill also
      // reaps it when a downstream stage stops iterating early.
      const unregister = registerChild(() => sources.killGroup(proc));
      try {
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
        const failure = exitFailure(proc, cmd);
        if (failure) throw failure;
      } finally {
        unregister();
        sources.killGroup(proc);
      }
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
        env: shellEnv(),
        // Own process group — see shellSource: a forking /bin/sh (dash) would
        // otherwise orphan the grandchild on Ctrl-C or an early downstream exit.
        detached: true,
      });
      const unregister = registerChild(() => sources.killGroup(proc));
      try {
        // UPSTREAM failures must fail the line (the -c fail-fast contract);
        // writer failures must not (a child that exits early — head — closes
        // its stdin, and sh treats that as success). Either way the child
        // must reach EOF-or-death, or the stdout loop below never ends.
        let upstreamError: unknown;
        const writePromise = (async () => {
          const writer = proc.stdin as FileSink;
          try {
            for await (const item of input.lines()) {
              try {
                // write() returns a Promise under backpressure — awaiting it
                // paces the writer AND surfaces EPIPE here (catchable) when
                // the child exits early, instead of as unhandled-rejection
                // spam from the sink's internal flush.
                const r = writer.write(formatItem(item) + "\n") as number | Promise<number>;
                if (typeof r !== "number") await r;
              } catch {
                break; // child closed stdin — stop feeding, not an error
              }
            }
          } catch (err) {
            upstreamError = err ?? new Error("upstream failed");
          } finally {
            try {
              await writer.end();
            } catch {}
            if (upstreamError !== undefined) proc.kill();
          }
        })();

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
        await writePromise;
        // Upstream failure wins: it is the root cause, and the child's nonzero
        // exit is usually just a consequence of us killing it.
        if (upstreamError !== undefined) {
          throw upstreamError instanceof Error ? upstreamError : new Error(String(upstreamError));
        }
        const failure = exitFailure(proc, cmd);
        if (failure) throw failure;
      } finally {
        unregister();
        sources.killGroup(proc);
      }
    })(),
  );
}

interface FileSink {
  write(data: string | Uint8Array): number;
  end(): Promise<number>;
}
