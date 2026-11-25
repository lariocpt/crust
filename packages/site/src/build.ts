// The SSG pipeline (plan §4): config → content → route table → assets →
// render → emit → publish, and nothing else. Every stage COLLECTS diagnostics
// instead of dying on the first problem (the config.ts convention), so one run
// reports every problem; the build rejects with a BuildError carrying ALL of
// them, staging is deleted, and the previous output is untouched (publish is
// the last step and restores on any mid-swap failure). Warnings never fail.
//
// Concurrency: the output is LOCKED for the run (emit.acquireBuildLock,
// claimed after the startup cleanup and before the staging mkdir) — a
// concurrent build of the same output is refused with build.busy before it
// can interleave its renames with the holder's (the measured false-pass
// race: a second build publishing into the first's rename window got rolled
// back by the first's restore while the second reported success).
//
// Determinism (plan §4.6): sequential render in route order (renderAll),
// lexicographic ordering everywhere, no timestamps in any emitted byte.

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve as nativeResolve, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAssets, copyPublicDir, publicCollisions } from "./assets";
import { checkOutputOverlap, resolveConfigPaths } from "./config";
import { buildRouteTable, discoverContent } from "./content";
import { BuildError, compareStrings, type Diagnostic, sortDiagnostics } from "./diagnostics";
import {
  acquireBuildLock,
  cleanupStale,
  type EmitFile,
  notFoundPage,
  publish,
  robotsTxt,
  sitemapXml,
  stagingDirFor,
  writePages,
} from "./emit";
import { parsePage } from "./pages";
import { collectUnusedAssets, renderAll, renderPage } from "./render";
import { routeToFile } from "./routes";
import type { Page, ResolvedSite, Site } from "./types";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Path to `site.config.ts`; relative paths resolve against the cwd. */
  readonly configFile: string;
}

/** One row of the emitted route table. */
export interface BuildPage {
  readonly route: string;
  /** posix, relative to the config directory. */
  readonly sourcePath: string;
  /** output-root-relative file (routeToFile's mapping). */
  readonly file: string;
}

/**
 * The public build result (contractVersion 1). `assets` maps the declared
 * manifest name to its hashed output-relative path.
 */
export interface BuildResult {
  readonly contractVersion: 1;
  readonly outputDirectory: string;
  /**
   * The CONTENT pages, sorted by route. The generated 404 page is emitted
   * to the output (and excluded from the sitemap) but is NOT a page here —
   * it is not authored content, so consumers must not expect it in `pages`.
   */
  readonly pages: BuildPage[];
  /** manifest name → `assets/<name>-<hash>.<ext>`, keys sorted. */
  readonly assets: Readonly<Record<string, string>>;
  readonly durationMs: number;
  /** Every warning-severity diagnostic of the run, sorted. */
  readonly warnings: Diagnostic[];
}

/**
 * INTERNAL (chunk 8's dev watcher): the BuildResult plus the per-page readText
 * reverse index (page sourcePath → realpath'd dependency files). Never part
 * of the public contract — `build()` projects it away.
 */
export interface BuildInternalResult extends BuildResult {
  readonly pageDeps: Readonly<Record<string, string[]>>;
}

// ---------------------------------------------------------------------------
// config loading
// ---------------------------------------------------------------------------

/**
 * Runtime stand-in for the phantom brand: a `defineSite()` result always
 * carries every resolved key (the optional ones as undefined-stripped or
 * present — defineSite always sets site/content/layouts/assets/output/
 * sitemap/lang). Anything else was hand-made or is not a config at all.
 */
function looksLikeSite(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return ["site", "content", "layouts", "assets", "output", "sitemap", "lang"].every((key) =>
    Object.hasOwn(obj, key),
  );
}

async function loadSiteConfig(configPath: string): Promise<Site> {
  let mod: Record<string, unknown>;
  try {
    // file URL, not a bare path: Windows drive letters are not valid specifiers.
    mod = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof BuildError) throw e; // defineSite's own diagnostics stay verbatim
    throw new BuildError([
      {
        code: "config.load",
        severity: "error",
        sourcePath: configPath,
        message: `importing the config file ${JSON.stringify(configPath)} failed: ${messageOf(e)}`,
      },
    ]);
  }
  if (!looksLikeSite(mod.default)) {
    throw new BuildError([
      {
        code: "config.load",
        severity: "error",
        sourcePath: configPath,
        message:
          `the default export of ${JSON.stringify(configPath)} is not a defineSite() result; ` +
          'the config file must `export default defineSite({ ... })` from "@crust/site"',
      },
    ]);
  }
  return mod.default as Site;
}

// ---------------------------------------------------------------------------
// publicAsset verification (the emitter half of the public-asset.* contract)
// ---------------------------------------------------------------------------

/**
 * What the existence check reads off a render result. Structural — not the
 * full PageRender — so tests can feed minimal records and the check never
 * depends on render internals.
 */
