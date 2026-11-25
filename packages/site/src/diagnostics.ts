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
  // render.* — the template value contract (plan §1: "never a false pass,
  // never a silent coercion"). All render.bad-value; the message says what
  // the value was. A value we cannot name a safe rendering for is a build
  // error, full stop — true/NaN/Infinity/thenables/Symbol/bigint/functions/
  // objects throw BEFORE any toString/valueOf is invoked.
  "render.bad-value": "render.bad-value",
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
