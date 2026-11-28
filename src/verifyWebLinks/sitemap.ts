import { resolve } from "node:path";

const MAX_SITEMAP_DEPTH = 32;

class SitemapNotFoundError extends Error {
  constructor(
    readonly source: string,
    status: number,
  ) {
    super(`fetch ${source}: HTTP ${status}`);
  }
}

export interface DiscoverOpts {
  sitemapUrl?: string;
  baseUrl?: string;
  timeoutMs: number;
  userAgent: string;
}

export interface DiscoverResult {
  seeds: string[];
  origin: URL;
  /**
   * Which sitemap each seed came from (v0.3.6+), so a failure whose origin is
   * the sitemap itself can name it: `fromUrl` is the sitemap URL (or the local
   * sitemap path), stated honestly instead of omitted.
   */
  seedSources: { url: string; sitemap: string }[];
}

export async function discoverSeeds(opts: DiscoverOpts): Promise<DiscoverResult> {
  const sitemapUrl = opts.sitemapUrl;
  if (sitemapUrl) {
    const seeds = await readSitemap(sitemapUrl, opts);
    return {
      seeds,
      origin: new URL(seeds[0]),
      seedSources: seeds.map((url) => ({ url, sitemap: sitemapUrl })),
    };
  }

  if (!opts.baseUrl) {
    throw new Error("either --site-map-url or --base-url is required");
  }
  const base = new URL(opts.baseUrl);

  const fromRobots = await tryRobots(base, opts);
  if (fromRobots.length > 0)
    return {
      seeds: fromRobots.map((r) => r.url),
      origin: base,
      seedSources: fromRobots,
    };

  // /sitemap.xml is the convention; /sitemap-index.xml is what Astro's
  // sitemap integration emits by default — probe both before giving up.
  const candidates = ["/sitemap.xml", "/sitemap-index.xml"];
  for (const path of candidates) {
    const fallback = new URL(path, base).toString();
    try {
      const seeds = await readSitemap(fallback, opts);
      return {
        seeds,
        origin: base,
        seedSources: seeds.map((url) => ({ url, sitemap: fallback })),
      };
    } catch (err) {
      // A missing conventional root is a probe miss. Once a root exists,
      // failures inside it are declared work and must not be hidden by fallback.
      if (!(err instanceof SitemapNotFoundError) || err.source !== fallback) throw err;
    }
  }
  throw new Error(
    `no sitemap entries found via robots.txt, ${candidates.join(" or ")} on ${base.origin}`,
  );
}

async function tryRobots(
  base: URL,
  opts: DiscoverOpts,
): Promise<{ url: string; sitemap: string }[]> {
  const robotsUrl = new URL("/robots.txt", base).toString();
  let text: string;
  try {
    const r = await fetchWithTimeout(robotsUrl, opts);
    if (!r.ok) return [];
    text = await r.text();
  } catch {
    return [];
  }
  const sitemapLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^sitemap:/i.test(l))
    .map((l) => l.slice(l.indexOf(":") + 1).trim());
  const seeds: { url: string; sitemap: string }[] = [];
  for (const sm of sitemapLines) {
    seeds.push(...(await readSitemap(sm, opts)).map((url) => ({ url, sitemap: sm })));
  }
  return seeds;
}

async function loadSitemapBody(source: string, opts: DiscoverOpts): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const r = await fetchWithTimeout(source, opts);
    if (r.status === 404 || r.status === 410) {
      // Ignore ONLY an absent conventional root, never a missing declared child.
      throw new SitemapNotFoundError(source, r.status);
    }
    if (!r.ok) throw new Error(`fetch ${source}: HTTP ${r.status}`);
    return await r.text();
  }
  const abs = resolve(process.cwd(), source);
  const f = Bun.file(abs);
  if (!(await f.exists())) throw new Error(`sitemap not found: ${abs}`);
  return await f.text();
}

async function readSitemap(
  source: string,
  opts: DiscoverOpts,
  ancestors = new Set<string>(),
): Promise<string[]> {
  const key = /^https?:\/\//.test(source)
    ? (() => {
        const url = new URL(source);
        url.hash = "";
        return url.href;
      })()
    : resolve(process.cwd(), source);
  if (ancestors.has(key)) throw new Error(`sitemap cycle at ${source}`);
  if (ancestors.size >= MAX_SITEMAP_DEPTH) {
    throw new Error(`sitemap depth limit (${MAX_SITEMAP_DEPTH}) exceeded at ${source}`);
  }
  ancestors.add(key);
  try {
    const body = await loadSitemapBody(source, opts);
    const seeds = await parseSitemap(body, opts, ancestors);
    if (seeds.length === 0) throw new Error(`sitemap at ${source} contained no URLs`);
    return seeds;
  } finally {
    ancestors.delete(key);
  }
}

async function parseSitemap(
  body: string,
  opts: DiscoverOpts,
  ancestors: Set<string>,
): Promise<string[]> {
  const locs = extractLocs(body);
  if (/<sitemapindex/i.test(body)) {
    const all: string[] = [];
    for (const child of locs) {
      all.push(...(await readSitemap(child, opts, ancestors)));
    }
    return all;
  }
  return locs;
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  for (const m of xml.matchAll(re)) {
    out.push(decodeXmlEntities(m[1]));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchWithTimeout(url: string, opts: DiscoverOpts): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    return await fetch(url, {
      headers: { "user-agent": opts.userAgent },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
