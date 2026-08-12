import { resolve } from "node:path";
import { Glob } from "bun";
import { registerBuiltinFns } from "../builtinFns";
import { expandTarget as expandGlob } from "../fixtures";
import { parse } from "../parser";
import type { Context } from "../types";

export interface PipeLineResult {
  file: string;
  lineNo: number;
  line: string;
  status: "pass" | "fail";
  durationMs: number;
  error?: string;
}

export interface PipesReport {
  results: PipeLineResult[];
  totals: { pass: number; fail: number; files: number };
  bailed: boolean;
}

export interface PipesOpts {
  target: string;
  bail?: boolean;
  timeoutMs?: number;
  setup?: string;
}

// A hermetic Context per run: builtin fns (sql, …) registered, but no init.ts
// and no shared alias state — a .pipes file must behave the same on every
// machine.
function freshContext(): Context {
  const ctx = {
    aliases: new Map(),
    functions: new Map(),
    history: [],
  } as unknown as Context;
  registerBuiltinFns(ctx);
  return ctx;
}

async function expandPipesTarget(target: string): Promise<string[]> {
  // expandGlob (from fixtures.ts) enforces .crust.ts; do our own suffix rule.
  const looksGlob = /[*?[\]{}]/.test(target);
  if (!looksGlob) {
    const abs = resolve(process.cwd(), target);
    if (!(await Bun.file(abs).exists())) return [];
    return [abs];
  }
  // Static import above, NOT await import("bun"): dynamic import of the
  // "bun" module breaks inside --bytecode compiled binaries ("awaitPromise
  // is not defined") — only the glob branch hit it, so single-file targets
  // masked the bug.
  const g = new Glob(target);
  const out: string[] = [];
  for await (const f of g.scan({ cwd: process.cwd(), absolute: true })) {
    if (f.endsWith(".pipes")) out.push(f);
  }
  out.sort();
  return out;
}

// Import the setup module (explicit --setup, else sibling <name>.setup.ts)
// and await its default export. Setup seeds process.env — that is how lines
// get $TOKEN-style values.
async function runSetup(file: string, explicit?: string): Promise<void> {
  let mod: string | null = null;
  if (explicit) {
    mod = resolve(process.cwd(), explicit);
  } else {
    const sibling = file.replace(/\.pipes$/, ".setup.ts");
    if (await Bun.file(sibling).exists()) mod = sibling;
  }
  if (!mod) return;
  const imported = (await import(mod)) as { default?: () => unknown };
  if (typeof imported.default === "function") {
    await imported.default();
  }
}

async function drainWithTimeout(line: string, ctx: Context, timeoutMs?: number): Promise<void> {
  const iter = parse(line)(ctx).lines();
  const drain = (async () => {
    for await (const _ of iter) {
      // shorthand fixtures assert via expect/assert stages; output is noise
    }
  })();
  if (!timeoutMs) {
    await drain;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void iter.return?.(undefined as never);
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([drain, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runPipes(opts: PipesOpts): Promise<PipesReport> {
  const files = await expandPipesTarget(opts.target);
  if (files.length === 0) {
    throw new Error(`test-pipes: no files matched ${opts.target}`);
  }

  const results: PipeLineResult[] = [];
  let bailed = false;

  outer: for (const file of files) {
    await runSetup(file, opts.setup);
    const text = await Bun.file(file).text();
    const lines = text.split("\n");
    const ctx = freshContext();

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const start = performance.now();
      try {
        // Sequential on purpose: shorthand suites interleave requests with
        // sql assertions about what the previous line did.
        await drainWithTimeout(line, ctx, opts.timeoutMs);
        results.push({
          file,
          lineNo: i + 1,
          line,
          status: "pass",
          durationMs: performance.now() - start,
        });
      } catch (err) {
        results.push({
          file,
          lineNo: i + 1,
          line,
          status: "fail",
          durationMs: performance.now() - start,
          error: (err as Error).message,
        });
        if (opts.bail) {
          bailed = true;
          break outer;
        }
      }
    }
  }

  const totals = {
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    files: files.length,
  };
  return { results, totals, bailed };
}
