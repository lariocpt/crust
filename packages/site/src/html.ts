// The fenced template runtime (plan §1).
//
// A tagged template CANNOT enforce rules by inspecting the literal —
// `html\`<scr${"i"}pt>\`` defeats any literal check. The enforced design:
//
//   1. EVERY interpolated value is rendered through ONE escape function
//      (& < > " ' → entities, ampersand first), so a value can never
//      contribute a raw structural character to the document.
//   2. Each value's character range is recorded (recursively, through
//      arbitrary template nesting — a value interpolated three levels deep
//      is still tracked in the final document).
//   3. `finalizeDocument` runs the post-render fence (fence.ts) over
//      (final markup, merged ranges) and throws a BuildError on any
//      violation. The renderer (render chunk) calls it per page.
//
// Value semantics (render.bad-value, thrown BEFORE any toString/valueOf/
// toPrimitive is invoked — a hostile getter must never run):
//   string            → escaped
//   finite number     → String(n); `0` renders "0" (never falsy-dropped)
//   null/undefined/   → nothing (no range: an empty emission crosses no
//     false                     boundary)
//   Html              → the child's markup; its ranges are offset by the
//                       insertion point and merged in
//   arrays            → flattened recursively, joined with no separator
//   EVERYTHING ELSE   → render.bad-value: true, NaN, ±Infinity, Promises and
//     (true, NaN,      other thenables (detected WITHOUT letting a throwing
//     Infinity,         .then getter escape — the access is wrapped and a
//     Promise,          failure becomes the bad-value diagnostic), Symbol,
//     Symbol,           bigint, functions, class instances, plain objects.
//   Cycles            → a node that is its own ancestor in one render is a
//     (per-render        render.bad-value. A node used in TWO branches of the
//     seen-set)          same render (a diamond, e.g. an array rendered twice)
//                       is legal — values are resolved LIVE per render, so a
//                       shared array always shows its current contents.
//   Depth             → the root template is depth 0; a node at depth > 64
//                       is a render.bad-value.
//
// `trustedHtml(markup, ranges)` builds an Html from trusted internal markup
// (the markdown renderer, chunk 4, uses it to hand value ranges to the fence
// without re-escaping). It is exported from THIS module for internal use but
// deliberately NOT from index.ts.

import { BuildError, type Diagnostic } from "./diagnostics";
import { type Range, runFence } from "./fence";

/**
 * The brand. A REAL unique symbol (a `declare const` would be type-only and
 * vanish at runtime) that is never exported: a unique symbol is unnameable
 * outside this module, so no other module can stamp or inspect this
 * property, and a plain object cannot impersonate an Html.
 */
const htmlBrand = Symbol("crust-site.Html");

/**
 * The public opaque value type. Only `html` (and the internal `trustedHtml`)
 * produce one. Consumers treat it as an opaque token: interpolate it into
 * `html`, hand it to `renderToString`/`finalizeDocument`.
 */
export interface Html {
  readonly [htmlBrand]: never;
}

/** What template authors may interpolate. `true` is deliberately absent. */
export type HtmlValue = string | number | false | null | undefined | Html | readonly HtmlValue[];

/** The node behind an Html. `template` = a tagged-template capture; `trusted` = trustedHtml. */
type Node =
  | {
      readonly [htmlBrand]: true;
      readonly kind: "template";
      readonly literal: readonly string[];
      readonly values: readonly unknown[];
    }
  | {
      readonly [htmlBrand]: true;
      readonly kind: "trusted";
      readonly markup: string;
      readonly ranges: readonly Range[];
    };

function isHtml(value: unknown): value is Html {
  return typeof value === "object" && value !== null && Object.hasOwn(value, htmlBrand);
}

function nodeOf(html: Html): Node {
  const node = html as Html & Node;
  if (node.kind !== "template" && node.kind !== "trusted") {
    throw badValue("an impersonated Html value (a plain object is not an Html)");
  }
  return node;
}

function makeTemplateNode(literal: readonly string[], values: readonly unknown[]): Html {
  return { [htmlBrand]: true, kind: "template", literal, values } as unknown as Html;
}

function makeTrustedNode(markup: string, ranges: readonly Range[]): Html {
  return { [htmlBrand]: true, kind: "trusted", markup, ranges } as unknown as Html;
}

