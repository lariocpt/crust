// Upstream forwarding for validation-proxy mode. The proxy is a bystander:
// it forwards the request as-is (minus hop-by-hop headers), reads the whole
// upstream body so the validator can inspect it, and rebuilds an equivalent
// Response for the client.

import { isJsonContentType } from "./validateRequest";

export interface ProxyResult {
  response: Response;
  /** True when the upstream body was non-empty (any content type). */
  hasBody: boolean;
  /** Decoded body text — only when the upstream said JSON and the body was non-empty. */
  bodyText: string | null;
}

export class UpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

// Hop-by-hop (plus content negotiation we break by re-reading the body).
const STRIP_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
];

const STRIP_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

export function joinUpstreamUrl(url: URL, upstream: string): URL {
  // `new URL(url.pathname, upstream)` would resolve the ABSOLUTE pathname
  // against the upstream and drop its base path — join the pathnames instead
  // so `--proxy http://host/base` forwards /api/x to /base/api/x.
  const base = new URL(upstream);
  const target = new URL(base);
  target.pathname = base.pathname.replace(/\/$/, "") + url.pathname;
  target.search = url.search;
  target.hash = "";
  return target;
}

export async function forward(
  method: string,
  url: URL,
  headers: Headers,
  rawBody: ArrayBuffer | null,
  upstream: string,
  timeoutMs: number,
): Promise<ProxyResult> {
  const target = joinUpstreamUrl(url, upstream);
  const outHeaders = new Headers(headers);
  for (const h of STRIP_REQUEST_HEADERS) outHeaders.delete(h);

  const hasBody = rawBody !== null && rawBody.byteLength > 0;
  let upstreamRes: Response;
  let raw: ArrayBuffer;
  try {
    upstreamRes = await fetch(target, {
      method,
      headers: outHeaders,
      body: hasBody ? rawBody : undefined,
      redirect: "manual", // 3xx pass through untouched
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read fully ONCE as raw bytes — decoding to text and back would mangle
    // binary bodies (images, identity-served gzip, …). Validation only ever
    // needs text when the upstream declared JSON.
    raw = await upstreamRes.arrayBuffer();
  } catch (err) {
    throw new UpstreamError((err as Error).message || String(err), { cause: err });
  }

  const respHeaders = new Headers(upstreamRes.headers);
  for (const h of STRIP_RESPONSE_HEADERS) respHeaders.delete(h);
  // 101/204/205/304 (and empty bodies generally) must be rebuilt body-less.
  const bodyAllowed =
    raw.byteLength > 0 && ![101, 204, 205, 304].includes(upstreamRes.status) && method !== "HEAD";
  const response = new Response(bodyAllowed ? raw : null, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
  const bodyText =
    raw.byteLength > 0 && isJsonContentType(upstreamRes.headers.get("content-type"))
      ? new TextDecoder().decode(raw)
      : null;
  return { response, hasBody: raw.byteLength > 0, bodyText };
}
