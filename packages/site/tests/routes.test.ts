// The route contract: STRICT normalization (nothing auto-normalizes — a route
// that is not already in normal form is an error, never a silent fix), the
// normative URL↔file table, the single canonical-URL resolver, and both
// collision passes (exact + case-insensitive, plan §4.5 + Windows table).
import { describe, expect, test } from "bun:test";
import { BuildError, type Diagnostic, type DiagnosticCode, isDiagnostic } from "../src/diagnostics";
import {
  canonicalUrl,
  findRouteCollisions,
  isNormalizedRoute,
  normalizeRoute,
  routeToFile,
} from "../src/routes";
import type { RouteEntry } from "../src/types";

const SRC = "docs/page.md";

/** Accept cases: [input, expected normalized route]. */
const ACCEPT: [string, string][] = [
  ["/", "/"],
  ["/a", "/a"],
  ["/a/b", "/a/b"],
  ["/a/b/c", "/a/b/c"],
  ["/a-b_c.d", "/a-b_c.d"],
  ["/dots...", "/dots..."],
  ["/my.nul", "/my.nul"],
  ["/dots.", "/dots."],
  ["/com0", "/com0"],
  ["/lpt10", "/lpt10"],
  ["/conc", "/conc"],
  ["/A", "/A"],
  ["/A/B", "/A/B"],
  ["/café", "/café"],
  ["/日本語", "/日本語"],
  ["/。", "/。"],
  ["/a%20b", "/a%20b"],
  ["/a%25b", "/a%25b"],
  ["/a%3Fb", "/a%3Fb"],
  ["/a%23b", "/a%23b"],
  ["/a~b!c$d(e)", "/a~b!c$d(e)"],
  ["/a+b,c=d;e", "/a+b,c=d;e"],
  ["/a^b|c", "/a^b|c"],
  ["/a'b", "/a'b"],
  // a double-encoded traversal decodes ONCE to the literal text "%2e%2e",
  // whose normalized form percent-encodes the "%" (see the traps block below)
  ["/a%252e%252e", "/a%252e%252e"],
];

