// The URL policy (plan §1): pre-parse rejects, scheme allowlist, host/userinfo
// rules. Every reject case here is one that a browser WOULD resolve
// dangerously (or that a parser would "fix" into something dangerous) — the
// policy rejects before `new URL` gets a chance to normalize.
//
// v1 policy (locked in the task): absolute http(s) URLs to OTHER origins are
// ACCEPTED — external links are legitimate. The same-origin rule applies to
// RELATIVE refs only, and it holds by construction (a relative ref resolves
// against the site origin). The fence's url-attribute check therefore
// enforces exactly this function over tracked values.
import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "../src/diagnostics";
import { isDiagnostic } from "../src/diagnostics";
import { decodeEntities } from "../src/fence";
import { canonicalUrl } from "../src/routes";
import { urlBase, validateUrl } from "../src/url";

const SITE = "https://site.dev";
const OPTS = { siteUrl: SITE };
const OPTS_PAGE = { siteUrl: SITE, pageRoute: "/a/b" };

/** [value, opts, expected return] — expected return is always the input. */
const ACCEPT: [string, typeof OPTS | typeof OPTS_PAGE][] = [
  // pure fragments
  ["#frag", OPTS],
  ["#", OPTS],
  ["#a-b_c.d", OPTS],
  // relative / root-relative refs (same-origin by construction)
  ["./x", OPTS],
  ["./x?q=1#f", OPTS],
  ["/x", OPTS],
  ["/x?y=1", OPTS],
  ["/x/y/z", OPTS],
  ["/a%20b", OPTS],
  ["x/y", OPTS],
  ["x/y?z", OPTS],
  ["?q=1", OPTS],
  // page-relative resolution: /a/b + ../x → /x (still the site)
  ["../x", OPTS_PAGE],
  ["..", OPTS_PAGE],
  ["../../x", OPTS_PAGE],
  ["./../x", OPTS_PAGE],
  // absolute same-origin
  ["https://site.dev", OPTS],
  ["https://site.dev/", OPTS],
  ["https://site.dev/x", OPTS],
  ["http://site.dev", OPTS],
  ["https://site.dev:8080/x", OPTS],
  ["HTTPS://SITE.DEV/x", OPTS],
  // absolute http(s) to OTHER origins: legitimate external links — accepted
  // (scheme + non-empty host is the whole policy for http/https)
  ["https://other.example", OPTS],
  ["https://ok.example/x?q=1#f", OPTS],
  ["http://other.example", OPTS],
  ["https://user.example", OPTS], // no userinfo: fine
  // non-web schemes
  ["mailto:x@y.com", OPTS],
  ["mailto:x@y.com?subject=hi", OPTS],
  ["tel:+15551234567", OPTS],
  ["tel:15551234567", OPTS],
  ["sms:15551234567", OPTS],
  ["MAILTO:x@y.com", OPTS],
  // empty value: resolves to the current page — same-origin by construction
  ["", OPTS],
  // IPv6 literal and IDN host: parsed, non-empty host, accepted (no crash)
  ["https://[::1]/", OPTS],
  ["https://[::1]:8443/x", OPTS],
  ["https://оxample.dev", OPTS], // Cyrillic о — punycode-encodes, external https
  // percent-escapes are NOT decoded before scheme detection: `java%09script:`
  // has no scheme (percent is not a scheme char) → relative ref → same-origin.
  // A browser agrees: it never percent-decodes before parsing the scheme.
  ["java%09script:x", OPTS],
  ["java%0ascript:x", OPTS],
  // mailto/tel payload shapes
  ["mailto:a+b-tag@x.com", OPTS],
  ["tel:+1-555-1234", OPTS],
];

