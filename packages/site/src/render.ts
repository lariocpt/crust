// The layout render engine (plan §3 "Layout context", §4.6 determinism).
//
// A page is rendered by its Layout: a plain function that receives a
// LayoutContext and returns an Html (or a Promise resolving to one). The
// context is where the safety model lives:
//
//   - `page`    — a DEEP-FROZEN view of the page (every mutation throws in
//                 strict mode). Containers (headings/data/links/warnings/
//                 diagnostics) are shallow-COPIED into the view before
//                 freezing, so the route table's own page object keeps its
//                 original, still-mutable containers (later chunks may
//                 append to them); shared leaves (the records, the body
//                 Html node) are frozen in place — they are immutable by
//                 construction and Object.freeze is idempotent.
//   - `content` — the page's rendered markdown body (trustedHtml: its value
//                 ranges are already handed to the fence).
//   - `site`    — { url }: the site's base URL (path prefix included).
//
// The PER-RENDER head sink (plan §3 — this fixes the "dedup vs pure
// function" contradiction): every Layout(ctx) invocation gets a FRESH state
// object; head()/stylesheet()/script()/url()/publicAsset()/readText() close
// over it, so first-call-vs-repeat dedup is plain per-render state, and
// concurrent renders are isolated by construction (no module-level state is
// read or written by the engine — a layout that keeps its OWN module-level
// state across renders is an author hazard, documented here, not policed).
// When the render finishes the sink is CLOSED: any helper called afterwards
// (a captured ctx used late) throws — plan §3 "calling outside a render
// throws". A helper promise the layout never AWAITED is the author's hazard,
// and the engine stays honest about it two ways: a readText still pending when
// the render returned cannot retroactively change the finished result (its
// realpath lands on the closed, already-collected sink — never on a later
// page's), and if it then fails, the rejection surfaces UNHANDLED rather than
// being swallowed here. Swallowing it would turn a real failure into a silent
// pass (crust rule 1), so the loud crash is the intended behaviour.
//
// Helper semantics (pinned by tests/render.test.ts):
//   - head()       emits EXACTLY seven tags, LF-joined, no trailing newline:
//                 <title>, description meta, canonical link, og:title,
//                 og:description, og:url, og:type=website (property=
//                 namespace). Every value goes through the html runtime's
//                 ONE escaper, so a title with `"` or a newline can never
//                 break its attribute (a raw newline inside a QUOTED
//                 attribute is legal HTML and is kept as-is). It NEVER emits
//                 charset/viewport — the layout hand-writes those (the
//                 validation step, chunk 7, errors if they are missing).
//                 A SECOND head() call emits nothing and records
//                 head.duplicate — a build-error diagnostic, NOT a throw
//                 (plan §3); the page still renders.
//                 NO LENGTH CAP in v1: title and description are emitted
//                 verbatim (the plan floated 128/200 as a minor idea). The
//                 decision is to ship none: silently truncating metadata is
//                 the kind of quiet rewrite crust rule 1 dislikes, and a
//                 too-long <title> is a style problem for the metadata
//                 validation pass (chunk 7), where a WARNING can name the
//                 page, rather than a silent cut here.
//   - stylesheet()/script() share ONE dedup namespace, mirroring the config's
//                 single asset namespace (config.ts rejects a name declared
//                 in both maps). The FIRST call for a name emits the tag;
//                 repeats emit nothing. The tag's KIND follows the MANIFEST
//                 ENTRY'S EXTENSION (`.js` → `<script defer>`, `.css` →
//                 `<link rel="stylesheet">`), never which helper was called:
//                 the manifest is the one source of truth for what the
//                 asset's bytes are, and a helper/ext mismatch (a
//                 stylesheet() on a JS entry) must never silently emit a
//                 broken tag — it emits the tag the bytes require. An
//                 unknown name records asset.unknown-entrypoint (page-
//                 attributed) and ABORTS this page's render.
//   - Asset URLs are ABSOLUTE against the site (`site + "/" + file`, prefix
//                 included) so a path-prefixed site (GH Pages `/docs/`)
//                 serves them correctly; for a prefix-less site this is
//                 exactly the root-absolute `/assets/…` form.
//   - url() wraps validateUrl with the PAGE as base: the full site URL
//                 (prefix included) is the base, so relative refs resolve
//                 against `site + route` — which is EXACTLY the page's
//                 canonical URL (url.ts `urlBase({siteUrl, pageRoute}) ===
//                 canonicalUrl(site, route)`, pinned by tests). A bare origin
//                 would drop the prefix, and pages.ts/markdown.ts use the
//                 same full-site base for the same reason. The cross-origin
//                 re-check still uses the site's ORIGIN. On failure: record
//                 (page-attributed) + abort.
//   - publicAsset(path) is a PATH, not a URL: never percent-decoded,
//                 posix-normalized; literal traversal (`..` segments,
//                 leading "/", backslashes, drive letters, NUL, empty) is
//                 rejected before any filesystem access
//                 (public-asset.traversal). The normalized path is recorded
//                 for the emitter's existence check (chunk 7).
//   - readText(path) — the confinement contract: root = REALPATH of the
//                 config directory; absolute/`..`/NUL/backslash/drive
//                 rejected before resolution, then resolve → REALPATH →
//                 the result must stay inside the root (a symlink never
//                 extends a boundary; a missing file is read-text.failed,
//                 NOT an escape — the path stayed inside, there is just
//                 nothing there); 10 MiB cap checked via stat before
//                 reading; strict UTF-8. The final realpath lands in the
//                 render's dependency set (chunk 8's dev invalidation
//                 consumes it).
//
// Failure semantics (crust rule 1 — never a false pass, never a crash):
//   - a helper failure records a PAGE-ATTRIBUTED diagnostic and aborts
//     THIS page's render only (the result's html is null); renderAll
//     continues with the remaining pages;
//   - a layout that throws (or a Promise that rejects) → render.threw with
//     the error's message AND stack, page-attributed;
//   - a layout returning a non-Html (or a Promise resolving to one) →
//     render.bad-result;
//   - a fence violation from finalizeDocument → the fence diagnostics
//     (codes preserved) re-stamped with the page's sourcePath;
//   - renderPage and renderAll NEVER throw out of the engine.
//
// Determinism (plan §4.6): renderAll renders SEQUENTIALLY in lexicographic
// (code-unit) route order no matter what order the pages arrive in; every
// render gets a fresh sink; every returned list is sorted; all output is
// LF-only.

