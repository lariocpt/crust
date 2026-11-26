// Public types: the config input shape (what a user's `site.config.ts`
// imports), the branded validated `Site`, the resolved view, the frontmatter
// contract, and the content-pipeline shapes (pages, headings, internal
// links). Input shapes are what defineSite TYPE-checkS against;
// runtime validation in config.ts is independent (JS users get the same
// diagnostics — crust rule 1, no silent pass).

import type { Diagnostic } from "./diagnostics";
import type { Html } from "./html";

/**
 * Documented-open union (plan, "Locked decisions" 4): v1 accepts only
 * `"never"`, but typing it open means a future `"always"`/`"html"` widens the
 * enum without breaking anyone's compiled config. defineSite still REJECTS
 * every value other than "never" at runtime.
 */
export type TrailingSlash = "never" | (string & {});

/**
 * A layout is any function; the real LayoutContext arrives with the render
 * chunk. Typed `(...args: never[]) => unknown` so a user's
 * `(ctx: LayoutContext) => string` is assignable while non-functions are not.
 */
export type LayoutFn = (...args: never[]) => unknown;

export interface ContentConfig {
  /** Directory of .md sources, relative to the config file (absolute allowed). */
  directory: string;
  /** Globs to include. Default: every .md file, recursively. */
  include?: string[];
  /** Globs to exclude; exclude wins over include. Default `[]`. */
  exclude?: string[];
  /** Must be a key of `layouts`. */
  defaultLayout: string;
  /**
   * Maps a source file to a route. Must return an ALREADY-normalized route
   * (no auto-normalization, plan §2); a bad return is an error naming the page.
   */
  route?: (arg: { relativePath: string }) => string;
  /**
   * Hook for the data layer. `parsePage` calls it with the page's RAW
   * frontmatter `data` (or `{}` when absent) and the page's sourcePath; an
   * async hook (a returned Promise) is awaited. It must RESOLVE to a plain
   object — a throw or rejection becomes `frontmatter.data-invalid`, and a
   non-object result is the same (never a silent pass). The resolved object
   becomes `page.data`.
   */
  parseData?: (value: unknown, ctx: { sourcePath: string }) => unknown;
}

export interface AssetsConfig {
  /** name → entrypoint path. Names share ONE namespace with `styles`. */
  scripts?: Record<string, string>;
  styles?: Record<string, string>;
  /** Copied to the output root unhashed (no cache-busting, documented). */
  publicDirectory?: string;
}

export interface OutputConfig {
  directory: string;
  /** v1 accepts only `"never"`. */
  trailingSlash?: TrailingSlash;
}

export interface RobotsConfig {
  indexable: boolean;
}

export interface DevConfig {
  hostname?: string;
  /** 1..65535. */
  port?: number;
}

/** The shape a user's `site.config.ts` passes to `defineSite`. */
export interface SiteConfig {
  /** Absolute http(s) URL, may carry a path prefix, must NOT end in "/". */
  site: string;
  content: ContentConfig;
  /** Non-empty registry name → layout function. */
  layouts: Record<string, LayoutFn>;
  assets?: AssetsConfig;
  output: OutputConfig;
  /** Default true. */
  sitemap?: boolean;
  robots?: RobotsConfig;
  dev?: DevConfig;
  /** BCP 47. Default "en". */
  lang?: string;
}

/**
 * Phantom brand: `defineSite` is the only producer of a `Site`, and the
 * property does not exist at runtime — a hand-made object literal cannot
 * impersonate a validated config.
 */
declare const siteBrand: unique symbol;

/**
 * A validated config with RAW (unresolved) paths, as stored by `defineSite`.
 * Resolve with `resolveConfigPaths(site, configDir)` before any I/O.
 */
export interface Site {
  readonly [siteBrand]: never;
  readonly site: string;
  readonly content: {
    readonly directory: string;
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly defaultLayout: string;
    readonly route?: (arg: { relativePath: string }) => string;
    readonly parseData?: (value: unknown, ctx: { sourcePath: string }) => unknown;
  };
  readonly layouts: Readonly<Record<string, LayoutFn>>;
  readonly assets: {
    readonly scripts: Readonly<Record<string, string>>;
    readonly styles: Readonly<Record<string, string>>;
    readonly publicDirectory?: string;
  };
  readonly output: { readonly directory: string; readonly trailingSlash: TrailingSlash };
  readonly sitemap: boolean;
  readonly robots?: RobotsConfig;
  readonly dev?: DevConfig;
  readonly lang: string;
}

