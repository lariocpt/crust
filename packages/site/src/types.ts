// Public types: the config input shape (what a user's `site.config.ts`
// imports), the branded validated `Site`, the resolved view, and the
// frontmatter contract. Input shapes are what defineSite TYPE-checkS against;
// runtime validation in config.ts is independent (JS users get the same
// diagnostics — crust rule 1, no silent pass).

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
  /** Hook for the later data layer; stored untouched in v1. */
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
}

/** One row of the route table handed to `findRouteCollisions`. */
export interface RouteEntry {
  route: string;
  sourcePath: string;
}