export interface PublicAssetRender {
  readonly page: { readonly sourcePath: string };
  readonly publicAssets: readonly string[];
}

/**
 * Verify every publicAsset path the renders recorded. render.ts already
 * rejected malformed paths at RECORD time; this re-validates the recorded
 * shape before ANY filesystem access, so a corrupted or tampered record can
 * never become a stat outside the public directory:
 *   - empty, NUL, backslash, drive letter, a leading `/`, or a `..` segment
 *     → malformed → reported missing WITHOUT any stat (a plain join+stat
 *     would bless the target: `posix.join` drops the public dir for an
 *     absolute path, and `..`/backslashes traverse out of it);
 *   - well-formed → must be a regular file under the public directory.
 * `publicDir` undefined makes EVERY recorded path missing (there is no
 * directory a file could live in) — a page with a dead reference would be
 * a false pass (crust rule 1).
 */
export async function verifyPublicAssets(
  publicDir: string | undefined,
  renders: readonly PublicAssetRender[],
): Promise<Diagnostic[]> {
  const all: Diagnostic[] = [];
  for (const r of renders) {
    for (const pa of r.publicAssets) {
      const malformed =
        pa === "" ||
        pa.includes("\0") ||
        pa.includes("\\") ||
        /^[A-Za-z]:/.test(pa) ||
        pa.startsWith("/") ||
        pa.split("/").includes("..");
      let isFile = false;
      if (!malformed && publicDir !== undefined) {
        isFile = await stat(posix.join(publicDir, pa))
          .then((s) => s.isFile())
          .catch(() => false);
      }
      if (!isFile) {
        all.push({
          code: "public-asset.missing",
          severity: "error",
          sourcePath: r.page.sourcePath,
          message:
            `publicAsset(${JSON.stringify(pa)}) referenced by the layout is not a file under ` +
            (publicDir !== undefined
              ? `assets.publicDirectory (${JSON.stringify(publicDir)})`
              : "the public directory: assets.publicDirectory is not configured"),
        });
      }
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

async function runBuild(
  resolved: ResolvedSite,
  staging: string,
  outputDir: string,
  started: number,
): Promise<BuildInternalResult> {
  const all: Diagnostic[] = [];

  // content: discover → parse. parsePage throws BuildError for frontmatter
  // problems (chunk 2's contract); fold them into the collected set instead of
  // dying, so one run reports every broken page.
  const files = await discoverContent(resolved);
  const pages: Page[] = [];
  for (const file of files) {
    const sourcePath = posix.relative(resolved.configDir, file.absolutePath);
    try {
      pages.push(
        await parsePage({
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          sourcePath,
          resolvedSite: resolved,
        }),
      );
    } catch (e) {
      if (e instanceof BuildError) all.push(...e.diagnostics);
      else
        all.push({
          code: "content.read-failed",
          severity: "error",
          sourcePath,
          message: `reading ${JSON.stringify(sourcePath)} failed: ${messageOf(e)}`,
        });
    }
  }
  // TODO(chunk 8): pass pageRoute + a route-table RouteResolver into parsePage
  // and validate page.links (link.broken / link.draft, error in prod / warning
  // in dev). Until then relative .md links are recorded exists:false and a
  // link to a draft passes silently — chunk 8 turns that red.

  const table = buildRouteTable(pages, resolved);
  all.push(...table.diagnostics);

  const assets = await buildAssets(resolved, staging);
  all.push(...assets.diagnostics);

  const renderOpts = {
    site: resolved.site,
    manifest: assets.manifest,
    layouts: resolved.layouts,
    configDir: resolved.configDir,
    publicDir: resolved.assets.publicDirectory,
  };
  const rendered = await renderAll(table.pages, renderOpts);
  for (const r of rendered.pages) all.push(...r.diagnostics);

  // The generated 404 (plan, "Locked decisions" 2): rendered through the same
  // engine and layout registry as every page, after the content pages so the
  // asset audit sees it too (an asset referenced only by the 404 is used).
  const notFound = notFoundPage(resolved.site, resolved.content.defaultLayout);
  const notFoundRender = await renderPage({ ...renderOpts, page: notFound });
  all.push(...notFoundRender.diagnostics);
  all.push(...collectUnusedAssets(assets.manifest, [...rendered.pages, notFoundRender]));

  // public copy + collisions against EVERY generated path (the copy already
  // landed in staging; a collision is an error, so staging is discarded whole).
  const pub = await copyPublicDir(resolved, staging);
  all.push(...pub.diagnostics);
  const generatedPaths = [
    ...table.pages.map((p) => routeToFile(p.route)),
    "404.html",
    ...(resolved.sitemap ? ["sitemap.xml"] : []),
    ...(resolved.robots !== undefined ? ["robots.txt"] : []),
    ...[...assets.manifest.values()].map((e) => e.file),
  ];
  all.push(...publicCollisions(pub.copied, generatedPaths));

  // publicAsset existence check (render.ts recorded the normalized paths;
  // verifyPublicAssets re-validates the RECORDED shape and stats each one —
  // a path with no file behind it would publish a page with a dead
  // reference: an error, never a silent hole, crust rule 1). No
  // publicDirectory configured makes every recorded path missing.
  all.push(
    ...(await verifyPublicAssets(resolved.assets.publicDirectory, [
      ...rendered.pages,
      notFoundRender,
    ])),
  );

  if (all.some((d) => d.severity === "error")) throw new BuildError(all);

  // emit (only reached error-free: every render carried a document)
  const documents = [...rendered.pages, notFoundRender];
  const items: EmitFile[] = [];
  for (const r of documents) {
    if (r.html === null) {
      // renderPage's contract is "null html ⟺ an error diagnostic", and no
      // error was collected — an engine bug must still fail loudly, never
      // publish a hole (crust rule 1).
      all.push({
        code: "render.threw",
        severity: "error",
        sourcePath: r.page.sourcePath,
        message:
          "the render produced no document without recording an error diagnostic; " +
          "this is an engine bug — nothing was published",
      });
      continue;
    }
    items.push({ route: r.page.route, file: routeToFile(r.page.route), html: r.html });
  }
  if (all.some((d) => d.severity === "error")) throw new BuildError(all);

  await writePages(staging, items);
  if (resolved.sitemap) {
    await writeFileAt(staging, "sitemap.xml", sitemapXml(table.pages));
  }
  const robots = robotsTxt(resolved.site, resolved.robots, resolved.sitemap);
  if (robots !== null) await writeFileAt(staging, "robots.txt", robots);

  await publish(staging, outputDir);

  const pageDeps: Record<string, string[]> = {};
  for (const r of documents) pageDeps[r.page.sourcePath] = r.deps;

  return {
    contractVersion: 1,
    outputDirectory: outputDir,
    pages: table.pages.map((p) => ({
      route: p.route,
      sourcePath: p.sourcePath,
      file: routeToFile(p.route),
    })),
    assets: Object.fromEntries(
      [...assets.manifest.entries()]
        .sort((a, b) => compareStrings(a[0], b[0]))
        .map(([name, entry]) => [name, entry.file]),
    ),
    durationMs: Math.round(performance.now() - started),
    warnings: sortDiagnostics(all.filter((d) => d.severity === "warning")),
    pageDeps,
  };
}

async function writeFileAt(staging: string, file: string, contents: string): Promise<void> {
  await writeFile(posix.join(staging, file), contents);
}

/**
 * Run the pipeline and return the INTERNAL result (BuildResult + pageDeps).
 * Chunk 8's dev watcher imports this; authors use `build()`.
 */
export async function buildInternal(options: BuildOptions): Promise<BuildInternalResult> {
  const started = performance.now();
  const raw = typeof options?.configFile === "string" ? options.configFile : "";
  if (raw === "") {
    throw new BuildError([
      {
        code: "config.load",
        severity: "error",
        sourcePath: "",
        message: "build() requires a configFile path (e.g. ./site.config.ts)",
      },
    ]);
  }
  // absolute before anything else: every stored path resolves against the
  // CONFIG FILE's directory, and the import needs a stable specifier.
  const configPath = toPosix(nativeResolve(process.cwd(), raw));
  const site = await loadSiteConfig(configPath);
  const resolved = resolveConfigPaths(site, posix.dirname(configPath));
  checkOutputOverlap(resolved);

  const outputDir = posix.resolve(resolved.output.directory);
  // startup cleanup (which restores a killed build's orphaned previous output
  // to the output path) FIRST, then the lock: a concurrent build of this
  // output is refused before it can interleave its renames with the holder's.
  await cleanupStale(outputDir);
  const release = await acquireBuildLock(outputDir);
  const staging = stagingDirFor(outputDir);
  try {
    await mkdir(staging, { recursive: true });
    return await runBuild(resolved, staging, outputDir, started);
  } finally {
    // success moved staging into place (it no longer exists); any failure path
    // — including a publish that restored the old output — leaves staging to
    // delete here. force swallows the already-gone case. Then the lock is
    // released (its file may already be gone — that is fine).
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}

/**
 * Build the site (the public entry). Resolves to the BuildResult; rejects
 * with a BuildError carrying EVERY collected diagnostic when anything failed.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const internal = await buildInternal(options);
  // explicit projection: the public shape is exactly the contract, the
  // internal extras (pageDeps) cannot leak through a stray property.
  return {
    contractVersion: internal.contractVersion,
    outputDirectory: internal.outputDirectory,
    pages: internal.pages,
    assets: internal.assets,
    durationMs: internal.durationMs,
    warnings: internal.warnings,
  };
}