/** [value, expected code] — every one of these is a real browser hazard. */
const REJECT: [string, Diagnostic["code"]][] = [
  // dangerous schemes (raw and case-variant)
  ["javascript:alert(1)", "url.scheme"],
  ["JAVASCRIPT:alert(1)", "url.scheme"],
  ["JavaScript:alert(1)", "url.scheme"],
  ["jAvAsCrIpT:x", "url.scheme"],
  ["vbscript:msgbox(1)", "url.scheme"],
  ["data:text/html,<script>alert(1)</script>", "url.scheme"],
  ["data:text/plain,x", "url.scheme"],
  ["file:///etc/passwd", "url.scheme"],
  ["file://host/x", "url.scheme"],
  ["blob:https://x/uuid", "url.scheme"],
  ["about:blank", "url.scheme"],
  ["ftp://files.example/x", "url.scheme"],
  ["ws://socket.example", "url.scheme"],
  ["wss://socket.example", "url.scheme"],
  ["x:alert(1)", "url.scheme"], // an unknown single-letter scheme is still a scheme
  // control characters: the WHATWG parser strips \t\r\n from ANY position,
  // so java\tscript: IS javascript: to a browser
  ["java\tscript:alert(1)", "url.control-char"],
  ["java\nscript:alert(1)", "url.control-char"],
  ["java\rscript:alert(1)", "url.control-char"],
  ["java\0script:", "url.control-char"],
  ["java\u000bscript:", "url.control-char"], // vertical tab
  ["java\u000cscript:", "url.control-char"], // form feed
  ["java\u007fscript:", "url.control-char"],
  [" //evil.com", "url.control-char"], // leading space, then protocol-relative
  // named entities: the browser decodes the FULL HTML5 named set in an
  // attribute value BEFORE the URL parser runs. &Tab;/&NewLine; decode to
  // characters the URL parser strips; &colon; decodes to ':'. The fence's
  // decoder cannot ship the 2200-entry table, so ANY surviving `&name;`
  // is rejected (conservative route, locked in review).
  ["java&Tab;script:alert(1)", "url.entity-escape"],
  ["java&NewLine;script:alert(1)", "url.entity-escape"],
  ["javascript&colon;alert(1)", "url.entity-escape"],
  ["java&lT;script:x", "url.entity-escape"], // case-insensitive names too
  // named entities are rejected even when they look harmless — a surviving
  // `&name;` means the fence's decode and the browser's disagree somewhere
  ["https://x.dev/?a=1&dot;=2", "url.entity-escape"],
  // quotes and backslash: attribute-escape and Windows-path tricks
  ['http://exa"mple.com', "url.bad-char"],
  ["http://exa'mple.com", "url.bad-char"],
  ["http://exa`mple.com", "url.bad-char"],
  ["http\\://evil.example", "url.bad-char"],
  ["https://x.com/a\\b", "url.bad-char"],
  // entity smuggling: the browser decodes &#10; (newline) in the attribute
  // value BEFORE the URL parser runs — java&#10;script: becomes javascript:
  ["java&#10;script:alert(1)", "url.entity-escape"],
  ["java&#x0A;script:alert(1)", "url.entity-escape"],
  ["java&#X0a;script:", "url.entity-escape"],
  // protocol-relative: resolves against the CURRENT page, not the site
  ["//evil.com", "url.protocol-relative"],
  ["//evil.com/x?q=1", "url.protocol-relative"],
  // userinfo is rejected outright in v1
  ["https://user:pass@x.dev", "url.userinfo"],
  ["https://user@x.dev", "url.userinfo"],
  ["http://:pass@x.dev", "url.userinfo"],
  // http(s) with no host
  ["http://", "url.no-host"],
  ["https://", "url.no-host"],
  // invalid port: `new URL` THROWS — must surface as a diagnostic, never a crash
  ["https://x.dev:99999", "url.scheme"],
  ["https://x.dev:notaport", "url.scheme"],
  // bare `//` is protocol-relative too (not an empty relative ref)
  ["//", "url.protocol-relative"],
];

function capture(value: string, opts: typeof OPTS | typeof OPTS_PAGE): unknown {
  try {
    validateUrl(value, opts);
    return undefined;
  } catch (d) {
    return d;
  }
}

