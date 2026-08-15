#!/usr/bin/env bun
import { FlagError, type FlagSpec, parseFlags } from "../args";
import { crawl, extractFragment, stripFragment } from "./crawler";
import { diff, loadMetaFixtures } from "./metaFixtures";
import { renderJson, renderText } from "./report";
import { discoverSeeds } from "./sitemap";
import type { Failure, MetaFixture, VerifyOpts, VerifyReport } from "./types";

const DEFAULT_UA = "crust-verify-web-links/0.1";

const USAGE = `verify-web-links <url|sitemap> [options]

Crawl a site from its sitemap, verify every link is reachable, and
optionally diff Open Graph / meta tags against .crust.ts fixtures.

The positional argument is the site: anything ending .xml (or containing
"sitemap") is treated as a sitemap, otherwise as a base URL to crawl from.
Pass --sitemap / --base-url explicitly to override that guess.

  --sitemap <src>          URL (http://, https://) or local path to a sitemap.xml.
                           Mutually exclusive with --base-url.
                           (--site-map-url is accepted as an alias.)
  --base-url <url>         Auto-discover the sitemap: probe /robots.txt for
                           Sitemap: lines, then fall back to /sitemap.xml and /sitemap-index.xml.
  --fixtures <glob>        .crust.ts fixture file or glob exporting
                           { url, meta: { ... } } (or array). Each fixture's
                           meta is diffed against the page's extracted meta.
  -c, --concurrency N      parallel fetches (default 4).
  -t, --timeout ms         per-request timeout (default 10000).
  --user-agent <s>         User-Agent header (default crust-verify-web-links/0.1).
  --max-depth N            recursion depth for internal pages (default 5).
  --no-recurse             only verify URLs listed in the sitemap; do not crawl
                           internal links found on those pages.
  --no-anchors             skip validation of #fragment targets.
  --no-redirect-warnings   treat 3xx redirect chains as informational, not failures.
  --include-external       also queue external (different-origin) links for
                           status checking. Never recursed.
  --exclude <substring>    skip URLs containing <substring> (repeatable). Use for
                           subtrees that redirect by design, e.g. --exclude /checkout/.
  --max-pages N            stop fetching after N URLs; the report counts what was
                           left unchecked. Safety valve for crawls that explode
                           (e.g. WooCommerce filter URLs). Default 0 = unlimited.
  --no-progress            suppress the 5s progress heartbeat on stderr.
  --json                   emit a machine-readable JSON report on stdout.
  -h, --help               show this message.

Exit codes: 0 all clear, 1 verification failures, 2 bad args / unrecoverable fetch.
`;

export async function runCli(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  if (typeof opts === "number") return opts;

  let seeds: string[];
  let origin: URL;
  try {
    const d = await discoverSeeds({
      sitemapUrl: opts.sitemapUrl,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      userAgent: opts.userAgent,
    });
    seeds = d.seeds;
    origin = d.origin;
  } catch (err) {
    process.stderr.write(`verify-web-links: ${(err as Error).message}\n`);
    return 2;
  }

  let fixtures: MetaFixture[] = [];
  if (opts.fixtures) {
    try {
      fixtures = await loadMetaFixtures(opts.fixtures);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 2;
    }
  }

  const { results, dropped } = await crawl(seeds, origin, opts);
  const failures = collectFailures(results, fixtures, opts);

  let pages = 0;
  let assets = 0;
  for (const r of results.values()) {
    if (r.contentType.toLowerCase().includes("text/html")) pages++;
    else assets++;
  }

  const report: VerifyReport = {
    results,
    failures,
    totals: { pages, assets, failures: failures.length, dropped },
  };

  if (opts.json) {
    process.stdout.write(`${renderJson(report)}\n`);
  } else {
    process.stdout.write(renderText(report));
  }
  return failures.length > 0 ? 1 : 0;
}