import { readFile, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { AssetManifest } from "./assets";
import { manifestLookup } from "./assets";
import type { RoutedPage } from "./content";
import {
  BuildError,
  compareStrings,
  type Diagnostic,
  isDiagnostic,
  sortDiagnostics,
} from "./diagnostics";
import { filesystemPath } from "./fs-path";
import { finalizeDocument, type Html, html, isHtml } from "./html";
import type { LayoutFn } from "./types";
import { validateUrl } from "./url";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * DeepReadonly: the type-level image of the deep freeze renderPage applies
 * to the page it hands a layout. Functions and primitives pass through
 * untouched; arrays and objects map to readonly counterparts (homomorphic
 * mapping, so private members survive).
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** The read-only page view a LayoutContext exposes. */
export type FrozenPage = DeepReadonly<RoutedPage>;

/**
 * What a layout receives. Everything is bound to ONE render: the sink
 * behind the helpers is created fresh for this Layout(ctx) invocation and
 * closed when the render finishes (a captured ctx used later throws).
 */
export interface LayoutContext {
  /** The page, deep-frozen: every mutation throws in strict mode. */
  readonly page: FrozenPage;
  /** The rendered markdown body of the page (value ranges already tracked). */
  readonly content: Html;
  /** The site's base URL (may carry a path prefix). */
  readonly site: Readonly<{ readonly url: string }>;
  /**
   * The head block: <title>, description meta, canonical, og:title,
   * og:description, og:url, og:type — in that order, LF-joined, all values
   * escaped. NEVER emits charset/viewport (the layout writes those). A
   * second call in this render emits nothing and records head.duplicate.
   */
  head(): Html;
  /**
   * The stylesheet tag for the manifest entry `name`
   * (<link rel="stylesheet" href="…">). First call per name per render
   * emits the tag, repeats emit nothing. The tag's kind follows the
   * entry's extension. Unknown name: asset.unknown-entrypoint + abort.
   */
  stylesheet(name: string): Html;
  /** Same as stylesheet() for scripts (<script defer src="…"></script>). */
  script(name: string): Html;
  /**
   * Validate a URL against the policy, resolving relative refs against
   * THIS page (site + route, prefix included). Returns the value unchanged
   * when valid; records the policy diagnostic (page-attributed) and aborts
   * the page's render when invalid.
   */
  url(value: string): string;
  /**
   * The public file's URL: site + "/" + posix-normalized path. Literal
   * traversal (`..`, leading "/", backslash, drive letter, NUL, empty) is
   * rejected (public-asset.traversal) and aborts the page's render. The
   * normalized path is recorded for the emitter's existence check.
   */
  publicAsset(path: string): string;
  /**
   * Read a text file under the config directory with the confinement
   * contract (realpath must stay inside realpath(configDir); 10 MiB cap;
   * strict UTF-8; the realpath is recorded as a render dependency).
   * Failures record a readText.* diagnostic (page-attributed) and abort
   * the page's render.
   */
  readText(path: string): Promise<string>;
}

/** A layout: a function of the render context. */
export type Layout = (ctx: LayoutContext) => Html | Promise<Html>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One page's render result. `html` is null when the render was aborted. */
export interface PageRender {
  /** The deep-frozen page view the layout saw. */
  readonly page: FrozenPage;
  /** The final fenced document, or null when the render was aborted. */
  readonly html: string | null;
  /** Every diagnostic recorded during this render, sorted. */
  readonly diagnostics: Diagnostic[];
  /** readText realpaths (posix, absolute), sorted and unique. */
  readonly deps: string[];
  /** publicAsset paths (posix, output-root-relative), sorted and unique. */
  readonly publicAssets: string[];
  /** The manifest names this page actually emitted tags for, sorted. */
  readonly usedAssets: Readonly<{
    readonly scripts: string[];
    readonly styles: string[];
  }>;
}

/** renderPage options (the shape chunk 7's emitter reuses). */
export interface RenderPageOptions {
  /** The page with its final route, canonical URL, and resolved layout. */
  readonly page: RoutedPage;
  /** The site's base URL (prefix included, no trailing slash). */
  readonly site: string;
  readonly manifest: AssetManifest;
  readonly layouts: Readonly<Record<string, LayoutFn>>;
  /** The config directory; realpath'd to form the readText root. */
  readonly configDir: string;
  /**
   * The public directory. renderPage itself does not touch it (it only
   * normalizes and records publicAsset paths); the emitter (chunk 7)
   * verifies each recorded path exists under it.
   */
  readonly publicDir?: string;
}

/** renderAll options (everything renderPage needs except the page). */
export interface RenderAllOptions {
  readonly site: string;
  readonly manifest: AssetManifest;
  readonly layouts: Readonly<Record<string, LayoutFn>>;
  readonly configDir: string;
  readonly publicDir?: string;
}

/** Everything a render pass produced, plus the cross-page asset audit. */
export interface RenderAllResult {
  /** One render per input page, in lexicographic route order. */
  readonly pages: PageRender[];
  /**
   * asset.unused warnings: manifest names no page ever referenced (one per
   * name, sorted). A warning, never an error (plan §5).
   */
  readonly unusedAssets: Diagnostic[];
}

// ---------------------------------------------------------------------------
// The per-render sink
// ---------------------------------------------------------------------------

/**
 * The render-scoped state object (plan §3): created fresh for every
 * Layout(ctx) invocation, closed when the render finishes, referenced by no
 * other render. Dedup is plain state on it; nothing here is module-level.
 */
interface Sink {
  closed: boolean;
  page: FrozenPage;
  siteUrl: string;
  pageRoute: string;
  manifest: AssetManifest;
  diagnostics: Diagnostic[];
  deps: Set<string>;
  publicAssets: Set<string>;
  usedScripts: Set<string>;
  usedStyles: Set<string>;
  /** name → the tag the first call emitted (dedup memory). */
  assetTags: Map<string, Html>;
  headEmitted: boolean;
}

function createSink(page: FrozenPage, siteUrl: string, manifest: AssetManifest): Sink {
  return {
    closed: false,
    page,
    siteUrl,
    pageRoute: page.route,
    manifest,
    diagnostics: [],
    deps: new Set(),
    publicAssets: new Set(),
    usedScripts: new Set(),
    usedStyles: new Set(),
    assetTags: new Map(),
    headEmitted: false,
  };
}

/**
 * The abort marker helpers throw (a helper failure must end THIS page's
 * render, not crash the pass). The diagnostic is already recorded on the
 * sink; the marker only exists to unwind the layout call.
 */
class RenderAbort extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super("render aborted");
    this.name = "RenderAbort";
    this.diagnostics = diagnostics;
  }
}

