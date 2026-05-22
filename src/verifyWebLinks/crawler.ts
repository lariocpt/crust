import { extractFromHtml } from "./extractors";
import type { CrawlResult, LinkRef, VerifyOpts } from "./types";

const MAX_REDIRECT_HOPS = 5;

interface QueueItem {
  url: string;
  depth: number;
  asPage: boolean;
}

export async function crawl(
  seeds: string[],
  origin: URL,
  opts: VerifyOpts,
): Promise<Map<string, CrawlResult>> {
  const visited = new Map<string, CrawlResult>();
  const queue: QueueItem[] = [];

  for (const s of seeds) {
    queue.push({ url: stripFragment(s), depth: 0, asPage: true });
  }

  const inFlight = new Set<Promise<void>>();

  const startNext = (): boolean => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.url)) continue;
      visited.set(item.url, placeholder(item.url));
      const task: Promise<void> = process(item, origin, opts, visited, queue).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
      return true;
    }
    return false;
  };

  while (queue.length > 0 || inFlight.size > 0) {
    while (inFlight.size < opts.concurrency && startNext()) {
      // fill pool
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  return visited;
}

function placeholder(url: string): CrawlResult {
  return {
    url,
    status: 0,
    finalUrl: url,
    redirectChain: [],
    contentType: "",
    ids: [],
    links: [],
    meta: { byKey: {} },
    durationMs: 0,
  };
}

async function process(
  item: QueueItem,
  origin: URL,
  opts: VerifyOpts,
  visited: Map<string, CrawlResult>,
  queue: QueueItem[],
): Promise<void> {
  const start = performance.now();
  const result: CrawlResult = placeholder(item.url);

  try {
    const fetched = await fetchFollowing(item.url, opts);
    result.status = fetched.status;
    result.finalUrl = fetched.finalUrl;
    result.redirectChain = fetched.chain;
    result.contentType = fetched.contentType;

    const isInternal = sameOrigin(fetched.finalUrl, origin);
    const isHtml = fetched.contentType.toLowerCase().includes("text/html");

    if (
      item.asPage &&
      isInternal &&
      isHtml &&
      fetched.response &&
      fetched.status >= 200 &&
      fetched.status < 400
    ) {
      const ext = await extractFromHtml(fetched.response);
      result.ids = [...ext.ids];
      result.meta = ext.meta;
      const refs: LinkRef[] = [];
      for (const l of ext.links) {
        const resolved = resolveLink(l.href, fetched.finalUrl);
        if (!resolved) continue;
        refs.push({ href: l.href, resolved, kind: l.tag, fromUrl: item.url });
      }
      result.links = refs;

      if (opts.recurse && item.depth < opts.maxDepth) {
        for (const ref of refs) {
          const target = stripFragment(ref.resolved);
          if (visited.has(target)) continue;
          const targetInternal = sameOrigin(target, origin);
          const isPageLink = ref.kind === "a" || ref.kind === "iframe";
          if (isPageLink && targetInternal) {
            queue.push({ url: target, depth: item.depth + 1, asPage: true });
          } else if (targetInternal || opts.includeExternal) {
            queue.push({ url: target, depth: item.depth + 1, asPage: false });
          }
        }
      } else {
        for (const ref of refs) {
          const target = stripFragment(ref.resolved);
          if (visited.has(target)) continue;
          const targetInternal = sameOrigin(target, origin);
          if (targetInternal || opts.includeExternal) {
            queue.push({ url: target, depth: item.depth + 1, asPage: false });
          }
        }
      }
    } else if (fetched.response) {
      // Drain stream so we don't leak
      await fetched.response.arrayBuffer().catch(() => undefined);
    }
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    result.durationMs = performance.now() - start;
    visited.set(item.url, result);
  }
}

interface FetchResult {
  status: number;
  finalUrl: string;
  chain: string[];
  contentType: string;
  response: Response | null;
}

async function fetchFollowing(url: string, opts: VerifyOpts): Promise<FetchResult> {
  const chain: string[] = [];
  let current = url;
  for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let r: Response;
    try {
      r = await fetch(current, {
        headers: { "user-agent": opts.userAgent },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      await r.arrayBuffer().catch(() => undefined);
      if (!loc) {
        return { status: r.status, finalUrl: current, chain, contentType: "", response: null };
      }
      const next = resolveLink(loc, current);
      if (!next) {
        return { status: r.status, finalUrl: current, chain, contentType: "", response: null };
      }
      chain.push(current);
      current = next;
      continue;
    }
    return {
      status: r.status,
      finalUrl: current,
      chain,
      contentType: r.headers.get("content-type") ?? "",
      response: r,
    };
  }
  return { status: 0, finalUrl: current, chain, contentType: "", response: null };
}

function sameOrigin(url: string, origin: URL): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin.origin;
  } catch {
    return false;
  }
}

export function resolveLink(href: string, baseUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export function stripFragment(url: string): string {
  const h = url.indexOf("#");
  return h === -1 ? url : url.slice(0, h);
}

export function extractFragment(url: string): string | null {
  const h = url.indexOf("#");
  if (h === -1) return null;
  const frag = url.slice(h + 1);
  return frag.length > 0 ? frag : null;
}
