// In-process lifecycle jobs the MCP server holds across tool calls:
// mock servers and stream sessions (procs runners, tails, held commands).
//
// WHY in-process: an MCP host keeps the server alive between calls, so a
// mock server or a dev runner started by one call must still be serving on
// the next. Child `crust -c` processes cannot hold anything, and the session
// machinery (RingBuffer pump, ViewQueue, procs supervision) is already
// in-process by construction — reusing it beats re-implementing it over IPC.
//
// stdout discipline: nothing here ever writes to process.stdout. The pump
// pushes items into a RingBuffer and any attached ViewQueue; queries collect
// results and return them as values. Pipeline shell stages PIPE their stdout
// (only stderr is inherited), which is what makes in-process query drains
// safe next to a protocol stream on fd 1.

import { formatItem } from "../format";
import * as interrupt from "../interrupt";
import { classify } from "../lexer";
import { MAX_CAPACITY, RingBuffer } from "../logs/ring";
import { ViewQueue } from "../logs/session";
import { loadSpec } from "../mockServer/loadSpec";
import {
  countColonParamPaths,
  countRegexLiteralPatterns,
  countWebhookOperations,
} from "../mockServer/router";
import { type RunningServer, startServer } from "../mockServer/server";
import { buildSource, parseStages } from "../parser";
import { Pipeline } from "../pipeline";
import { shellEnv } from "../shellPath";
import { killGroup, type ProcSpec, procs as procsSource, tail as tailSource } from "../sources";
import type { Context } from "../types";

export interface MockJob {
  kind: "mock";
  id: string;
  label: string;
  startedAt: number;
  server: RunningServer;
  origin: string;
  proxy?: string;
  modes: string;
  /** Spec-shape warnings the CLI prints at boot (colon params, regex
   *  literals, webhooks-only docs) — the tool returns them verbatim. */
  warnings: string[];
  seeded: number;
}

export interface StreamJob {
  kind: "stream";
  id: string;
  label: string;
  startedAt: number;
  /** Distinguishes a supervised procs runner from a plain held source. */
  procs?: boolean;
  ring: RingBuffer<unknown>;
  live: ViewQueue | null;
  sourceEnded: boolean;
  sourceError: string | null;
  teardown(): Promise<void>;
  pumpDone: Promise<void>;
}

export type Job = MockJob | StreamJob;

const LIVE_MAX_MS = 300_000;
const QUERY_ITEM_MAX = 5_000;
/** procs teardown carries its own SIGTERM→SIGKILL escalation (~3s); stop()
 *  waits for it but never wedges the MCP connection behind a child that
 *  ignores both signals. Past this bound stop REPORTS that teardown is still
 *  in flight — it never claims the processes are gone when they may not be. */
const TEARDOWN_REPORT_MS = 10_000;

export interface StreamQueryResult {
  items: string[];
  truncated: boolean;
  /** null = retro only (no live window requested, or the source already ended). */
  live: { collected: number; dropped: number; timedOut: boolean } | null;
  rawJson: { retro: number; live: number };
  buffer: { size: number; capacity: number; pushed: number; evicted: number; ended: boolean };
  sourceError: string | null;
}

export class JobManager {
  private seq = 0;
  private jobs = new Map<string, Job>();

  constructor(readonly ctx: Context) {}

  /** Unwind a pipeline iterator and WAIT for its finally (kill escalations
   *  live there). Typed wrapper: generators return iterator results, the
   *  teardown contract wants void. */
  private static async closeIter(iter: { return?: (v?: unknown) => unknown }): Promise<void> {
    try {
      await iter.return?.(undefined);
    } catch {
      // an iterator already unwound by its source failing is not news
    }
  }

  // ---------------------------------------------------------------- mock ----