/** Record a diagnostic and abort the page's render (never returns). */
function abort(sink: Sink, diagnostic: Diagnostic): never {
  sink.diagnostics.push(diagnostic);
  throw new RenderAbort([diagnostic]);
}

/** A helper called after the render finished is a loud throw (plan §3). */
function requireOpen(sink: Sink): void {
  if (!sink.closed) return;
  throw new Error(
    "layout context is closed: head()/stylesheet()/script()/url()/publicAsset()/" +
      "readText() may only be called while the page is rendering — a captured " +
      "LayoutContext is not valid after the render finished",
  );
}

function emptyHtml(): Html {
  return html``;
}

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

/**
 * The per-render head block, EXACTLY (plan §3): <title>, description meta,
 * canonical link, og:title, og:description, og:url, og:type=website — in
 * that order, LF-joined, no trailing newline. Every value is interpolated
 * through the html runtime, so it goes through the ONE escaper: a title
 * with `"`, `<`, `>` or `&` is neutralized, and a newline inside a QUOTED
 * attribute is legal HTML (kept as-is, cannot break the attribute).
 * og:type is the only static value.
 */
function head(sink: Sink): Html {
  requireOpen(sink);
  if (sink.headEmitted) {
    sink.diagnostics.push({
      code: "head.duplicate",
      severity: "error",
      sourcePath: sink.page.sourcePath,
      message:
        `head() was called a second time for page ${JSON.stringify(sink.page.sourcePath)}; ` +
        "only the first call emits — v1 expects exactly one <title>, one description and one canonical per document",
    });
    return emptyHtml();
  }
  sink.headEmitted = true;
  const { title, description, canonicalUrl } = sink.page;
  return html`<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="website">`;
}

