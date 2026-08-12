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

// The old `stats()` sink lived here; it hardcoded every latency to 0 and
// reported fabricated percentiles. `transforms.statsStage` is the real one.