function collectFailures(
  results: Map<string, import("./types").CrawlResult>,
  fixtures: MetaFixture[],
  opts: VerifyOpts,
): Failure[] {
  const failures: Failure[] = [];

  for (const r of results.values()) {
    if (r.error) {
      failures.push({ kind: "broken-link", url: r.url, detail: r.error });
      continue;
    }
    if (r.status < 200 || r.status >= 400) {
      failures.push({ kind: "broken-link", url: r.url, detail: `HTTP ${r.status}` });
    }
  }

  if (opts.redirectWarnings) {
    for (const r of results.values()) {
      if (r.redirectChain.length > 0) {
        const path = [...r.redirectChain, r.finalUrl].join(" -> ");
        failures.push({
          kind: "redirect-chain",
          url: r.url,
          detail: `${r.redirectChain.length} hop(s): ${path}`,
        });
      }
    }
  }

  if (opts.checkAnchors) {
    for (const r of results.values()) {
      for (const ref of r.links) {
        const frag = extractFragment(ref.resolved);
        if (!frag) continue;
        const targetUrl = stripFragment(ref.resolved);
        const target = results.get(targetUrl);
        if (!target || target.error) continue;
        if (target.status < 200 || target.status >= 400) continue;
        if (!target.ids.includes(frag)) {
          failures.push({
            kind: "missing-anchor",
            url: ref.resolved,
            detail: `#${frag} not found on ${targetUrl} (from ${ref.fromUrl})`,
          });
        }
      }
    }
  }

  for (const r of results.values()) {
    for (const ref of r.links) {
      if (ref.kind !== "og-image") continue;
      const target = results.get(stripFragment(ref.resolved));
      if (!target) continue;
      if (target.status < 200 || target.status >= 400) {
        failures.push({
          kind: "og-image-broken",
          url: ref.resolved,
          detail: `from ${ref.fromUrl}, HTTP ${target.status}`,
        });
      } else if (!target.contentType.toLowerCase().startsWith("image/")) {
        failures.push({
          kind: "og-image-broken",
          url: ref.resolved,
          detail: `from ${ref.fromUrl}, content-type ${target.contentType || "<unset>"}`,
        });
      }
    }
  }

  for (const fx of fixtures) {
    const r = results.get(stripFragment(fx.url));
    if (!r) {
      failures.push({
        kind: "meta-fixture-no-page",
        url: fx.url,
        detail: "fixture URL was not crawled (not in sitemap and not reachable from one)",
      });
      continue;
    }
    const diffs = diff("meta", fx.meta, r.meta.byKey);
    for (const f of diffs) {
      failures.push({
        kind: "meta-mismatch",
        url: fx.url,
        detail: `${f.path}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`,
      });
    }
  }

  return failures;
}

export const SPEC: FlagSpec = {
  // A bare URL is the common case. A sitemap is recognisable by its shape, so
  // the two mutually-exclusive source flags collapse into one positional.
  source: { type: "string", positional: 0 },
  "site-map-url": { type: "string" },
  sitemap: { type: "string" },
  "base-url": { type: "string" },
  fixtures: { type: "string" },
  concurrency: { short: "c", type: "number" },
  timeout: { short: "t", type: "number" },
  "user-agent": { type: "string" },
  "max-depth": { type: "number" },
  "max-pages": { type: "number" },
  exclude: { type: "string", repeat: true },
  "no-recurse": { type: "boolean" },
  "no-anchors": { type: "boolean" },
  "no-redirect-warnings": { type: "boolean" },
  "include-external": { type: "boolean" },
  "no-progress": { type: "boolean" },
  json: { type: "boolean" },
};

const looksLikeSitemap = (v: string): boolean => /\.xml($|\?)/i.test(v) || /sitemap/i.test(v);

function parseArgs(args: string[]): VerifyOpts | number {
  let sitemapUrl: string | undefined;
  let baseUrl: string | undefined;
  let fixtures: string | undefined;
  let concurrency = 4;
  let timeoutMs = 10000;
  let userAgent = DEFAULT_UA;
  let maxDepth = 5;
  let recurse = true;
  let checkAnchors = true;
  let redirectWarnings = true;
  let includeExternal = false;
  let exclude: string[] = [];
  let progress = true;
  let maxPages = 0;
  let json = false;

  try {
    const { values, rest, help } = parseFlags(args, SPEC);
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);

    sitemapUrl = (values["site-map-url"] ?? values.sitemap) as string | undefined;
    baseUrl = values["base-url"] as string | undefined;
    const source = values.source as string | undefined;
    if (source !== undefined) {
      if (looksLikeSitemap(source)) sitemapUrl ??= source;
      else baseUrl ??= source;
    }

    fixtures = values.fixtures as string | undefined;
    concurrency = (values.concurrency as number | undefined) ?? 4;
    timeoutMs = (values.timeout as number | undefined) ?? 10000;
    userAgent = (values["user-agent"] as string | undefined) ?? DEFAULT_UA;
    maxDepth = (values["max-depth"] as number | undefined) ?? 5;
    maxPages = (values["max-pages"] as number | undefined) ?? 0;
    exclude = (values.exclude as string[] | undefined) ?? [];
    recurse = values["no-recurse"] !== true;
    checkAnchors = values["no-anchors"] !== true;
    redirectWarnings = values["no-redirect-warnings"] !== true;
    includeExternal = values["include-external"] === true;
    progress = values["no-progress"] !== true;
    json = values.json === true;

    if (concurrency < 1) throw new FlagError("--concurrency must be >= 1");
    if (timeoutMs < 1) throw new FlagError("--timeout must be >= 1");
    if (maxDepth < 0) throw new FlagError("--max-depth must be >= 0");
    if (maxPages < 0) throw new FlagError("--max-pages must be >= 0");
  } catch (err) {
    process.stderr.write(`verify-web-links: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (sitemapUrl && baseUrl) {
    process.stderr.write(
      "verify-web-links: --site-map-url and --base-url are mutually exclusive\n",
    );
    return 2;
  }
  if (!sitemapUrl && !baseUrl) {
    process.stderr.write(`verify-web-links: a sitemap URL or a base URL is required\n${USAGE}`);
    return 2;
  }

  return {
    sitemapUrl,
    baseUrl,
    fixtures,
    concurrency,
    timeoutMs,
    userAgent,
    maxDepth,
    recurse,
    checkAnchors,
    redirectWarnings,
    includeExternal,
    exclude,
    progress,
    maxPages,
    json,
  };
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
