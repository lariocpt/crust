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
//   build        — the SSG pipeline (Bun.build per entrypoint, render, emit,
//                  publish with the rename/copy contract)
//
// The kernel here is pure logic: no filesystem, no rendering, no bundling.
// It deliberately imports NOTHING third-party except `yaml` (located
// frontmatter positions); the renderer arrives with the render chunk.
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
export const contractVersion = 1;

export { checkOutputOverlap, defineSite, resolveConfigPaths } from "./config";
export type { Diagnostic, DiagnosticCode, Severity } from "./diagnostics";
export { BuildError, DiagnosticCodes, isDiagnostic, sortDiagnostics } from "./diagnostics";
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
// NOT public: trustedHtml, renderToString, escapeHtml, the fence's scanner
// (fence.ts), and the url internals — those are internal wiring for the
// render chunk and the test-suite, not a contract for site authors.
// trustedHtml, renderToString and escapeHtml stay OUT of this file on
// purpose (task contract: exported from html.ts for internal use / tests
// only, never part of the author-facing surface).
export { finalizeDocument, html } from "./html";
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
  LayoutFn,
  OutputConfig,
  PageFrontmatter,
  ResolvedSite,
  RobotsConfig,
  RouteEntry,
  Site,
  SiteConfig,
  TrailingSlash,
} from "./types";
export type { UrlAttribute, UrlPolicyOptions } from "./url";
export { validateUrl, validateUrl as url } from "./url";
