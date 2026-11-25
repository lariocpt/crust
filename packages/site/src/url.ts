// The URL policy (plan §1): the ONE function that decides whether a URL string
// may reach a URL-bearing attribute. `ctx.url()` (the render chunk) wraps it,
// and the fence re-runs it over every URL-bearing attribute whose value
// contains a tracked template value — so an author who forgets `url()` is
// caught at build time, not at click time.
//
// The policy is TOTAL and reject-first: anything that is not unambiguously
// one of the allowed forms is an error. The pre-parse rejects run BEFORE
// `new URL()` because the WHATWG parser normalizes aggressively (it strips
// `\t\r\n` from any position and percent-decodes nothing in schemes we care
// about) — a parser that "fixes" input is a fence that misses attacks.

import type { Diagnostic, DiagnosticCode } from "./diagnostics";

/** Schemes allowed in a URL. Everything else is rejected (plan §1). */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:"]);

/** Attributes whose value is a URL and is re-checked by the fence. */
export const URL_ATTRIBUTES = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "background",
  "data",
] as const;

export type UrlAttribute = (typeof URL_ATTRIBUTES)[number];

/**
 * Options for URL resolution. `siteOrigin` is the site's absolute http(s)
 * origin (scheme + host + port). `pageRoute` is the current page's normalized
 * route, used as the relative base; when omitted the base is the site root.
 */
export interface UrlPolicyOptions {
  siteOrigin: string;
  pageRoute?: string;
}

function urlDiagnostic(code: DiagnosticCode, value: string, message: string): Diagnostic {
  return {
    code,
    severity: "error",
    sourcePath: "",
    message: `url ${JSON.stringify(value)}: ${message}`,
  };
}

/**
 * Validate a URL value. Returns the value UNCHANGED when valid (so callers
 * can pipe it straight into the markup); throws a Diagnostic when invalid.
 *
 * Pre-parse rejects (checked on the RAW text, before any parsing):
 *   - url.control-char     — any char below U+0020, U+007F, or U+0020 (space)
 *   - url.bad-char         — `"` `'` `` ` `` `\`
 *   - url.entity-escape    — the substring `&#` (the raw form of an HTML
 *                            entity reference; `java&#10;script:` becomes
 *                            `javascript:` in a browser that decodes first)
 *   - url.protocol-relative — a leading `//` (no scheme; the browser resolves
 *                            it against the CURRENT page's origin — v1
 *                            rejects it outright instead of guessing)
 *
 * Then the shape policy:
 *   - a pure fragment `#...` is valid (same page, by construction)
 *   - a relative or root-relative ref is valid by construction: it resolves
 *     against the site (same origin); we still resolve it and re-check the
 *     origin so a future base change cannot smuggle a cross-origin ref in
 *   - an absolute URL: `new URL` parse (a parse failure is url.scheme — the
 *     input claimed to be absolute but is not a URL); the lowercased scheme
 *     must be in {http:, https:, mailto:, tel:, sms:} (url.scheme otherwise);
 *     http/https require a non-empty host (url.no-host) and reject userinfo
 *     outright in v1 (url.userinfo)
 *
 * NOTE: absolute http(s) URLs to OTHER origins are ACCEPTED — external links
 * are legitimate. The same-origin rule applies to RELATIVE refs only (and it
 * holds by construction: a relative ref resolves against the site origin).
 */
