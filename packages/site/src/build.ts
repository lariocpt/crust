// The SSG pipeline (plan §4): config → content → route table → assets →
// render → validate → emit → publish, and nothing else. Every stage COLLECTS diagnostics
// instead of dying on the first problem (the config.ts convention), so one run
// reports every problem; the build rejects with a BuildError carrying ALL of
// them, staging is deleted, and the previous output is untouched (publish is
// the last step and restores on any mid-swap failure). Warnings never fail.
//
// Two entry points share one pipeline (runBuild, mode-parameterized):
//   - build() / buildInternal(): production. Drafts are NOT rendered;
//     link.draft / link.broken are ERRORS (a published site 404s on them);
//     the staging is the production sibling and the run ends with the
//     publish rename under the per-output build lock.
//   - devBuild(): the dev server's build (chunk 9, plan §4.4). Drafts ARE
//     rendered — each with the DRAFT banner prepended to its body — and
//     link.draft / link.broken are WARNINGS (the dev server serves them, so
//     the link really resolves there — plan §5); It takes NO lock and runs NO
//     cleanupStale (the dev process never renames into the output and must
//     never restore an orphan into it), and it never publishes: the result's
//     outputDirectory is the dev staging tree, served in place.
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
import {
  buildRouteTable,
  derivePageRoute,
  discoverContent,
  type PrecomputedRoute,
} from "./content";
import { BuildError, compareStrings, type Diagnostic, sortDiagnostics } from "./diagnostics";
import {
  acquireBuildLock,
  cleanupStale,
  devStagingDirFor,
  type EmitFile,
  notFoundPage,
  publish,
  robotsTxt,
  sitemapXml,
  stagingDirFor,
  writePages,
} from "./emit";
import { parseFrontmatter } from "./frontmatter";
import { type Html, html, trustedHtml } from "./html";
import { parsePage } from "./pages";
import { collectUnusedAssets, renderAll, renderPage } from "./render";
import { routeToFile } from "./routes";
import type { FrontmatterResult, Page, ResolvedSite, RouteResolver, Site } from "./types";
import { type EmittedPage, type KnownRoute, validatePages } from "./validate";

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
 * INTERNAL (chunk 9's dev watcher): the BuildResult plus the per-page readText
 * reverse index (page sourcePath → realpath'd dependency files) and the draft
 * pages (dev mode only — a production build renders no drafts, so its
 * `draftPages` is empty). Never part of the public contract — `build()`
 * projects it away.
 */
export interface BuildInternalResult extends BuildResult {
  /**
   * The DRAFT pages this run emitted, sorted by route (empty in a
   * production build — drafts are rendered only in dev mode). Same shape as
   * `pages`.
   */
  readonly draftPages: BuildPage[];
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

/**
 * "build" = a production build: no drafts rendered, link.draft/link.broken are
 * errors, the run ends with the publish rename. "dev" = the dev server's
 * build: drafts rendered with the banner, link.draft/link.broken are warnings,
 * no publish (the result's outputDirectory is the dev staging itself).
 */
type BuildMode = "build" | "dev";

async function runBuild(
  resolved: ResolvedSite,
  staging: string,
  outputDir: string,
  started: number,
  mode: BuildMode,
): Promise<BuildInternalResult> {
  const all: Diagnostic[] = [];

  // content: discover → pre-pass → parse. The pre-pass reads each file ONCE
  // and parses its frontmatter, so every page's route (frontmatter `route`
  // ?? content.route(relativePath), normalized) and draft flag are known
  // BEFORE the first markdown render: a page's relative .md links must
  // resolve against the FULL route table, which only exists once every
  // page's route is derived. Frontmatter problems fold into the collected
  // set (the parse loop skips the file — no Page is created for it) instead
  // of dying, so one run reports every broken page.
  const files = await discoverContent(resolved);
  const frontmatters = new Map<string, FrontmatterResult>();
  const precomputed = new Map<string, PrecomputedRoute>();
  for (const file of files) {
    const sourcePath = posix.relative(resolved.configDir, file.absolutePath);
    let text: string;
    try {
      text = await Bun.file(file.absolutePath).text();
    } catch (e) {
      all.push({
        code: "content.read-failed",
        severity: "error",
        sourcePath,
        message: `reading ${JSON.stringify(sourcePath)} failed: ${messageOf(e)}`,
      });
      continue;
    }
    let parsed: FrontmatterResult;
    try {
      parsed = parseFrontmatter(text, sourcePath);
    } catch (e) {
      // A frontmatter problem is the located BuildError chunk 2 raises —
      // folded into the collected set. A NON-BuildError here is an engine
      // bug, and the read already succeeded, so labeling it
      // content.read-failed would be a lie — content.parse-failed keeps
      // the code true (crust rule 1).
      if (e instanceof BuildError) {
        all.push(...e.diagnostics);
      } else {
        all.push({
          code: "content.parse-failed",
          severity: "error",
          sourcePath,
          message: `parsing ${JSON.stringify(sourcePath)} failed: ${messageOf(e)}`,
        });
      }
      continue;
    }
    frontmatters.set(sourcePath, parsed);
    precomputed.set(
      sourcePath,
      derivePageRoute({
        frontmatterRoute: parsed.frontmatter.route,
        relativePath: file.relativePath,
        sourcePath,
        routeFn: resolved.content.route,
        draft: parsed.frontmatter.draft === true,
      }),
    );
  }
  // The link resolver answers .md candidates from the pre-pass decisions —
  // the route set the route table will replay, with the drafts INCLUDED: the
  // PRODUCTION table excludes drafts, but link resolution must see them so a
  // link to a draft resolves (and step 7 reports link.draft with the right
  // destination) instead of passing silently. A candidate no file derives is
  // null (recorded exists:false — step 7 turns it into link.broken).
  // "external" is never returned: a candidate reaching the resolver is an
  // already-normalized route, and a route is never an external URL.
  const preRoutes = new Map<string, boolean>();
  for (const decision of precomputed.values()) {
    if (decision.route !== undefined) preRoutes.set(decision.route, decision.draft);
  }
  const routeResolver: RouteResolver = (candidate) => {
    const draft = preRoutes.get(candidate);
    return draft === undefined ? null : { route: candidate, exists: true, isDraft: draft };
  };

  const pages: Page[] = [];
  for (const file of files) {
    const sourcePath = posix.relative(resolved.configDir, file.absolutePath);
    const frontmatter = frontmatters.get(sourcePath);
    if (frontmatter === undefined) continue; // diagnosed in the pre-pass; no Page
    try {
      pages.push(
        await parsePage({
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          sourcePath,
          resolvedSite: resolved,
          frontmatter,
          pageRoute: precomputed.get(sourcePath)?.route,
          routeResolver,
        }),
      );
    } catch (e) {
      // With a provided frontmatter parsePage performs no file I/O
      // (renderMarkdown contains its own throws, parseData is caught inside
      // it), so a throw here is an engine bug, not a read failure — recorded,
      // never fatal, and labeled distinct from content.read-failed so the
      // code stays true (crust rule 1).
      if (e instanceof BuildError) {
        all.push(...e.diagnostics);
      } else {
        all.push({
          code: "content.parse-failed",
          severity: "error",
          sourcePath,
          message: `parsing ${JSON.stringify(sourcePath)} failed: ${messageOf(e)}`,
        });
      }
    }
  }

  const table = buildRouteTable(pages, resolved, precomputed);
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
  // dev mode renders the drafts too (the dev server serves them, so their
  // links are validated against the full table); each draft's body gets the
  // DRAFT banner prepended — trusted engine markup, so the fence still runs
  // over it like any other document bytes. Production renders no drafts.
  const draftPages =
    mode === "dev" ? table.drafts.map((p) => ({ ...p, body: draftBannerBody(p.body) })) : [];
  const toRender = mode === "dev" ? [...table.pages, ...draftPages] : table.pages;
  const rendered = await renderAll(toRender, renderOpts);
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
    ...toRender.map((p) => routeToFile(p.route)),
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
  const emitted: EmittedPage[] = [];
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
    // step 7's input: the final emitted document plus the links the markdown
    // pass recorded (internal destinations only — external URLs are never
    // in there, so they are never link- or fragment-checked).
    emitted.push({
      route: r.page.route,
      sourcePath: r.page.sourcePath,
      html: r.html,
      links: r.page.links,
    });
  }
  // step 7 (plan §4.7): link/fragment/metadata validation over the FINAL
  // emitted documents, BEFORE anything lands in staging — the fragment check
  // needs the bytes about to be written, and a failed validation must block
  // the publish, not clean up after it. The route set is the production
  // pages AND the drafts, excluding the generated /404 (a link to it is
  // link.broken — the 404 page is not a link target). Errors fall through
  // to the gate below (nothing is published); warnings join
  // BuildResult.warnings.
  const knownRoutes = new Map<string, KnownRoute>();
  for (const p of table.pages) {
    if (p.route !== "/404") knownRoutes.set(p.route, { draft: false });
  }
  for (const p of table.drafts) {
    if (p.route !== "/404") knownRoutes.set(p.route, { draft: true });
  }
  // mode passes through: "build" errors on draft/broken internal links, "dev"
  // warns (plan §5 — the dev server serves drafts, so the links resolve there).
  all.push(...validatePages({ mode, pages: emitted, routes: knownRoutes }));
  if (all.some((d) => d.severity === "error")) throw new BuildError(all);

  await writePages(staging, items);
  if (resolved.sitemap) {
    await writeFileAt(staging, "sitemap.xml", sitemapXml(table.pages));
  }
  const robots = robotsTxt(resolved.site, resolved.robots, resolved.sitemap);
  if (robots !== null) await writeFileAt(staging, "robots.txt", robots);

  // The publish rename is the PRODUCTION tail. Dev never renames into the
  // output directory (the dev staging is the served tree, owned by the
  // dev server), so the "dev" mode simply stops here.
  if (mode === "build") await publish(staging, outputDir);

  const pageDeps: Record<string, string[]> = {};
  for (const r of documents) pageDeps[r.page.sourcePath] = r.deps;

  return {
    contractVersion: 1,
    // dev: the result IS the staging tree (the dev server serves it in place
    // and owns its lifetime); build: the published output directory.
    outputDirectory: mode === "dev" ? staging : outputDir,
    pages: table.pages.map((p) => ({
      route: p.route,
      sourcePath: p.sourcePath,
      file: routeToFile(p.route),
    })),
    // dev: the drafts this run emitted (banned in production, so this is
    // always [] for mode "build" — the dev watcher and the dev CLI use the
    // list to know which routes carry the banner).
    draftPages: draftPages.map((p) => ({
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

// ---------------------------------------------------------------------------
// the DRAFT banner (dev mode only)
// ---------------------------------------------------------------------------

/**
 * The DRAFT banner, prepended to every draft page's BODY in dev mode only
 * (plan §4.4). Engine-owned markup — not authored content, so it is a
 * constant here (byte-stable across rebuilds, which is what keeps the
 * no-lastmod/byte-identical-rebuild contract honest even while a draft
 * exists) and it is trustedHtml (the fence still runs over it like any
 * document bytes). It is static markup with no attributes the fence's
 * url/style/attribute checks could trip on, no event handlers, and no
 * dynamic values, so a draft's banner can never open a fence violation the
 * page itself would not have. DEV ONLY: a production build never renders
 * drafts at all, so the banner never reaches the output directory.
 *
 * Styled with one inline rule per element (no `<style>` block, no
 * `style=` attribute — the fence's style-body rule is about `<style>`
 * elements, but keeping the banner attribute-free keeps it trivially
 * fence-safe and leaves the site's own CSS in charge of anything richer).
 */
export const DRAFT_BANNER_HTML = `<div data-crust-draft="true"
  style="background:#fff8e1;color:#6d5300;border-bottom:1px solid #e0c05a;padding:8px 16px;font-family:system-ui,sans-serif;font-size:14px">
<strong>DRAFT</strong> &mdash; this page is marked <code>draft: true</code> and will not be published
</div>`;

/**
 * Wrap a draft page's rendered body with the banner: a template whose first
 * value is the trusted banner and second is the page body. Both values are
 * real Html, so the fence tracks them (the banner contributes no tracked
 * ranges — it is trusted engine markup — while the body's markdown value
 * ranges are tracked exactly as on a normal page).
 */
function draftBannerBody(body: Html): Html {
  return html`${trustedHtml(DRAFT_BANNER_HTML)}${body}`;
}

/** A config file loaded, resolved and overlap-checked — ready for a run. */
export interface LoadedConfig {
  /** The config file's absolute posix path (the import specifier source). */
  readonly configPath: string;
  readonly site: Site;
  readonly resolved: ResolvedSite;
}

/**
 * Load + resolve + validate ONE config file. `buildInternal` and `devBuild`
 * both go through this, so the overlap check runs for the dev server too: a
 * config that `build` would refuse is refused by `dev` with the SAME
 * diagnostics (a dev server happily serving an unbuildable site would be a
 * false pass). Relative paths resolve against the process cwd (CLI convention);
 * every stored path then resolves against the CONFIG FILE's directory.
 */
export async function loadResolvedConfig(configFile: string): Promise<LoadedConfig> {
  const raw = typeof configFile === "string" ? configFile : "";
  if (raw === "") {
    throw new BuildError([
      {
        code: "config.load",
        severity: "error",
        sourcePath: "",
        message: "a configFile path is required (e.g. ./site.config.ts)",
      },
    ]);
  }
  // absolute before anything else: every stored path resolves against the
  // CONFIG FILE's directory, and the import needs a stable specifier.
  const configPath = toPosix(nativeResolve(process.cwd(), raw));
  const site = await loadSiteConfig(configPath);
  const resolved = resolveConfigPaths(site, posix.dirname(configPath));
  checkOutputOverlap(resolved);
  return { configPath, site, resolved };
}

/**
 * Run the pipeline and return the INTERNAL result (BuildResult + draftPages +
 * pageDeps). Chunk 9's dev watcher imports `devBuild` (same pipeline, dev
 * mode); authors use `build()`.
 */
export async function buildInternal(options: BuildOptions): Promise<BuildInternalResult> {
  const started = performance.now();
  const loaded = await loadResolvedConfig(options?.configFile ?? "");

  const resolved = loaded.resolved;
  const outputDir = posix.resolve(resolved.output.directory);
  // startup cleanup (which restores a killed build's orphaned previous output
  // to the output path) FIRST, then the lock: a concurrent build of this
  // output is refused before it can interleave its renames with the holder's.
  await cleanupStale(outputDir);
  const release = await acquireBuildLock(outputDir);
  const staging = stagingDirFor(outputDir);
  try {
    await mkdir(staging, { recursive: true });
    return await runBuild(resolved, staging, outputDir, started, "build");
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

/**
 * The DEV server's build (plan §4.4, chunk 9). Same pipeline as `build()` in
 * mode "dev": drafts ARE rendered (each with the DRAFT banner), and
 * link.draft / link.broken are WARNINGS instead of errors. The differences
 * from a production run, and why each one exists:
 *   - the staging is the DEV family (`devStagingDirFor`, `.crust-dev-staging-`),
 *     a sibling of the output directory (same filesystem, never /tmp) — the
 *     dev server serves it IN PLACE and owns its lifetime;
 *   - NO build lock: the dev process never renames into the output, so the
 *     lock's naming space stays exclusive to publishing builds and a dev
 *     process can neither claim nor be claimed by it;
 *   - NO cleanupStale: that startup pass RESTORES orphaned out-old trees INTO
 *     the output — a dev process must never write to the output directory,
 *     so it never runs it;
 *   - NO publish: there is nothing to swap in. The returned
 *     `result.outputDirectory` is the dev staging tree itself.
 *
 * On failure the staging is deleted and the BuildError rethrown with every
 * collected diagnostic (the caller — the dev server — formats and reports
 * them, and keeps serving the last complete tree).
 */
export interface DevBuild {
  /** The dev staging tree (`.crust-dev-staging-<pid>-<nonce>` beside the output). */
  readonly staging: string;
  readonly result: BuildInternalResult;
  /** The resolved config the run used (the dev watcher watches its dirs). */
  readonly resolved: ResolvedSite;
  /** The config file's absolute posix path. */
  readonly configPath: string;
}

/**
 * INTERNAL (the dev server's watcher): re-run the mode-"dev" pipeline into
 * `staging` with an ALREADY-loaded resolved config. The caller (dev.ts)
 * creates `staging` via `devStagingDirFor` and owns its lifetime: on
 * success it serves it, on failure it deletes it. This is deliberately NOT
 * `devBuild`: a content change must rebuild with the config that was loaded
 * when the dev process started — re-importing the config file here would
 * silently apply a config edit in-process, which the dev server refuses to
 * do (config changes mean a worker restart, never a partial reload).
 */
export async function devRebuild(
  resolved: ResolvedSite,
  staging: string,
  outputDir: string,
): Promise<BuildInternalResult> {
  const started = performance.now();
  try {
    await mkdir(staging, { recursive: true });
    return await runBuild(resolved, staging, outputDir, started, "dev");
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export async function devBuild(options: { readonly configFile: string }): Promise<DevBuild> {
  const loaded = await loadResolvedConfig(options?.configFile ?? "");
  const resolved = loaded.resolved;
  const outputDir = posix.resolve(resolved.output.directory);
  const staging = devStagingDirFor(outputDir);
  try {
    const result = await devRebuild(resolved, staging, outputDir);
    return { staging, result, resolved, configPath: loaded.configPath };
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
