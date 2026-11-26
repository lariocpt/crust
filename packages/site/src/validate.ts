// Post-render validation — pipeline step 7 (plan §4.7): runs AFTER render and
// BEFORE emit/publish, over the FINAL emitted documents. Three checks, all
// collected (never first-error-fatal) and handed to the build's diagnostic
// pool, where errors block the publish and warnings join BuildResult.warnings:
//
//   1. Internal links — every internal link extracted during render (the
//      page's `links`, which contains ONLY internal destinations: .md links
//      resolved against the route table and same-page fragments — external
//      URLs are never recorded, so they are never fragment-checked):
//        - destination is the generated 404 route → link.broken (the 404
//          page is generated, excluded from the sitemap, and is not a link
//          target — plan, "Locked decisions" 2);
//        - destination is in neither the route table (production) nor the
//          drafts → link.broken, naming the source page, the line and the
//          destination;
//        - destination is a draft → link.draft.
//      Severity (plan §5 — crust rule 1, no false pass): in a production
//      build (mode "build") both are ERRORS; in dev (mode "dev", chunk 9
//      passes it) both are WARNINGS, because the dev server renders and
//      serves drafts, so the link really resolves there.
//
//   2. Fragments — a link carrying #fragment requires the destination page's
//      FINAL EMITTED html to contain id="fragment". The ids are collected
//      ONCE per emitted page (route → Set<ids>, scanning the emitted bytes)
//      and shared across every link in the run. Same-page fragments are
//      included (a fragment link's route is its own page). The check applies
//      only to destinations that were actually emitted: a draft destination
//      in a production build has no emitted bytes (its link.draft above is
//      the report), so its fragment is not checked twice.
//
//   3. Metadata — per emitted page (INCLUDING the generated 404): exactly
//      one <meta charset> (head() never emits one — the layout hand-writes
//      it), exactly one <title>, exactly one rel="canonical". head() is the
//      only producer of title and canonical in v1, so a document with no
//      canonical is reported as metadata.head-missing ("the layout never
//      called head()"); a document with none is never a silent pass.
//
// WHY A REGEX OVER THE EMITTED BYTES IS ACCEPTABLE HERE (and nowhere else in
// the package): every byte of these documents is OUR OWN output. The fence
// (finalizeDocument) already guaranteed the well-formedness of everything
// the author interpolated — value ranges cannot cross comment/script/
// attribute boundaries, every attribute is double-quoted, every URL-bearing
// attribute re-passed the URL policy (so no `"` or `>` inside a value) —
// and the only other content is static markup the engine and the layout
// template wrote literally (markdown bodies are fully escaped: html:false,
// so an `id="..."` sequence inside text or code is entity-escaped and can
// only ever be matched as a real attribute). Scanning own, fenced bytes is
// a linear-time state machine (the plan's DoS rule), never a parse of
// untrusted input. Three scanning rules follow from that, each pinned by a
// test that fails without it:
//
//   - COMMENTS ARE STRIPPED before any scan. A commented-out
//     `<meta charset>`/`<title>`/`id="…"` is not a head fact or an anchor,
//     and counting it would be a false pass (a dead fragment link passing,
//     a head-less page satisfying the charset check). `<!--` can only
//     appear as literal layout markup (the fence escapes `<` in every
//     interpolated value, markdown escapes raw HTML), so a linear
//     `<!--…-->` strip is safe over our bytes.
//   - IDS ARE QUOTED-ONLY (double or single). Broadening to unquoted values
//     is UNSOUND: an unquoted `id=x` inside a code fence contains no
//     escapable characters, survives escaping verbatim, and would be
//     byte-identical to layout markup — fragments would false-pass from
//     code samples. A quoted id can never survive escaping (&quot;), so a
//     quoted-only match is always a real attribute. Layouts must quote
//     their ids; an unquoted hand-written id is not recognized (documented).
//   - `<title>` INSIDE `<svg>` IS NOT THE DOCUMENT TITLE. An accessible
//     svg icon carries its own <title>; counting it would false-fail every
//     page that uses one (title-duplicate) and false-satisfy the title check
//     for a head-less page. Titles are counted with linear svg-depth
//     tracking (svg is never nested in svg in practice; the depth clamps).
//
// Drafts' OWN links: a production build renders (and emits) no drafts, so
// the validator is only ever FEED production pages plus the 404 in
// "build" mode — a draft's links are not validated in a build (there are no
// bytes to check fragments against, and its links would 404 by
// construction anyway). In "dev" mode chunk 9 feeds the full page set, and
// a draft's own broken links are then flagged (as warnings). Defense in
// depth: if a draft page is nevertheless handed to a "build" validator, it
// is skipped WHOLE (links and metadata) — validating bytes that will never
// be published would only produce false errors.

