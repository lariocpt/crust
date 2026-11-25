// Diagnostics: the closed code vocabulary (plan §5) and the error that carries
// them.
//
// Codes are `namespace.name` strings in ONE frozen registry. The registry is
// the single source of truth: adding a code is exactly one line, and codes are
// never repurposed or removed (contractVersion rules — a rename is a major).
// Later chunks append their namespaces here (asset.*, link.*, render.*,
// output.*, dev.*) without touching anything else.
//
// Every diagnostic produced by the package must use a code from this registry;
// `isDiagnostic` checks membership, so a typo'd code fails loudly instead of
// reaching users as an unknown string.

export type Severity = "error" | "warning";

/**
 * The closed v1 code vocabulary. One line per code; the key and the value are
 * the same string so the registry doubles as the runtime validator.
 */
export const DiagnosticCodes = Object.freeze({
  "config.unknown-key": "config.unknown-key",
  "config.site": "config.site",
  "config.layout-type": "config.layout-type",
  "config.asset-name-clash": "config.asset-name-clash",
  "config.asset-name": "config.asset-name",
  "config.output-overlap": "config.output-overlap",
  "config.port": "config.port",
  // The config FILE itself could not be loaded: the dynamic import threw, or
  // the default export is not a defineSite() result. Distinct from every
  // config.* validation code — those mean "the config loaded and is wrong";
  // this means "there is no config to validate".
  "config.load": "config.load",
  // A known key whose value has the wrong type/shape. Distinct from
  // config.unknown-key (the key itself is not in the schema) and from the
  // specific codes above; crust rule 1 — a wrong-typed value must be an error
  // at validation time, never a crash (or a silent pass) three steps later.
  "config.type": "config.type",
  "route.invalid": "route.invalid",
  "route.query-fragment": "route.query-fragment",
  "route.traversal": "route.traversal",
  "route.shape": "route.shape",
  "route.case-collision": "route.case-collision",
  "route.duplicate": "route.duplicate",
  "frontmatter.missing": "frontmatter.missing",
  "frontmatter.not-mapping": "frontmatter.not-mapping",
  "frontmatter.duplicate-key": "frontmatter.duplicate-key",
  "frontmatter.unknown-key": "frontmatter.unknown-key",
  "frontmatter.missing-title": "frontmatter.missing-title",
  "frontmatter.bad-value": "frontmatter.bad-value",
  // The block is delimited but is not parseable YAML at all (not even a
  // partial mapping). Distinct from frontmatter.not-mapping, which means
  // "parsed fine, but it is not a mapping" — conflating them would tell the
  // user their document has the wrong shape when it has a syntax error.
  "frontmatter.parse-error": "frontmatter.parse-error",
  // description was absent and derived from the first paragraph; the message
  // carries the derived value (plan §2 — a warning, not an error).
  "frontmatter.derived-description": "frontmatter.derived-description",
  // description was absent AND there was no text to derive from (empty body,
  // or a first paragraph without text). The description stays "" and the
  // page is otherwise legal — a warning, never an error. Distinct from
  // derived-description: claiming a derivation that did not happen would be
  // a false report (crust rule 1).
  "frontmatter.missing-description": "frontmatter.missing-description",
  // The content directory produced no NON-DRAFT pages: a production build
  // would emit no content pages (only the generated 404 page). Suspicious
  // but legal (a drafts-only site is a legitimate dev state) — a warning,
  // never an error. The message distinguishes "zero pages at all" from
  // "N drafts, zero production".
  "content.no-pages": "content.no-pages",
  // content.parseData threw, or returned something that is not a plain
  // object. The thrown Error's message is folded into this diagnostic.
  "frontmatter.data-invalid": "frontmatter.data-invalid",
  // Neither frontmatter `route` nor content.route produced a route for the
  // page. Distinct from route.invalid (a route EXISTS but is malformed).
  "route.missing": "route.missing",
  // frontmatter.layout (or defaultLayout) names a key that is not in the
  // layouts registry; the message names the page and the available keys.
  "layout.unknown": "layout.unknown",
  // A markdown link/image destination failed the URL policy (url.ts), or an
  // internal .md target is not a valid route shape. The offending
  // destination is stripped from the emitted markup, so the output is inert
  // even if the build is continued past the error.
  "link.invalid": "link.invalid",
  // markdown-it itself threw while rendering (it is otherwise error-tolerant
  // and treats almost everything as text). Line is in FULL-FILE coordinates.
  "markdown.parse-error": "markdown.parse-error",
  // render.* — the template value contract (plan §1: "never a false pass,
  // never a silent coercion"). All render.bad-value; the message says what
  // the value was. A value we cannot name a safe rendering for is a build
  // error, full stop — true/NaN/Infinity/thenables/Symbol/bigint/functions/
  // objects throw BEFORE any toString/valueOf is invoked.
  "render.bad-value": "render.bad-value",
  // The layout function returned (or a Promise resolved to) something that
  // is not an Html, without throwing. Page-attributed; the page's render is
  // aborted (no output) while the rest of the build pass continues.
  "render.bad-result": "render.bad-result",
  // The layout — or the engine's own render/fence stage — threw something
  // that is not a diagnostic. The message carries the error's message AND
  // its stack; the page's render is aborted, the pass never crashes.
  "render.threw": "render.threw",
  // head() called a SECOND time within one render. The second call emits
  // nothing (the document already has its title/canonical) and this
  // diagnostic is what fails the build (plan §3: "a build error diagnostic,
  // not a throw") — the page still renders.
  "head.duplicate": "head.duplicate",
  // public-asset.* — the public-directory URL helper (render chunk). The
  // argument is a FILE PATH, not a URL: it is never percent-decoded (%2e%2e
  // is a literal filename), so the only traversal vectors are literal ones.
  // Any of `..` segments, a leading "/", a backslash, a drive letter, NUL
  // or an empty path is rejected BEFORE any filesystem access; the
  // normalized path is recorded for the emitter's existence check.
  "public-asset.traversal": "public-asset.traversal",
  // The emitter's existence check (chunk 7, promised by public-asset.traversal
  // and the render.ts publicDir contract): a path a layout recorded via
  // publicAsset() is not a readable file under assets.publicDirectory — the
  // page would publish a dead reference (crust rule 1), so this is an error.
  // No publicDirectory configured makes EVERY recorded path missing.
  "public-asset.missing": "public-asset.missing",
  // readText.* — the config-directory text reader (render chunk). The
  // confinement contract: root = REALPATH of the config directory; the
  // FINAL realpath must stay inside it (a symlink never extends a
  // boundary); 10 MiB size cap; strict UTF-8.
  // A path that escapes the root — either a literal traversal rejected
  // BEFORE resolution (absolute, `..`, NUL, backslash, drive letter) or a
  // resolution (a symlink or component) whose realpath lands outside — is
  // read-text.escape; the message says which stage caught it.
  "read-text.escape": "read-text.escape",
  // The file is larger than the 10 MiB cap (checked via stat BEFORE the
  // bytes are read). A file of EXACTLY the cap is legal.
  "read-text.toobig": "read-text.toobig",
  // The path stayed inside the root but is not a readable text file:
  // missing, a directory, unreadable, or not valid UTF-8 — the message
  // says which.
  "read-text.failed": "read-text.failed",
  // fence.* — the post-render document fence (chunk 3). Every violation is
  // collected; finalizeDocument wraps them in one BuildError.
  "fence.script-body": "fence.script-body",
  "fence.style-body": "fence.style-body",
  "fence.comment-value": "fence.comment-value",
  "fence.dynamic-tag-name": "fence.dynamic-tag-name",
  "fence.dynamic-attr-name": "fence.dynamic-attr-name",
  "fence.event-handler": "fence.event-handler",
  "fence.unquoted-attribute": "fence.unquoted-attribute",
  "fence.unterminated": "fence.unterminated",
  "fence.url-attribute": "fence.url-attribute",
  "fence.ping-attr": "fence.ping-attr",
  "fence.srcdoc-attr": "fence.srcdoc-attr",
  // asset.* — the bundling pipeline (chunk 5, plan §4.2/§4.5). Exactly ONE
  // emitted file per declared entrypoint is the invariant.
  // entrypoint produced several files (imported assets, real chunks) — v1
  // emits exactly one hashed file per entrypoint and refuses the rest.
  "asset.entrypoint-chunked": "asset.entrypoint-chunked",
  // Bun.build failed (thrown or returned failure) or emitted zero / an
  // unrecognizable file; the bundler's own messages are folded in.
  "asset.bundle-failed": "asset.bundle-failed",
  // assets.publicDirectory is configured but unusable (absent, not a dir).
  "asset.public-missing": "asset.public-missing",
  // A symbolic link inside assets.publicDirectory. Never copied (a symlink
  // could publish an arbitrary host tree or recurse forever — the package-wide
  // "symlinks don't extend a boundary" rule) and never silently skipped (the
  // author put the file there expecting it published — a silent skip is a
  // false pass, crust rule 1). Always an error.
  "asset.public-symlink": "asset.public-symlink",
  // script()/stylesheet() name (or any manifest lookup) not declared in
  // assets.scripts/assets.styles — a map-key typo is a build error, never a
  // silently missing tag (plan §5).
  "asset.unknown-entrypoint": "asset.unknown-entrypoint",
  // A declared asset that no rendered page ever passed to script() or
  // stylesheet() — declared but dead. A WARNING (not an error): the asset
  // bundles and emits fine, the author simply never referenced it.
  "asset.unused": "asset.unused",
  // output.* — emit-time collisions (chunk 5 provides the detector, chunk 6
  // runs it): a public file that would overwrite a generated file.
  "output.collision": "output.collision",
  // A discovered .md file could not be read at parse time (it vanished between
  // discovery and reading, is unreadable, …). The file was FOUND by discovery,
  // so silence here would be a false pass (crust rule 1) — always an error.
  "content.read-failed": "content.read-failed",
  // Defense in depth (chunk 7): a resolved write path left the staging
  // directory. Routes are normalized long before emit, so this can only fire
  // on an internal bug — but a write outside staging would escape the atomic
  // publish contract, so it is caught at the write itself, never trusted to
  // the upstream normalization.
  "output.escape": "output.escape",
  // build.* — the per-output build lock (chunk 7, emit.ts): a concurrent
  // build of the same output is REFUSED rather than interleaving its
  // publish renames with the holder's (a measured false-pass race: the
  // second build's output rolled back by the first's restore while the
  // second reported success). The message names the live holder's pid;
  // dead holders' locks are reclaimed automatically, so a killed build
  // never blocks the output forever.
  "build.busy": "build.busy",
  // url.* — the URL policy (plan §1 url()): pre-parse rejects, scheme
  // allowlist, host/userinfo rules. Thrown by validateUrl; the fence quotes
  // the reason when a tracked value fails it (fence.url-attribute).
  "url.control-char": "url.control-char",
  "url.bad-char": "url.bad-char",
  "url.entity-escape": "url.entity-escape",
  "url.protocol-relative": "url.protocol-relative",
  "url.scheme": "url.scheme",
  "url.no-host": "url.no-host",
  "url.userinfo": "url.userinfo",
} as const);

