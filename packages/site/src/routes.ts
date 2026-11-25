// Routes: the URL side of the contract. Routes are file-write inputs, so
// validation is STRICT and total — nothing auto-normalizes (plan §2: "No
// auto-normalization of route() returns"). A route that is not already in
// normalized form is an error naming the offender, never a silent fix: a
// generator that quietly rewrites routes produces two URLs for one page.
//
// `normalizeRoute` throws a bare Diagnostic (not a BuildError): callers
// (frontmatter, the page collector) collect many diagnostics into one
// BuildError, and `isDiagnostic` separates these from real exceptions.

import {
  BuildError,
  compareStrings,
  type Diagnostic,
  type DiagnosticCode,
  isDiagnostic,
} from "./diagnostics";
import type { RouteEntry } from "./types";

/** Windows device names, rejected per segment regardless of extension. */
const RESERVED_NAMES = new Set([
  "con",
  "nul",
  "prn",
  "aux",
  ...["com", "lpt"].flatMap((prefix) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${prefix}${n}`)),
]);

function routeDiagnostic(code: DiagnosticCode, sourcePath: string, message: string): Diagnostic {
  return { code, message, severity: "error", sourcePath };
}

function shape(sourcePath: string, message: string): Diagnostic {
  return routeDiagnostic("route.shape", sourcePath, message);
}

/**
 * Control and invisible format characters: C0 + C1 controls, DEL, soft
 * hyphen, bidi/zero-width formatters, BOM, and the noncharacters. None may
 * appear in a route — raw or after percent-decoding — because they are
 * invisible in a printed URL (two routes that display identically but are
 * different strings) and they break line-based processing (U+2028/2029 are
 * LINE/PARAGRAPH SEPARATOR). Astral-plane code points contain no Cc; the
 * handful of Cf there are obscure script characters no route uses.
 */
const CONTROL_OR_FORMAT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this class is the definition of the control/format characters a route must not contain, so it has to name them
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\ufffb\ufffe\uffff]/;

function hasControlChars(value: string): boolean {
  return CONTROL_OR_FORMAT.test(value);
}

/**
 * WHATWG path percent-encode set (C0 controls, space, `"`, `#`, `<`, `>`,
 * backtick, `?`, `{`, `}`) plus `%` itself — `%` must round-trip as `%25`
 * because we decode before re-encoding. Applied to ASCII only: non-ASCII
 * letters stay literal (the plan keeps unicode routes readable; the raw
 * control/backslash rejections above still fence the dangerous bytes).
 */
function mustEncode(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  // C0 controls (0x00-0x1F), DEL and the C1 block (0x7F-0x9F) all
  // percent-encode. The WHATWG path set stops at C0/DEL, but a C1 control
  // that reached the encoder would be a raw control byte in a file name;
  // the rejections above make that unreachable, this range is defense in
  // depth. (NOT 0x20-0x7E — printable ASCII stays literal.)
  if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  return (
    ch === "%" ||
    ch === '"' ||
    ch === "<" ||
    ch === ">" ||
    ch === "`" ||
    ch === "?" ||
    ch === "#" ||
    ch === "{" ||
    ch === "}" ||
    ch === "\\"
  );
}

function encodeSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    out += mustEncode(ch) ? encodeURIComponent(ch) : ch;
  }
  return out;
}

/**
 * Validate a route and return it, STRICTLY: the input must already be the
 * normalized form, or a Diagnostic is thrown (no silent fixing).
 *
 * Normal form: starts with `/`; segments percent-decoded then NFKC-normalized
 * (so `%2e%2e`, `．．` and U+2024 all become the traversal they hide behind),
 * re-encoded per the WHATWG path set plus C1 controls (non-ASCII letters stay
 * literal, so unicode routes remain readable), joined with single slashes,
 * no trailing slash, root is `/`. Case is preserved. Rejected outright:
 *   non-strings                                → route.invalid
 *   literal `?`/`#`                            → route.query-fragment
 *   and, all route.shape:
 *     control or invisible format characters (C0/C1, DEL, bidi/zero-width
 *     formatters, soft hyphen, BOM, noncharacters) — raw or after decoding
 *     backslashes, drive letters, empty segments, decoded slashes, invalid
 *     percent-escapes or malformed UTF-8, Windows reserved device names
 *     (con/nul/prn/aux/com1-9/lpt1-9, case-insensitive, checked on the stem
 *     before the first dot — `nul.html` is just as reserved as `nul` — with
 *     trailing dots/spaces ignored), and anything whose normalized form
 *     differs from the input.
 *
 * The final round-trip comparison is the backstop: ANY transformation
 * (decode, NFKC, re-encode) that changes the string rejects it, so a new
 * NFKC surprise cannot silently slip into a file name.
 */
