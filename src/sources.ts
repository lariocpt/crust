import { stat } from "node:fs/promises";
import { file, Glob } from "bun";
import { Pipeline } from "./pipeline";

export function range(start: number, end: number): Pipeline<number> {
  return Pipeline.of(
    (async function* () {
      for (let i = start; i <= end; i++) yield i;
    })(),
  );
}

export function glob(pattern: string): Pipeline<string> {
  const g = new Glob(pattern);
  return Pipeline.of(
    (async function* () {
      for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
        yield f;
      }
    })(),
  );
}

export function read(path: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      const text = await file(path).text();
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) yield line;
    })(),
  );
}

export interface TailOptions {
  lines?: number;
  follow?: boolean;
  pollMs?: number;
}

// Polling cadence under follow. Aggressive enough for an interactive log
// stream, gentle enough not to flood a slow disk. Override per call with
// `pollMs` if you need something tighter.
const DEFAULT_TAIL_POLL_MS = 200;

export function tail(paths: string | string[], opts: TailOptions = {}): Pipeline<string> {
  const initialLines = opts.lines ?? 10;
  const follow = opts.follow ?? false;
  const pollMs = opts.pollMs ?? DEFAULT_TAIL_POLL_MS;
  const inputs = Array.isArray(paths) ? paths : [paths];

  return Pipeline.of(
    (async function* () {
      const resolved = await expandTailPaths(inputs);
      if (resolved.length === 0) {
        if (!follow) throw new Error(`tail: no files matched ${inputs.join(", ")}`);
        return;
      }
      if (resolved.length === 1) {
        yield* tailOne(resolved[0]!, initialLines, follow, pollMs);
        return;
      }
      yield* mergeAsync(resolved.map((p) => tailOne(p, initialLines, follow, pollMs)));
    })(),
  );
}

async function expandTailPaths(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (/[*?[]/.test(input)) {
      const g = new Glob(input);
      const matches: string[] = [];
      for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
        matches.push(f);
      }
      matches.sort();
      for (const m of matches) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    } else if (!seen.has(input)) {
      seen.add(input);
      out.push(input);
    }
  }
  return out;
}

async function* tailOne(
  path: string,
  initialLines: number,
  follow: boolean,
  pollMs: number,
): AsyncGenerator<string> {
  let offset = 0;
  let currentIno: number | null = null;
  let buf = "";

  try {
    const s0 = await stat(path);
    const text = await file(path).slice(0, s0.size).text();
    offset = s0.size;
    currentIno = s0.ino;
    if (initialLines > 0) {
      const all = text.split("\n");
      if (all.length > 0 && all[all.length - 1] === "") all.pop();
      for (const line of all.slice(-initialLines)) yield line;
    }
  } catch (err) {
    if (!follow) throw err;
  }

  if (!follow) return;

  while (true) {
    await Bun.sleep(pollMs);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(path);
    } catch {
      continue;
    }
    // Rotate-and-recreate: a new inode replaced the old file. Reset
    // and read from the top. Truncate-in-place: same inode but file
    // shrank below our offset. Reset and read from the top.
    if (currentIno !== null && s.ino !== currentIno) {
      offset = 0;
      buf = "";
    } else if (s.size < offset) {
      offset = 0;
      buf = "";
    }
    currentIno = s.ino;

    if (s.size > offset) {
      const chunk = await file(path).slice(offset, s.size).text();
      offset = s.size;
      buf += chunk;
      const split = buf.split("\n");
      buf = split.pop() ?? "";
      for (const line of split) yield line;
    }
  }
}

// Merge N async generators into one stream. Yields each value as soon as any
// upstream produces it (non-deterministic order across sources). Used by
// multi-file tail so `tail a.log b.log` behaves like `tail -f a.log b.log`.
async function* mergeAsync<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
  type Slot = {
    idx: number;
    gen: AsyncGenerator<T>;
    pending: Promise<{ idx: number; res: IteratorResult<T> }>;
  };
  const slots: Slot[] = gens.map((gen, idx) => ({
    idx,
    gen,
    pending: gen.next().then((res) => ({ idx, res })),
  }));
  const active = new Set(slots);
  try {
    while (active.size > 0) {
      const winner = await Promise.race([...active].map((s) => s.pending));
      const slot = slots[winner.idx]!;
      if (winner.res.done) {
        active.delete(slot);
        continue;
      }
      yield winner.res.value;
      slot.pending = slot.gen.next().then((res) => ({ idx: slot.idx, res }));
    }
  } finally {
    for (const s of slots) {
      void s.gen.return?.(undefined as unknown as T);
    }
  }
}

export function GET(url: string, opts?: RequestInit): Pipeline<Response> {
  return Pipeline.of(
    (async function* () {
      const res = await fetch(url, { ...opts, method: "GET" });
      yield res;
    })(),
  );
}
