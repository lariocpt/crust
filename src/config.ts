import { Pipeline } from "./pipeline";
import { range, glob, read, GET } from "./sources";
import { POST, PUT, PATCH, DELETE, expect, parallel } from "./transforms";
import { discoverGlobals } from "./discover";
import type { Context } from "./types";

interface CrustGlobal {
  alias(name: string, cmd: string): void;
  unalias(name: string): void;
  fn(name: string, handler: (...args: unknown[]) => unknown): void;
  prompt?: (cwd: string, git: string | null) => string;
}

declare global {
  // eslint-disable-next-line no-var
  var crust: CrustGlobal;
}

export async function loadConfig(ctx: Context, configPath?: string): Promise<void> {
  const path = configPath ?? `${process.env.HOME}/.config/crust/init.ts`;

  (globalThis as { crust?: CrustGlobal }).crust = {
    alias: (name, cmd) => ctx.aliases.set(name, cmd),
    unalias: (name) => ctx.aliases.delete(name),
    fn: (name, handler) => ctx.functions.set(name, handler),
    prompt: undefined,
  };

  const g = globalThis as Record<string, unknown>;
  g.Pipeline = Pipeline;
  g.range = range;
  g.glob = glob;
  g.read = read;
  g.GET = GET;
  g.POST = POST;
  g.PUT = PUT;
  g.PATCH = PATCH;
  g.DELETE = DELETE;
  g.expectStage = expect;
  g.parallel = parallel;
  g.$ = Bun.$;

  // Discover globally-installed npm packages and register them as pipeline
  // stages. Runs before init.ts so explicit crust.fn() calls in init.ts
  // overwrite (and therefore win over) auto-discovered entries.
  await discoverGlobals(ctx);

  try {
    await import(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ENOENT") {
      process.stderr.write(`crust: failed to load ${path}: ${(err as Error).message}\n`);
    }
  }
}
