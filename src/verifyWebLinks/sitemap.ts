import { resolve } from "node:path";

export interface DiscoverOpts {
  sitemapUrl?: string;
  baseUrl?: string;
  timeoutMs: number;
  userAgent: string;
}

export interface DiscoverResult {
  seeds: string[];
  origin: URL;
}

export async function discoverSeeds(opts: DiscoverOpts): Promise<DiscoverResult> {
  if (opts.sitemapUrl) {
    const body = await loadSitemapBody(opts.sitemapUrl, opts);
    const seeds = await parseSitemap(body, opts);
    if (seeds.length === 0) throw new Error(`sitemap at ${opts.sitemapUrl} contained no URLs`);
    return { seeds, origin: new URL(seeds[0]!) };
  }

  if (!opts.baseUrl) {
    throw new Error("either --site-map-url or --base-url is required");
  }
  const base = new URL(opts.baseUrl);

  const fromRobots = await tryRobots(base, opts);
  if (fromRobots.length > 0) return { seeds: fromRobots, origin: base };

  const fallback = new URL("/sitemap.xml", base).toString();
  const body = await loadSitemapBody(fallback, opts);
  const seeds = await parseSitemap(body, opts);
  if (seeds.length === 0) {
    throw new Error(`no sitemap entries found via robots.txt or ${fallback}`);
  }
  return { seeds, origin: base };
}

async function tryRobots(base: URL, opts: DiscoverOpts): Promise<string[]> {
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
  const seeds: string[] = [];
  for (const sm of sitemapLines) {
    try {
      const body = await loadSitemapBody(sm, opts);
      seeds.push(...(await parseSitemap(body, opts)));
    } catch {
      // ignore individual sitemap failure when probing
    }
  }
  return seeds;
}

async function loadSitemapBody(source: string, opts: DiscoverOpts): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const r = await fetchWithTimeout(source, opts);
    if (!r.ok) throw new Error(`fetch ${source}: HTTP ${r.status}`);
    return await r.text();
  }
  const abs = resolve(process.cwd(), source);
  const f = Bun.file(abs);
  if (!(await f.exists())) throw new Error(`sitemap not found: ${abs}`);
  return await f.text();
}

async function parseSitemap(body: string, opts: DiscoverOpts): Promise<string[]> {
  const locs = extractLocs(body);
  if (/<sitemapindex/i.test(body)) {
    const all: string[] = [];
    for (const child of locs) {
      try {
        const childBody = await loadSitemapBody(child, opts);
        all.push(...(await parseSitemap(childBody, opts)));
      } catch {
        // ignore one bad child sitemap; surface in crawl instead
      }
    }
    return all;
  }
  return locs;
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  for (const m of xml.matchAll(re)) {
    out.push(decodeXmlEntities(m[1]!));
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