import { type Diagnostic, type Severity, sortDiagnostics } from "./diagnostics";
import type { InternalLink } from "./types";

/** One document that will (or did) land in the output. */
export interface EmittedPage {
  /** The page's normalized route. */
  readonly route: string;
  /** posix, relative to the config directory ("<generated>" for the 404). */
  readonly sourcePath: string;
  /** The final emitted html (what the file on disk will contain). */
  readonly html: string;
  /** The internal links extracted during this page's render. */
  readonly links: readonly InternalLink[];
}

/** One known route: a production page, or a draft (dev table / link target). */
export interface KnownRoute {
  /** true when the route belongs to a draft page. */
  readonly draft: boolean;
}

export interface ValidationOptions {
  /**
   * "build" = a production build: the validator sees the production pages
   * plus the generated 404, and draft links are ERRORS. "dev" = the dev
   * server's validation (chunk 9): the validator sees the FULL page set
   * (drafts included, their links validated), and draft links are WARNINGS
   * (plan §5).
   */
  readonly mode: "build" | "dev";
  /** The emitted documents, in any order (diagnostics are sorted). */
  readonly pages: readonly EmittedPage[];
  /**
   * Every KNOWN route the site can have: production pages AND drafts —
   * EXCLUDING "/404" (the generated 404 is not a link target and is
   * special-cased as link.broken).
   */
  readonly routes: ReadonlyMap<string, KnownRoute>;
}

// The scanners (see the header for why regex over our own bytes is sound).
// All are linear-time; attribute NAMES match case-insensitively (HTML is
// case-insensitive for them), values case-sensitively (ids are).
const ID_ATTR = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CHARSET_META = /<meta\s+charset\s*=/gi;
const CANONICAL_LINK = /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// svg-depth tracking for the title count: <svg …> opens, </svg …> closes,
// <title> at depth 0 is the document title (an svg <title> is an icon's
// accessible name, not the page's).
const SVG_OR_TITLE = /<svg\b|<\/svg\s*>|<title[\s>]/gi;

/** Literal HTML comments removed (see the header: safe over own bytes). */
function stripComments(html: string): string {
  return html.replace(HTML_COMMENT, "");
}

/**
 * Every id attribute value in one emitted document (markdown heading ids
 * and any hand-written layout ids alike). Collected once per page and
 * shared across all fragment checks of the run. Comments are stripped
 * first (a commented-out id is not an anchor); values are quoted-only
 * (see the header for why unquoted matching would false-pass).
 */
export function collectIds(html: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const m of stripComments(html).matchAll(ID_ATTR)) ids.add(m[1] ?? m[2] ?? "");
  return ids;
}

/** <title> count OUTSIDE <svg> (svg <title> is an icon label, not the page title). */
function countTitles(html: string): number {
  let count = 0;
  let svgDepth = 0;
  for (const m of html.matchAll(SVG_OR_TITLE)) {
    const tok = m[0].toLowerCase();
    if (tok.startsWith("<svg")) svgDepth++;
    else if (tok.startsWith("</svg")) svgDepth = Math.max(0, svgDepth - 1);
    else if (svgDepth === 0) count++;
  }
  return count;
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m === null ? 0 : m.length;
}

/** "on line 6 of \"content/index.md\"" / "in \"content/index.md\"". */
function at(page: EmittedPage, line: number | null): string {
  return line === null
    ? `in ${JSON.stringify(page.sourcePath)}`
    : `on line ${line} of ${JSON.stringify(page.sourcePath)}`;
}

/** The link-severity for the mode (plan §5): error in prod, warning in dev. */
function linkSeverity(mode: "build" | "dev"): Severity {
  return mode === "build" ? "error" : "warning";
}

/**
 * Check ONE emitted page's metadata contract (plan §3): exactly one
 * `<meta charset>`, exactly one `<title>`, exactly one `rel="canonical"`.
 * `head()` is the only title/canonical producer in v1, so:
 *   - zero canonical  → metadata.head-missing ("head() never called");
 *   - two+ canonical  → metadata.canonical-duplicate;
 *   - zero/two+ title → metadata.title-missing / metadata.title-duplicate
 *     (svg <title> elements do not count — see countTitles);
 *   - zero/two+ charset → metadata.charset-missing / metadata.charset-duplicate.
 * Comments are stripped before counting (a commented-out tag satisfies
 * nothing). All errors, in every mode — a page missing its head is broken
 * output whether it ships or merely serves.
 */