export function validateUrl(value: string, opts: UrlPolicyOptions): string {
  if (typeof value !== "string") {
    throw urlDiagnostic("url.scheme", String(value), "must be a string");
  }

  // --- pre-parse rejects -------------------------------------------------
  let i = 0;
  for (; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // code <= 0x20 covers the C0 controls AND U+0020 (space) itself;
    // 0x7F is DEL. All are invisible-ish in a printed URL and are exactly
    // what the WHATWG parser strips (`java\tscript:` → `javascript:`).
    if (code <= 0x20 || code === 0x7f) {
      throw urlDiagnostic(
        "url.control-char",
        value,
        `contains a control character or space (U+${code.toString(16).toUpperCase()})`,
      );
    }
  }
  for (const ch of ['"', "'", "`", "\\"]) {
    if (value.includes(ch)) {
      throw urlDiagnostic("url.bad-char", value, `contains ${JSON.stringify(ch)}`);
    }
  }
  if (value.includes("&#")) {
    throw urlDiagnostic(
      "url.entity-escape",
      value,
      "contains an HTML entity reference (`&#`); decode it away or use a plain URL",
    );
  }
  // Named entity references (`&Tab;`, `&NewLine;`, `&colon;`, …): a browser
  // decodes the FULL HTML5 named set in an attribute value BEFORE the URL
  // parser runs, and &Tab;/&NewLine; decode to characters the URL parser
  // strips — `java&Tab;script:x` IS `javascript:x` in a browser. The fence's
  // decodeEntities covers only the five entities html.ts emits plus numeric
  // references; shipping the ~2200-entry table to decode the rest is not an
  // honest option, so the conservative rule wins: any surviving `&name;`
  // pattern is rejected outright. Linear scan (no backtracking regex): each
  // '&' starts one name probe; name chars are visited O(1) times overall.
  for (let k = value.indexOf("&"); k !== -1; k = value.indexOf("&", k + 1)) {
    let m = k + 1;
    while (m < value.length) {
      const c = value.charCodeAt(m);
      const isAlnum =
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
      if (!isAlnum) break;
      m++;
    }
    if (m > k + 1 && m < value.length && value[m] === ";") {
      throw urlDiagnostic(
        "url.entity-escape",
        value,
        "contains a named HTML entity reference (`&name;`); browsers decode it before the URL parser runs (&Tab;/&NewLine; smuggle stripped chars, &colon; smuggles a scheme) — use a plain URL",
      );
    }
  }
  if (value.startsWith("//")) {
    throw urlDiagnostic(
      "url.protocol-relative",
      value,
      "protocol-relative URLs (`//host/...`) are rejected in v1; use an absolute http(s) URL",
    );
  }

  let siteOrigin: URL;
  try {
    siteOrigin = new URL(opts.siteOrigin);
  } catch {
    // A caller that hands over an unparseable base is a caller bug, not a
    // value problem — but the function must stay total (never a raw throw).
    throw urlDiagnostic(
      "url.scheme",
      value,
      `the base ${JSON.stringify(opts.siteOrigin)} is not a parseable URL`,
    );
  }

  // --- pure fragment: same page, always safe -----------------------------
  if (value.startsWith("#")) return value;

  // Absolute input = starts with a URL scheme (WHATWG:
  // [a-zA-Z][a-zA-Z0-9+.-]*:). `mailto:x@y.com`, `tel:+1` and `sms:1` have
  // NO "://" — testing for "://" would misroute them as relative refs.
  // (`//` is already rejected as protocol-relative above.) Everything else
  // is a relative or root-relative ref.
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  if (!SCHEME.test(value)) {
    const base = opts.pageRoute ? `${opts.siteOrigin}${opts.pageRoute}` : `${opts.siteOrigin}/`;
    let resolved: URL;
    try {
      resolved = new URL(value, base);
    } catch {
      throw urlDiagnostic("url.scheme", value, "is not a parseable URL or relative reference");
    }
    // A relative ref can only leave the site if the base is not the site —
    // re-check the origin anyway (defense in depth against base misuse).
    if (
      (resolved.protocol === "http:" || resolved.protocol === "https:") &&
      resolved.origin !== siteOrigin.origin
    ) {
      throw urlDiagnostic(
        "url.scheme",
        value,
        `resolves cross-origin to ${resolved.origin}; relative refs must stay on the site`,
      );
    }
    return value;
  }

  // --- absolute URLs -------------------------------------------------------
  const schemeMatch = SCHEME.exec(value);
  // Special-scheme values must use the `//` authority form. WHATWG normalizes
  // `https:evil.com` (and `https:/evil.com`) to `https://evil.com/` — the
  // parser REWRITES the input, and a parser that rewrites is a fence that
  // misses (this file's header rule). A value that only becomes an external
  // URL after normalization is rejected, not silently accepted.
  if (schemeMatch) {
    const claimed = schemeMatch[0].toLowerCase();
    if (
      (claimed === "http:" || claimed === "https:") &&
      !value.toLowerCase().startsWith(`${claimed}//`)
    ) {
      throw urlDiagnostic(
        "url.scheme",
        value,
        "http(s) URLs must use the `//` authority form (`https://…`): WHATWG normalizes `https:x` to `https://x/`, so this value is not what it appears to be",
      );
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // A special-scheme URL with an EMPTY host (http://, https://?x) is a
    // parse failure per WHATWG ("missing host") — report it as such, not as
    // an unknown scheme. Other parse failures are a scheme-shape problem.
    const inScheme = schemeMatch ? schemeMatch[0] : "";
    const rest = value.slice(inScheme.length);
    const hostPart =
      (rest.startsWith("//") ? rest.slice(2) : rest.replace(/^\//, "")).split(/[/?#]/)[0] ?? "";
    if ((inScheme === "http:" || inScheme === "https:") && hostPart === "") {
      throw urlDiagnostic("url.no-host", value, "http(s) URLs require a non-empty host");
    }
    throw urlDiagnostic("url.scheme", value, "is not a parseable absolute URL");
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw urlDiagnostic(
      "url.scheme",
      value,
      `scheme "${scheme}" is not allowed (allowed: ${[...ALLOWED_SCHEMES].sort().join(", ")})`,
    );
  }
  if (scheme === "http:" || scheme === "https:") {
    if (parsed.host === "") {
      throw urlDiagnostic("url.no-host", value, "http(s) URLs require a non-empty host");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw urlDiagnostic("url.userinfo", value, "userinfo (user:pass@) is rejected in v1");
    }
  }
  return value;
}
