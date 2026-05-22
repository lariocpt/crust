// Stub: tests should fail until §4 is implemented.

import type { Pipeline } from "./pipeline";

const NOT_IMPL = (op: string) =>
  new Error(`sinks.${op}: not implemented yet — see docs/spec/v0.1-contract.md §4`);

export function write<T>(_path: string): (input: Pipeline<T>) => Promise<void> {
  throw NOT_IMPL("write");
}

export function dest(_dir: string): (input: Pipeline<{ path: string; contents: string | Uint8Array }>) => Promise<void> {
  throw NOT_IMPL("dest");
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
  throw NOT_IMPL("stats");
}