/**
 * The view after `resolveConfigPaths`: every path is absolute (posix form),
 * resolved against the CONFIG FILE's directory — never cwd.
 */
export interface ResolvedSite {
  readonly configDir: string;
  readonly site: string;
  readonly content: Site["content"] & { readonly directory: string };
  readonly layouts: Site["layouts"];
  readonly assets: {
    readonly scripts: Readonly<Record<string, string>>;
    readonly styles: Readonly<Record<string, string>>;
    readonly publicDirectory?: string;
  };
  readonly output: Site["output"];
  readonly sitemap: boolean;
  readonly robots?: RobotsConfig;
  readonly dev?: DevConfig;
  readonly lang: string;
}

/** The built-in frontmatter keys, everything else is frontmatter.unknown-key. */
export interface PageFrontmatter {
  title: string;
  description?: string;
  layout?: string;
  /** Always a normalized route (validated at parse time). */
  route?: string;
  draft?: boolean;
  data?: Record<string, unknown>;
}

export interface FrontmatterResult {
  frontmatter: PageFrontmatter;
  /** Everything after the closing `---` line. */
  body: string;
  /** 1-based line of the first body line, in the FULL file's coordinates. */
  bodyStartLine: number;
  /**
   * 1-based line (FULL-file coordinates) of the `data` key, when the
   * frontmatter has one — so a content.parseData failure can point at it.
   */
  dataLine?: number;
}

/** One row of the route table handed to `findRouteCollisions`. */
export interface RouteEntry {
  route: string;
  sourcePath: string;
}

/**
 * A heading as collected during render: `id` is the FINAL slug (collision
 * suffixes applied in document order), `text` the plain text of the heading
 * with markdown syntax stripped and entities decoded.
 */
export interface Heading {
  level: number;
  id: string;
  text: string;
}

/**
 * An internal link extracted during render — the input for chunk 7's link
 * validation. `route` is the destination route (for a pure fragment link,
 * the page's own route); `exists: false` means the destination looked like
 * an internal page but was not in the route table (chunk 7 turns that into
 * link.broken — chunk 4 only records). `line` is best-effort: block-level
 * map info in FULL-file coordinates, `null` when no enclosing block carried
 * a map.
 */
export interface InternalLink {
  route: string;
  fragment: string | null;
  line: number | null;
  exists: boolean;
  isDraft: boolean;
  kind: "page" | "fragment";
}

/**
 * A route-table answer for an internal link candidate: the page entry,
 * `"external"` (not an internal route at all — keep the destination and
 * apply the URL policy), or `null` (looks internal, not found).
 */
export type RouteResolution =
  | { route: string; exists: boolean; isDraft: boolean }
  | "external"
  | null;

/**
 * Resolves an internal link candidate — the destination path already
 * resolved against the PAGE'S ROUTE and stripped of `.md` (never the
 * source path, plan §2). Chunk 6 wires this to the real route table;
 * chunk 4 defines the interface and tests it with a fake.
 */
export type RouteResolver = (candidateRoute: string) => RouteResolution;

/**
 * One parsed .md page. `route`/`canonicalUrl` are filled by the route-table
 * step (buildRouteTable) — a page straight from parsePage carries only the
 * frontmatter `route` when it had one. `diagnostics` carries every
 * page-level problem found during parse/render (errors AND warnings);
 * `warnings` is the warning-severity subset, for callers that only surface
 * those.
 */
export interface Page {
  readonly sourcePath: string;
  /** posix, relative to content.directory, extension stripped (plan §2). */
  readonly relativePath: string;
  /** frontmatter route only; content.route() runs in buildRouteTable. */
  readonly route?: string;
  /** frontmatter layout only; defaultLayout fallback in buildRouteTable. */
  readonly layout?: string;
  readonly title: string;
  readonly description: string;
  readonly headings: Heading[];
  readonly data: Record<string, unknown>;
  readonly draft: boolean;
  readonly body: Html;
  readonly links: InternalLink[];
  readonly warnings: Diagnostic[];
  readonly diagnostics: Diagnostic[];
}
