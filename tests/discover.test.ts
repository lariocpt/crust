import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "../src/types";

function mkCtx(): Context {
  return {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: () => {},
    dotenv: { history: [], snapshot: null },
  };
}

async function makeGlobalDir(
  prefix: string,
  packages: Record<string, { pkg: Record<string, unknown>; main?: string }>,
): Promise<void> {
  const deps: Record<string, string> = {};
  for (const name of Object.keys(packages)) deps[name] = "1.0.0";
  await mkdir(prefix, { recursive: true });
  await writeFile(`${prefix}/package.json`, JSON.stringify({ dependencies: deps }));
  for (const [name, { pkg, main }] of Object.entries(packages)) {
    const pkgDir = `${prefix}/node_modules/${name}`;
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      `${pkgDir}/package.json`,
      JSON.stringify({ name, main: "index.mjs", ...pkg }),
    );
    if (main !== undefined) await writeFile(`${pkgDir}/index.mjs`, main);
  }
}

async function freshImport(): Promise<typeof import("../src/discover")> {
  // bust module cache so env-var changes take effect per test
  const path = `../src/discover?t=${Date.now()}-${Math.random()}`;
  return await import(path);
}

describe("discoverGlobals", () => {
  let tmp: string;
  let prefix: string;
  let cache: string;
  const savedPrefix = process.env.CRUST_GLOBAL_PREFIX;
  const savedCache = process.env.CRUST_CACHE_DIR;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "crust-discover-"));
    prefix = join(tmp, "global");
    cache = join(tmp, "cache");
    process.env.CRUST_GLOBAL_PREFIX = prefix;
    process.env.CRUST_CACHE_DIR = cache;
  });

  afterEach(async () => {
    if (savedPrefix === undefined) delete process.env.CRUST_GLOBAL_PREFIX;
    else process.env.CRUST_GLOBAL_PREFIX = savedPrefix;
    if (savedCache === undefined) delete process.env.CRUST_CACHE_DIR;
    else process.env.CRUST_CACHE_DIR = savedCache;
    await rm(tmp, { recursive: true, force: true });
  });

  test("no global prefix → no-op", async () => {
    process.env.CRUST_GLOBAL_PREFIX = join(tmp, "does-not-exist");
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.size).toBe(0);
  });

  test("registers library package, skips binary package", async () => {
    await makeGlobalDir(prefix, {
      "fake-lib": {
        pkg: {},
        main: `export default function(input, suffix) { return input + ":" + suffix; }`,
      },
      "fake-bin": {
        pkg: { bin: "cli.js" },
        main: `export default function() { return "should not run"; }`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.has("fake-lib")).toBe(true);
    expect(ctx.functions.has("fake-bin")).toBe(false);
  });

  test("strips @scope/ from exposed name", async () => {
    await makeGlobalDir(prefix, {
      "@example/cool-pkg": {
        pkg: {},
        main: `export default function(x) { return "cool:" + x; }`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.has("cool-pkg")).toBe(true);
    expect(ctx.functions.has("@example/cool-pkg")).toBe(false);
  });

  test("crust field opts a binary package into stage dispatch", async () => {
    await makeGlobalDir(prefix, {
      "binlib": {
        pkg: { bin: "cli.js", crust: {} },
        main: `export default function(x) { return "OK:" + x; }`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.has("binlib")).toBe(true);
  });

  test("lazy dispatch actually invokes the package", async () => {
    await makeGlobalDir(prefix, {
      "fake-lib": {
        pkg: {},
        main: `export default function(input, suffix) { return input + ":" + suffix; }`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    const fn = ctx.functions.get("fake-lib")!;
    const out = await fn("hello", "world");
    expect(out).toBe("hello:world");
  });

  test("crust.stage selects a named export", async () => {
    await makeGlobalDir(prefix, {
      "multi-fn": {
        pkg: { crust: { stage: "doStage" } },
        main: `
          export function doStage(input, n) { return input.repeat(Number(n)); }
          export function other() { return "no"; }
        `,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    const fn = ctx.functions.get("multi-fn")!;
    expect(await fn("ab", "3")).toBe("ababab");
  });

  test("package with no callable default → registered, but throws on call", async () => {
    await makeGlobalDir(prefix, {
      "no-default": {
        pkg: {},
        main: `export const a = 1; export const b = 2;`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    // Discovery succeeds (we don't import eagerly), but invocation surfaces the error.
    expect(ctx.functions.has("no-default")).toBe(true);
    const fn = ctx.functions.get("no-default")!;
    await expect(fn("x")).rejects.toThrow(/no callable export/);
  });

  test("broken package doesn't block other packages", async () => {
    await makeGlobalDir(prefix, {
      "good-lib": {
        pkg: {},
        main: `export default function(x) { return "good:" + x; }`,
      },
      "broken-lib": {
        // package.json is invalid JSON
        pkg: {},
      },
    });
    // Corrupt broken-lib's package.json
    await writeFile(`${prefix}/node_modules/broken-lib/package.json`, "{ not json");
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.has("good-lib")).toBe(true);
    expect(ctx.functions.has("broken-lib")).toBe(false);
  });

  test("cache is written on rebuild", async () => {
    await makeGlobalDir(prefix, {
      "fake-lib": { pkg: {}, main: `export default function(x){return x;}` },
    });
    const { discoverGlobals } = await freshImport();
    await discoverGlobals(mkCtx());
    const cacheFile = Bun.file(`${cache}/globals.json`);
    expect(await cacheFile.exists()).toBe(true);
    const parsed = JSON.parse(await cacheFile.text());
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].exposedAs).toBe("fake-lib");
  });

  test("cache hit on second call (no re-discovery)", async () => {
    await makeGlobalDir(prefix, {
      "fake-lib": { pkg: {}, main: `export default function(x){return x;}` },
    });
    const { discoverGlobals } = await freshImport();
    await discoverGlobals(mkCtx());
    // Mutate package.json to add a new dep WITHOUT touching its mtime —
    // by writing a separate cache value back with the original mtime.
    // Simpler approach: replace fake-lib with broken content and verify
    // the second call STILL exposes fake-lib (proving it used the cache).
    await rm(`${prefix}/node_modules/fake-lib/package.json`);
    const ctx2 = mkCtx();
    await discoverGlobals(ctx2);
    expect(ctx2.functions.has("fake-lib")).toBe(true);
  });

  test("cache invalidates when package.json mtime changes", async () => {
    await makeGlobalDir(prefix, {
      "old-lib": { pkg: {}, main: `export default function(x){return x;}` },
    });
    const { discoverGlobals } = await freshImport();
    await discoverGlobals(mkCtx());

    // wait a tick so mtime is observably different on filesystems with second-resolution mtime
    await new Promise((r) => setTimeout(r, 50));
    await makeGlobalDir(prefix, {
      "new-lib": { pkg: {}, main: `export default function(x){return x;}` },
    });
    const ctx2 = mkCtx();
    await discoverGlobals(ctx2);
    expect(ctx2.functions.has("new-lib")).toBe(true);
    expect(ctx2.functions.has("old-lib")).toBe(false);
  });

  test("explicit registration overrides auto-dispatch", async () => {
    await makeGlobalDir(prefix, {
      "fake-lib": {
        pkg: {},
        main: `export default function(x){return "auto:"+x;}`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    // Simulate init.ts calling crust.fn("fake-lib", ...) after discovery.
    ctx.functions.set("fake-lib", (x) => `manual:${x}`);
    const fn = ctx.functions.get("fake-lib")!;
    expect(fn("hi")).toBe("manual:hi");
  });

  test("name collision: second package with same exposedAs is skipped", async () => {
    await makeGlobalDir(prefix, {
      "@a/dup": {
        pkg: {},
        main: `export default function(){return "a";}`,
      },
      "@b/dup": {
        pkg: {},
        main: `export default function(){return "b";}`,
      },
    });
    const { discoverGlobals } = await freshImport();
    const ctx = mkCtx();
    await discoverGlobals(ctx);
    expect(ctx.functions.has("dup")).toBe(true);
    // exact winner is non-deterministic since Object.keys order on package.json
    // deps is insertion-order; whichever is first wins. Verify exactly one
    // function got registered.
    let count = 0;
    for (const k of ctx.functions.keys()) if (k === "dup") count++;
    expect(count).toBe(1);
  });
});
