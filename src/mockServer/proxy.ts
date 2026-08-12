// Upstream forwarding for validation-proxy mode. The proxy is a bystander:
// it forwards the request as-is (minus hop-by-hop headers), reads the whole
// upstream body so the validator can inspect it, and rebuilds an equivalent
// Response for the client.

export interface ProxyResult {
  response: Response;
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

export async function forward(
  method: string,
  url: URL,
  headers: Headers,
  rawBody: ArrayBuffer | null,
  upstream: string,
  timeoutMs: number,
): Promise<ProxyResult> {
  const target = new URL(url.pathname + url.search, upstream);
  const outHeaders = new Headers(headers);
  for (const h of STRIP_REQUEST_HEADERS) outHeaders.delete(h);

  const hasBody = rawBody !== null && rawBody.byteLength > 0;
  let upstreamRes: Response;
  let bodyText: string;
  try {
    upstreamRes = await fetch(target, {
      method,
      headers: outHeaders,
      body: hasBody ? rawBody : undefined,
      redirect: "manual", // 3xx pass through untouched
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read fully — validation needs the text, and streaming it twice is worse.
    bodyText = await upstreamRes.text();
  } catch (err) {
    throw new UpstreamError((err as Error).message || String(err), { cause: err });
  }

  const respHeaders = new Headers(upstreamRes.headers);
  for (const h of STRIP_RESPONSE_HEADERS) respHeaders.delete(h);
  // 101/204/205/304 (and empty bodies generally) must be rebuilt body-less.
  const bodyAllowed =
    bodyText.length > 0 && ![101, 204, 205, 304].includes(upstreamRes.status) && method !== "HEAD";
  const response = new Response(bodyAllowed ? bodyText : null, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
  return { response, bodyText: bodyText.length > 0 ? bodyText : null };
}
