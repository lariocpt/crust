import { formatItem } from "../format";
import * as interrupt from "../interrupt";
import { classify, tokenize } from "../lexer";
import { parseStages } from "../parser";
import { Pipeline } from "../pipeline";
import type { Context } from "../types";
import { RingBuffer } from "./ring";

// Bounded hand-off between the pump and the live view. Drop-oldest under
// pressure, with the drops COUNTED and reported — same honesty rule as the
// load source. end() is the graceful close: the stream finishes, so
// terminal stages downstream (bare `stats`) flush their summaries.
export class ViewQueue {
  private items: unknown[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  dropped = 0;

  constructor(private cap: number) {}

  offer(item: unknown): void {
    if (this.ended) return;
    if (this.items.length >= this.cap) {
      this.items.shift();
      this.dropped++;
    }
    this.items.push(item);
    this.waiter?.();
    this.waiter = null;
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = null;
  }

  async *stream(): AsyncGenerator<unknown> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((res) => {
        this.waiter = res;
      });
    }
  }
}

export interface LogsSessionOpts {
  source: AsyncIterable<unknown>;
  sourceLabel: string;
  bufferSize: number;
  viewQueueSize?: number;
  readInput(opts: { prompt: string; history: string[] }): Promise<string | null>;
  write(s: string): void;
  writeErr(s: string): void;
  /** Arm a Ctrl-C watcher; returns dispose. Nested inside the cli's guard. */
  onInterrupt(cb: () => void): () => void;
  ctx: Context;
  /** Extra banner line (e.g. the procs object-shape note). */
  note?: string;
  /** Tear down the held source so the pump can end (kill children etc.). */
  teardown?(): void | Promise<void>;
}

const HELP = `logs session — each line is a pipeline fragment run over the buffer, then live:
  grep ERROR
  (l => JSON.parse(l)) | filter (e => e.level >= 40) | stats --every 5
commands:
  buffer   show buffer usage        clear   empty the buffer
  help     this text                exit    tear down the source and leave (or Ctrl-D)
notes: a fragment runs TWICE (buffer, then live) — use >> not > in shell stages.
Ctrl-C once ends the live view and FLUSHES terminal stages (bare \`stats\` prints
its summary right there); Ctrl-C again hard-cancels a stuck query.
`;

export class LogsSession {
  private ring: RingBuffer<unknown>;
  private live: ViewQueue | null = null;
  private sourceEnded = false;
  private sourceError: string | null = null;
  private pumpDone: Promise<void>;
  private viewQueueSize: number;

  constructor(private opts: LogsSessionOpts) {
    this.ring = new RingBuffer(opts.bufferSize);
    this.viewQueueSize = opts.viewQueueSize ?? 1024;
    this.pumpDone = this.pump();
  }

  // The pump owns the source iterator for the whole session. push+offer is a
  // synchronous pair, and a query's snapshot+attach is a synchronous block,
  // so every item lands in exactly one of retro/live — never both or neither.
  private async pump(): Promise<void> {
    try {
      for await (const item of this.opts.source) {
        this.ring.push(item);
        this.live?.offer(item);
      }
    } catch (err) {
      this.sourceError = (err as Error).message;
    } finally {
      this.sourceEnded = true;
      this.live?.end();
    }
  }

  async run(): Promise<number> {
    const { writeErr } = this.opts;
    writeErr(
      `logs: ${this.opts.sourceLabel} — buffering last ${this.ring.capacity} items (\`help\` for commands, \`exit\` to leave)\n`,
    );
    if (this.opts.note) writeErr(`logs: ${this.opts.note}\n`);
    const history: string[] = [];
    while (true) {
      const line = await this.opts.readInput({ prompt: "logs> ", history });
      if (line === null) break; // Ctrl-D
      const q = line.trim();
      if (!q) continue;
      history.push(q);
      if (q === "exit" || q === "quit") break;
      if (q === "help") {
        writeErr(HELP);
        continue;
      }
      if (q === "buffer") {
        const state = this.sourceEnded ? "; source ended" : "";
        writeErr(
          `buffer: ${this.ring.size}/${this.ring.capacity} items (pushed ${this.ring.pushed}, evicted ${this.ring.evicted}${state})\n`,
        );
        continue;
      }
      if (q === "clear") {
        this.ring.clear();
        writeErr("buffer cleared\n");
        continue;
      }
      await this.runQuery(q);
    }
    await this.shutdown();
    return 0;
  }

