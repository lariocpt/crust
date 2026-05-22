import { stat, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Context } from "./types";

const DEBUG = process.env.CRUST_DEBUG === "1";

function dbg(msg: string): void {
  if (DEBUG) process.stderr.write(`crust: discover: ${msg}\n`);
}

interface CacheEntry {
  name: string;
  exposedAs: string;
  stageHint?: string;
}

interface Cache {
  pkgJsonMtime: number;
  entries: CacheEntry[];
}

function globalPrefix(): string {
  return process.env.CRUST_GLOBAL_PREFIX
    ?? `${process.env.HOME}/.bun/install/global`;
}

function cacheDir(): string {
  return process.env.CRUST_CACHE_DIR
    ?? `${process.env.HOME}/.cache/crust`;
}

function cachePath(): string {
  return `${cacheDir()}/globals.json`;
}

export async function discoverGlobals(ctx: Context): Promise<void> {
  const pkgJsonPath = `${globalPrefix()}/package.json`;
  let pkgJsonMtime: number;
  try {
    pkgJsonMtime = (await stat(pkgJsonPath)).mtimeMs;
  } catch {
    return;
  }

  let cache: Cache | null = null;
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Cache;
    if (parsed.pkgJsonMtime === pkgJsonMtime && Array.isArray(parsed.entries)) {
      cache = parsed;
    }
  } catch {
    // cache miss or corrupt — rebuild
  }

  if (!cache) {
    cache = await rebuildCache(pkgJsonMtime);
    await writeCache(cache);
  }

  for (const entry of cache.entries) {
    if (ctx.functions.has(entry.exposedAs)) continue;
    ctx.functions.set(
      entry.exposedAs,
      lazyDispatch(entry.name, entry.stageHint),
    );
  }
}

async function rebuildCache(pkgJsonMtime: number): Promise<Cache> {
  let pkg: { dependencies?: Record<string, string> };
  try {
    const raw = await readFile(`${globalPrefix()}/package.json`, "utf8");
    pkg = JSON.parse(raw);
  } catch {
    return { pkgJsonMtime, entries: [] };
  }
  const deps = Object.keys(pkg.dependencies ?? {});

  const settled = await Promise.allSettled(deps.map(inspectPackage));

  const entries: CacheEntry[] = [];
  const seen = new Set<string>();
  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const entry = result.value;
    if (seen.has(entry.exposedAs)) {
      dbg(`name collision on "${entry.exposedAs}" — skipping ${entry.name}`);
      continue;
    }
    seen.add(entry.exposedAs);
    entries.push(entry);
  }
  return { pkgJsonMtime, entries };
}

async function inspectPackage(name: string): Promise<CacheEntry | null> {
  try {
    const pkgJsonPath = `${globalPrefix()}/node_modules/${name}/package.json`;
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
      crust?: { stage?: string };
    };
    // Packages installed for their binary continue to behave as shell commands
    // — unless they explicitly opt into stage dispatch via the `crust` field.
    if (pkg.bin && !pkg.crust) {
      dbg(`skipping "${name}" — has bin field`);
      return null;
    }
    const exposedAs = name.startsWith("@")
      ? name.split("/")[1] ?? name
      : name;
    return { name, exposedAs, stageHint: pkg.crust?.stage };
  } catch (err) {
    dbg(`failed to inspect "${name}": ${(err as Error).message}`);
    return null;
  }
}

async function writeCache(cache: Cache): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(cache));
  } catch (err) {
    dbg(`cache write failed: ${(err as Error).message}`);
  }
}

function lazyDispatch(
  packageName: string,
  stageHint: string | undefined,
): (...args: unknown[]) => unknown {
  let resolved: ((...args: unknown[]) => unknown) | null = null;
  let resolveError: Error | null = null;
  let inflight: Promise<void> | null = null;

  const resolve = async (): Promise<void> => {
    try {
      const importPath = `${globalPrefix()}/node_modules/${packageName}`;
      const mod = (await import(importPath)) as Record<string, unknown> & {
        default?: unknown;
      };
      const fn = pickExport(mod, stageHint);
      if (typeof fn !== "function") {
        throw new Error(
          `package "${packageName}" has no callable export — ` +
          `wrap it explicitly with crust.fn() in init.ts`,
        );
      }
      resolved = fn as (...args: unknown[]) => unknown;
    } catch (err) {
      resolveError = err as Error;
    }
  };

  return async (...args: unknown[]): Promise<unknown> => {
    if (!resolved && !resolveError) {
      if (!inflight) inflight = resolve();
      await inflight;
    }
    if (resolveError) throw resolveError;
    return resolved!(...args);
  };
}

function pickExport(
  mod: Record<string, unknown> & { default?: unknown },
  stageHint: string | undefined,
): unknown {
  if (stageHint && typeof mod[stageHint] === "function") return mod[stageHint];
  if (typeof mod.default === "function") return mod.default;
  if (typeof mod === "function") return mod;
  const fnExports = Object.entries(mod).filter(
    ([k, v]) => typeof v === "function" && k !== "default",
  );
  if (fnExports.length === 1) return fnExports[0]![1];
  return null;
}
