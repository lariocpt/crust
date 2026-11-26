// The asset pipeline contract, run through REAL Bun.build calls (Bun 1.4.4).
// Several tests pin measured bundler behavior — see the header of
// src/assets.ts for the locked facts. Fixture prefixes ("crust-site-bundle-fx-",
// "crust-site-staging-") deliberately do NOT start with the build-tmpdir
// prefix ("crust-site-asset-") so the cleanup tests can snapshot the system
// temp dir without seeing fixtures.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  type AssetManifest,
  buildAssets,
  copyPublicDir,
  manifestLookup,
  publicCollisions,
  stripMultiFileBanners,
} from "../src/assets.ts";
import { defineSite, resolveConfigPaths } from "../src/config.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import type { AssetsConfig, ResolvedSite } from "../src/types.ts";

const created: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

async function project(
  files: Record<string, string>,
  assets?: AssetsConfig,
): Promise<{ dir: string; site: ResolvedSite }> {
  const dir = await tmp("crust-site-bundle-fx-");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  const site = resolveConfigPaths(
    defineSite({
      site: "https://crust.dev",
      content: { directory: "content", defaultLayout: "docs" },
      layouts: { docs: () => "" },
      output: { directory: "dist" },
      ...(assets !== undefined ? { assets } : {}),
    }),
    dir,
  );
  return { dir, site };
}

const scripts = (map: Record<string, string>): AssetsConfig => ({ scripts: map });
const HASHED_JS = /^assets\/[A-Za-z0-9_-]+-[0-9a-f]{16}\.js$/;

async function listing(dir: string): Promise<string[] | undefined> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return undefined; // directory does not exist
  }
}

async function readStaged(staging: string, file: string): Promise<Buffer> {
  return readFile(join(staging, file));
}

