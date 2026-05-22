import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Pipeline } from "./pipeline";

export function write<T>(path: string): (input: Pipeline<T>) => Promise<void> {
  return async (input) => {
    await mkdir(dirname(path), { recursive: true });
    const lines: string[] = [];
    for await (const item of input.lines()) lines.push(String(item));
    await Bun.write(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  };
}

export function dest(
  dir: string,
): (input: Pipeline<{ path: string; contents: string | Uint8Array }>) => Promise<void> {
  return async (input) => {
    await mkdir(dir, { recursive: true });
    for await (const item of input.lines()) {
      await Bun.write(join(dir, basename(item.path)), item.contents);
    }
  };
}

export interface Stats {
  count: number;
  durationMs: number;
  status: Record<number, number>;
  p50: number;
  p95: number;
  p99: number;
}

export function stats(): (input: Pipeline<Response>) => Promise<Stats> {
  return async (input) => {
    const start = Date.now();
    const latencies: number[] = [];
    const statusCounts: Record<number, number> = {};
    let count = 0;
    for await (const r of input.lines()) {
      count++;
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      // Per-request latency tracking deferred — see v0.1.5 stretch.
      latencies.push(0);
    }
    const durationMs = Date.now() - start;
    const sorted = latencies.slice().sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
    return {
      count,
      durationMs,
      status: statusCounts,
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
    };
  };
}
