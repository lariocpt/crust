import { formatItem } from "../format";
import * as interrupt from "../interrupt";
import { classify, tokenize } from "../lexer";
import { parseStages } from "../parser";
import { Pipeline } from "../pipeline";
import type { Context } from "../types";
import { MAX_CAPACITY, RingBuffer } from "./ring";

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
  /** ANSI highlighting for `search` matches (cli passes stdout.isTTY). */
  color?: boolean;
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
  json on
  filter (e => e.level >= 40) | stats --every 5
commands:
  buffer [N]     show buffer usage / resize the window (newest items kept)
  clear          empty the buffer
  json on|off    parse JSON-object lines at query time (others stay raw strings)
  search <text>  match the buffer only — highlighted + counted, no live view
  help           this text
  exit           tear down the source and leave (or Ctrl-D)
notes: a fragment runs TWICE (buffer, then live) — use >> not > in shell stages.
Up-arrow recalls earlier queries.
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
  private jsonMode = false;
  private jsonHintDone = false;

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
      const prompt = this.jsonMode ? "logs[json]> " : "logs> ";
      const line = await this.opts.readInput({ prompt, history });
      if (line === null) break; // Ctrl-D
      const q = line.trim();
      if (!q) continue;
      history.push(q);
      if (q === "exit" || q === "quit") break;
      if (q === "help") {
        writeErr(HELP);
        continue;
      }
      const bufferCmd = q.match(/^buffer(?:\s+(\S+))?$/);
      if (bufferCmd) {
        if (bufferCmd[1] === undefined) {
          // Exact historical output — pinned by tests.
          const state = this.sourceEnded ? "; source ended" : "";
          writeErr(
            `buffer: ${this.ring.size}/${this.ring.capacity} items (pushed ${this.ring.pushed}, evicted ${this.ring.evicted}${state})\n`,
          );
        } else {
          this.resizeBuffer(bufferCmd[1]);
        }
        continue;
      }
      if (q === "clear") {
        this.ring.clear();
        writeErr("buffer cleared\n");
        continue;
      }
      const jsonCmd = q.match(/^json(?:\s+(\S+))?$/);
      if (jsonCmd) {
        this.jsonHintDone = true;
        if (jsonCmd[1] === undefined) {
          writeErr(`json: ${this.jsonMode ? "on" : "off"} (\`json on|off\` to change)\n`);
        } else if (jsonCmd[1] === "on") {
          this.jsonMode = true;
          writeErr(
            "json: on — string items parsing to JSON objects/arrays reach queries parsed; everything else stays raw (ring untouched; `json off` reverts)\n",
          );
        } else if (jsonCmd[1] === "off") {
          this.jsonMode = false;
          writeErr("json: off\n");
        } else {
          writeErr("json: usage — json on|off\n");
        }
        continue;
      }
      const searchCmd = q.match(/^search(?:\s+(.*))?$/);
      if (searchCmd) {
        const needle = searchCmd[1]?.trim();
        if (!needle) {
          writeErr(
            "search: usage — search <text> (fixed substring; for regex or live matching, run a `grep` query)\n",
          );
        } else {
          this.runSearch(needle);
        }
        continue;
      }
      this.maybeJsonHint();
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
    const rawSnapshot = this.ring.snapshot();
    // json mode is a QUERY-TIME transform: the ring always stores raw items,
    // so `json off` is an instant lossless revert. String items that don't
    // become objects stay raw AND are counted — a mixed stream must neither
    // crash the query (the old `(l => JSON.parse(l))` idiom did) nor let
    // lines silently vanish.
    let retroRaw = 0;
    let liveRaw = 0;
    const snapshot = this.jsonMode
      ? rawSnapshot.map((i) => this.tryJson(i, () => retroRaw++))
      : rawSnapshot;
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
          retroIter.return?.(undefined)?.catch(() => {});
          return;
        }
        if (retroRaw > 0) {
          writeErr(
            `json: ${retroRaw} of ${rawSnapshot.length} buffered item(s) stayed raw (not JSON objects)\n`,
          );
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
      const liveSource = this.jsonMode
        ? this.mapJson(queue.stream(), () => liveRaw++)
        : queue.stream();
      const iter = build(Pipeline.of(liveSource), ctx).lines()[Symbol.asyncIterator]();
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
          iter.return?.(undefined)?.catch(() => {});
        } else {
          if (queue.dropped > 0) {
            writeErr(`logs: live view lagged — dropped ${queue.dropped} oldest item(s)\n`);
          }
          if (liveRaw > 0) {
            writeErr(`json: ${liveRaw} live item(s) stayed raw (not JSON objects)\n`);
          }
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

  // A string item parsing to a non-null object/array is replaced by the
  // parsed value. Everything else — non-strings (procs items), non-JSON
  // text, strings parsing to primitives ("42" must not change type) —
  // passes through unchanged; string misses are counted for the report.
  private tryJson(item: unknown, miss: () => void): unknown {
    if (typeof item !== "string") return item;
    const t = item.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const parsed = JSON.parse(item);
        if (parsed !== null && typeof parsed === "object") return parsed;
      } catch {
        // fall through — stays raw
      }
    }
    miss();
    return item;
  }

  private async *mapJson(src: AsyncGenerator<unknown>, miss: () => void): AsyncGenerator<unknown> {
    for await (const item of src) yield this.tryJson(item, miss);
  }

  // One-shot, evaluated lazily before a query while json is off. sample()
  // is a cheap peek — snapshot() would copy up to a million items per
  // prompt. Suggests, never auto-enables: silently changing the item type
  // under a lambda the user already typed is the interactive cousin of a
  // false pass.
  private maybeJsonHint(): void {
    if (this.jsonHintDone || this.jsonMode) return;
    try {
      const sample = this.ring
        .sample(8)
        .filter((i): i is string => typeof i === "string" && i.trim().length > 0);
      if (sample.length < 3) return; // not enough evidence yet — re-check next query
      this.jsonHintDone = true; // decided either way — stop paying per prompt
      for (const s of sample) {
        if (!s.trimStart().startsWith("{")) return;
        try {
          const p = JSON.parse(s);
          if (p === null || typeof p !== "object" || Array.isArray(p)) return;
        } catch {
          return;
        }
      }
      this.opts.writeErr(
        "hint: buffer looks like NDJSON — `json on` parses object lines at query time (`json off` reverts)\n",
      );
    } catch {
      this.jsonHintDone = true; // hint only — never let it interfere
    }
  }

  private resizeBuffer(arg: string): void {
    const { writeErr } = this.opts;
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) {
      writeErr(`logs: buffer size must be a positive integer — got "${arg}"\n`);
      return;
    }
    const target = Math.min(n, MAX_CAPACITY);
    if (n > MAX_CAPACITY) writeErr(`logs: buffer capped at ${MAX_CAPACITY}\n`);
    const before = this.ring.capacity;
    const { kept, discarded } = this.ring.resize(target);
    const drop = discarded > 0 ? `, discarded ${discarded} oldest` : "";
    writeErr(`buffer: resized ${before} → ${target} (kept ${kept} item(s)${drop})\n`);
  }

  // Retro-only, over the RAW ring (independent of json mode; works on procs
  // objects via formatItem): instant return, a count even at zero matches,
  // and highlighting — the three things a re-run query genuinely lacks.
  private runSearch(needle: string): void {
    const { write, writeErr } = this.opts;
    const snap = this.ring.snapshot();
    let matches = 0;
    for (const item of snap) {
      const text = formatItem(item);
      if (!text.includes(needle)) continue;
      matches++;
      write(`${this.highlight(text, needle)}\n`);
    }
    // Zero matches must never be silence.
    writeErr(`search: ${matches} matching item(s) of ${snap.length} buffered\n`);
  }

  // split/join on the literal needle — never a RegExp built from user text.
  private highlight(text: string, needle: string): string {
    if (this.opts.color !== true) return text;
    return text.split(needle).join(`\x1b[1;31m${needle}\x1b[0m`);
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