/**
 * The fenced template. Captures the literal and the RAW values; rendering
 * (escaping, range tracking, cycle/depth checks) happens lazily on each
 * top-level render, so a shared array always shows its current contents.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  return makeTemplateNode(strings, values);
}

/**
 * Escape the five HTML structural characters, in ONE pass. The single
 * character-class replace is what makes it safe: `&` is replaced before any
 * other character is touched, so the entities it emits are never re-escaped
 * (input `&amp;` → `&amp;amp;`, never `&amp;amp;amp;`), and no other
 * character can smuggle a raw `&` past the check.
 */
export function escapeHtml(value: string): string {
  // The map is the escape table: one entry per structural character. The
  // fallback is unreachable (the character class admits exactly these five)
  // but keeps the callback total.
  const TABLE: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
  };
  return value.replace(/[&<>"']/g, (ch) => TABLE[ch] ?? ch);
}

function badValue(message: string): Diagnostic {
  return {
    code: "render.bad-value",
    severity: "error",
    sourcePath: "",
    message: `template value rejected: ${message}`,
  };
}

function describe(value: unknown): string {
  try {
    if (value === null) return "null";
    const t = typeof value;
    if (t !== "object" && t !== "function") return `${t} ${JSON.stringify(value)}`;
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name !== "" ? `an object of type ${name}` : "an object";
  } catch {
    return "an object";
  }
}

interface Rendered {
  markup: string;
  ranges: Range[];
}

interface RenderCtx {
  /**
   * Nodes and arrays on the current render PATH (cycle detection). Path-based
   * (not global): the same value in TWO branches of one render (a diamond,
   * e.g. an array interpolated twice) is legal and rendered twice — only a
   * value that is its own ANCESTOR is rejected. Arrays are tracked too: an
   * array that contains itself (arr.push(arr)) must die with a diagnostic,
   * not a raw stack overflow.
   */
  seen: Set<unknown>;
  /** Per-render cache: a node is rendered at most once per top-level render. */
  memo: Map<Html, Rendered>;
}

const MAX_DEPTH = 64;

function renderNode(node: Html, depth: number, ctx: RenderCtx): Rendered {
  const memoized = ctx.memo.get(node);
  if (memoized) return memoized;
  if (ctx.seen.has(node)) {
    throw badValue(
      "a cycle in the Html value graph: a value is its own ancestor (shared arrays render live, cycles do not terminate)",
    );
  }
  if (depth > MAX_DEPTH) {
    throw badValue(`nesting depth ${depth} exceeds the cap of ${MAX_DEPTH}`);
  }
  ctx.seen.add(node);
  let rendered: Rendered;
  try {
    const shape = nodeOf(node);
    if (shape.kind === "trusted") {
      rendered = { markup: shape.markup, ranges: [...shape.ranges] };
    } else {
      const parts: string[] = [];
      const ranges: Range[] = [];
      let pos = 0;
      for (let i = 0; i < shape.values.length; i++) {
        parts.push(shape.literal[i]);
        pos += shape.literal[i].length;
        const len = renderValue(shape.values[i], depth + 1, ctx, pos, parts, ranges);
        pos += len;
      }
      parts.push(shape.literal[shape.values.length]);
      rendered = { markup: parts.join(""), ranges };
    }
  } finally {
    ctx.seen.delete(node);
  }
  ctx.memo.set(node, rendered);
  return rendered;
}

/**
 * Render one value. Appends its markup to `parts`, records its (escaped)
 * range in `ranges`, and returns the markup's length. Throws a
 * render.bad-value Diagnostic for anything that has no safe rendering.
 */
function renderValue(
  value: unknown,
  depth: number,
  ctx: RenderCtx,
  pos: number,
  parts: string[],
  ranges: Range[],
): number {
  if (value === null || value === undefined || value === false) {
    parts.push("");
    return 0;
  }
  switch (typeof value) {
    case "string": {
      const escaped = escapeHtml(value);
      parts.push(escaped);
      if (escaped.length > 0) ranges.push([pos, pos + escaped.length]);
      return escaped.length;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw badValue(
          `${value} is not renderable (non-finite numbers are rejected; render the number's meaning, not its type name)`,
        );
      }
      const text = String(value);
      parts.push(text);
      ranges.push([pos, pos + text.length]);
      return text.length;
    }
    case "boolean": {
      // false is handled above; only true reaches here
      throw badValue(
        "true is not renderable (false/null/undefined render as nothing; everything else must be named)",
      );
    }
    case "bigint":
      throw badValue(
        "a bigint is not renderable (convert it to a string or finite number explicitly)",
      );
    case "symbol":
      throw badValue("a symbol is not renderable");
    case "function":
      throw badValue(`${describe(value)} is not renderable`);
    case "object": {
      if (isHtml(value)) {
        const child = renderNode(value, depth, ctx);
        parts.push(child.markup);
        for (const r of child.ranges) ranges.push([pos + r[0], pos + r[1]]);
        return child.markup.length;
      }
      if (Array.isArray(value)) {
        // Flatten recursively, joined with no separator. Elements render at
        // the ARRAY'S depth (grouping does not add template depth) — but a
        // NESTED array does add one: without that increment, a pathological
        // 50k-deep array nesting is a raw RangeError (stack overflow)
        // instead of a render.bad-value diagnostic (crust rule 1: honest
        // failure, never an uncatchable crash).
        if (depth > MAX_DEPTH) {
          throw badValue(`array nesting depth ${depth} exceeds the cap of ${MAX_DEPTH}`);
        }
        if (ctx.seen.has(value)) {
          throw badValue(
            "a cycle in the Html value graph: an array is its own ancestor (shared arrays render live, cycles do not terminate)",
          );
        }
        ctx.seen.add(value);
        let len = 0;
        try {
          for (const element of value) {
            len += renderValue(
              element,
              Array.isArray(element) ? depth + 1 : depth,
              ctx,
              pos + len,
              parts,
              ranges,
            );
          }
        } finally {
          ctx.seen.delete(value);
        }
        return len;
      }
      // Thenable check WITHOUT letting a throwing getter escape: the .then
      // access is wrapped, and a failure here means "we cannot prove this is
      // safe" — the answer is the same bad-value diagnostic, never the
      // getter's error leaking out.
      let then: unknown;
      try {
        then = (value as { then?: unknown }).then;
      } catch {
        throw badValue(
          "an object whose .then access throws; it cannot be proven safe and is treated as unrenderable",
        );
      }
      if (typeof then === "function") {
        throw badValue("a Promise/thenable is not renderable (values are never awaited)");
      }
      throw badValue(
        `${describe(value)} is not renderable (only Html, strings, finite numbers, and arrays of those are)`,
      );
    }
    default:
      throw badValue("a value of an unsupported type");
  }
}