describe("validateUrl — accepts", () => {
  test.each(ACCEPT)("%s", (value, opts) => {
    expect(validateUrl(value, opts)).toBe(value); // returned unchanged
  });
});

describe("validateUrl — rejects", () => {
  test.each(REJECT)("%s → %s", (value, code) => {
    const d = capture(value, OPTS);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe(code);
    expect((d as Diagnostic).severity).toBe("error");
    expect((d as Diagnostic).message).toContain(JSON.stringify(value));
  });
});

describe("validateUrl — policy decisions", () => {
  test("a cross-origin ABSOLUTE http(s) URL is a legitimate external link", () => {
    // Locked correction: the same-origin rule applies to RELATIVE refs only
    // (which cannot be cross-origin anyway). Absolute http(s) to another
    // origin: scheme + non-empty host is the whole policy.
    expect(validateUrl("https://other.example", OPTS)).toBe("https://other.example");
    expect(validateUrl("http://other.example/deep/path?q=1#f", OPTS_PAGE)).toBe(
      "http://other.example/deep/path?q=1#f",
    );
  });

  test("a relative ref resolves against the page route, and stays on the site", () => {
    // /a/b + ../x → /x on the site. The origin re-check makes a future base
    // misuse loud instead of a cross-origin leak.
    expect(validateUrl("../x", OPTS_PAGE)).toBe("../x");
    expect(validateUrl("/abs", OPTS_PAGE)).toBe("/abs");
  });

  test("%6aavascript: has no scheme, so it is a RELATIVE ref and stays same-origin", () => {
    // No leading letter+colon → the URL parser treats it as a path; it
    // resolves against the site and cannot become a javascript: URL.
    expect(validateUrl("%6aavascript:alert(1)", OPTS)).toBe("%6aavascript:alert(1)");
  });

  test("a double-escaped entity (&amp;#10;) is rejected outright — the conservative named-entity rule", () => {
    // A browser decodes entities in an attribute value exactly ONCE, so the
    // literal text `&amp;#10;` decodes to `&#10;` — a safe literal. But a
    // surviving `&name;` in a value means the fence's single decode pass and
    // the browser's decode table could disagree (the fence decodes only the
    // five html.ts emits + numerics; the browser decodes ~2200 names). The
    // conservative rule (locked in review): ANY `&name;` pattern is rejected.
    const value = "&amp;#10;script:";
    const d = capture(value, OPTS);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("url.entity-escape");
    // The FENCE is where the single-decode semantics live: it decodes the
    // attribute value ONCE (the browser's entity pass), so the author's
    // `&amp;#10;` becomes `&#10;` and the raw `&#` check catches the
    // smuggled newline.
    const decoded = decodeEntities(value);
    expect(decoded).toBe("&#10;script:");
    const d2 = capture(decoded, OPTS);
    expect(isDiagnostic(d2)).toBe(true);
    expect((d2 as Diagnostic).code).toBe("url.entity-escape");
  });

  test("a non-string input is a diagnostic, never a raw TypeError", () => {
    const d = capture("42", OPTS);
    void d; // (string path covered above)
    let thrown: unknown;
    try {
      (validateUrl as (v: unknown, o: typeof OPTS) => string)(42, OPTS);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("url.scheme");
  });

  test("an unparseable site base is a diagnostic, never a raw throw", () => {
    let thrown: unknown;
    try {
      validateUrl("/x", { siteUrl: "not a url" });
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("url.scheme");
  });

  test("the allowlist is exactly http/https/mailto/tel/sms", () => {
    expect(validateUrl("http://x.dev", OPTS)).toBe("http://x.dev");
    expect(validateUrl("https://x.dev", OPTS)).toBe("https://x.dev");
    for (const scheme of ["mailto", "tel", "sms"]) {
      expect(validateUrl(`${scheme}:x`, OPTS)).toBe(`${scheme}:x`);
    }
  });

  test("http(s) values must use the `//` authority form (WHATWG rewrites the rest)", () => {
    // `https:evil.com` parses to https://evil.com/ — the parser REWRITES the
    // input, so the checked value is not the executed value. Rejected.
    for (const v of ["https:evil.com", "https:/evil.com", "HTTPS:evil.com", "http:site.dev"]) {
      const d = capture(v, OPTS);
      expect(isDiagnostic(d)).toBe(true);
      expect((d as Diagnostic).code).toBe("url.scheme");
    }
    // controls: the proper authority form still passes
    expect(validateUrl("https://evil.com", OPTS)).toBe("https://evil.com");
    expect(validateUrl("https://site.dev/x", OPTS)).toBe("https://site.dev/x");
  });
});

describe("the base invariant — relative resolution agrees with canonicalUrl", () => {
  // Regression for the chunk-6 flagged bug: pages.ts computed
  // `new URL(site).origin` and handed THAT to the markdown renderer, so for a
  // path-prefixed site (GH Pages `https://x.dev/docs`) the prefix silently
  // dropped out of every relative-ref resolution while the page's canonical
  // URL kept it. The fix hands the FULL site URL down (pages.ts → markdown.ts
  // → validateUrl; render.ts's ctx.url() and the fence take the same base).
  // The invariant every caller relies on — pinned here with EXPLICIT bytes,
  // not just self-consistency, so a drift in EITHER side is red:
  //
  //     urlBase({ siteUrl: site, pageRoute: route }) === canonicalUrl(site, route)
  const PREF = "https://x.dev/docs";

  test("urlBase({siteUrl, pageRoute}) === canonicalUrl(site, route), pinned byte for byte", () => {
    expect(canonicalUrl(PREF, "/")).toBe("https://x.dev/docs/");
    expect(canonicalUrl(PREF, "/a")).toBe("https://x.dev/docs/a");
    expect(canonicalUrl(PREF, "/a/b")).toBe("https://x.dev/docs/a/b");
    expect(urlBase({ siteUrl: PREF, pageRoute: "/" })).toBe("https://x.dev/docs/");
    expect(urlBase({ siteUrl: PREF, pageRoute: "/a" })).toBe("https://x.dev/docs/a");
    expect(urlBase({ siteUrl: PREF, pageRoute: "/a/b" })).toBe("https://x.dev/docs/a/b");
    // no pageRoute: the site root — prefix kept, one slash added
    expect(urlBase({ siteUrl: PREF })).toBe("https://x.dev/docs/");
    for (const route of ["/", "/a", "/a/b"]) {
      expect(urlBase({ siteUrl: PREF, pageRoute: route })).toBe(canonicalUrl(PREF, route));
    }
    // a prefix-less site: origin === full site, the invariant holds trivially
    // (and this is the case that MASKED the bug in the first place)
    expect(urlBase({ siteUrl: "https://x.dev", pageRoute: "/a/b" })).toBe("https://x.dev/a/b");
  });

  test("a relative ref resolves identically against urlBase and canonicalUrl", () => {
    for (const ref of ["x", "./x", "../x", "../../x", "/abs", "x?q=1#f", "?q=1"]) {
      expect(new URL(ref, urlBase({ siteUrl: PREF, pageRoute: "/a/b" })).href).toBe(
        new URL(ref, canonicalUrl(PREF, "/a/b")).href,
      );
    }
  });

  test("control: the ORIGIN base (the old bug) does NOT agree with canonicalUrl", () => {
    // `new URL(site).origin` is "https://x.dev" — the /docs prefix is gone.
    // A relative ref then resolves to a URL the site can never serve.
    const originBase = new URL(PREF).origin + "/a/b"; // "https://x.dev/a/b"
    const canonical = canonicalUrl(PREF, "/a/b"); // "https://x.dev/docs/a/b"
    expect(originBase).toBe("https://x.dev/a/b");
    expect(new URL("x", originBase).href).toBe("https://x.dev/a/x");
    expect(new URL("x", canonical).href).toBe("https://x.dev/docs/a/x");
    expect(new URL("x", originBase).href).not.toBe(new URL("x", canonical).href);
  });
});
