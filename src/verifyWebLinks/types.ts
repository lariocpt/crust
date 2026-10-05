export type LinkKind = "a" | "img" | "script" | "link" | "iframe" | "og-image";

export interface LinkRef {
  href: string;
  resolved: string;
  kind: LinkKind;
  fromUrl: string;
}

export interface MetaTags {
  byKey: Record<string, string>;
}

export interface CrawlResult {
  url: string;
  status: number;
  finalUrl: string;
  redirectChain: string[];
  contentType: string;
  ids: string[];
  links: LinkRef[];
  meta: MetaTags;
  /**
   * True when the body was parsed as HTML, so `ids`/`links` are a complete
   * picture of the page. A URL fetched with `asPage: false` (an asset, or any
   * link when `--no-recurse` is set) has empty `ids` because nothing looked at
   * it — which must never be read as "the anchor does not exist".
   */
  parsed: boolean;
  error?: string;
  durationMs: number;
}

export type FailureKind =
  | "broken-link"
  | "missing-anchor"
  | "redirect-chain"
  | "meta-mismatch"
  | "meta-fixture-no-page"
  | "og-image-broken";

export interface Failure {
  kind: FailureKind;
  url: string;
  detail: string;
}

export interface MetaFixture {
  url: string;
  meta: Record<string, unknown>;
}

export interface VerifyOpts {
  sitemapUrl?: string;
  baseUrl?: string;
  fixtures?: string;
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  maxDepth: number;
  recurse: boolean;
  checkAnchors: boolean;
  redirectWarnings: boolean;
  includeExternal: boolean;
  exclude: string[];
  progress: boolean;
  maxPages: number;
  json: boolean;
}

export interface VerifyReport {
  results: Map<string, CrawlResult>;
  failures: Failure[];
  totals: {
    pages: number;
    assets: number;
    failures: number;
    /** URLs discovered but never fetched because --max-pages was reached. */
    dropped: number;
    /**
     * `#fragment` links whose destination was fetched but not parsed as a page
     * (`--no-recurse`, an `--exclude`d destination, or a depth cap), so the
     * check could not run. Reported, never counted as a failure either way.
     */
    anchorsSkipped: number;
  };
}
