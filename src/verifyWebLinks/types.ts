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
  json: boolean;
}

export interface VerifyReport {
  results: Map<string, CrawlResult>;
  failures: Failure[];
  totals: {
    pages: number;
    assets: number;
    failures: number;
  };
}