describe("buildAssets", () => {
  test("a ts entrypoint bundles its local import into ONE hashed file", async () => {
    const { site } = await project(
      {
        "src/util.ts": `export const greet = (n: string): string => "hi " + n;\n`,
        "src/app.ts": `import { greet } from "./util";\nconsole.log(greet("x"));\n`,
      },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    expect([...manifest.keys()]).toEqual(["app"]);
    const entry = manifest.get("app");
    if (!entry) throw new Error('manifest is missing the declared "app" entry');
    expect(entry.file).toMatch(HASHED_JS);
    const emitted = await readStaged(staging, entry.file);
    expect(entry.bytes).toBe(emitted.length);
    // the local module is INLINED (one file, no import left), and the name is
    // fully posix — no backslash ever reaches the manifest (Windows table).
    const text = emitted.toString();
    expect(text).toContain("hi ");
    expect(text).not.toContain("import");
    expect(entry.file).not.toContain("\\");
    expect(await listing(join(staging, "assets"))).toEqual([entry.file.slice("assets/".length)]);
  });

  test("the manifest name is the DECLARED name, not the entry file's basename", async () => {
    const { site } = await project(
      { "src/weird-entry-name.ts": `console.log(1);\n` },
      scripts({ main: "src/weird-entry-name.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    expect(manifest.get("main")?.file).toMatch(/^assets\/main-[0-9a-f]{16}\.js$/);
  });

  test("a css entrypoint merges @import into ONE stylesheet output (pinned, Bun 1.4.4)", async () => {
    const { site } = await project(
      {
        "src/base.css": `.base { color: red; }\n`,
        "src/site.css": `@import "./base.css";\n.site { color: blue; }\n`,
      },
      { styles: { site: "src/site.css" } },
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const file = manifest.get("site")?.file;
    expect(file).toMatch(/^assets\/site-[0-9a-f]{16}\.css$/);
    const text = (await readStaged(staging, file ?? "missing")).toString();
    expect(text).toContain(".base");
    expect(text).toContain(".site");
  });

  test("dynamic import() is INLINED by Bun 1.4.4 — single output, no diagnostics (pinned)", async () => {
    // Measured: target "browser" converts `await import("./lazy.ts")` into an
    // inline promise resolution; NO chunk file is emitted. The multi-output
    // guard stays for entrypoints that really do emit several files (next
    // test); if a future Bun starts chunking, the same guard catches it.
    const { site } = await project(
      {
        "src/lazy.ts": `export const lazy = 42;\n`,
        "src/app.ts": `export async function go() {\n  const m = await import("./lazy.ts");\n  return m.lazy;\n}\nconsole.log(go);\n`,
      },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    expect(manifest.size).toBe(1);
    const text = (await readStaged(staging, manifest.get("app")?.file ?? "missing")).toString();
    expect(text).toContain("42");
  });

  test("an entrypoint emitting side files is asset.entrypoint-chunked, naming every file", async () => {
    const { site } = await project(
      {
        "src/with-asset.ts": `import logo from "./logo.svg";\nconsole.log(logo);\n`,
        "src/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>\n`,
      },
      scripts({ "with-asset": "src/with-asset.ts", logo: "src/logo.svg" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(manifest.size).toBe(0);
    expect(diagnostics.map((d) => d.code)).toEqual([
      // both entrypoints measured to emit 2 files (entry + hashed svg)
      "asset.entrypoint-chunked",
      "asset.entrypoint-chunked",
    ]);
    expect(diagnostics.map((d) => d.severity)).toEqual(["error", "error"]);
    // sorted by declared name, and every message names the entrypoint and
    // lists the emitted files (the svg's own Bun-assigned name included).
    expect(diagnostics[0].message).toContain("logo");
    expect(diagnostics[0].message).toContain(".svg");
    expect(diagnostics[1].message).toContain("with-asset");
    expect(diagnostics[1].message).toContain(".svg");
    // nothing half-emitted: no assets/ directory at all.
    expect(await listing(join(staging, "assets"))).toBeUndefined();
  });

  test("a syntax error is an asset.bundle-failed diagnostic, not a thrown crash", async () => {
    const { site } = await project(
      {
        "src/bad.ts": `export function ( { ;\n`,
        "src/good.ts": `console.log(1);\n`,
      },
      scripts({ bad: "src/bad.ts", good: "src/good.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    // measured: Bun.build THROWS an AggregateError whose .errors are
    // BuildMessages with position — folded into located diagnostics.
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.code).toBe("asset.bundle-failed");
      expect(d.severity).toBe("error");
      expect(d.sourcePath).toContain("bad.ts");
    }
    expect(diagnostics.some((d) => d.message.includes("Expected identifier"))).toBe(true);
    expect(diagnostics[0].line).toBe(1);
    expect(diagnostics[0].message).toContain("bad");
    // the failing entrypoint does NOT cancel its sibling (collect, don't halt)
    expect([...manifest.keys()]).toEqual(["good"]);
  });

  test("a missing entrypoint file is asset.bundle-failed naming the file", async () => {
    // the src/ directory exists (a missing FILE, not a missing tree — with no
    // directory at all Bun reports "failed to open root directory .../src"
    // and the file name never appears); the message is then the measured
    // "ModuleNotFound resolving <path> (entry point)".
    const { site } = await project(
      { "src/keep.ts": `console.log(0);\n` },
      scripts({ gone: "src/gone.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(manifest.size).toBe(0);
    expect(diagnostics.map((d) => d.code)).toContain("asset.bundle-failed");
    expect(diagnostics[0].message).toContain("gone.ts");
  });

  test("the hash changes when any input byte changes", async () => {
    const files = {
      "src/util.ts": `export const n = 1;\n`,
      "src/app.ts": `import { n } from "./util";\nconsole.log(n);\n`,
    };
    const { dir, site } = await project(files, scripts({ app: "src/app.ts" }));
    const s1 = await tmp("crust-site-staging-");
    const first = await buildAssets(site, s1);
    const before = first.manifest.get("app")?.file;
    // one byte changes in a DEPENDENCY, not the entrypoint — the hash of the
    // final emitted bytes must move with it.
    await writeFile(join(dir, "src/util.ts"), `export const n = 2;\n`);
    const s2 = await tmp("crust-site-staging-");
    const second = await buildAssets(site, s2);
    const after = second.manifest.get("app")?.file;
    expect(before).toMatch(HASHED_JS);
    expect(after).toMatch(HASHED_JS);
    expect(after).not.toBe(before);
  });

  test("two DIFFERENT entrypoints with identical bytes share the hash but not the name", async () => {
    // The manifest is name-keyed (plan §1: names are map keys, never path
    // components), so identical content under two declared names must produce
    // the same 16-hex hash inside two distinct file names — proving the hash
    // is content-driven (name-independent) and the name is declaration-driven
    // (content-independent). Identical name+hash therefore implies identical
    // content (collision-safety argument in src/assets.ts).
    // The honest way to get identical emitted bytes through two entrypoints
    // is one file declared twice — which is exactly the case that must not
    // overwrite itself. (Two DIFFERENT files with identical content share a
    // hash too, once the cwd-relative banner is stripped — pinned below.)
    const { site } = await project(
      { "src/same.ts": `console.log("same");\n` },
      scripts({ one: "src/same.ts", two: "src/same.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const one = manifest.get("one")?.file;
    const two = manifest.get("two")?.file;
    expect(one).toMatch(/^assets\/one-[0-9a-f]{16}\.js$/);
    expect(two).toMatch(/^assets\/two-[0-9a-f]{16}\.js$/);
    const hashOf = (f: string): string => f.slice(f.lastIndexOf("-") + 1, f.lastIndexOf("-") + 17);
    expect(hashOf(one ?? "")).toBe(hashOf(two ?? ""));
    expect(one).not.toBe(two);
    // both files exist, byte-identical, and the hashes are lowercase hex
    const a = await readStaged(staging, one ?? "missing");
    const b = await readStaged(staging, two ?? "missing");
    expect(Buffer.compare(a, b)).toBe(0);
    expect(hashOf(one ?? "")).toBe(hashOf(one ?? "").toLowerCase());
  });

  test("identical inputs rebuild a byte-identical, name-sorted manifest (plan §4.6)", async () => {
    const { site } = await project(
      {
        "src/a.ts": `console.log("a");\n`,
        "src/b.ts": `console.log("b");\n`,
        "src/s.css": `.s { color: red; }\n`,
      },
      { scripts: { zulu: "src/a.ts", mike: "src/b.ts" }, styles: { Alpha: "src/s.css" } },
    );
    const s1 = await tmp("crust-site-staging-");
    const s2 = await tmp("crust-site-staging-");
    const one = await buildAssets(site, s1);
    const two = await buildAssets(site, s2);
    expect(one.diagnostics).toEqual([]);
    expect(two.diagnostics).toEqual([]);
    // scripts AND styles interleave in ONE sorted namespace (code-unit order,
    // uppercase before lowercase — compareStrings, locale-free).
    expect([...one.manifest.keys()]).toEqual(["Alpha", "mike", "zulu"]);
    expect([...two.manifest.keys()]).toEqual([...one.manifest.keys()]);
    expect(JSON.stringify([...one.manifest])).toBe(JSON.stringify([...two.manifest]));
    for (const entry of one.manifest.values()) {
      const a = await readStaged(s1, entry.file);
      const b = await readStaged(s2, entry.file);
      expect(Buffer.compare(a, b)).toBe(0);
    }
  });

  test("the manifest lists ONLY real outputs — junk in staging cannot leak into it", async () => {
    // Why this matters: Bun.build does NOT clear an outdir (measured; see the
    // control test below), so any design that COLLECTS FILES FROM A DIRECTORY
    // (a reused outdir, or a staging scan) would publish stale files. This
    // module never scans: outputs come from the Bun.build result array only,
    // each build into a fresh mkdtemp dir. Pre-seeded staging junk proves the
    // manifest is result-driven, not directory-driven.
    const { site } = await project(
      { "src/app.ts": `console.log(1);\n` },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    await mkdir(join(staging, "assets"), { recursive: true });
    await writeFile(join(staging, "assets", "junk-stale-old.js"), `stale\n`);
    const first = await buildAssets(site, staging);
    expect([...first.manifest.keys()]).toEqual(["app"]);
    expect(first.manifest.get("app")?.file).not.toContain("junk");
    // rebuild into the SAME staging dir: still only the real output, byte-stable
    const second = await buildAssets(site, staging);
    expect(JSON.stringify([...second.manifest])).toBe(JSON.stringify([...first.manifest]));
    expect(await readFile(join(staging, "assets", "junk-stale-old.js"), "utf8")).toBe("stale\n");
  });

  test("control: Bun.build does NOT clear a reused outdir (why fresh tmpdirs are mandatory)", async () => {
    // The locked measurement, pinned directly: two builds into one outdir
    // leave BOTH files in the directory. A "collect the outdir" design would
    // publish the first build's file into the second build — a stale leak and
    // a false artifact. buildAssets avoids this structurally (fresh mkdtemp +
    // outputs array), never by clearing.
    const { dir } = await project({
      "src/a-entry.ts": `console.log("a");\n`,
      "src/b-entry.ts": `console.log("b");\n`,
    });
    const outdir = await tmp("crust-site-bundle-fx-outdir-");
    const a = await Bun.build({
      entrypoints: [join(dir, "src/a-entry.ts")],
      outdir,
      target: "browser",
    });
    const b = await Bun.build({
      entrypoints: [join(dir, "src/b-entry.ts")],
      outdir,
      target: "browser",
    });
    expect(a.outputs).toHaveLength(1);
    expect(b.outputs).toHaveLength(1);
    expect(await listing(outdir)).toEqual(["a-entry.js", "b-entry.js"]);
  });

  test("build tmpdirs are removed on success AND on failure (system temp snapshot)", async () => {
    const buildTmps = async (): Promise<Set<string>> =>
      new Set((await readdir(tmpdir())).filter((n) => n.startsWith("crust-site-asset-")));
    const before = await buildTmps();
    const { site } = await project(
      { "src/app.ts": `console.log(1);\n`, "src/bad.ts": `export function ( { ;\n` },
      scripts({ app: "src/app.ts" }),
    );
    await buildAssets(site, await tmp("crust-site-staging-"));
    const afterSuccess = await buildTmps();
    expect([...afterSuccess].filter((n) => !before.has(n))).toEqual([]);
    const { site: broken } = await project(
      { "src/bad.ts": `export function ( { ;\n` },
      scripts({ bad: "src/bad.ts" }),
    );
    await buildAssets(broken, await tmp("crust-site-staging-"));
    const afterFailure = await buildTmps();
    expect([...afterFailure].filter((n) => !before.has(n))).toEqual([]);
  });

  test("tmpdirs are gone even when the COPY into staging throws (finally covers every path)", async () => {
    // The build succeeds; the failure is our own writeFile/mkdir into staging.
    // The rejection must still not leak the build tmpdir (resource-leak audit:
    // the finally block runs on thrown I/O errors, not just bundler errors).
    const buildTmps = async (): Promise<string[]> =>
      (await readdir(tmpdir())).filter((n) => n.startsWith("crust-site-asset-"));
    const before = await buildTmps();
    const { site } = await project(
      { "src/app.ts": `console.log(1);\n` },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    // assets exists as a FILE → mkdir(staging/assets) cannot succeed (ENOTDIR)
    await writeFile(join(staging, "assets"), `not a directory\n`);
    await expect(buildAssets(site, staging)).rejects.toThrow();
    expect(await buildTmps()).toEqual(before);
  });

  test("zero declared assets is an empty manifest — no assets/ directory is created", async () => {
    const { site } = await project({ "src/x.ts": `console.log(1);\n` });
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(manifest.size).toBe(0);
    expect(diagnostics).toEqual([]);
    expect(await listing(join(staging, "assets"))).toBeUndefined();
  });
});

/**
 * Manifest access for the tests below: a missing key is a labeled failure,
 * never a cryptic `TypeError: … of undefined (reading 'file')` — a broken
 * build must be reported, not masked (design rule 1).
 */
function assetFile(manifest: AssetManifest, name: string): string {
  const entry = manifest.get(name);
  if (entry === undefined) throw new Error(`asset "${name}" is not in the build manifest`);
  return entry.file;
}

describe("Bun banner strip (cross-cwd determinism)", () => {
  // Bun 1.4.x prepends a cwd-relative path banner to the bundled output;
  // buildAssets strips them (src/assets.ts, stripBundlerBanner for the one
  // leading banner of single-input bundles, stripMultiFileBanners for every
  // per-file banner of multi-input bundles) so the hash and the emitted
  // bytes never depend on the working directory.

  test("single-file entries: identical hashes and byte-identical files from THREE different cwds", async () => {
    const { dir, site } = await project(
      {
        "src/app.ts": `const a = 1;\nexport { a };\n`,
        "src/site.css": `.x { color: red; }\n`,
      },
      { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" } },
    );
    // Three structurally different cwds relative to the project — the
    // banner would render three different forms (e.g. `src/app.ts`,
    // `../<proj>/src/app.ts`, `../../../<proj>/src/app.ts`), so any
    // cwd leakage in the bytes (or hashes) is visible.
    const deepRoot = await tmp("crust-site-cwd-deep-");
    const cwds = [dir, await tmp("crust-site-cwd-shallow-"), join(deepRoot, "deep", "er")];
    await mkdir(join(deepRoot, "deep", "er"), { recursive: true });
    const stags = [
      await tmp("crust-site-staging-"),
      await tmp("crust-site-staging-"),
      await tmp("crust-site-staging-"),
    ];
    const original = process.cwd();
    const results: Awaited<ReturnType<typeof buildAssets>>[] = [];
    try {
      for (const cwd of cwds) {
        process.chdir(cwd);
        results.push(await buildAssets(site, stags[results.length]));
      }
    } finally {
      process.chdir(original);
    }
    for (const r of results) expect(r.diagnostics).toEqual([]);
    // identical manifests: same names, same hashed file names, same byte counts
    const asJson = (m: (typeof results)[number]["manifest"]) => JSON.stringify([...m.entries()]);
    expect(asJson(results[1].manifest)).toBe(asJson(results[0].manifest));
    expect(asJson(results[2].manifest)).toBe(asJson(results[0].manifest));
    // and the emitted files are byte-identical across all three builds
    for (const [name, entry] of results[0].manifest) {
      const a = await readFile(join(stags[0], entry.file));
      expect(a.equals(await readFile(join(stags[1], assetFile(results[1].manifest, name))))).toBe(
        true,
      );
      expect(a.equals(await readFile(join(stags[2], assetFile(results[2].manifest, name))))).toBe(
        true,
      );
    }
  });

  test("the leading banner is gone from single-file outputs (JS and CSS); content intact", async () => {
    const { site } = await project(
      {
        "src/app.ts": `console.log(1);\n`,
        "src/site.css": `.x { color: red; }\n`,
      },
      { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" } },
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const js = (await readFile(join(staging, assetFile(manifest, "app")))).toString();
    const css = (await readFile(join(staging, assetFile(manifest, "site")))).toString();
    // the banner would be the very first line of the file; the real content
    // of these fixtures is not a comment
    expect(js.startsWith("//")).toBe(false);
    expect(css.startsWith("/*")).toBe(false);
    expect(js).toContain("console.log");
    expect(css).toContain("color: red");
  });

  test("a hashbang entry keeps its hashbang; the banner after it is stripped", async () => {
    const { site } = await project(
      { "src/app.ts": `#!/usr/bin/env node\nconsole.log(1);\n` },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const text = (await readFile(join(staging, assetFile(manifest, "app")))).toString();
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // no banner line anywhere (it sat after one blank line, post-hashbang)
    expect(text).not.toContain("// ");
    expect(text).toContain("console.log");
  });

  test("a user comment equal to its own banner: Bun drops the comment, we drop the banner", async () => {
    // The over-strip guard, stated against measured Bun 1.4.4 behavior: the
    // transpiler drops the entry's OWN comment line before the banner is
    // prepended, so the output holds exactly ONE such line — the banner.
    // The strip must remove that one line and nothing else, leaving the
    // pure code. (The comment line is gone from the bundle entirely — a
    // documented consequence of Bun's comment-free transpile, not a loss
    // this strip could cause either way.)
    const { dir, site } = await project(
      { "src/app.ts": `console.log(1);\n` },
      scripts({ app: "src/app.ts" }),
    );
    const abs = join(dir, "src/app.ts");
    const rel =
      process.platform === "win32"
        ? win32.relative(process.cwd(), abs).replace(/\\/g, "/")
        : posix.relative(process.cwd(), abs);
    await writeFile(abs, `// ${rel}\nconsole.log(1);\n`);
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const text = (await readFile(join(staging, assetFile(manifest, "app")))).toString();
    expect(text).toBe("console.log(1);\n");
    expect(text).not.toContain(rel);
  });

  test("a template-literal line that LOOKS like the banner is never touched", async () => {
    // Why the strip is an exact match and never a pattern: the transpiler
    // is comment-free, but backtick-string content is emitted VERBATIM —
    // a line of it can be byte-identical to the banner and sit in the
    // output as a plain line. The strip removes only the banner at the
    // head of the file and must leave such a line intact.
    const { site } = await project(
      {
        "src/app.ts": "const s = `first\n// src/app.ts\nthird`;\nconsole.log(s);\n",
      },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const text = (await readFile(join(staging, assetFile(manifest, "app")))).toString();
    expect(text).toBe("var s = `first\n// src/app.ts\nthird`;\nconsole.log(s);\n");
  });

  test("identical content in two DIFFERENT files shares one hash (purely content-driven)", async () => {
    // Pre-strip, the differing banners would have forced different hashes
    // here; the strip makes the hash a function of content alone (plan §1).
    const { site } = await project(
      {
        "src/a.ts": `console.log("same");\n`,
        "src/b.ts": `console.log("same");\n`,
      },
      scripts({ a: "src/a.ts", b: "src/b.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const hashOf = (f: string): string => f.slice(f.lastIndexOf("-") + 1, f.lastIndexOf("-") + 17);
    const a = assetFile(manifest, "a");
    const b = assetFile(manifest, "b");
    expect(hashOf(a)).toBe(hashOf(b));
    expect(a).not.toBe(b);
  });

  test("a multi-file bundle strips EVERY per-file path comment (metafile-enumerated, exact match, gated)", async () => {
    // The leading banner of a multi-file bundle names the FIRST bundled
    // file (a dependency), not the entry — the single-file head-match cannot
    // identify it, and a pattern strip would eat template-literal lines that
    // merely look like banners. The strip therefore enumerates the build's
    // input files from the metafile (whose keys are measured byte-identical
    // to the banner paths), computes the exact banner for each, and removes
    // any output line byte-identical to one of them — gated on the file's
    // first line being such a banner, so a bannerless or changed-shape
    // output is never touched. This pins the STRIP (the inverse of the old
    // documented-residual test: a regression that keeps these comments
    // breaks here, which would re-open the cwd-sensitive hash).
    const { site } = await project(
      {
        "src/util.ts": `export const n = 1;\n`,
        "src/more.ts": `export const m = 2;\n`,
        "src/app.ts": `import { n } from "./util";\nimport { m } from "./more";\nconsole.log(n + m);\n`,
      },
      scripts({ app: "src/app.ts" }),
    );
    const staging = await tmp("crust-site-staging-");
    const { manifest, diagnostics } = await buildAssets(site, staging);
    expect(diagnostics).toEqual([]);
    const text = (await readFile(join(staging, assetFile(manifest, "app")))).toString();
    // no per-file path banner survives anywhere in the file
    for (const line of text.split("\n")) {
      expect(line).not.toMatch(/^\/\/ .+$/);
    }
    expect(text).not.toContain("src/util.ts");
    expect(text).not.toContain("src/more.ts");
    expect(text).not.toContain("src/app.ts");
    // content intact, in bundle order
    const i1 = text.indexOf("n = 1");
    const i2 = text.indexOf("m = 2");
    const i3 = text.indexOf("console.log");
    expect(i1).not.toBe(-1);
    expect(i2).not.toBe(-1);
    expect(i3).not.toBe(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("a multi-file bundle (entry imports 2 local modules) is byte-identical — hash and file — from THREE different cwds", async () => {
    // THE determinism contract for the old residual case: pre-fix, every
    // per-file banner of a multi-file bundle embedded a cwd-relative path,
    // so the same site built from a different cwd hashed differently. Now
    // every banner is stripped (metafile-enumerated, exact match, gated), so
    // the emitted bytes — and the hash — are identical from any working
    // directory. The three cwds are structurally different relative to the
    // project, so the banners render three different forms (a plain
    // `src/…` form, a `../<proj>/src/…` form from a sibling, and a deeper
    // `../../…` form) — any cwd leakage in the bytes or hashes is visible.
    const { dir, site } = await project(
      {
        "src/util.ts": `export const n = 1;\n`,
        "src/more.ts": `export const m = 2;\n`,
        "src/app.ts": `import { n } from "./util";\nimport { m } from "./more";\nconsole.log(n + m);\n`,
        "src/base.css": `.base { color: red; }\n`,
        "src/site.css": `@import "./base.css";\n.site { color: blue; }\n`,
      },
      { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" } },
    );
    const deepRoot = await tmp("crust-site-cwd-deep-");
    const cwds = [dir, await tmp("crust-site-cwd-shallow-"), join(deepRoot, "deep", "er")];
    await mkdir(join(deepRoot, "deep", "er"), { recursive: true });
    const stags = [
      await tmp("crust-site-staging-"),
      await tmp("crust-site-staging-"),
      await tmp("crust-site-staging-"),
    ];
    const original = process.cwd();
    const results: Awaited<ReturnType<typeof buildAssets>>[] = [];
    try {
      for (const cwd of cwds) {
        process.chdir(cwd);
        results.push(await buildAssets(site, stags[results.length]));
      }
    } finally {
      process.chdir(original);
    }
    for (const r of results) expect(r.diagnostics).toEqual([]);
    // identical manifests: same names, same hashed file names, same byte
    // counts (the hashes themselves are the cross-cwd proof)
    const asJson = (m: (typeof results)[number]["manifest"]) => JSON.stringify([...m.entries()]);
    expect(asJson(results[1].manifest)).toBe(asJson(results[0].manifest));
    expect(asJson(results[2].manifest)).toBe(asJson(results[0].manifest));
    // and the emitted files are byte-identical across all three builds —
    // JS multi-file AND CSS @import bundles (block-comment banners)
    for (const [name, entry] of results[0].manifest) {
      const a = await readFile(join(stags[0], entry.file));
      expect(a.equals(await readFile(join(stags[1], assetFile(results[1].manifest, name))))).toBe(
        true,
      );
      expect(a.equals(await readFile(join(stags[2], assetFile(results[2].manifest, name))))).toBe(
        true,
      );
    }
  });

  test("a bare-specifier import resolves from the ENTRY's location (node_modules) even from a foreign cwd, and its banner is stripped", async () => {
    // The metafile-based strip must not move module resolution: the entry
    // imports a bare specifier that resolves via a node_modules tree NEXT TO
    // THE ENTRY (never via the process cwd), and the build runs from an
    // unrelated working directory. The package's banner — a node_modules
    // path, cwd-relative — must be stripped like any other input's, which
    // is what keeps the hash cwd-independent for npm imports.
    const { site } = await project(
      {
        "node_modules/fake-pkg/index.js": `export const fromPkg = "pkg-content";\n`,
        "src/app.ts": `import { fromPkg } from "fake-pkg";\nconsole.log(fromPkg);\n`,
      },
      scripts({ app: "src/app.ts" }),
    );
    const otherCwd = await tmp("crust-site-cwd-bare-");
    const staging = await tmp("crust-site-staging-");
    const original = process.cwd();
    let result: Awaited<ReturnType<typeof buildAssets>>;
    try {
      process.chdir(otherCwd);
      result = await buildAssets(site, staging);
    } finally {
      process.chdir(original);
    }
    expect(result.diagnostics).toEqual([]);
    const text = (await readFile(join(staging, assetFile(result.manifest, "app")))).toString();
    expect(text).toContain("pkg-content");
    // the package's banner is gone: no node_modules path anywhere
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("fake-pkg");
  });
});

describe("stripMultiFileBanners (unit)", () => {
  // The strip operates on the EMITTED bytes, so these tests synthesize the
  // bytes Bun 1.4.4 would emit (a banner before every file's code, one
  // blank line between files — measured) and run the real strip against
  // them. Each test chdirs into a fresh tmpdir so the cwd-relative
  // candidate computation (and the entry read for the hashbang check) is
  // deterministic; the cwd is restored in `finally` like the build-level
  // cross-cwd tests.
  const runInTmp = async (
    setup: (cwd: string) => Promise<void>,
    body: (cwd: string) => Promise<void>,
  ): Promise<void> => {
    const cwd = await tmp("crust-site-strip-unit-");
    const original = process.cwd();
    try {
      await setup(cwd);
      await body(cwd);
    } finally {
      process.chdir(original);
    }
  };

  test("strips every per-file banner; code and blank lines survive", async () => {
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "app.ts"), `console.log(1);\n`); // no hashbang
      },
      async (cwd) => {
        // metafile keys exactly as Bun reports them (pretty, cwd-relative)
        const text =
          "// util.ts\n" +
          `const n = 1;\n\n` +
          "// more.ts\n" +
          `const m = 2;\n\n` +
          "// app.ts\n" +
          `console.log(n + m);\n`;
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "app.ts"), ".js", [
          "util.ts",
          "more.ts",
          "app.ts",
        ]);
        // every banner line gone; every original line break kept (a
        // stripped banner leaves its line break behind)
        expect(new TextDecoder("utf-8").decode(out)).toBe(
          "\nconst n = 1;\n\n\nconst m = 2;\n\n\nconsole.log(n + m);\n",
        );
      },
    );
  });

  test("gate: a first line that is no computed banner returns the SAME bytes object untouched", async () => {
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "app.ts"), `console.log(1);\n`);
      },
      async (cwd) => {
        const text = "// not-a-known-input.ts\nconst n = 1;\n";
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "app.ts"), ".js", [
          "util.ts",
          "app.ts",
        ]);
        // identity, not equality: a no-match must leave the bytes ALONE
        expect(out).toBe(bytes);
      },
    );
  });

  test("gate at the hashbang offset: the banner after a preserved hashbang is stripped", async () => {
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "app.ts"), `#!/usr/bin/env node\nconsole.log(1);\n`);
      },
      async (cwd) => {
        const text = `#!/usr/bin/env node\n\n// app.ts\nconst n = 1;\n`;
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "app.ts"), ".js", ["app.ts"]);
        expect(new TextDecoder("utf-8").decode(out)).toBe(
          `#!/usr/bin/env node\n\n\nconst n = 1;\n`,
        );
      },
    );
  });

  test("a template-literal line byte-identical to a banner is stripped with it (pinned caveat)", async () => {
    // The transpile drops EVERY source comment, so a bare comment-shaped
    // line in the output can only be a banner or template-literal content.
    // When the latter is byte-identical to a computed banner, the exact
    // match removes it: one line of STRING data changes (the backtick
    // boundaries survive, the code still parses) — never code structure.
    // docs/USAGE.md (Assets) documents the trade; this pins it so any
    // future change to the rule has to change the docs, not silently.
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "app.ts"), `console.log(1);\n`);
      },
      async (cwd) => {
        const text = `// util.ts\nconst s = \`keep\n// util.ts\ndrop\`;\n`;
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "app.ts"), ".js", [
          "util.ts",
          "app.ts",
        ]);
        expect(new TextDecoder("utf-8").decode(out)).toBe(`\nconst s = \`keep\n\ndrop\`;\n`);
      },
    );
  });

  test("the ../ pretty form (an input outside the cwd) is matched too", async () => {
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "e.js"), `console.log(1);\n`);
      },
      async (cwd) => {
        // key "../other/mod.js": the metafile's form for a file OUTSIDE the
        // cwd — the candidate list re-derives it from the resolved absolute
        // path, so both forms must match
        const text = `// ../other/mod.js\nconst m = 3;\n\n// e.js\nconst e = 4;\n`;
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "e.js"), ".js", [
          "../other/mod.js",
          "e.js",
        ]);
        expect(new TextDecoder("utf-8").decode(out)).toBe("\nconst m = 3;\n\n\nconst e = 4;\n");
      },
    );
  });

  test("css bundles: block-comment banners are stripped for every input", async () => {
    await runInTmp(
      async (cwd) => {
        await writeFile(join(cwd, "b.css"), `.b { color: blue; }\n`);
      },
      async (cwd) => {
        const text = `/* a.css */\n.a { color: red; }\n\n/* b.css */\n.b { color: blue; }\n`;
        const bytes = Buffer.from(text, "utf8");
        const out = await stripMultiFileBanners(bytes, join(cwd, "b.css"), ".css", [
          "a.css",
          "b.css",
        ]);
        expect(new TextDecoder("utf-8").decode(out)).toBe(
          "\n.a { color: red; }\n\n\n.b { color: blue; }\n",
        );
      },
    );
  });

  test("empty bytes are returned unchanged", async () => {
    const bytes = new Uint8Array(0);
    const out = await stripMultiFileBanners(bytes, "/nonexistent/entry.js", ".js", ["x.js"]);
    expect(out).toBe(bytes);
  });
});