  private async runQuery(fragment: string): Promise<void> {
    const { write, writeErr, ctx } = this.opts;
    let build: ReturnType<typeof parseStages>;
    try {
      build = parseStages(fragment);
    } catch (err) {
      writeErr(`crust: ${(err as Error).message}\n`);
      return;
    }

    // Synchronous snapshot + live attach — the exactly-once boundary.
    const snapshot = this.ring.snapshot();
    const queue = this.sourceEnded ? null : new ViewQueue(this.viewQueueSize);
    this.live = queue;

    // The QUERY (never the held source) drives the interrupt bus: shell
    // stages inside a fragment register their children with it, so a
    // cancelled query's `sh` child is actually killed instead of leaking.
    // The held source is immune by construction — cli tails carry their own
    // AbortSignal (which opts them out of the bus race), cli shell sources
    // never register, and procs listens for SIGINT which the bus never emits.
    interrupt.beginRun();
    try {
      // RETRO — the watcher must be armed here too: a fragment whose shell
      // child lingers after stdin EOF would otherwise wedge the session
      // with the keyboard dead. One press cancels the whole query.
      let retroCancelled = false;
      let cancelRetro: () => void = () => {};
      const retroCancelPromise = new Promise<void>((res) => {
        cancelRetro = res;
      });
      const disposeRetro = this.opts.onInterrupt(() => {
        writeErr("^C\n");
        retroCancelled = true;
        interrupt.fire(); // kill the fragment's registered shell children
        cancelRetro();
      });
      const retroIter = build(Pipeline.of(snapshot), ctx).lines()[Symbol.asyncIterator]();
      try {
        const retroDrain = (async () => {
          let res = await retroIter.next();
          while (!res.done) {
            write(`${formatItem(res.value)}\n`);
            res = await retroIter.next();
          }
        })();
        const who = await Promise.race([
          retroDrain.then(() => "done" as const),
          retroCancelPromise.then(() => "cancelled" as const),
        ]);
        if (who === "cancelled") {
          retroDrain.catch(() => {});
          void retroIter.return?.(undefined);
          return;
        }
      } catch (err) {
        writeErr(`crust: ${(err as Error).message}\n`);
        return; // a query that broke on the buffer must not run again live
      } finally {
        disposeRetro();
        if (retroCancelled) {
          this.live = null;
          queue?.end();
        }
      }

      if (!queue) {
        writeErr(
          `-- source ended${this.sourceError ? ` (${this.sourceError})` : ""}: retro only --\n`,
        );
        return;
      }

      writeErr("-- live --\n");
      this.maybeStatsHint(fragment);
      let presses = 0;
      let hardCancel: () => void = () => {};
      const hardCancelled = new Promise<void>((res) => {
        hardCancel = res;
      });
      const dispose = this.opts.onInterrupt(() => {
        presses++;
        writeErr("^C\n");
        if (presses === 1) {
          queue.end(); // graceful: stream ends, terminal stages flush
        } else {
          interrupt.fire(); // kill stuck shell children, wake parked stages
          hardCancel();
        }
      });
      const iter = build(Pipeline.of(queue.stream()), ctx).lines()[Symbol.asyncIterator]();
      try {
        const drain = (async () => {
          let res = await iter.next();
          while (!res.done) {
            write(`${formatItem(res.value)}\n`);
            res = await iter.next();
          }
        })();
        const outcome = await Promise.race([
          drain.then(() => "done" as const),
          hardCancelled.then(() => "hard" as const),
        ]);
        if (outcome === "hard") {
          drain.catch(() => {});
          void iter.return?.(undefined);
        } else if (queue.dropped > 0) {
          writeErr(`logs: live view lagged — dropped ${queue.dropped} oldest item(s)\n`);
        }
        if (this.sourceEnded && presses === 0) {
          writeErr(`-- source ended${this.sourceError ? ` (${this.sourceError})` : ""} --\n`);
        }
      } catch (err) {
        // A query error never kills the session — print and reprompt.
        writeErr(`crust: ${(err as Error).message}\n`);
      } finally {
        dispose();
      }
    } finally {
      interrupt.endRun();
      if (this.live === queue) this.live = null;
      queue?.end();
    }
  }

  private maybeStatsHint(fragment: string): void {
    try {
      const toks = tokenize(fragment);
      const last = classify(toks[toks.length - 1]!.text);
      if (last.kind === "stats" && last.everySec === undefined) {
        this.opts.writeErr(
          "hint: bare `stats` prints once when the view ends (Ctrl-C) — `stats --every 5` for rolling output\n",
        );
      }
    } catch {
      // hint only — never let it interfere with the query
    }
  }

  private async shutdown(): Promise<void> {
    try {
      await this.opts.teardown?.();
    } catch {
      // a source that is already gone is fine
    }
    const clean = await Promise.race([
      this.pumpDone.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    if (!clean) {
      this.opts.writeErr("logs: source did not shut down cleanly (continuing)\n");
    }
  }
}