/** Reject cases: [input, expected code]. */
const REJECT: [unknown, DiagnosticCode][] = [
  ["", "route.shape"],
  ["a", "route.shape"],
  ["a/b", "route.shape"],
  ["/a/", "route.shape"],
  ["//a", "route.shape"],
  ["/a//b", "route.shape"],
  ["/a/./b", "route.traversal"],
  ["/.", "route.traversal"],
  ["/..", "route.traversal"],
  ["/a/../b", "route.traversal"],
  ["/%2e", "route.traversal"],
  ["/%2e%2e", "route.traversal"],
  ["/%2E%2E/b", "route.traversal"],
  ["/．．", "route.traversal"],
  ["/a?b", "route.query-fragment"],
  ["/a#b", "route.query-fragment"],
  ["/a\\b", "route.shape"],
  ["/C:/x", "route.shape"],
  ["/c:x", "route.shape"],
  ["/a\u0000b", "route.shape"],
  ["/a\u0007b", "route.shape"],
  ["/a\u007fb", "route.shape"],
  ["/%00", "route.shape"],
  ["/%41", "route.shape"],
  ["/a%41b", "route.shape"],
  ["/a%3fb", "route.shape"],
  ["/a%zz", "route.shape"],
  ["/a%", "route.shape"],
  ["/a%2fb", "route.shape"],
  ["/a b", "route.shape"],
  ["/a ", "route.shape"],
  ["/Ａ", "route.shape"],
  ["/cafe\u0301", "route.shape"],
  ["/con", "route.shape"],
  ["/CON", "route.shape"],
  ["/Con", "route.shape"],
  ["/nul", "route.shape"],
  ["/prn", "route.shape"],
  ["/aux", "route.shape"],
  ["/com1", "route.shape"],
  ["/com9", "route.shape"],
  ["/CoM2", "route.shape"],
  ["/lpt1", "route.shape"],
  ["/lpt9", "route.shape"],
  ["/con.", "route.shape"],
  ["/con ", "route.shape"],
  ["/con.html", "route.shape"],
  ["/nul.txt", "route.shape"],
  // the reserved-name check runs on the DECODED segment: percent-escapes
  // cannot smuggle a device name past it
  ["/n%75l.html", "route.shape"],
  ["/N%75L", "route.shape"],
  ["/com1.html", "route.shape"],
  ["/LPT9", "route.shape"],
  // malformed double-encoded traversal: "%252e%2e" decodes ONCE to "a%2e."
  // (a literal "%2e" plus a real dot); its normal form is "a%252e.", so the
  // input is rejected — never a traversal, never silently fixed. (The
  // correctly double-encoded "%252e%252e" is in ACCEPT above.)
  ["/a%252e%2e", "route.shape"],
  // encoded separators
  ["/a%2Fb", "route.shape"],
  ["/a%5cb", "route.shape"],
  // malformed UTF-8 after a well-formed percent-escape is still an invalid
  // escape ("invalid percent-escape or malformed UTF-8")
  ["/a%FF%0Fb", "route.shape"],
  // NFKC compatibility characters: the decoded+normalized form must equal
  // the input, so fullwidth forms of / % : are never "already normalized"
  ["/a／b", "route.shape"],
  ["/a%EF%BC%8Fb", "route.shape"],
  ["/a％b", "route.shape"],
  ["/％", "route.shape"],
  ["/c：x", "route.shape"], // fullwidth colon NFKC→ ":" → drive letter
  // U+2024 ONE DOT LEADER NFKC→ ".": a hidden traversal
  ["/\u2024", "route.traversal"],
  ["/%E2%80%A4", "route.traversal"],
  ["/a\u2024b", "route.shape"], // mixed segment: normalizes to "a.b"
  // control and invisible format characters — raw and decoded. C1 controls
  // (U+0080-9F), the LINE/PARAGRAPH separators and the zero-width formatters
  // are invisible in a printed URL and break line-based processing.
  ["/a\u0087b", "route.shape"],
  ["/a%C2%87b", "route.shape"],
  ["/a\u2028b", "route.shape"],
  ["/a\u2029b", "route.shape"],
  ["/a\u200Bb", "route.shape"],
  ["/a\uFEFFb", "route.shape"],
  ["/a\u061Cb", "route.shape"],
  ["/a\u00ADb", "route.shape"],
  // CRLF / tab inside the route string are control characters
  ["/a\r\nb", "route.shape"],
  ["/a\tb", "route.shape"],
  [42, "route.invalid"],
  [null, "route.invalid"],
  [undefined, "route.invalid"],
  [true, "route.invalid"],
  [{}, "route.invalid"],
];

function capture(input: unknown): unknown {
  try {
    normalizeRoute(input, { sourcePath: SRC });
    return undefined;
  } catch (d) {
    return d;
  }
}

describe("normalizeRoute — accepts", () => {
  test.each(ACCEPT)("%s", (input, expected) => {
    expect(normalizeRoute(input, { sourcePath: SRC })).toBe(expected);
  });
});

describe("normalizeRoute — rejects", () => {
  test.each(REJECT)("%s → %s", (input, code) => {
    const d = capture(input);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe(code);
    expect((d as Diagnostic).severity).toBe("error");
    expect((d as Diagnostic).sourcePath).toBe(SRC);
    // the message quotes the offending route (JSON-escaped, so only assert
    // the raw substring for printable strings)
    if (typeof input === "string") {
      expect((d as Diagnostic).message).toContain(JSON.stringify(input));
    }
  });
});

describe("isNormalizedRoute", () => {
  test.each(ACCEPT)("%s is normalized", (input) => {
    expect(isNormalizedRoute(input)).toBe(true);
  });
  test.each(REJECT)("%s is not normalized", (input) => {
    expect(isNormalizedRoute(input)).toBe(false);
  });
});

describe("normalizeRoute — properties", () => {
  test("is idempotent on every accepted route", () => {
    for (const [input, expected] of ACCEPT) {
      const once = normalizeRoute(input, { sourcePath: SRC });
      expect(normalizeRoute(once, { sourcePath: SRC })).toBe(expected);
    }
  });

  test("percent-escapes that decode to the same bytes are NOT normalized (no silent fixing)", () => {
    // "%41" decodes to "A"; the normalized form is "/A", so "/%41" must error
    // rather than quietly rewrite — two URLs for one page is a false pass.
    expect(isNormalizedRoute("/%41")).toBe(false);
    expect(normalizeRoute("/A", { sourcePath: SRC })).toBe("/A");
  });
});