  async startMock(opts: {
    spec: string;
    port: number;
    host: string;
    stateful?: boolean;
    state?: string;
    seed?: string;
    validate?: boolean;
    strict?: boolean;
    proxy?: string;
    proxyTimeoutMs?: number;
    report?: string;
  }): Promise<MockJob> {
    // Mutual exclusions mirrored from the CLI's contract BEFORE any boot work:
    // an agent gets this error, not a wedged half-boot.
    if (opts.proxy !== undefined && (opts.state !== undefined || opts.seed !== undefined)) {
      throw new Error("mock-server: --proxy excludes --state/--seed/--stateful");
    }
    const loaded = await loadSpec(opts.spec);
    const server = await startServer({
      port: opts.port,
      hostname: opts.host,
      spec: loaded.spec,
      stateful: opts.stateful,
      state: opts.state,
      seed: opts.seed,
      validate: opts.validate,
      strict: opts.strict,
      proxy: opts.proxy,
      proxyTimeoutMs: opts.proxyTimeoutMs,
      report: opts.report,
    });
    const modes = [
      opts.stateful || opts.state || opts.seed ? "stateful" : "",
      opts.validate && !opts.proxy ? "validate" : "",
      opts.strict ? "strict" : "",
      opts.proxy ? `proxy -> ${opts.proxy}` : "",
      opts.state ? `state: ${opts.state}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    // The same boot warnings the CLI prints — routes that can never match a
    // real client must not look healthy from the outside.
    const warnings: string[] = [];
    const colon = countColonParamPaths(loaded.spec);
    if (colon > 0) {
      warnings.push(
        `${colon} path(s) use Express-style ':param' — OpenAPI templates parameters as '{param}', so these are matched LITERALLY and will not match a real value`,
      );
    }
    const literalPatterns = countRegexLiteralPatterns(loaded.spec);
    if (literalPatterns > 0) {
      warnings.push(
        `${literalPatterns} pattern(s) are JavaScript regex LITERALS — JSON Schema expects a bare regex, so NO value can satisfy them`,
      );
    }
    if (server.routes.length === 0) {
      const hooks = countWebhookOperations(loaded.spec);
      if (hooks > 0) {
        warnings.push(
          `0 routes but ${hooks} webhook operation(s) — webhooks are callbacks you receive, not endpoints to mock`,
        );
      }
    }
    const job: MockJob = {
      kind: "mock",
      id: `mock-${++this.seq}`,
      label: opts.spec,
      startedAt: Date.now(),
      server,
      origin: loaded.origin,
      proxy: opts.proxy,
      modes,
      warnings,
      seeded: server.seeded,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async stopMock(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.kind !== "mock") throw new Error(`no mock server job ${id}`);
    await job.server.stop();
    this.jobs.delete(id);
  }

  listMock(): MockJob[] {
    return [...this.jobs.values()].filter((j): j is MockJob => j.kind === "mock");
  }

  // -------------------------------------------------------------- stream ----

  /** Hold an arbitrary source open (tail / held shell command / procs literal
   *  / anything the grammar builds as a source) and pump it into a ring. */
  async openStream(spec: string, bufferSize: number): Promise<StreamJob> {
    const kind = classify(spec);
    let source: AsyncIterable<unknown>;
    let teardown: () => void | Promise<void>;

    switch (kind.kind) {
      case "stdin":
        throw new Error(
          "logs: a stdin source belongs to a pipe, not a session — run `cmd | crust -c 'stdin | …'` via crust_run_line instead",
        );
      case "glob":
        throw new Error(
          `logs: a bare glob yields file PATHS, not contents — try \`tail -n 0 -F ${spec}\` or \`read ${spec}\``,
        );
      case "shell": {
        // Spawn here (not via the parser's shell source) so teardown's kill
        // reaches the child — the held command must not outlive the session.
        const proc = Bun.spawn(["sh", "-c", kind.text], {
          stdout: "pipe",
          stderr: "inherit",
          env: shellEnv(),
          detached: true,
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
          killGroup(proc);
        };
        break;
      }
      case "tail": {
        // Built directly (not via buildSource) so teardown can ABORT the
        // follow loop — same reason the interactive logs CLI does.
        const controller = new AbortController();
        const pipeline = tailSource(kind.paths, {
          lines: kind.lines,
          follow: kind.follow,
          signal: controller.signal,
        });
        const iter = pipeline.lines()[Symbol.asyncIterator]();
        source = { [Symbol.asyncIterator]: () => iter };
        teardown = () => {
          controller.abort();
          return JobManager.closeIter(iter);
        };
        break;
      }
      case "procs": {
        // A procs literal typed as a logs source. Evaluated like the
        // parser's procs stage (same trusted-eval stance: the MCP caller
        // already runs arbitrary lambdas), but through a factory that
        // attaches THIS session's AbortController — the per-session kill.
        // A global SIGINT here would tear down every procs session at once.
        const controller = new AbortController();
        const factory = (specs: Record<string, string | ProcSpec>): Pipeline<unknown> =>
          procsSource(specs, { signal: controller.signal });
        const build = new Function("procs", `return (${kind.source});`) as (
          p: (specs: Record<string, string | ProcSpec>) => Pipeline<unknown>,
        ) => Pipeline<unknown>;
        const pipeline = build(factory);
        const iter = pipeline.lines()[Symbol.asyncIterator]();
        source = { [Symbol.asyncIterator]: () => iter };
        teardown = () => {
          controller.abort();
          return JobManager.closeIter(iter);
        };
        break;
      }
      default: {
        // read, GET, a registered function … anything buildable as a source.
        const pipeline = buildSource(kind, this.ctx);
        const iter = pipeline.lines()[Symbol.asyncIterator]();
        source = { [Symbol.asyncIterator]: () => iter };
        teardown = () => JobManager.closeIter(iter);
        break;
      }
    }

    return this.attachStream(source, teardown, spec, bufferSize, false);
  }

