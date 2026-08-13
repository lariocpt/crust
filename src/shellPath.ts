import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// npm-script-style PATH for shell stages: prepend every ancestor
// node_modules/.bin (nearest first) so locally-installed tool binaries
// (pino-pretty, tsc, vitest…) work bare — `grep x | pino-pretty` instead of
// `grep x | node_modules/.bin/pino-pretty` — exactly like inside `bun run`.
// Computed per spawn because `cd` moves the session at runtime; the cost is
// a handful of stat calls, noise next to a process spawn.
export function shellEnv(): Record<string, string | undefined> {
  const bins: string[] = [];
  let dir = process.cwd();
  while (true) {
    const bin = join(dir, "node_modules", ".bin");
    if (existsSync(bin)) bins.push(bin);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (bins.length === 0) return { ...process.env };
  return {
    ...process.env,
    PATH: [...bins, process.env.PATH ?? ""].join(delimiter),
  };
}