function validateMetadata(page: EmittedPage, out: Diagnostic[]): void {
  const html = stripComments(page.html);
  const charset = countMatches(html, CHARSET_META);
  if (charset === 0) {
    out.push({
      code: "metadata.charset-missing",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} has no <meta charset>: ` +
        "the layout must hand-write one (head() never emits charset)",
    });
  } else if (charset > 1) {
    out.push({
      code: "metadata.charset-duplicate",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} carries ${charset} <meta charset> tags: ` +
        "exactly one is required",
    });
  }

  const title = countTitles(html);
  if (title === 0) {
    out.push({
      code: "metadata.title-missing",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} has no <title>: ` +
        "the layout must include ctx.head() (head() is the only <title> producer)",
    });
  } else if (title > 1) {
    out.push({
      code: "metadata.title-duplicate",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} carries ${title} <title> tags: ` +
        "exactly one is required",
    });
  }

  const canonical = countMatches(html, CANONICAL_LINK);
  if (canonical === 0) {
    out.push({
      code: "metadata.head-missing",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} has no rel="canonical" link: ` +
        "the layout never called head() (head() is the only canonical producer)",
    });
  } else if (canonical > 1) {
    out.push({
      code: "metadata.canonical-duplicate",
      severity: "error",
      sourcePath: page.sourcePath,
      message:
        `the emitted document for ${JSON.stringify(page.sourcePath)} carries ${canonical} rel="canonical" links: ` +
        "exactly one is required",
    });
  }
}

/**
 * Check one internal link of one emitted page against the known routes and
 * the emitted id sets (see the module header for the pinned rules).
 */
function validateLink(
  page: EmittedPage,
  link: InternalLink,
  routes: ReadonlyMap<string, KnownRoute>,
  ids: ReadonlyMap<string, ReadonlySet<string>>,
  severity: Severity,
  out: Diagnostic[],
): void {
  const dest = link.route;
  const line = link.line === null ? undefined : link.line;

  // The generated 404 page is not a link target (plan, "Locked decisions" 2)
  // — in every mode.
  if (dest === "/404") {
    out.push({
      code: "link.broken",
      severity,
      sourcePath: page.sourcePath,
      line,
      message:
        `internal link ${at(page, link.line)} points at ${JSON.stringify(dest)}: ` +
        "the 404 page is generated, not authored content, and is not a link target",
    });
    return;
  }

  const known = routes.get(dest);
  if (known === undefined) {
    out.push({
      code: "link.broken",
      severity,
      sourcePath: page.sourcePath,
      line,
      message:
        `internal link ${at(page, link.line)} points at ${JSON.stringify(dest)}: ` +
        "that route is not a page of this site (not in the route table, not a draft)",
    });
    return;
  }

  if (known.draft) {
    out.push({
      code: "link.draft",
      severity,
      sourcePath: page.sourcePath,
      line,
      message:
        `internal link ${at(page, link.line)} points at the draft page ${JSON.stringify(dest)}: ` +
        (severity === "error"
          ? "drafts are not published — the link would 404 on the production site"
          : "the link resolves here (dev renders drafts) but would 404 on the production build"),
    });
  }

  // Fragment: the destination's FINAL EMITTED html must carry the id. Only
  // checked when the destination was actually emitted — a draft destination
  // in a production build has no emitted bytes (its link.draft above is the
  // report), and external URLs never reach this function (they are not
  // internal links: the renderer records them as none).
  if (link.fragment !== null) {
    const target = ids.get(dest);
    if (target !== undefined && !target.has(link.fragment)) {
      out.push({
        code: "link.missing-fragment",
        severity: "error",
        sourcePath: page.sourcePath,
        line,
        message:
          `internal link ${at(page, link.line)} carries fragment ${JSON.stringify(link.fragment)} ` +
          `but the emitted document for ${JSON.stringify(dest)} contains no id=${JSON.stringify(link.fragment)}`,
      });
    }
  }
}

/**
 * Run the full step-7 validation over the emitted documents and return the
 * collected diagnostics, sorted (the caller folds them into its pool; a
 * BuildError re-sorts, so determinism holds either way). Never throws.
 */
export function validatePages(options: ValidationOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const severity = linkSeverity(options.mode);

  // Every emitted page's ids, once per page (plan §4.7: fragments are
  // checked against the ids collected from the final emitted HTML).
  const ids = new Map<string, ReadonlySet<string>>();
  for (const page of options.pages) ids.set(page.route, collectIds(page.html));

  for (const page of options.pages) {
    // A draft page is emitted in DEV only. A production build feeds this
    // function no drafts (they are not rendered); if one slips through
    // anyway, skip it WHOLE — its links are not validated in a build, and
    // its metadata would fail a page that is never published (a false
    // error). In dev the draft is genuinely served, so it is checked like
    // any page.
    if (options.mode === "build" && options.routes.get(page.route)?.draft === true) continue;

    validateMetadata(page, out);
    for (const link of page.links) validateLink(page, link, options.routes, ids, severity, out);
  }
  return sortDiagnostics(out);
}