/** Every valid diagnostic code, as a union of the registry's strings. */
export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes];

/**
 * One located problem. `sourcePath` is always posix and relative to the
 * project root (plan, Windows table: "sourcePath in diagnostics always posix").
 * `line`/`column` are 1-based and in the coordinates of the file named.
 */
export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  severity: Severity;
  sourcePath?: string;
  line?: number;
  column?: number;
}

/** Runtime guard for values thrown/collected as diagnostics. */
export function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.code === "string" &&
    Object.hasOwn(DiagnosticCodes, d.code) &&
    typeof d.message === "string" &&
    (d.severity === "error" || d.severity === "warning")
  );
}

/**
 * Code-unit lexicographic compare. Deliberately NOT `localeCompare`: that is
 * locale COLLACTION (ICU data + the process's default locale), so two
 * machines can order the same strings differently — measured: en collation
 * orders "ab.md" before "aB.md" (case is a secondary key), while code units
 * order "aB.md" (0x42) before "ab.md" (0x61). A locale-dependent order would
 * break the byte-identical-rebuild guarantee (plan §4.6) across machines;
 * code-unit order is the locale-free meaning of "lexicographic".
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministic order: sourcePath, then line, then code. Diagnostics that tie
 * on all three keep their input order (Array#sort is stable), so a build's
 * output is byte-reproducible (plan §4.6).
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const p = compareStrings(a.sourcePath ?? "", b.sourcePath ?? "");
    if (p !== 0) return p;
    const l = (a.line ?? -1) - (b.line ?? -1);
    if (l !== 0) return l;
    return compareStrings(a.code, b.code);
  });
}

function summarize(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return `site build failed: ${parts.join(" and ") || "no diagnostics"}`;
}

/**
 * The failed-build carrier (plan §5): a failed build rejects with a BuildError
 * holding ALL collected diagnostics, already sorted. Construction sorts, so no
 * call site can leak an unordered list.
 */
export class BuildError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[], message?: string) {
    const sorted = sortDiagnostics(diagnostics);
    super(message ?? summarize(sorted));
    this.name = "BuildError";
    this.diagnostics = sorted;
  }
}