/**
 * The shared-namespace asset tag (see the module header for the pinned
 * decisions: one dedup namespace mirroring the config's, tag kind follows
 * the manifest entry's extension, URLs absolute against the site).
 */
function assetTag(sink: Sink, name: string): Html {
  requireOpen(sink);
  if (typeof name !== "string") {
    abort(sink, {
      code: "asset.unknown-entrypoint",
      severity: "error",
      sourcePath: sink.page.sourcePath,
      message:
        `script()/stylesheet() require a string asset name, ` +
        `received ${name === null ? "null" : typeof name}`,
    });
  }
  const cached = sink.assetTags.get(name);
  if (cached !== undefined) return emptyHtml();
  const lookup = manifestLookup(sink.manifest, name);
  if (!lookup.found) {
    abort(sink, { ...lookup.diagnostic, sourcePath: sink.page.sourcePath });
  }
  const file = lookup.entry.file;
  const url = `${sink.siteUrl}/${file}`;
  const isJs = file.endsWith(".js");
  const tag = isJs
    ? html`<script defer src="${url}"></script>`
    : html`<link rel="stylesheet" href="${url}">`;
  sink.assetTags.set(name, tag);
  if (isJs) sink.usedScripts.add(name);
  else sink.usedStyles.add(name);
  return tag;
}

/**
 * The URL policy under the ctx name (plan §1 url()). The base is the FULL
 * site URL (path prefix included) — validateUrl resolves relative refs
 * against it and re-checks the ORIGIN — so a prefixed site (GH Pages
 * /docs/) resolves relative refs correctly; passing a bare origin would
 * silently drop the prefix. On failure the policy diagnostic is re-stamped
 * to the page and the page's render aborts.
 */
function url(sink: Sink, value: string): string {
  requireOpen(sink);
  if (typeof value !== "string") {
    abort(sink, {
      code: "url.scheme",
      severity: "error",
      sourcePath: sink.page.sourcePath,
      message: `url() requires a string, received ${value === null ? "null" : typeof value}`,
    });
  }
  try {
    return validateUrl(value, { siteUrl: sink.siteUrl, pageRoute: sink.pageRoute });
  } catch (d) {
    if (!isDiagnostic(d)) throw d;
    abort(sink, { ...d, sourcePath: sink.page.sourcePath });
  }
}

