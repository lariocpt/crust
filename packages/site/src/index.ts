// @crust/site — the crust site generator.
//
// The public API (plan: ~/.opencode/plan/crust-site-v1.md):
//
//   defineSite / resolveConfigPaths / checkOutputOverlap
//                — the config contract (site URL, content, assets, output)
//   normalizeRoute / routeToFile / canonicalUrl / findRouteCollisions
//                — the route table: strict normalization, the URL↔file map,
//                  duplicate + case-insensitive collision passes
//   parseFrontmatter — the .md frontmatter contract, with diagnostics located
//                in full-file coordinates
//   html         — the fenced template runtime (value-range fence + escaping)
//   Layout/LayoutContext — the layout render engine's types (per-render head
//                  sink, deep-frozen page); renderPage/renderAll are
//                  exported as documented pipeline wiring (USAGE.md,
//                  "Programmatic API") for users who drive the render engine
//                  directly — build()/dev import ./render themselves, not
//                  through this entry — NOT an author-facing API: authors
//                  write layouts, they never call the engine
//   build        — the SSG pipeline (Bun.build per entrypoint, render, emit,
//                  publish with the rename/copy contract)
//
// The kernel here is pure logic: no filesystem, no rendering, no bundling.
// It deliberately imports NOTHING third-party except `yaml` (located
// frontmatter positions) and `markdown-it` (raw HTML disabled, the content
// pipeline in markdown.ts/pages.ts/content.ts); the renderer arrives with
// the render chunk. The content pipeline's types (Page, Heading,
// InternalLink, RouteResolver) are public; its functions are internal wiring
// until build() (chunk 6/8) exposes the pipeline as a whole.
//
// Packaging: this ships as a PLAIN npm package run under Bun
// (`bunx @crust/site build`), not as a compiled binary. A compiled Bun binary
// cannot resolve bare npm specifiers from files OUTSIDE its own bundle
// (measured 2026-11-12, Bun 1.4.3/1.4.4 — crust AGENTS.md), and a site's
// `site.config.ts` and layouts are imported from disk at run time. The crust
// binary therefore carries only a redirect stub named `site`
// (crust: src/builtinFns/site.ts) that points back here.

/**
 * The version of the BuildResult/diagnostic contract (v1 = 1).
 *
 * Versioning rules (plan, "Locked decisions" 4): additive fields and enum
 * widening are minor; renames/removals/narrowing are major; diagnostic codes
 * are never repurposed; narrow enums are typed as documented-open unions.
 */
export type { BuildOptions, BuildPage, BuildResult } from "./build";
export { build } from "./build";
export const contractVersion = 1;

export { checkOutputOverlap, defineSite, resolveConfigPaths } from "./config";
export type { Diagnostic, DiagnosticCode, Severity } from "./diagnostics";
export { BuildError, DiagnosticCodes, sortDiagnostics } from "./diagnostics";
export { parseFrontmatter } from "./frontmatter";
export type { Html, HtmlValue } from "./html";

// The fenced template runtime (plan §1). Public surface:
//
//   html           — the tagged template. Values are escaped through ONE
//                    escaper and their character ranges are tracked;
//                    finalizeDocument runs the fence over the result.
//   Html / HtmlValue — the opaque value type and what may be interpolated.
//   finalizeDocument — render + fence in one; a violation throws a BuildError
//                      carrying ALL fence diagnostics. The renderer (render
//                      chunk) calls it per page.
//   url            — the URL policy under its public name. It IS
//                    validateUrl: one function, two names, so the plan's
//                    `url()` reads naturally at the call site while the
//                    explicit name stays available for search and for the
//                    fence's cross-references. `ctx.url()` (render chunk)
//                    wraps exactly this.
//
// NOT public: trustedHtml, renderToString, escapeHtml, isHtml (the brand
// guard the render engine uses internally), the fence's scanner (fence.ts),
// isDiagnostic (the registry-membership guard — internal modules and tests
// import it from ./diagnostics) and collectUnusedAssets (the cross-page
// asset audit — the build pipeline runs it from ./render) — those are
// internal wiring, not a contract for site authors. They stay OUT of this
// file on purpose (exported from their own module for internal use / tests
// only, never part of the author-facing surface).
export { finalizeDocument, html } from "./html";
// The layout render engine (plan §3). The TYPES are part of the public
// contract (build()'s BuildResult references PageRender; a user's layout is
// a Layout). renderPage/renderAll are exported as the documented "pipeline
// wiring" (USAGE.md, "Programmatic API") for consumers who drive the engine
// directly — build()/dev do NOT import them through this entry, they import
// ./render — and they are NOT advertised to layout authors: site authors
// write layouts and never call the engine.
export type {
  AssetUsage,
  DeepReadonly,
  FrozenPage,
  Layout,
  LayoutContext,
  PageRender,
  RenderAllOptions,
  RenderAllResult,
  RenderPageOptions,
} from "./render";
export { renderAll, renderPage } from "./render";
export {
  canonicalUrl,
  findRouteCollisions,
  isNormalizedRoute,
  normalizeRoute,
  routeToFile,
} from "./routes";
export type {
  AssetsConfig,
  ContentConfig,
  DevConfig,
  FrontmatterResult,
  Heading,
  InternalLink,
  LayoutFn,
  OutputConfig,
  Page,
  PageFrontmatter,
  ResolvedSite,
  RobotsConfig,
  RouteEntry,
  RouteResolution,
  RouteResolver,
  Site,
  SiteConfig,
  TrailingSlash,
} from "./types";
export type { UrlAttribute, UrlPolicyOptions } from "./url";
export { validateUrl, validateUrl as url } from "./url";