describe("normalizeRoute — normalization traps (adversarial)", () => {
  test("double-encoded traversal is safe in BOTH directions", () => {
    // The properly double-encoded traversal "/a%252e%252e" decodes ONCE to
    // the literal text "a%2e%2e" — not a traversal — and round-trips
    // (re-encoding the literal "%" as "%25" reproduces the input), so it is
    // accepted and stable. A MALFORMED double-encoding "/a%252e%2e" decodes
    // to "a%2e." whose normal form is "a%252e." — rejected, never a
    // traversal, never silently fixed.
    const d = capture("/a%252e%2e") as Diagnostic;
    expect(isDiagnostic(d)).toBe(true);
    expect(d.code).toBe("route.shape");
    expect(d.message).toContain(JSON.stringify("/a%252e."));
    const ok = normalizeRoute("/a%252e%252e", { sourcePath: SRC });
    expect(ok).toBe("/a%252e%252e");
    expect(normalizeRoute(ok, { sourcePath: SRC })).toBe(ok); // idempotent
    // and decoding the accepted form never yields a traversal segment
    expect(decodeURIComponent("a%252e%252e")).toBe("a%2e%2e");
  });

  test("a fullwidth percent (NFKC → '%') can never survive normalization", () => {
    // "%EF%BC%85" decodes to U+FF05, NFKC to "%"; the normal form is "%25",
    // which differs from the input — rejected, so no percent can sneak in
    // pre-decode and change what the decoder sees.
    expect(isNormalizedRoute("/a％b")).toBe(false);
    expect(isNormalizedRoute("/％")).toBe(false);
  });

  test("U+2024 ONE DOT LEADER is the traversal it looks like", () => {
    // NFKC maps U+2024 to "."; a segment that normalizes to "." is a
    // traversal segment and is rejected as one (raw or percent-encoded).
    const raw = capture("/\u2024") as Diagnostic;
    const enc = capture("/%E2%80%A4") as Diagnostic;
    expect(raw.code).toBe("route.traversal");
    expect(enc.code).toBe("route.traversal");
  });

  test("line/paragraph separators are rejected raw and decoded", () => {
    // U+2028/2029 are Cc: they survive printing but split lines — they must
    // never reach a route (raw) or survive a percent-decode (encoded).
    for (const input of ["/a\u2028b", "/a%E2%80%A8b", "/a\u2029b", "/a%E2%80%A9b"]) {
      const d = capture(input) as Diagnostic;
      expect(isDiagnostic(d)).toBe(true);
      expect(d.code).toBe("route.shape");
    }
  });

  test("Windows reserved names are checked on the decoded segment", () => {
    // "n%75l" decodes to "nul" — the reserved check must run AFTER decoding,
    // or a device name smuggled in as percent-escapes becomes an unwritable
    // file on Windows with no diagnostic.
    for (const input of ["/n%75l", "/N%75L.html", "/%63om1", "/lpt9"]) {
      const d = capture(input) as Diagnostic;
      expect(isDiagnostic(d)).toBe(true);
      expect(d.code).toBe("route.shape");
    }
    // and legitimate lookalikes stay legal
    expect(normalizeRoute("/nan.txt", { sourcePath: SRC })).toBe("/nan.txt");
    expect(normalizeRoute("/com0", { sourcePath: SRC })).toBe("/com0");
    expect(normalizeRoute("/my.nul", { sourcePath: SRC })).toBe("/my.nul");
  });
});