  /** Structured procs supervision: specs validated by procs() itself, kill
   *  via this session's own AbortSignal (never a global SIGINT). */
  async startProcs(
    commands: Record<string, string | ProcSpec>,
    bufferSize: number,
  ): Promise<StreamJob> {
    const controller = new AbortController();
    const pipeline = procsSource(commands, { signal: controller.signal });
    const iter = pipeline.lines()[Symbol.asyncIterator]();
    const source = { [Symbol.asyncIterator]: () => iter };
    const teardown = (): Promise<void> => {
      controller.abort();
      return JobManager.closeIter(iter);
    };
    return this.attachStream(
      source,
      teardown,
      `procs(${Object.keys(commands).join(", ")})`,
      bufferSize,
      true,
    );
  }

  private attachStream(
    source: AsyncIterable<unknown>,
    teardown: () => void | Promise<void>,
    label: string,
    bufferSize: number,
    procs: boolean,
  ): StreamJob {
    const size = Math.min(Math.max(1, Math.trunc(bufferSize)), MAX_CAPACITY);
    const job: StreamJob = {
      kind: "stream",
      id: `logs-${++this.seq}`,
      label,
      startedAt: Date.now(),
      procs: procs || undefined,
      ring: new RingBuffer<unknown>(size),
      live: null,
      sourceEnded: false,
      sourceError: null,
      teardown: async () => {
        await teardown();
      },
      pumpDone: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    job.pumpDone = this.pump(job, source);
    return job;
  }

  /** Same exactly-once contract as the interactive logs pump: push+offer is a
   *  synchronous pair, and a query's snapshot+attach is a synchronous block,
   *  so every item lands in exactly one of retro/live — never both or neither. */
  private async pump(job: StreamJob, source: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const item of source) {
        job.ring.push(item);
        job.live?.offer(item);
      }
    } catch (err) {
      job.sourceError = (err as Error).message;
    } finally {
      job.sourceEnded = true;
      job.live?.end();
    }
  }

  async stopStream(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (!job || job.kind !== "stream") throw new Error(`no stream session ${id}`);
    this.jobs.delete(id);
    try {
      await job.teardown();
    } catch {
      // a source that is already gone is fine
    }
    const clean = await Promise.race([
      job.pumpDone.then(() => true),
      Bun.sleep(TEARDOWN_REPORT_MS).then(() => false),
    ]);
    // The held source must not keep offering into a dead session.
    job.live?.end();
    return clean
      ? "torn down cleanly"
      : "teardown still in flight past 10s (a child ignoring SIGTERM); crust kills it when the server exits";
  }

  listStream(): StreamJob[] {
    return [...this.jobs.values()].filter((j): j is StreamJob => j.kind === "stream");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  // -------------------------------------------------------------- query ----

  /** Run a pipeline fragment over the buffered past, then (optionally) over a
   *  bounded live window — the interactive `logs>` semantics with a deadline
   *  instead of Ctrl-C. An EMPTY fragment is the buffer dump itself.
   *  json parses INPUT items before the fragment, exactly like `json on`. */
  async queryStream(
    id: string,
    fragment: string,
    opts: { liveMs?: number; json?: boolean; limit?: number },
  ): Promise<StreamQueryResult> {
    const job = this.jobs.get(id);
    if (!job || job.kind !== "stream") throw new Error(`no stream session ${id}`);
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 500)), QUERY_ITEM_MAX);
    const liveMs = Math.min(Math.max(0, Math.trunc(opts.liveMs ?? 0)), LIVE_MAX_MS);

    const result: StreamQueryResult = {
      items: [],
      truncated: false,
      live: null,
      rawJson: { retro: 0, live: 0 },
      buffer: { size: 0, capacity: 0, pushed: 0, evicted: 0, ended: job.sourceEnded },
      sourceError: job.sourceError,
    };

    // json mode is a QUERY-TIME transform over a raw ring: string items that
    // parse to objects/arrays are replaced; everything else stays raw AND is
    // counted — a mixed stream must neither crash the query nor silently drop
    // lines (the interactive session's contract, same helper semantics).
    const tryJson = (item: unknown, miss: () => void): unknown => {
      if (typeof item !== "string") return item;
      const t = item.trimStart();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          const parsed = JSON.parse(item);
          if (parsed !== null && typeof parsed === "object") return parsed;
        } catch {
          /* stays raw */
        }
      }
      miss();
      return item;
    };
    const mapLiveJson = (items: AsyncIterable<unknown>): AsyncGenerator<unknown> =>
      (async function* () {
        for await (const i of items) yield tryJson(i, () => result.rawJson.live++);
      })();

    let build: ReturnType<typeof parseStages> | null = null;
    const trimmed = fragment.trim();
    if (trimmed) build = parseStages(trimmed); // malformed fragment throws — the tool reports it

    // Synchronous snapshot + live attach — the exactly-once boundary.
    const rawSnapshot = job.ring.snapshot();
    const snapshot =
      opts.json === true
        ? rawSnapshot.map((i) => tryJson(i, () => result.rawJson.retro++))
        : rawSnapshot;
    const queue = liveMs > 0 && !job.sourceEnded ? new ViewQueue(4096) : null;
    job.live = queue;

    // Drain an iterator into strings, hard-capped at `cap` items. The caller
    // owns the iterator so a deadline cancel can reach the SAME iterator
    // `collect` parked on — a fresh `.lines()` would unwind nothing.
    const collect = async (
      iter: AsyncIterator<unknown>,
      cap: number,
      into: string[],
    ): Promise<{ capped: boolean }> => {
      let capped = false;
      while (cap > 0) {
        const res = await iter.next();
        if (res.done) break;
        into.push(formatItem(res.value));
        cap--;
        if (cap === 0) {
          // One peek would DOUBLE-COUNT under the exactly-once contract;
          // reaching the cap is reported as truncation even if the stream
          // was concurrently done — conservative, never a silent cut.
          capped = true;
          await iter.return?.(undefined)?.catch(() => {});
          break;
        }
      }
      return { capped };
    };

    // The QUERY (never the held source) drives the interrupt bus, so a
    // timed-out live window's shell children are killed rather than leaked.
    interrupt.beginRun();
    try {
      const retroPipeline = build ? build(Pipeline.of(snapshot), this.ctx) : Pipeline.of(snapshot);
      const retroIter = retroPipeline.lines()[Symbol.asyncIterator]();
      const retro = await collect(retroIter, limit - result.items.length, result.items);
      if (retro.capped) result.truncated = true;

      if (queue) {
        const liveInput: AsyncIterable<unknown> =
          opts.json === true ? mapLiveJson(queue.stream()) : queue.stream();
        const livePipeline = build
          ? build(Pipeline.of(liveInput), this.ctx)
          : Pipeline.of(liveInput);
        const liveIter = livePipeline.lines()[Symbol.asyncIterator]();
        const liveOut: string[] = [];
        const draining = collect(liveIter, limit - result.items.length, liveOut);
        const deadline = Bun.sleep(liveMs).then(() => ({ kind: "deadline" as const }));
        const first = await Promise.race([
          draining.then((r) => ({ kind: "done" as const, r })),
          deadline,
        ]);
        if (first.kind === "done") {
          result.live = { collected: liveOut.length, dropped: queue.dropped, timedOut: false };
        } else {
          // Deadline: end the view GRACEFULLY (the stream finishes, terminal
          // stages like a bare `stats` flush their summary), then hard-cancel
          // a drain that still wedges after 2s — firing the bus kills the
          // query's registered shell children and wakes parked stages.
          queue.end();
          const raced = await Promise.race([
            draining.then(() => "done" as const),
            Bun.sleep(2_000).then(() => "hard" as const),
          ]);
          if (raced === "hard") {
            interrupt.fire();
            void liveIter.return?.(undefined)?.catch(() => {});
          }
          result.live = { collected: liveOut.length, dropped: queue.dropped, timedOut: true };
        }
        result.items.push(...liveOut);
      }
    } finally {
      interrupt.endRun();
      if (job.live === queue) job.live = null;
      queue?.end();
      result.buffer = {
        size: job.ring.size,
        capacity: job.ring.capacity,
        pushed: job.ring.pushed,
        evicted: job.ring.evicted,
        ended: job.sourceEnded,
      };
    }
    return result;
  }

  // ----------------------------------------------------------- teardown ----

  async stopAll(): Promise<void> {
    const ids = [...this.jobs.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        try {
          if (job.kind === "mock") await job.server.stop();
          else {
            await job.teardown();
            job.live?.end();
            await Promise.race([job.pumpDone, Bun.sleep(TEARDOWN_REPORT_MS)]);
          }
        } catch {
          // best-effort on the way out; the process is leaving anyway
        }
      }),
    );
  }
}
