#!/usr/bin/env bun
import { crawl, extractFragment, stripFragment } from "./crawler";
import { diff, loadMetaFixtures } from "./metaFixtures";
import { renderJson, renderText } from "./report";
import { discoverSeeds } from "./sitemap";
import type { Failure, MetaFixture, VerifyOpts, VerifyReport } from "./types";

const DEFAULT_UA = "crust-verify-web-links/0.1";

const USAGE = `verify-web-links (--site-map-url <url|path> | --base-url <url>) [options]

Crawl a site from its sitemap, verify every link is reachable, and
optionally diff Open Graph / meta tags against .crust.ts fixtures.

  --site-map-url <src>     URL (http://, https://) or local path to a sitemap.xml.
                           Mutually exclusive with --base-url.
  --base-url <url>         Auto-discover the sitemap: probe /robots.txt for
                           Sitemap: lines, then fall back to /sitemap.xml and /sitemap-index.xml.
  --fixtures <glob>        .crust.ts fixture file or glob exporting
                           { url, meta: { ... } } (or array). Each fixture's
                           meta is diffed against the page's extracted meta.
  --concurrency N          parallel fetches (default 4).
  --timeout ms             per-request timeout (default 10000).
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
  const exclude: string[] = [];
  let progress = true;
  let maxPages = 0;
  let json = false;

  function intFlag(value: string | undefined, name: string): number | null {
    const n = parseInt(value ?? "", 10);
    if (!Number.isFinite(n)) {
      process.stderr.write(`verify-web-links: ${name} requires an integer\n`);
      return null;
    }
    return n;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    const [key, inlineVal] = splitFlag(a);
    const consume = (): string | undefined => (inlineVal !== undefined ? inlineVal : args[++i]);

    switch (key) {
      case "--site-map-url":
        sitemapUrl = consume();
        break;
      case "--base-url":
        baseUrl = consume();
        break;
      case "--fixtures":
        fixtures = consume();
        break;
      case "--concurrency": {
        const n = intFlag(consume(), "--concurrency");
        if (n === null) return 2;
        if (n < 1) {
          process.stderr.write("verify-web-links: --concurrency must be >= 1\n");
          return 2;
        }
        concurrency = n;
        break;
      }
      case "--timeout": {
        const n = intFlag(consume(), "--timeout");
        if (n === null) return 2;
        if (n < 1) {
          process.stderr.write("verify-web-links: --timeout must be >= 1\n");
          return 2;
        }
        timeoutMs = n;
        break;
      }
      case "--user-agent":
        userAgent = consume() ?? userAgent;
        break;
      case "--max-depth": {
        const n = intFlag(consume(), "--max-depth");
        if (n === null) return 2;
        if (n < 0) {
          process.stderr.write("verify-web-links: --max-depth must be >= 0\n");
          return 2;
        }
        maxDepth = n;
        break;
      }
      case "--no-recurse":
        recurse = false;
        break;
      case "--no-anchors":
        checkAnchors = false;
        break;
      case "--no-redirect-warnings":
        redirectWarnings = false;
        break;
      case "--include-external":
        includeExternal = true;
        break;
      case "--exclude": {
        const v = consume();
        if (!v) {
          process.stderr.write("verify-web-links: --exclude requires a value\n");
          return 2;
        }
        exclude.push(v);
        break;
      }
      case "--max-pages": {
        const n = intFlag(consume(), "--max-pages");
        if (n === null) return 2;
        if (n < 0) {
          process.stderr.write("verify-web-links: --max-pages must be >= 0\n");
          return 2;
        }
        maxPages = n;
        break;
      }
      case "--no-progress":
        progress = false;
        break;
      case "--json":
        json = true;
        break;
      default:
        process.stderr.write(`verify-web-links: unknown arg '${a}'\n`);
        process.stderr.write(USAGE);
        return 2;
    }
  }

  if (sitemapUrl && baseUrl) {
    process.stderr.write(
      "verify-web-links: --site-map-url and --base-url are mutually exclusive\n",
    );
    return 2;
  }
  if (!sitemapUrl && !baseUrl) {
    process.stderr.write("verify-web-links: --site-map-url or --base-url is required\n");
    process.stderr.write(USAGE);
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

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