function renderRoot(root: Html): Rendered {
  const ctx: RenderCtx = { seen: new Set(), memo: new Map() };
  return renderNode(root, 0, ctx);
}

/**
 * Render an Html to its raw markup. INTERNAL (no fence) — exported for
 * tests and for the render chunk; page output must go through
 * `finalizeDocument` so the fence actually runs.
 */
export function renderToString(root: Html): string {
  return renderRoot(root).markup;
}

/**
 * Render an Html AND run the fence over the result. This is what the
 * renderer (render chunk) calls per page: a violation throws a BuildError
 * carrying ALL fence diagnostics (never the first one only).
 */
export function finalizeDocument(
  root: Html,
  opts: { siteOrigin: string; pageRoute?: string },
): string {
  const rendered = renderRoot(root);
  const diagnostics = runFence(rendered.markup, rendered.ranges, opts);
  if (diagnostics.length > 0) throw new BuildError(diagnostics);
  return rendered.markup;
}

/**
 * Build an Html from TRUSTED internal markup plus explicit value ranges
 * (the markdown renderer's escape output lands here: the markup is already
 * escaped by the renderer, and the ranges mark where its tracked values are,
 * so the fence polices them exactly like html-template values).
 *
 * Internal — exported from this module only, NOT from index.ts. Ranges must
 * be well-formed (integers, 0 ≤ start ≤ end ≤ markup.length, sorted,
 * non-overlapping — the invariants the fence's overlap tests rely on).
 */
export function trustedHtml(markup: string, ranges: Range[] = []): Html {
  if (typeof markup !== "string") {
    throw badValue(
      `trustedHtml markup must be a string, received ${markup === null ? "null" : typeof markup}`,
    );
  }
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (
      r.length !== 2 ||
      !Number.isInteger(r[0]) ||
      !Number.isInteger(r[1]) ||
      r[0] < 0 ||
      r[0] > r[1] ||
      r[1] > markup.length
    ) {
      throw badValue(
        `trustedHtml range ${JSON.stringify([...r])} is malformed (integers, 0 ≤ start ≤ end ≤ ${markup.length})`,
      );
    }
    if (i > 0) {
      const prev = ranges[i - 1];
      if (r[0] < prev[1]) {
        throw badValue(
          `trustedHtml ranges are out of order or overlapping (${JSON.stringify([...prev])} before ${JSON.stringify([...r])})`,
        );
      }
    }
  }
  return makeTrustedNode(markup, ranges);
}

// (rangesOverlap / Range live in fence.ts — tests and internal modules import
// them from there, so nothing is re-exported here.)