describe("manifestLookup", () => {
  test("a declared name returns its entry", async () => {
    const { site } = await project(
      { "src/app.ts": `console.log(1);\n` },
      scripts({ app: "src/app.ts" }),
    );
    const { manifest } = await buildAssets(site, await tmp("crust-site-staging-"));
    const result = manifestLookup(manifest, "app");
    expect(result.found).toBe(true);
    if (result.found) expect(result.entry.file).toMatch(HASHED_JS);
  });

  test("an unknown name returns an asset.unknown-entrypoint diagnostic naming the declared ones", async () => {
    const { site } = await project(
      { "src/app.ts": `console.log(1);\n`, "src/s.css": `.s{color:red}\n` },
      { scripts: { app: "src/app.ts" }, styles: { theme: "src/s.css" } },
    );
    const { manifest } = await buildAssets(site, await tmp("crust-site-staging-"));
    const result = manifestLookup(manifest, "appp");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.diagnostic.code).toBe("asset.unknown-entrypoint");
      expect(result.diagnostic.severity).toBe("error");
      expect(result.diagnostic.message).toContain("appp");
      expect(result.diagnostic.message).toContain("app, theme");
    }
  });

  test("an empty manifest says so instead of listing nothing", () => {
    const result = manifestLookup(new Map(), "app");
    expect(result.found).toBe(false);
    if (!result.found) expect(result.diagnostic.message).toContain("no assets were declared");
  });
});