/**
 * The public-file URL (see the module header for the pinned rules). The
 * argument is a PATH — never percent-decoded — so traversal is judged on
 * the literal text and rejected before any resolution.
 */
// Function DECLARATION (not a const arrow) on purpose: TypeScript's
// control-flow analysis only treats a call to a never-returning function
// declaration as a terminator — a `const f = (): never => …` is not, which
// would make every `if (bad) fail(…)` below an unproven branch.
function publicAssetReject(sink: Sink, path: string, reason: string): never {
  return abort(sink, {
    code: "public-asset.traversal",
    severity: "error",
    sourcePath: sink.page.sourcePath,
    message: `publicAsset(${JSON.stringify(String(path))}): ${reason}`,
  });
}

function publicAsset(sink: Sink, path: string): string {
  requireOpen(sink);
  if (typeof path !== "string") {
    publicAssetReject(sink, path, `must be a path string, received ${typeof path}`);
  }
  if (path === "") publicAssetReject(sink, path, "the path is empty");
  if (path.includes("\0")) publicAssetReject(sink, path, "contains a NUL character");
  if (path.includes("\\")) publicAssetReject(sink, path, "contains a backslash (paths are posix)");
  if (/^[A-Za-z]:/.test(path)) publicAssetReject(sink, path, "is a Windows drive-letter path");
  if (path.startsWith("/")) publicAssetReject(sink, path, "is absolute (a leading /)");
  if (path.split("/").includes("..")) publicAssetReject(sink, path, "contains a `..` segment");
  const normalized = posix.normalize(path);
  // Backstop (unreachable after the checks above): the normalized path must
  // be a plain relative path inside the public directory.
  if (normalized === ".." || normalized.startsWith("../")) {
    publicAssetReject(sink, path, "normalizes to a path outside the public directory");
  }
  sink.publicAssets.add(normalized);
  return `${sink.siteUrl}/${normalized}`;
}

/** 10 MiB — the readText size cap (plan §1). A file of EXACTLY the cap is legal. */
const READ_TEXT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The confinement contract (see the module header for the full story):
 * reject before resolution (absolute, `..`, NUL, backslash, drive letter —
 * all read-text.escape), resolve → REALPATH → containment (a symlink that
 * leaves the root is read-text.escape; a missing file is read-text.failed —
 * the path stayed inside, there is just nothing there), stat → isFile and
 * size cap, read → strict UTF-8. The final realpath is recorded in the
 * render's dependency set (chunk 8's dev invalidation consumes it).
 */
// Function DECLARATION (not a const arrow) on purpose: TypeScript's
// control-flow analysis only treats a call to a never-returning function
// declaration as a terminator — a `const f = (): never => …` is not, which
// would make `let x; try { x = … } catch { fail(…); }` an "x may be
// unassigned" error (and, worse, paper over the never-guarantee).
function readTextFail(
  sink: Sink,
  path: string,
  code: "read-text.escape" | "read-text.toobig" | "read-text.failed",
  reason: string,
): never {
  return abort(sink, {
    code,
    severity: "error",
    sourcePath: sink.page.sourcePath,
    message: `readText(${JSON.stringify(String(path))}): ${reason}`,
  });
}

