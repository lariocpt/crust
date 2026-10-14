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
  /**
   * Parsed as HTML even though the declared content-type said otherwise
   * (`application/xhtml+xml`, or a document that begins `<!doctype html>`
   * served as `text/plain`). The links in it were followed; the server
   * mislabels it, which is a fact worth printing.
   */
  sniffedHtml: boolean;
  /**
   * Fetched as a page (sitemap entry or `<a>`/`<iframe>` target), internal,
   * 2xx/3xx — and NOT parsed, because neither the content-type nor the body
   * said HTML. Nothing looked at its links, so the crawl stopped here.
   */
  unparsedPage: boolean;
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
  /**
   * Fail the run when it did not finish verifying everything it discovered —
   * a `--max-pages` cut-off, a `#fragment` link whose page was never parsed,
   * or a page-shaped document crust could not read as HTML. The default keeps
   * the exit code about broken links only; this makes "all clear" mean
   * "every discovered link was checked".
   */
  strict: boolean;
}

export interface VerifyTotals {
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
  /**
   * Pages whose content-type said non-HTML but which were parsed anyway
   * (declared `application/xhtml+xml`, or the body begins `<!doctype html`).
   * Counted in `pages`, and disclosed: the server is mislabelling them.
   */
  sniffedPages: number;
  /**
   * Page-shaped documents crust could not read as HTML, so the links inside
   * them were never followed. The crawl ended at each one.
   */
  unparsedPages: number;
  /**
   * False when this run left discovered work unchecked: `dropped`,
   * `anchorsSkipped` or `unparsedPages` nonzero. For a CI that reads `--json`
   * and must not mistake an incomplete crawl for a clean one.
   */
  complete: boolean;
}

export interface VerifyReport {
  results: Map<string, CrawlResult>;
  failures: Failure[];
  totals: VerifyTotals;
}