describe("copyPublicDir", () => {
  const withPublic = (dir: string): AssetsConfig => ({ publicDirectory: dir });

  test("copies the tree preserving relative paths and bytes; copied list sorted", async () => {
    const { site } = await project(
      {
        "pub/z.txt": `z\n`,
        "pub/a.txt": `a\n`,
        "pub/nested/y.txt": `y\n`,
        "pub/nested/deep/b.txt": `deep-bytes-\x00\xff\n`,
        "pub/.hidden": `dot\n`, // public is user-declared wholesale — dotfiles included
      },
      withPublic("pub"),
    );
    // empty directories are part of the tree too — including NESTED ones
    await mkdir(join(site.configDir, "pub", "empty"), { recursive: true });
    await mkdir(join(site.configDir, "pub", "outer", "inner-empty"), { recursive: true });
    const staging = await tmp("crust-site-staging-");
    const { copied, diagnostics } = await copyPublicDir(site, staging);
    expect(diagnostics).toEqual([]);
    expect(copied).toEqual([".hidden", "a.txt", "nested/deep/b.txt", "nested/y.txt", "z.txt"]);
    // byte-for-byte, no rewriting (the CRLF-normalizing determinism rule is
    // for emitted text, not opaque public files)
    expect(await readStaged(staging, "nested/deep/b.txt")).toEqual(
      await readFile(join(site.configDir, "pub", "nested/deep/b.txt")),
    );
    expect(await readStaged(staging, ".hidden")).toEqual(Buffer.from("dot\n"));
    // files land at the staging ROOT — no pub/ wrapper
    expect(await listing(join(staging, "pub"))).toBeUndefined();
    expect(await listing(join(staging, "empty"))).toEqual([]);
    expect(await listing(join(staging, "outer"))).toEqual(["inner-empty"]);
    expect(await listing(join(staging, "outer", "inner-empty"))).toEqual([]);
  });

  test("no publicDirectory configured → silent no-op; configured-but-empty → empty list", async () => {
    const bare = await project({ "src/x.ts": `console.log(1);\n` });
    const staging1 = await tmp("crust-site-staging-");
    expect(await copyPublicDir(bare.site, staging1)).toEqual({ copied: [], diagnostics: [] });
    expect(await listing(staging1)).toEqual([]);
    const { site } = await project({ "keep/.gitkeep": `` }, withPublic("keep2"));
    await mkdir(join(site.configDir, "keep2"), { recursive: true });
    expect(await copyPublicDir(site, await tmp("crust-site-staging-"))).toEqual({
      copied: [],
      diagnostics: [],
    });
  });

  test("configured but absent is asset.public-missing; a FILE is asset.public-missing", async () => {
    const absent = await project({}, withPublic("pub"));
    const r1 = await copyPublicDir(absent.site, await tmp("crust-site-staging-"));
    expect(r1.copied).toEqual([]);
    expect(r1.diagnostics.map((d) => d.code)).toEqual(["asset.public-missing"]);
    expect(r1.diagnostics[0].severity).toBe("error");
    expect(r1.diagnostics[0].message).toContain("does not exist");
    expect(r1.diagnostics[0].sourcePath).toContain("pub");

    const fileNotDir = await project({ pub: `i am a file\n` }, withPublic("pub"));
    const r2 = await copyPublicDir(fileNotDir.site, await tmp("crust-site-staging-"));
    expect(r2.diagnostics.map((d) => d.code)).toEqual(["asset.public-missing"]);
    expect(r2.diagnostics[0].message).toContain("not a directory");
  });

  // Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows (admin
  // or developer mode) — an unprivileged machine fails with EPERM before the
  // behaviour under test is even reachable. Gated, never a false pass.
  test.skipIf(process.platform === "win32")(
    "symlinks (file and directory) are an error, never copied through",
    async () => {
      // Skipping silently would be a false pass (crust rule 1): the author
      // put the file in public/ expecting it to publish. Following it could
      // publish an arbitrary host tree. So: error, and nothing
      // symlink-shaped is copied.
      const { dir, site } = await project(
        { "pub/real.txt": `real\n`, "secret/leak.txt": `do-not-publish\n` },
        withPublic("pub"),
      );
      await writeFile(join(dir, "outside.txt"), `do-not-publish\n`);
      await symlink(join(dir, "outside.txt"), join(dir, "pub", "link.txt"));
      await symlink(join(dir, "secret"), join(dir, "pub", "link-dir"));
      const staging = await tmp("crust-site-staging-");
      const { copied, diagnostics } = await copyPublicDir(site, staging);
      expect(copied).toEqual(["real.txt"]);
      expect(diagnostics.map((d) => d.code)).toEqual([
        "asset.public-symlink",
        "asset.public-symlink",
      ]);
      expect(diagnostics.map((d) => d.severity)).toEqual(["error", "error"]);
      // sorted by public-relative path; each names its own link
      expect(diagnostics.map((d) => d.sourcePath)).toEqual(["link-dir", "link.txt"]);
      expect(diagnostics[0].message).toContain("link-dir");
      expect(diagnostics[1].message).toContain("link.txt");
      expect(await listing(join(staging, "link-dir"))).toBeUndefined();
      expect(await listing(staging)).toEqual(["real.txt"]);
    },
  );

  // Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows (admin
  // or developer mode) — an unprivileged machine fails with EPERM before the
  // behaviour under test is even reachable. Gated, never a false pass.
  test.skipIf(process.platform === "win32")(
    "publicDirectory itself being a symlink is asset.public-missing, named as such",
    async () => {
      const { dir, site } = await project({ "real-pub/f.txt": `f\n` }, withPublic("pub-link"));
      await symlink(join(dir, "real-pub"), join(dir, "pub-link"));
      const { copied, diagnostics } = await copyPublicDir(site, await tmp("crust-site-staging-"));
      expect(copied).toEqual([]);
      expect(diagnostics.map((d) => d.code)).toEqual(["asset.public-missing"]);
      expect(diagnostics[0].message).toContain("symbolic link");
    },
  );
});

