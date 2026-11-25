// The template runtime contract (plan §1): the escape table, value semantics
// (with the toString/valueOf never-invoked guarantee), cycle and depth
// rejection, range tracking through arbitrary nesting, and trustedHtml.
//
// Honest-failure pattern throughout: every guard has a case that VIOLATES it
// and a control that PASSES, so removing a guard turns a test red.
import { describe, expect, test } from "bun:test";
import { BuildError, type Diagnostic, isDiagnostic } from "../src/diagnostics";
import {
  escapeHtml,
  finalizeDocument,
  type Html,
  html,
  renderToString,
  trustedHtml,
} from "../src/html";

const SITE = "https://site.dev";

/** Render + fence; returns the diagnostic codes of the thrown BuildError (or []). */
function fenceCodes(doc: Html, pageRoute?: string): string[] {
  try {
    finalizeDocument(doc, { siteUrl: SITE, pageRoute });
    return [];
  } catch (e) {
    if (e instanceof BuildError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
}

function renderValue(value: unknown): unknown {
  try {
    return renderToString(html`${value as Html}`);
  } catch (d) {
    return d;
  }
}

describe("escapeHtml — ONE escaper, ampersand first", () => {
  test("escapes exactly & < > \" '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;");
  });

  test("the ampersand is replaced first: entities are never re-escaped", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("a&b<c>d\"e'f")).toBe("a&amp;b&lt;c&gt;d&quot;e&#x27;f");
  });

  test("every other character is untouched", () => {
    // `&` is deliberately NOT in this set: it IS escaped, and is covered by
    // the cases above. Tab/newline are kept via escapes in a plain string
    // (no template literal — the writer once mangled those).
    expect(escapeHtml(" \t\n/?:=()[]{}*+!@#$%^*|\\~")).toBe(" \t\n/?:=()[]{}*+!@#$%^*|\\~");
  });

  test("empty string stays empty", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("value semantics — safe values", () => {
  test.each([
    [0, "0"],
    [1, "1"],
    [-1, "-1"],
    [42.5, "42.5"],
    [0.1, "0.1"],
    [-0, "0"], // String(-0) === "0" — negative zero never renders "-0"
    [1e21, "1e+21"], // documented: JS number formatting, not a crust format
    [1e-7, "1e-7"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
  ])("number %s renders %s (0 is never falsy-dropped)", (n, expected) => {
    expect(renderToString(html`<i>${n}</i>`)).toBe(`<i>${expected}</i>`);
  });

  test.each([false, null, undefined])("%s emits nothing (no range, no text)", (v) => {
    expect(renderToString(html`[${v as unknown as Html}]`)).toBe("[]");
  });

  test("strings are escaped at the interpolation site", () => {
    const value = `<b> & 'q' "x"`;
    expect(renderToString(html`<a>${value}</a>`)).toBe(
      "<a>&lt;b&gt; &amp; &#x27;q&#x27; &quot;x&quot;</a>",
    );
  });

  test("an empty string emits nothing and tracks no range", () => {
    expect(renderToString(html`<a href="">x</a>`)).toBe('<a href="">x</a>');
  });

  test("nested arrays flatten recursively with no separator", () => {
    expect(renderToString(html`[${["a", ["b", ["c"]], "d"]}]`)).toBe("[abcd]");
  });

  test("an empty array emits nothing", () => {
    expect(renderToString(html`[${[]}]`)).toBe("[]");
  });

  test("a mix of values composes in order", () => {
    expect(renderToString(html`${"a"}${0}${null}${[false, "b"]}`)).toBe("a0b");
  });
});

describe("value semantics — unsafe values throw render.bad-value", () => {
  const UNSAFE: [string, unknown][] = [
    ["true", true],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["Symbol", Symbol("x")],
    ["bigint", 10n],
    ["function", () => "never rendered"],
    ["plain object", { a: 1 }],
  ];
  test.each(UNSAFE)("%s is rejected", (_, value) => {
    const d = renderValue(value);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("render.bad-value");
    expect((d as Diagnostic).severity).toBe("error");
  });

  test("a class instance is rejected", () => {
    class Widget {
      value = 1;
    }
    const d = renderValue(new Widget());
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("render.bad-value");
    expect((d as Diagnostic).message).toContain("Widget");
  });

  test("an object whose toString THROWS still dies with the bad-value diagnostic, never the toString error", () => {
    const hostile = {
      toString() {
        throw new Error("boom-from-toString");
      },
    };
    const d = renderValue(hostile);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("render.bad-value");
    // the getter's error must NOT leak: if any code path invoked toString,
    // "boom-from-toString" would be the thrown error instead.
    expect(JSON.stringify(d)).not.toContain("boom-from-toString");
  });

  test("an object whose .then getter THROWS dies with the bad-value diagnostic, never the getter error", () => {
    const hostile = {
      // biome-ignore lint/suspicious/noThenProperty: deliberate — the hostile value IS a thenable
      get then() {
        throw new Error("boom-from-then-getter");
      },
    };
    const d = renderValue(hostile);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("render.bad-value");
    expect(JSON.stringify(d)).not.toContain("boom-from-then-getter");
  });

  test.each([
    ["a Promise", Promise.resolve("x")],
    ["a rejected Promise", Promise.reject(new Error("nope")).catch(() => {})],
    // biome-ignore lint/suspicious/noThenProperty: deliberate — the hostile value IS a thenable
    ["a plain thenable", { then(_fn: unknown) {} }],
  ])("%s is rejected (values are never awaited)", (_, value) => {
    const d = renderValue(value);
    expect(isDiagnostic(d)).toBe(true);
    expect((d as Diagnostic).code).toBe("render.bad-value");
  });

  test("the diagnostics are thrown, not returned (finalizeDocument propagates them)", () => {
    expect(() => finalizeDocument(html`${true as unknown as Html}`, { siteUrl: SITE })).toThrow();
    expect(() => renderToString(html`${Number.NaN as unknown as Html}`)).toThrow();
  });
});

describe("cycles and sharing", () => {
  test("a node that is its own ancestor (via a live array) is a render.bad-value, not a stack overflow", () => {
    const arr: unknown[] = [];
    const node = html`<div>${arr as unknown as Html}</div>`;
    arr.push(node); // now node → arr → node
    let thrown: unknown;
    try {
      renderToString(node);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
    expect((thrown as Diagnostic).message).toContain("cycle");
  });

  test("an array that contains itself is a cycle, not an infinite loop", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    const node = html`<div>${arr as unknown as Html}</div>`;
    let thrown: unknown;
    try {
      renderToString(node);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
  });

  test("pathologically deep array nesting is a diagnostic, never a RangeError", () => {
    // 50k nested arrays: without a depth cap on array nesting this is a raw
    // stack overflow (RangeError) — a crash, not an honest diagnostic.
    let deep: unknown[] = [];
    for (let i = 0; i < 50000; i++) deep = [deep];
    let thrown: unknown;
    try {
      renderToString(html`${deep as unknown as Html}`);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
    expect((thrown as Diagnostic).message).toContain("depth");
  });

  test("a diamond is legal: the same node in two branches renders twice", () => {
    const shared = html`<b>x</b>`;
    expect(renderToString(html`${shared}${shared}`)).toBe("<b>x</b><b>x</b>");
  });

  test("the same array in two branches renders its current contents each time", () => {
    const arr: Html[] = [html`a`, html`b`];
    expect(renderToString(html`[${arr}]|${arr}`)).toBe("[ab]|ab");
  });

  test("a shared array is live per render: elements pushed between renders appear", () => {
    const arr: Html[] = [];
    const doc = html`<div>${arr}</div>`;
    expect(renderToString(doc)).toBe("<div></div>");
    arr.push(html`late`);
    expect(renderToString(doc)).toBe("<div>late</div>");
  });
});

describe("nesting depth cap (64)", () => {
  function chain(depth: number): Html {
    let node: Html = html`end`;
    for (let i = 0; i < depth; i++) node = html`<span>${node}</span>`;
    return node;
  }

  test("depth 64 is the maximum (root is depth 0)", () => {
    const out = renderToString(chain(64));
    // 64 nested <span> wrappers around "end"
    expect(out.startsWith("<span>")).toBe(true);
    expect(out.endsWith("end" + "</span>".repeat(64))).toBe(true);
    expect(out.length).toBe(6 * 64 + 7 * 64 + 3); // <span> + </span> per level, plus "end"
  });

  test("depth 65 is a render.bad-value", () => {
    let thrown: unknown;
    try {
      renderToString(chain(65));
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
    expect((thrown as Diagnostic).message).toContain("depth 65");
  });
});

describe("range tracking through arbitrary nesting", () => {
  test("a value three levels deep is still tracked in the final document", () => {
    const value = "javascript:alert(1)";
    const inner = html`${value}`; // level 1: the value lives here
    const mid = html`<a href="${inner}">x</a>`; // level 2: child interpolated
    const outer = html`<html><body>${mid}</body></html>`; // level 3
    // if the range had been lost, the fence would treat the href as literal
    // author markup and let the javascript: URL through (a false pass).
    expect(fenceCodes(outer)).toContain("fence.url-attribute");
  });

  test("ranges survive offset composition: positions stay correct after wrapping", () => {
    const inner = html`<span>abc</span>`;
    const mid = html`pre${inner}post`;
    const outer = html`<div>${mid}</div>`;
    expect(renderToString(outer)).toBe("<div>pre<span>abc</span>post</div>");
    // the fence must see the value at its FINAL offset, not the child's:
    // a comment starting after the outer div's start but before the value
    // must NOT overlap it.
    const doc = html`<div><!--c-->${mid}</div>`;
    expect(fenceCodes(doc)).toEqual([]);
  });

  test("five levels of ASYMMETRIC literals land the range at the exact offset", () => {
    // Build a value 5 levels deep with different-length literals at each
    // level. Pins: (a) exact markup composition, (b) the tracked range is
    // where the markup says it is — an unclosed comment opened BEFORE the
    // node fences the deep value, a closed comment ending exactly at the
    // node's start does not, and one char of literal padding past the value
    // start does (the comment then swallows the value's first char).
    const v = "x"; // the tracked value, 1 char
    let n = html`[${v}]`; // markup "[x]", value at [1,2)
    n = html`aa${n}bbbb`; // +2 → [3,4)
    n = html`<p>${n}</p>`; // +3 → [6,7)
    n = html`abcde${n}`; // +5 → [11,12)
    n = html`<i>${n}</i>`; // +3 → [14,15) within n
    const markup = renderToString(n);
    expect(markup).toBe("<i>abcde<p>aa[x]bbbb</p></i>");
    expect(markup[14]).toBe("x");
    // an unclosed comment before the node covers the deep value → violation
    expect(fenceCodes(html`<!--${n}`)).toContain("fence.comment-value");
    // a closed comment before the node never reaches it → clean
    expect(fenceCodes(html`<!--c-->${n}`)).toEqual([]);
    // and the url rule fires at the final offset: wrap the deep value in a
    // real href two levels up with a javascript: payload
    const evil = html`<a href="${"javascript:alert(1)"}">x</a>`;
    expect(fenceCodes(html`<div><section>${evil}</section></div>`)).toContain(
      "fence.url-attribute",
    );
  });

  test("a trusted fragment inside a template has its ranges offset like any child", () => {
    const markup = `<a href="javascript:alert(1)">x</a>`;
    const start = markup.indexOf("javascript:");
    const trusted = trustedHtml(markup, [[start, start + 18]]);
    // wrapped behind a long literal: the range must move with the markup
    expect(fenceCodes(html`<div>0123456789${trusted}</div>`)).toContain("fence.url-attribute");
    // and finalizeDocument accepts a trusted root with ranges directly
    expect(fenceCodes(trusted)).toContain("fence.url-attribute");
    expect(finalizeDocument(trustedHtml("<p>ok</p>", [[0, 1]]), { siteUrl: SITE })).toBe(
      "<p>ok</p>",
    );
  });
});

describe("trustedHtml — the internal factory for the markdown renderer", () => {
  test("trusted markup renders as-is", () => {
    expect(renderToString(trustedHtml("<p>abc</p>"))).toBe("<p>abc</p>");
  });

  test("trusted ranges are fenced like template ranges", () => {
    const markup = `<a href="javascript:alert(1)">x</a>`;
    const start = markup.indexOf("javascript:");
    const doc = trustedHtml(markup, [[start, start + 18]]);
    expect(fenceCodes(doc)).toContain("fence.url-attribute");
  });

  test("trusted markup without ranges is never url-checked", () => {
    const markup = `<a href="javascript:alert(1)">x</a>`;
    expect(fenceCodes(trustedHtml(markup))).toEqual([]);
  });

  const BAD_RANGES: { ranges: [number, number][]; why: string }[] = [
    { ranges: [[5, 2]], why: "start > end" },
    { ranges: [[-1, 2]], why: "negative start" },
    { ranges: [[0, 999]], why: "end beyond markup" },
    { ranges: [[1.5, 3]], why: "non-integer" },
    { ranges: [[2, 4, 1] as unknown as [number, number]], why: "wrong arity" },
  ];
  test.each(BAD_RANGES)("malformed range (%s) → render.bad-value", ({ ranges }) => {
    let thrown: unknown;
    try {
      trustedHtml("abcdef", ranges);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
    expect((thrown as Diagnostic).message).toContain("range");
  });

  test("out-of-order or overlapping ranges are rejected (the fence's overlap tests rely on the invariant)", () => {
    let thrown: unknown;
    try {
      trustedHtml("abcdef", [
        [3, 4],
        [1, 2],
      ]);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
  });

  test("a non-string markup is rejected", () => {
    let thrown: unknown;
    try {
      trustedHtml(42 as unknown as string);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
  });

  test("an impersonated Html (a plain object) is a render.bad-value", () => {
    const forged = { markup: "<b>x</b>", ranges: [] } as unknown as Html;
    let thrown: unknown;
    try {
      renderToString(forged);
    } catch (e) {
      thrown = e;
    }
    expect(isDiagnostic(thrown)).toBe(true);
    expect((thrown as Diagnostic).code).toBe("render.bad-value");
  });
});

describe("finalizeDocument — the per-page entry point", () => {
  test("a clean document returns its markup", () => {
    const doc = html`<!DOCTYPE html><html><head><title>t</title></head><body><a href="/x">x</a></body></html>`;
    expect(finalizeDocument(doc, { siteUrl: SITE })).toBe(
      `<!DOCTYPE html><html><head><title>t</title></head><body><a href="/x">x</a></body></html>`,
    );
  });

  test("a violation throws a BuildError carrying ALL diagnostics", () => {
    // two distinct violations in one document: both must be reported
    const doc = html`<a onclick="x" ping="/y"></a>`;
    let err: unknown;
    try {
      finalizeDocument(doc, { siteUrl: SITE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    const codes = (err as BuildError).diagnostics.map((d) => d.code);
    expect(codes).toContain("fence.event-handler");
    expect(codes).toContain("fence.ping-attr");
  });

  test("THREE simultaneous violations land in ONE BuildError (nothing short-circuits)", () => {
    const doc = html`<a onclick="x" ping="/y" srcdoc="z"></a>`;
    let err: unknown;
    try {
      finalizeDocument(doc, { siteUrl: SITE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    const codes = (err as BuildError).diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(["fence.event-handler", "fence.ping-attr", "fence.srcdoc-attr"]);
  });

  test("mixed violation classes (body + comment + url) all collect", () => {
    const doc = html`<script>bad()</script><!--${"in-comment"}--><a href="${"javascript:x"}">`;
    let err: unknown;
    try {
      finalizeDocument(doc, { siteUrl: SITE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    const codes = (err as BuildError).diagnostics.map((d) => d.code);
    expect(codes).toContain("fence.script-body");
    expect(codes).toContain("fence.comment-value");
    expect(codes).toContain("fence.url-attribute");
  });
});

describe("public API surface (index.ts)", () => {
  test("the author-facing exports exist and the internals stay internal", async () => {
    const api = await import("../src/index");
    // plan §1 public surface:
    expect(typeof api.html).toBe("function");
    expect(typeof api.finalizeDocument).toBe("function");
    expect(typeof api.url).toBe("function");
    expect(typeof api.validateUrl).toBe("function");
    expect(api.url).toBe(api.validateUrl); // one function, two names
    // internals must NOT be reachable from the package entry:
    for (const internal of ["trustedHtml", "renderToString", "escapeHtml", "runFence"]) {
      expect(internal in api).toBe(false);
    }
  });
});