export function normalizeRoute(input: unknown, opts: { sourcePath: string }): string {
  const sourcePath = opts.sourcePath;
  if (typeof input !== "string") {
    const kind = input === null ? "null" : typeof input;
    throw routeDiagnostic("route.invalid", sourcePath, `route must be a string, received ${kind}`);
  }
  if (hasControlChars(input)) {
    throw shape(
      sourcePath,
      `route ${JSON.stringify(input)} contains a control or invisible format character`,
    );
  }
  if (input.includes("\\")) {
    throw shape(sourcePath, `route ${JSON.stringify(input)} contains a backslash`);
  }
  if (input.includes("?") || input.includes("#")) {
    throw routeDiagnostic(
      "route.query-fragment",
      sourcePath,
      `route ${JSON.stringify(input)} must not contain a query or fragment`,
    );
  }
  if (!input.startsWith("/")) {
    throw shape(sourcePath, `route ${JSON.stringify(input)} must start with "/"`);
  }
  if (input === "/") return "/";

  const segments: string[] = [];
  for (const raw of input.slice(1).split("/")) {
    if (raw === "") {
      throw shape(
        sourcePath,
        `route ${JSON.stringify(input)} has an empty segment (double or trailing slash)`,
      );
    }
    let segment: string;
    try {
      segment = decodeURIComponent(raw).normalize("NFKC");
    } catch {
      throw shape(
        sourcePath,
        `route ${JSON.stringify(input)} has an invalid percent-escape or malformed UTF-8 sequence in ${JSON.stringify(raw)}`,
      );
    }
    if (segment === "." || segment === "..") {
      throw routeDiagnostic(
        "route.traversal",
        sourcePath,
        `route ${JSON.stringify(input)} contains a "." or ".." segment`,
      );
    }
    if (segment === "" || segment.includes("/") || segment.includes("\\")) {
      throw shape(
        sourcePath,
        `route ${JSON.stringify(input)} has a segment that decodes to a slash or nothing`,
      );
    }
    if (hasControlChars(segment)) {
      throw shape(
        sourcePath,
        `route ${JSON.stringify(input)} has a segment that decodes to a control or invisible format character`,
      );
    }
    if (/^[A-Za-z]:/.test(segment)) {
      throw shape(sourcePath, `route ${JSON.stringify(input)} has a Windows drive-letter segment`);
    }
    // Windows reserves the name before the first dot, and ignores trailing
    // dots/spaces: "CON", "con.", "con ", "nul.txt" are all unwritable.
    const stem =
      segment
        .toLowerCase()
        .replace(/[ .]+$/, "")
        .split(".")[0] ?? "";
    if (RESERVED_NAMES.has(stem)) {
      throw shape(
        sourcePath,
        `route ${JSON.stringify(input)} has the Windows-reserved segment ${JSON.stringify(segment)}`,
      );
    }
    segments.push(segment);
  }

  const normalized = `/${segments.map(encodeSegment).join("/")}`;
  // The backstop (see the header comment): ANY transformation (decode, NFKC,
  // re-encode) that changes the string means the input was not already in
  // normalized form — reject it, never fix it.
  if (normalized !== input) {
    throw shape(
      sourcePath,
      `route ${JSON.stringify(input)} is not normalized; expected ${JSON.stringify(normalized)}`,
    );
  }
  return normalized;
}

/** True iff `normalizeRoute` would accept the input unchanged. */
export function isNormalizedRoute(input: unknown): boolean {
  try {
    normalizeRoute(input, { sourcePath: "" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The normative URL↔file table (plan §4.5): `/`→`index.html`, `/a`→`a.html`,
 * `/a/b`→`a/b.html`. One table shared by emit, sitemap, dev server.
 *
 * The input is RE-VALIDATED, not trusted: a caller that hands over a
 * non-normalized route (a cross-chunk bug) must get a diagnostic, not a
 * broken file write — `"/a/"` would map to `"a/.html"`, a dotfile that no
 * URL addresses. A false pass is worse than a failure, so normalizeRoute's
 * own diagnostics (route.shape/invalid/…) are the only exit for bad input,
 * wrapped in the BuildError every other throw from this table already is.
 */
export function routeToFile(route: string): string {
  let normalized: string;
  try {
    normalized = normalizeRoute(route, { sourcePath: "" });
  } catch (d) {
    throw new BuildError([
      isDiagnostic(d)
        ? d
        : routeDiagnostic(
            "route.invalid",
            "",
            `routeToFile expects a normalized route, got ${JSON.stringify(route)}`,
          ),
    ]);
  }
  return normalized === "/" ? "index.html" : `${normalized.slice(1)}.html`;
}

/**
 * The one canonical URL resolver (plan §4.5), shared by sitemap, `ctx.url()`,
 * the link validator and the dev server. `site` carries no trailing slash
 * (defineSite enforces), so root is the only case that adds one.
 */
export function canonicalUrl(site: string, route: string): string {
  return route === "/" ? `${site}/` : `${site}${route}`;
}

/**
 * Route-table collisions, both passes (plan, Windows table):
 * exact duplicates → route.duplicate, and the case-insensitive pass for
 * case-insensitive filesystems → route.case-collision. Every diagnostic names
 * ALL colliding sourcePaths; output is deterministic (groups sorted, source
 * lists sorted, final sortDiagnostics).
 */
export function findRouteCollisions(entries: readonly RouteEntry[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const exact = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = exact.get(entry.route);
    if (paths) paths.push(entry.sourcePath);
    else exact.set(entry.route, [entry.sourcePath]);
  }
  for (const [route, paths] of [...exact].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort();
    diagnostics.push({
      code: "route.duplicate",
      severity: "error",
      sourcePath: sorted[0],
      message: `route "${route}" is produced by ${sorted.length} files: ${sorted.join(", ")}`,
    });
  }

  // lowercased route → exact route → first (sorted) sourcePath that produced it
  const byCase = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    const key = entry.route.toLowerCase();
    let group = byCase.get(key);
    if (!group) {
      group = new Map();
      byCase.set(key, group);
    }
    const seen = group.get(entry.route);
    if (seen === undefined || entry.sourcePath < seen) group.set(entry.route, entry.sourcePath);
  }
  for (const [, routes] of [...byCase].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (routes.size < 2) continue;
    const distinct = [...routes.keys()].sort();
    const named = distinct.map((route) => `"${route}" (${routes.get(route)})`);
    diagnostics.push({
      code: "route.case-collision",
      severity: "error",
      sourcePath: routes.get(distinct[0]),
      message: `routes ${named.join(" and ")} differ only by case and collide on case-insensitive filesystems`,
    });
  }

  return diagnostics;
}