describe("publicCollisions", () => {
  const codes = (diagnostics: Diagnostic[]): string[] => diagnostics.map((d) => d.code);

  test("exact, reserved-prefix and case-only collisions are all reported, sorted", () => {
    const diagnostics = publicCollisions(
      ["index.html", "assets/x.js", "Sitemap.xml", "ok.txt"],
      ["index.html", "sitemap.xml", "robots.txt", "404.html", "assets/app-0123456789abcdef.js"],
    );
    expect(codes(diagnostics)).toEqual([
      "output.collision",
      "output.collision",
      "output.collision",
    ]);
    // sorted by public path (code units: "S" < "a" < "i")
    expect(diagnostics.map((d) => d.sourcePath)).toEqual([
      "Sitemap.xml",
      "assets/x.js",
      "index.html",
    ]);
    expect(diagnostics[0].message).toContain("sitemap.xml"); // case-only names its twin
    expect(diagnostics[0].message).toContain("case-insensitive");
    expect(diagnostics[1].message).toContain("reserved");
    expect(diagnostics[2].message).toContain("generated file");
  });

  test("assets/ is reserved EVEN with zero generated files (pinned), folded case included", () => {
    // The generator owns assets/ as a namespace regardless of what is emitted
    // today (hashed names, dev-server immutable headers) — a public file
    // there is a landmine even for a currently asset-less site (plan §2).
    const diagnostics = publicCollisions(["assets/x.js", "Assets/y.js", "fine.txt"], []);
    expect(codes(diagnostics)).toEqual(["output.collision", "output.collision"]);
    expect(diagnostics.map((d) => d.sourcePath)).toEqual(["Assets/y.js", "assets/x.js"]);
  });

  test("two public files differing only by case collide with EACH OTHER (case-insensitive FS)", async () => {
    // On Windows the second silently overwrites the first in staging; the same
    // unconditional case-insensitive pass the route table runs (plan, Windows
    // table) applies here, so a Linux box cannot green-light a config that
    // half-emits on Windows. Control: distinct-case-but-distinct-fold passes.
    const diagnostics = publicCollisions(["README.md", "readme.md", "docs/A.md", "ok.txt"], []);
    expect(diagnostics.map((d) => d.code)).toEqual(["output.collision"]);
    expect(diagnostics[0].sourcePath).toBe("readme.md"); // names the later one...
    expect(diagnostics[0].message).toContain("README.md"); // ...against its twin
    expect(diagnostics[0].message).toContain("case-insensitive");
    expect(publicCollisions(["README.md", "readme.txt"], [])).toEqual([]);
  });

  test("clean public files and empty inputs produce nothing", () => {
    expect(publicCollisions([], ["index.html", "assets/app-0123456789abcdef.js"])).toEqual([]);
    expect(
      publicCollisions(["favicon.ico", "css/custom.css", "docs/file.pdf"], ["index.html"]),
    ).toEqual([]);
  });
});