async function readText(sink: Sink, root: string, path: string): Promise<string> {
  requireOpen(sink);
  if (typeof path !== "string") {
    readTextFail(sink, path, "read-text.escape", `must be a path string, received ${typeof path}`);
  }
  if (path.includes("\0")) readTextFail(sink, path, "read-text.escape", "contains a NUL character");
  if (path.includes("\\"))
    readTextFail(sink, path, "read-text.escape", "contains a backslash (paths are posix)");
  if (/^[A-Za-z]:/.test(path))
    readTextFail(sink, path, "read-text.escape", "is a Windows drive-letter path");
  if (path.startsWith("/")) {
    readTextFail(
      sink,
      path,
      "read-text.escape",
      "is absolute (readText reads under the config directory only)",
    );
  }
  if (path.split("/").includes(".."))
    readTextFail(sink, path, "read-text.escape", "contains a `..` segment");

  const target = filesystemPath.join(root, posix.normalize(path));
  let resolved: string;
  try {
    // toPosix on BOTH sides: on Windows realpath returns backslashes, and the
    // containment test below is a posix prefix compare (see renderPage's root).
    resolved = toPosix(await realpath(target));
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    readTextFail(
      sink,
      path,
      "read-text.failed",
      errno === "ENOENT" ? "no such file or directory" : `cannot resolve (${errno ?? String(e)})`,
    );
  }
  // Containment: the FINAL realpath must stay inside the realpath'd root —
  // a symlink (or any component) that resolves outside is an escape,
  // because symlinks never extend a boundary (the package-wide rule).
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    readTextFail(
      sink,
      path,
      "read-text.escape",
      `resolves to ${JSON.stringify(toPosix(resolved))}, which is outside the root ` +
        `${JSON.stringify(toPosix(root))} (a symlink or path component leaves the boundary)`,
    );
  }
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(resolved);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    readTextFail(sink, path, "read-text.failed", `cannot stat (${errno ?? String(e)})`);
  }
  if (!st.isFile()) {
    readTextFail(sink, path, "read-text.failed", "resolves to a directory, not a regular file");
  }
  if (st.size > READ_TEXT_MAX_BYTES) {
    readTextFail(
      sink,
      path,
      "read-text.toobig",
      `${st.size} bytes exceeds the ${READ_TEXT_MAX_BYTES}-byte (10 MiB) cap`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    readTextFail(sink, path, "read-text.failed", `cannot read (${errno ?? String(e)})`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    readTextFail(sink, path, "read-text.failed", "is not valid UTF-8");
  }
  sink.deps.add(toPosix(resolved));
  return text;
}

// ---------------------------------------------------------------------------
// The frozen page view + the context
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function freezeTree(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return; // cycle: already frozen (or being frozen)
  seen.add(value);
  Object.freeze(value);
  // Recurse only into plain containers; class instances (a Date in data, a
  // custom object) are frozen but not entered — their internals are the
  // author's. Html nodes ARE plain objects: their literal/values arrays get
  // frozen too (the runtime only ever reads them — safe, idempotent).
  if (Array.isArray(value)) {
    for (const element of value) freezeTree(element, seen);
  } else if (isPlainObject(value)) {
    for (const element of Object.values(value)) freezeTree(element, seen);
  }
}

/**
 * Build the deep-frozen page view (see the module header for the
 * copy-containers/freeze-leaves strategy and why it matters).
 */
function freezePageView(page: RoutedPage): FrozenPage {
  const view: Record<string, unknown> = {
    ...page,
    headings: [...page.headings],
    data: { ...page.data },
    links: [...page.links],
    warnings: [...page.warnings],
    diagnostics: [...page.diagnostics],
  };
  freezeTree(view, new Set());
  return view as FrozenPage;
}

function makeContext(sink: Sink, root: string): LayoutContext {
  const ctx: LayoutContext = {
    page: sink.page,
    content: sink.page.body,
    site: Object.freeze({ url: sink.siteUrl }),
    head: () => head(sink),
    stylesheet: (name: string) => assetTag(sink, name),
    script: (name: string) => assetTag(sink, name),
    url: (value: string) => url(sink, value),
    publicAsset: (path: string) => publicAsset(sink, path),
    readText: (path: string) => readText(sink, root, path),
  };
  return Object.freeze(ctx);
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

function describeValue(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return `a ${t} ${JSON.stringify(value)}`;
  }
  if (t === "symbol") return "a symbol";
  if (t === "undefined") return "undefined";
  if (t === "function") return "a function";
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? `an object of type ${name}` : "an object";
}

/**
 * The thenable probe (html.ts contract: detected WITHOUT letting a throwing
 * .then getter escape — a getter failure means "cannot prove safe", which
 * falls through to the bad-result check below, which names it honestly).
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

/**
 * render.threw with the error's message AND stack (the message carries both).
 * `stage` is a complete subject phrase ("the layout", "the page freeze", …)
 * — the template adds no article of its own.
 */
function renderThrew(sourcePath: string, error: unknown, stage: string): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return {
    code: "render.threw",
    severity: "error",
    sourcePath,
    message:
      `${stage} for page ${JSON.stringify(sourcePath)} threw: ${message}` +
      (stack !== undefined ? `\n${stack}` : ""),
  };
}