describe("routeToFile — the normative URL↔file table (plan §4.5)", () => {
  test.each([
    ["/", "index.html"],
    ["/a", "a.html"],
    ["/a/b", "a/b.html"],
    ["/a/b/c", "a/b/c.html"],
    ["/a%20b", "a%20b.html"],
  ] as const)("%s → %s", (route, file) => {
    expect(routeToFile(route)).toBe(file);
  });

  test("refuses a non-route instead of writing outside the output", () => {
    expect(() => routeToFile("a")).toThrow();
    expect(() => routeToFile("")).toThrow();
  });

  test("a non-normalized route is a BuildError, never a broken file name", () => {
    // The control: a caller that hands over a route normalizeRoute would
    // reject must get a diagnostic here. Without the re-validation the old
    // code mapped "/a/" to "a/.html" — a dotfile no URL addresses, a false
    // pass that only surfaces as 404s after the build.
    for (const bad of ["/a/", "/a//b", "/a%41", "/a\u2024b"]) {
      let thrown: unknown;
      try {
        routeToFile(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(BuildError);
      expect((thrown as BuildError).diagnostics[0].code).toBe("route.shape");
    }
  });
});

describe("canonicalUrl — the one resolver (site + route)", () => {
  test.each([
    ["https://x.dev", "/", "https://x.dev/"],
    ["https://x.dev", "/a", "https://x.dev/a"],
    ["https://x.dev", "/a/b", "https://x.dev/a/b"],
    ["https://x.dev/docs", "/", "https://x.dev/docs/"],
    ["https://x.dev/docs", "/a", "https://x.dev/docs/a"],
    ["https://x.dev/docs", "/a/b", "https://x.dev/docs/a/b"],
    ["http://localhost:3000", "/x", "http://localhost:3000/x"],
  ] as const)("%s + %s", (site, route, expected) => {
    expect(canonicalUrl(site, route)).toBe(expected);
  });
});

describe("findRouteCollisions", () => {
  function codes(entries: RouteEntry[]): [string, string][] {
    return findRouteCollisions(entries).map((d) => [d.code, d.message]);
  }

  test("exact duplicates name BOTH source files", () => {
    const ds = findRouteCollisions([
      { route: "/a", sourcePath: "docs/a.md" },
      { route: "/a", sourcePath: "docs/b.md" },
    ]);
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("route.duplicate");
    expect(ds[0].message).toContain("docs/a.md");
    expect(ds[0].message).toContain("docs/b.md");
    expect(ds[0].sourcePath).toBe("docs/a.md");
  });

  test("a three-way duplicate names all three", () => {
    const ds = findRouteCollisions([
      { route: "/a", sourcePath: "c.md" },
      { route: "/a", sourcePath: "a.md" },
      { route: "/a", sourcePath: "b.md" },
    ]);
    expect(ds).toHaveLength(1);
    expect(ds[0].message).toContain("a.md, b.md, c.md");
  });

  test("/A vs /a is a case-collision naming both", () => {
    const ds = findRouteCollisions([
      { route: "/A", sourcePath: "upper.md" },
      { route: "/a", sourcePath: "lower.md" },
    ]);
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("route.case-collision");
    expect(ds[0].message).toContain('"/A" (upper.md)');
    expect(ds[0].message).toContain('"/a" (lower.md)');
  });

  test("/A vs /B is no collision", () => {
    expect(
      findRouteCollisions([
        { route: "/A", sourcePath: "a.md" },
        { route: "/B", sourcePath: "b.md" },
      ]),
    ).toEqual([]);
  });

  test("a three-way case collision names all three variants", () => {
    const ds = findRouteCollisions([
      { route: "/AB", sourcePath: "ab.md" },
      { route: "/aB", sourcePath: "aB.md" },
      { route: "/ab", sourcePath: "ab2.md" },
    ]);
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("route.case-collision");
    for (const named of ['"/AB" (ab.md)', '"/aB" (aB.md)', '"/ab" (ab2.md)']) {
      expect(ds[0].message).toContain(named);
    }
  });

  test("an exact duplicate AND its case variant report once each", () => {
    const ds = findRouteCollisions([
      { route: "/a", sourcePath: "a.md" },
      { route: "/a", sourcePath: "b.md" },
      { route: "/A", sourcePath: "c.md" },
    ]);
    expect(ds.map((d) => d.code).sort()).toEqual(["route.case-collision", "route.duplicate"]);
  });

  test("empty and single-entry tables are clean", () => {
    expect(findRouteCollisions([])).toEqual([]);
    expect(findRouteCollisions([{ route: "/a", sourcePath: "a.md" }])).toEqual([]);
  });

  test("output order is deterministic under input shuffling", () => {
    const entries: RouteEntry[] = [
      { route: "/Z", sourcePath: "z.md" },
      { route: "/z", sourcePath: "y.md" },
      { route: "/dup", sourcePath: "d2.md" },
      { route: "/dup", sourcePath: "d1.md" },
      { route: "/x", sourcePath: "x.md" },
    ];
    const forward = codes(entries);
    const backward = codes([...entries].reverse());
    const rotated = codes([...entries.slice(2), ...entries.slice(0, 2)]);
    expect(backward).toEqual(forward);
    expect(rotated).toEqual(forward);
    expect(forward.map(([code]) => code)).toEqual(["route.duplicate", "route.case-collision"]);
  });
});