/** render.bad-result naming what the layout actually returned. */
function badResult(sourcePath: string, result: unknown, wasPromise: boolean): Diagnostic {
  return {
    code: "render.bad-result",
    severity: "error",
    sourcePath,
    message:
      `the layout for page ${JSON.stringify(sourcePath)} ` +
      (wasPromise ? "returned a Promise that resolved to " : "returned ") +
      `${describeValue(result)}; a layout must return an Html ` +
      `(or a Promise that resolves to an Html)`,
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function collect(sink: Sink, page: FrozenPage, html: string | null): PageRender {
  return {
    page,
    html,
    diagnostics: sortDiagnostics(sink.diagnostics),
    deps: [...sink.deps].sort(compareStrings),
    publicAssets: [...sink.publicAssets].sort(compareStrings),
    usedAssets: {
      scripts: [...sink.usedScripts].sort(compareStrings),
      styles: [...sink.usedStyles].sort(compareStrings),
    },
  };
}

/**
 * Render ONE page. Never throws (crust rule 1: a page failure is a located
 * diagnostic on the result, and the build pass must continue); the sink is
 * closed before the result returns, so a captured ctx cannot outlive the
 * render.
 */
export async function renderPage(opts: RenderPageOptions): Promise<PageRender> {
  const page = opts.page;

  let frozen: FrozenPage;
  try {
    frozen = freezePageView(page);
  } catch (e) {
    // A hand-crafted page with a throwing getter. Object.freeze never
    // invokes accessors, so freezing the original in place is still safe.
    const fallback = Object.freeze(page) as FrozenPage;
    const sink = createSink(fallback, opts.site, opts.manifest);
    sink.diagnostics.push(renderThrew(page.sourcePath, e, "the page freeze"));
    sink.closed = true;
    return collect(sink, fallback, null);
  }

  const sink = createSink(frozen, opts.site, opts.manifest);
  let html: string | null = null;
  try {
    // Layout resolution. Chunk 4 (buildRouteTable) already validated the
    // name; this double-check keeps renderPage total for hand-built inputs.
    const layout = opts.layouts[page.layout];
    if (layout === undefined || typeof layout !== "function") {
      const available = Object.keys(opts.layouts).sort(compareStrings).join(", ");
      sink.diagnostics.push({
        code: "layout.unknown",
        severity: "error",
        sourcePath: page.sourcePath,
        message:
          layout === undefined
            ? `layout "${page.layout}" for page ${page.sourcePath} is not a key of the layouts registry (available: ${available})`
            : `layout "${page.layout}" for page ${page.sourcePath} is not a function`,
      });
      return collect(sink, frozen, null);
    }

    // The readText root: the REALPATH of the config directory (a symlinked
    // config dir must not be able to extend the boundary later). Normalized to
    // posix form: on Windows realpath hands back backslashes while every
    // comparison and join below is posix (the plan's Windows row: internal
    // paths are posix-normalized). A missing config dir is an engine-setup
    // failure, named as such (the layout never ran, so "the layout" would be
    // a false statement — crust rule 1).
    let root: string;
    try {
      root = toPosix(await realpath(opts.configDir));
    } catch (e) {
      sink.diagnostics.push(
        renderThrew(
          page.sourcePath,
          e,
          `the readText root (the config directory realpath ${JSON.stringify(toPosix(opts.configDir))})`,
        ),
      );
      return collect(sink, frozen, null);
    }
    const ctx = makeContext(sink, root);

    // The registry type (LayoutFn: (...args: never[]) => unknown) is an
    // erased-function placeholder that lets config.ts hold ANY function
    // shape; having checked it is a function above, cast to Layout to
    // call it with the render context.
    const run: Layout = layout as unknown as Layout;
    let result = run(ctx);
    const wasPromise = isThenable(result);
    if (wasPromise) result = await result;

    if (!isHtml(result)) {
      sink.diagnostics.push(badResult(page.sourcePath, result, wasPromise));
    } else {
      try {
        // The fence runs per page, with the page as base (prefix included,
        // so URL re-checks resolve like the author's url() calls do).
        html = finalizeDocument(result, { siteUrl: opts.site, pageRoute: page.route });
      } catch (e) {
        if (e instanceof BuildError) {
          // Fence violations: codes preserved, re-stamped to the page.
          for (const d of e.diagnostics)
            sink.diagnostics.push({ ...d, sourcePath: page.sourcePath });
        } else if (isDiagnostic(e)) {
          // A render.bad-value thrown by the html runtime mid-finalize.
          sink.diagnostics.push({ ...e, sourcePath: page.sourcePath });
        } else {
          sink.diagnostics.push(renderThrew(page.sourcePath, e, "the render/fence stage"));
        }
      }
    }
  } catch (e) {
    if (!(e instanceof RenderAbort)) {
      if (isDiagnostic(e)) {
        sink.diagnostics.push({ ...e, sourcePath: page.sourcePath });
      } else {
        sink.diagnostics.push(renderThrew(page.sourcePath, e, "the layout"));
      }
    }
    // A RenderAbort's diagnostic is already on the sink.
  } finally {
    sink.closed = true;
  }
  return collect(sink, frozen, html);
}

/**
 * Anything that carries per-page asset usage: a PageRender, or any later
 * document the pipeline renders after the content pages (chunk 7's generated
 * 404 page). The audit takes the LIST, not the render pass, so a caller can
 * feed it exactly the set of documents that will actually be emitted.
 */
export interface AssetUsage {
  readonly usedAssets: Readonly<{
    readonly scripts: readonly string[];
    readonly styles: readonly string[];
  }>;
}

/**
 * The cross-page asset audit: every manifest name that NO rendered document
 * ever passed to script()/stylesheet() becomes an `asset.unused` WARNING
 * (plan §5: a warning, never an error), one per name, sorted.
 *
 * Exported separately from renderAll because the audit must run over EVERY
 * emitted document: chunk 7 renders the generated 404 page after renderAll,
 * and an asset referenced only there is not unused. Callers pass the full
 * list (content pages + drafts excluded + the 404 render) — extra documents
 * are simply more inputs to the union, which is the point.
 *
 * Note a page whose render ABORTED still counts as having referenced what it
 * called before failing: an abort always carries an error diagnostic, so the
 * build fails anyway and the audit never gets to decide anything about a
 * build that is already dead.
 */
export function collectUnusedAssets(
  manifest: AssetManifest,
  renders: readonly AssetUsage[],
): Diagnostic[] {
  const used = new Set<string>();
  for (const r of renders) {
    for (const n of r.usedAssets.scripts) used.add(n);
    for (const n of r.usedAssets.styles) used.add(n);
  }
  const unusedAssets: Diagnostic[] = [];
  for (const name of [...manifest.keys()].sort(compareStrings)) {
    if (used.has(name)) continue;
    unusedAssets.push({
      code: "asset.unused",
      severity: "warning",
      sourcePath: "",
      message:
        `asset "${name}" is declared but referenced by no page ` +
        "(never passed to script() or stylesheet())",
    });
  }
  return unusedAssets;
}

/**
 * Render EVERY page: sequentially, in lexicographic (code-unit) route
 * order — the determinism contract (plan §4.6), re-sorted here regardless
 * of input order so the pass can never depend on how pages arrived. Each
 * page gets a fresh sink; module-level state inside a layout is the
 * author's hazard (it is not isolated, and two pages sharing it see each
 * other's writes). renderPage never throws; the guard below is the last
 * line of the "never crash the render pass" contract (an engine bug must
 * still surface as a page-attributed render.threw, not a rejected build).
 *
 * The result also carries the cross-page audit (collectUnusedAssets) over
 * exactly the pages this pass rendered; a caller that renders more documents
 * afterwards (chunk 7's 404 page) re-runs the audit over the full list.
 */
export async function renderAll(
  pages: readonly RoutedPage[],
  opts: RenderAllOptions,
): Promise<RenderAllResult> {
  const ordered = [...pages].sort(
    (a, b) => compareStrings(a.route, b.route) || compareStrings(a.sourcePath, b.sourcePath),
  );
  const rendered: PageRender[] = [];
  for (const page of ordered) {
    try {
      rendered.push(await renderPage({ ...opts, page }));
    } catch (e) {
      rendered.push({
        page: Object.freeze(page) as FrozenPage,
        html: null,
        diagnostics: [renderThrew(page.sourcePath, e, "the render engine")],
        deps: [],
        publicAssets: [],
        usedAssets: { scripts: [], styles: [] },
      });
    }
  }

  return { pages: rendered, unusedAssets: collectUnusedAssets(opts.manifest, rendered) };
}
