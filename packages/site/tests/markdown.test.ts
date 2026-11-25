// The markdown pipeline contract: escaping (html:false), heading slugs, the
// URL policy on destinations, internal .md rewriting, task items, and the
// extraction chunk 7 will validate against.
//
// Pinned decisions tested here:
//  - slugify is GitHub-style: NFKD + combining marks stripped, so
//    "Ünïcödé" slugs to ASCII "unicode" (not "ünicödé").
//  - an empty slug (emoji-only heading) falls back to the id "section";
//    collisions append -1/-2/… in document order, incremented past ids that
//    are already taken.
//  - a rejected destination is reported link.invalid AND its href/src is
//    stripped, so the emitted markup is inert (defense in depth beyond the
//    error failing the build).
//  - markdown-it's silent javascript:-rejection is replaced by our policy:
//    validateLink admits everything, validateUrl judges it (no silent pass).
import { describe, expect, test } from "bun:test";
import { BuildError } from "../src/diagnostics";
import { finalizeDocument, html, renderToString } from "../src/html";
import { renderMarkdown, slugify } from "../src/markdown";
import type { RouteResolver } from "../src/types";

const BASE = {
  sourcePath: "docs/page.md",
  bodyStartLine: 1,
  siteUrl: "https://site.dev",
  pageRoute: "/guides/page",
};

function render(body: string, extra: Partial<Parameters<typeof renderMarkdown>[1]> = {}) {
  return renderMarkdown(body, { ...BASE, ...extra });
}

/** Fake route table: route → entry; "external" passes through; absent = null. */
function fakeResolver(
  entries: Record<string, { exists?: boolean; isDraft?: boolean } | "external">,
) {
  const resolver: RouteResolver = (route) => {
    const e = entries[route];
    if (e === undefined) return null;
    if (e === "external") return "external";
    return { route, exists: e.exists ?? true, isDraft: e.isDraft ?? false };
  };
  return resolver;
}

describe("heading slugs", () => {
  test("unicode: NFKD with diacritics stripped (pinned: ascii 'unicode')", () => {
    const r = render("# Ünïcödé");
    expect(r.headings).toEqual([{ level: 1, id: "unicode", text: "Ünïcödé" }]);
    expect(renderToString(r.html)).toContain('<h1 id="unicode">');
  });

  test("slugify edge cases", () => {
    expect(slugify("Ünïcödé")).toBe("unicode");
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("a  —  b")).toBe("a-b"); // punctuation dies, dashes collapse
    expect(slugify("--leading and trailing--")).toBe("leading-and-trailing");
    expect(slugify("snake_case kept")).toBe("snake_case-kept");
    expect(slugify("100% valid")).toBe("100-valid");
    expect(slugify("日本語 ルール")).toBe("日本語-ルール"); // unicode letters kept
    expect(slugify("🎉 🚀")).toBe(""); // emoji-only → empty → caller's fallback
  });

  test("duplicates Foo/Foo/Foo → foo, foo-1, foo-2", () => {
    const r = render("# Foo\n\n## Foo\n\n### Foo");
    expect(r.headings.map((h) => h.id)).toEqual(["foo", "foo-1", "foo-2"]);
  });

  test("collision suffix increments past an already-taken id", () => {
    const r = render("# Foo\n\n# foo-1\n\n# Foo");
    expect(r.headings.map((h) => h.id)).toEqual(["foo", "foo-1", "foo-2"]);
  });

  test("emoji-only heading falls back to 'section' (pinned), then section-1", () => {
    const r = render("# 🎉\n\n# 🚀");
    expect(r.headings.map((h) => h.id)).toEqual(["section", "section-1"]);
  });

  test("heading text is plain text: syntax stripped, entities decoded", () => {
    const r = render("# A &amp; B `c` *d*");
    expect(r.headings[0].text).toBe("A & B c d");
    expect(r.headings[0].id).toBe("a-b-c-d");
  });

  test("collision against an EXPLICIT '-1' heading: 'Foo','Foo','Foo-1' → foo, foo-1, foo-1-1", () => {
    const r = render("# Foo\n\n# Foo\n\n# Foo-1");
    expect(r.headings.map((h) => h.id)).toEqual(["foo", "foo-1", "foo-1-1"]);
  });

  test("punctuation-only heading slug is empty → 'section' fallback (pinned)", () => {
    const r = render("# !?\n\n# !!!");
    expect(r.headings.map((h) => h.id)).toEqual(["section", "section-1"]);
  });

  test("setext heading (text line + underline) slugs like any other heading", () => {
    const r = render("My Setext\n==========\n\nMy Setext\n----------");
    expect(r.headings.map((h) => [h.level, h.id])).toEqual([
      [1, "my-setext"],
      [2, "my-setext-1"],
    ]);
  });

  test("ids are stable across runs (no Set/Map iteration-order dependence)", () => {
    const body =
      "# Foo\n\n# Foo\n\n# Foo-1\n\n# Foo\n\n## Ünïcödé\n\n## Ünïcödé\n\n# 🎉\n\n# 🎉\n\n# !!!\n\n# plain";
    const a = renderMarkdown(body, BASE).headings.map((h) => h.id);
    const b = renderMarkdown(body, BASE).headings.map((h) => h.id);
    const c = renderMarkdown(body, BASE).headings.map((h) => h.id);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual([
      "foo",
      "foo-1",
      "foo-1-1",
      "foo-2",
      "unicode",
      "unicode-1",
      "section",
      "section-1",
      "section-2",
      "plain",
    ]);
  });
});

describe("escaping — html:false is the contract", () => {
  test("raw HTML renders as escaped inert text", () => {
    const r = render("<script>alert(1)</script>");
    const out = renderToString(r.html);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script>");
  });

  test("a fence containing </code><script>alert(1)</script> renders inert", () => {
    const r = render("```\n</code><script>alert(1)</script>\n```");
    const out = renderToString(r.html);
    expect(out).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<script>");
    expect(out).toContain("<code>");
  });

  test("inline code escapes too", () => {
    const out = renderToString(render("(`<b>` &amp;)").html);
    expect(out).toContain("<code>&lt;b&gt;</code> &amp;)");
  });
});

describe("link and image destinations", () => {
  test("javascript: destination → link.invalid, href stripped", () => {
    const r = render("[x](javascript:alert(1))");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(r.diagnostics[0].severity).toBe("error");
    const out = renderToString(r.html);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<a>x</a>");
  });

  test("entity-smuggled scheme (java&#58;…) is caught after markdown-it decodes it", () => {
    const r = render("[x](java&#58;script:alert(1))");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(renderToString(r.html)).not.toContain("java:script:");
  });

  test("image src runs the same policy", () => {
    const r = render("![alt](javascript:alert(1))");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    const out = renderToString(r.html);
    expect(out).toContain("<img");
    expect(out).not.toContain("src=");
  });

  test("external https is accepted untouched", () => {
    const r = render("[x](https://elsewhere.dev/a?b=1)");
    expect(r.diagnostics).toEqual([]);
    expect(r.links).toEqual([]);
    expect(renderToString(r.html)).toContain('<a href="https://elsewhere.dev/a?b=1">');
  });

  test("mailto/tel are accepted (url.ts policy passthrough)", () => {
    const r = render("[m](mailto:a@b.dev) [t](tel:+15551234)");
    expect(r.diagnostics).toEqual([]);
  });

  test("./other.md is rewritten to the route via the resolver (route-relative)", () => {
    const r = render("[x](./other.md#frag)", {
      resolveInternal: fakeResolver({ "/guides/other": {} }),
    });
    expect(renderToString(r.html)).toContain('<a href="/guides/other#frag">');
    expect(r.links).toEqual([
      {
        route: "/guides/other",
        fragment: "frag",
        line: 1,
        exists: true,
        isDraft: false,
        kind: "page",
      },
    ]);
  });

  test("../x.md resolves against the ROUTE directory, not the source path", () => {
    const r = render("[x](../x.md)", {
      pageRoute: "/a/b",
      resolveInternal: fakeResolver({ "/x": {} }),
    });
    expect(renderToString(r.html)).toContain('<a href="/x">');
    expect(r.links[0].route).toBe("/x");
  });

  test("a draft target is recorded with isDraft (chunk 7 decides severity)", () => {
    const r = render("[x](./wip.md)", {
      resolveInternal: fakeResolver({ "/guides/wip": { exists: true, isDraft: true } }),
    });
    expect(r.links).toEqual([
      { route: "/guides/wip", fragment: null, line: 1, exists: true, isDraft: true, kind: "page" },
    ]);
  });

  test("./missing.md is RECORDED with exists:false (chunk 4 records, chunk 7 fails)", () => {
    const r = render("[x](./missing.md)", { resolveInternal: fakeResolver({}) });
    expect(r.links).toEqual([
      {
        route: "/guides/missing",
        fragment: null,
        line: 1,
        exists: false,
        isDraft: false,
        kind: "page",
      },
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  test("no resolver at all → internal .md links are recorded exists:false, never silently ok", () => {
    const r = render("[x](./other.md)");
    expect(r.links.map((l) => l.exists)).toEqual([false]);
  });

  test("resolver 'external' keeps the destination and applies the URL policy", () => {
    const r = render("[x](./weird.md)", {
      resolveInternal: fakeResolver({ "/guides/weird": "external" }),
    });
    expect(r.diagnostics).toEqual([]);
    expect(renderToString(r.html)).toContain('href="./weird.md"');
    expect(r.links).toEqual([]);
  });

  test("fragment links are recorded for the chunk-7 fragment check", () => {
    const r = render("[x](#sec)");
    expect(r.links).toEqual([
      {
        route: "/guides/page",
        fragment: "sec",
        line: 1,
        exists: true,
        isDraft: false,
        kind: "fragment",
      },
    ]);
  });

  test("root-relative .md is NOT route-rewritten (documented v1 scope)", () => {
    const r = render("[x](/docs/other.md)", {
      resolveInternal: fakeResolver({ "/docs/other": {} }),
    });
    expect(renderToString(r.html)).toContain('href="/docs/other.md"');
    expect(r.links).toEqual([]);
  });

  test("diagnostic lines are FULL-FILE coordinates (bodyStartLine offset)", () => {
    const body = ["intro", "", "[bad](javascript:alert(1))"].join("\n");
    const r = render(body, { bodyStartLine: 5 });
    expect(r.diagnostics[0].line).toBe(7); // body line 2 (0-based 2) + 5
  });

  test("10-line frontmatter: a link on file line 30 reports line 30", () => {
    // Frontmatter occupies file lines 1..10 (bodyStartLine 11). Body lines
    // 1..18 are one paragraph, line 19 blank, line 20 carries the link —
    // file line 30.
    const lines: string[] = [];
    for (let i = 1; i <= 18; i++) lines.push(`filler line ${i}`);
    lines.push("");
    lines.push("[bad](javascript:alert(1))");
    const r = render(lines.join("\n"), { bodyStartLine: 11 });
    expect(r.diagnostics[0]?.line).toBe(30);
  });

  test("a link in a SETEXT heading points at the TEXT line, not the underline line", () => {
    // body: line 0 paragraph, line 1 blank, line 2 heading text, line 3 the
    // underline. The inline token's map is [2,3); with bodyStartLine 5 the
    // text line is file line 7 (the underline would be 8).
    const body = "above\n\n[bad](javascript:alert(1))\n====\n";
    const r = render(body, { bodyStartLine: 5 });
    expect(r.diagnostics[0]?.line).toBe(7);
  });
});

describe("internal .md links resolve against the ROUTE (cross-chunk: plan §2)", () => {
  test("docs/index.md linking ../guide.md resolves to /guide (route base, not source dir)", () => {
    // The page's source file lives at docs/index.md, but its ROUTE is /docs.
    // `../guide.md` must resolve against the route's directory:
    // /docs/.. = / → /guide.md → /guide. Resolving against the SOURCE path
    // would only give the same answer by accident here; the /a/b case below
    // separates the two.
    const r = render("[x](../guide.md)", {
      pageRoute: "/docs",
      resolveInternal: fakeResolver({ "/guide": {} }),
    });
    expect(renderToString(r.html)).toContain('<a href="/guide">');
    expect(r.links).toEqual([
      { route: "/guide", fragment: null, line: 1, exists: true, isDraft: false, kind: "page" },
    ]);
  });

  test("route and source dir differ: /a/b page (source docs/page.md) with ../x.md#sec → /x#sec", () => {
    const r = render("[x](../x.md#sec)", {
      pageRoute: "/a/b",
      resolveInternal: fakeResolver({ "/x": {} }),
    });
    expect(renderToString(r.html)).toContain('<a href="/x#sec">');
    expect(r.links).toEqual([
      { route: "/x", fragment: "sec", line: 1, exists: true, isDraft: false, kind: "page" },
    ]);
  });

  test("internal link to a draft target carries isDraft for chunk 7", () => {
    const r = render("[x](./wip.md)", {
      resolveInternal: fakeResolver({ "/guides/wip": { exists: true, isDraft: true } }),
    });
    expect(r.links).toEqual([
      { route: "/guides/wip", fragment: null, line: 1, exists: true, isDraft: true, kind: "page" },
    ]);
  });
});

describe("task list items (hand-rolled)", () => {
  test("checked and unchecked items render checkbox + label", () => {
    const out = renderToString(render("- [x] done\n- [ ] todo\n- plain").html);
    expect(out).toContain('<label><input checked="" disabled="" type="checkbox" />done</label>');
    expect(out).toContain('<label><input disabled="" type="checkbox" />todo</label>');
    expect(out).toContain("<li>plain</li>");
  });

  test("loose items keep the paragraph with the task-list-item class", () => {
    const out = renderToString(render("- [x] one\n\n- two").html);
    expect(out).toContain(
      '<p class="task-list-item"><label><input checked="" disabled="" type="checkbox" />one</label></p>',
    );
  });

  test("[x] without a following space stays literal text", () => {
    const out = renderToString(render("- [x]done").html);
    expect(out).toContain("[x]done");
    expect(out).not.toContain("checkbox");
  });
});

describe("destination policy covers EVERY destination kind", () => {
  // markdown-it 14's autolink rule (AUTOLINK_RE) accepts ANY `scheme:` inside
  // `<...>` — including `javascript:` — and validateLink (overridden to
  // admit-all here) lets it reach the token stream. Only the collect pass's
  // URL policy may reject it; markdown-it's default validateLink would have
  // turned it into SILENT text, which crust rule 1 forbids.
  test("autolink <javascript:alert(1)> → link.invalid, href stripped", () => {
    // markdown-it renders an autolink's URL as its visible LABEL. After the
    // href is stripped the label stays as inert escaped text (no URL left),
    // which is the correct honest rendering — the security property pinned
    // here is the destination, not the label.
    const r = render("<javascript:alert(1)>");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(r.diagnostics[0].severity).toBe("error");
    const out = renderToString(r.html);
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain("<a>javascript:alert(1)</a>");
  });

  test("autolink <script:alert(1)> (scheme-shaped) → link.invalid", () => {
    const r = render("<script:alert(1)>");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    const out = renderToString(r.html);
    expect(out).not.toContain('href="script:');
    expect(out).toContain("<a>script:alert(1)</a>");
  });

  test("autolink <https:x> (WHATWG-rewritten) → link.invalid, never silently normalized", () => {
    const r = render("<https:x>");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
  });

  test("autolink <https://ok.example/a> passes the policy untouched", () => {
    const r = render("<https://ok.example/a>");
    expect(r.diagnostics).toEqual([]);
    expect(renderToString(r.html)).toContain('<a href="https://ok.example/a">');
  });

  test("autolink <mailto:a@b.dev> passes the policy untouched", () => {
    const r = render("<mailto:a@b.dev>");
    expect(r.diagnostics).toEqual([]);
    expect(renderToString(r.html)).toContain('<a href="mailto:a@b.dev">');
  });

  test("reference-style link [x][1] with a javascript: definition → link.invalid", () => {
    const r = render("text [x][1] end\n\n[1]: javascript:alert(1)\n");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(r.diagnostics[0].severity).toBe("error");
    const out = renderToString(r.html);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<a>x</a>");
  });

  test("reference-style image ![x][1] with a javascript: definition → link.invalid, src stripped", () => {
    const r = render("![x][1]\n\n[1]: javascript:alert(1)\n");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    const out = renderToString(r.html);
    expect(out).toContain("<img");
    expect(out).not.toContain("src=");
  });

  test("reference definition that resolves to a valid URL is untouched", () => {
    const r = render("text [x] end\n\n[x]: https://ok.example\n");
    expect(r.diagnostics).toEqual([]);
    expect(renderToString(r.html)).toContain('<a href="https://ok.example">');
  });

  test("link title containing a double quote is escaped, not structure-breaking", () => {
    const r = render('[x](https://ok.example "ti\\"tle")');
    expect(r.diagnostics).toEqual([]);
    const out = renderToString(r.html);
    expect(out).toContain('title="ti&quot;tle"');
    expect(out).not.toContain('title="ti"tle"');
  });

  test("nested inline: a link inside emphasis inside a heading is judged (bad dest)", () => {
    const r = render("# Head **bold [x](javascript:alert(1))** rest");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(renderToString(r.html)).not.toContain("javascript:");
  });

  test("nested inline: a link inside a table cell is judged (bad dest)", () => {
    const r = render("a|b\n-|-\n[cell [x](javascript:alert(1))]|1");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(renderToString(r.html)).not.toContain("javascript:");
  });

  test("a link inside an image alt cannot smuggle a destination", () => {
    // alt text is inline: a link inside it is still a link token and is judged.
    const r = render("![**[x](javascript:alert(1))** alt](https://ok.example/i.png)");
    expect(r.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(renderToString(r.html)).not.toContain("javascript:");
  });
});

describe("escaping — no decode/encode round-trip may lose or invent data", () => {
  test("code span keeps `&amp;` LITERAL: escaped once, never double-decoded", () => {
    // Source `&amp;` must display as the literal 5 characters `&amp;`.
    // Correct markup: `&amp;amp;`. A double decode would emit `&amp;`
    // (displays as `&`) — wrong.
    const out = renderToString(render("x `&amp;` y").html);
    expect(out).toContain("<code>&amp;amp;</code>");
    expect(out).not.toContain("<code>&amp;</code>");
  });

  test("plain-text entity `&amp;` decodes once and re-escapes (displays as &)", () => {
    const out = renderToString(render("A &amp; B").html);
    expect(out).toContain("<p>A &amp; B</p>");
  });

  test("a fence containing `-->` and `</script>` is inert and fence-clean", () => {
    const r = render("```text\n-->\n</script>\n<!--\n```");
    const out = renderToString(r.html);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<!--");
    // The fence must not mistake the escaped content for a comment/script body:
    expect(() => finalizeDocument(r.html, { siteUrl: "https://site.dev" })).not.toThrow();
  });

  test("html:false: self-closing <img src=x onerror=1> renders as escaped text", () => {
    // html:false means the whole line is a plain paragraph whose text is
    // escaped: no tag, no attribute — the `onerror=` inside is visible inert
    // text, not an attribute (pinned: the raw `<img` tag must not survive).
    const r = render("<img src=x onerror=1>");
    const out = renderToString(r.html);
    expect(out).toContain("&lt;img src=x onerror=1&gt;");
    expect(out).not.toContain("<img ");
    expect(() => finalizeDocument(r.html, { siteUrl: "https://site.dev" })).not.toThrow();
  });

  test("html:false: a paragraph containing <!-- is escaped (no raw comment for the fence)", () => {
    const out = renderToString(render("before <!-- after").html);
    expect(out).toContain("before &lt;!-- after");
    expect(out).not.toContain("<!--");
  });

  test("<script src=...> without a scheme stays inert text (autolink needs a scheme)", () => {
    const r = render("<script src=x onerror=1>");
    const out = renderToString(r.html);
    expect(out).toContain("&lt;script src=x onerror=1&gt;");
    expect(r.diagnostics).toEqual([]);
  });
});

describe("trusted body inside a template attribute (author error is safe, pinned)", () => {
  // The markdown body is TRUSTED markup: it carries no tracked ranges, so the
  // fence treats it as author markup. The question this pins: is that safe
  // when a layout interpolates the body into an attribute POSITION? The fence
  // parses exactly as a browser does (fence.ts header), so whatever the
  // browser sees, the fence sees too.

  test("body without quotes in a QUOTED attribute: fence passes, value is the body", () => {
    const body = render("plain para", BASE).html;
    const out = finalizeDocument(html`<div title="${body}">rest</div>`, {
      siteUrl: "https://site.dev",
    });
    // No fence violation: inside a quoted attribute value, < and > are data.
    expect(out).toBe(`<div title="<p>plain para</p>\n">rest</div>`);
  });

  test("body WITH quoted attributes in a quoted attribute: fence passes, browser-split pinned", () => {
    // The first inner `"` closes the template's value (browser AND fence agree).
    // The remainder becomes a bogus attribute name + inert text: garbled, but
    // every fragment is an attribute value or text — the body is trusted
    // markup, so nothing structural can escape. Pinned exactly.
    const body = render("```ts\nx\n```", BASE).html;
    const out = finalizeDocument(html`<div title="${body}">rest`, {
      siteUrl: "https://site.dev",
    });
    expect(out).toBe('<div title="<pre><code class="language-ts">x\n</code></pre>\n">rest');
  });

  test("body in an UNQUOTED attribute position: fence.unquoted-attribute catches the raw <", () => {
    const body = render("plain para", BASE).html;
    let err: unknown;
    try {
      finalizeDocument(html`<div title=${body}>rest</div>`, {
        siteUrl: "https://site.dev",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    expect((err as BuildError).diagnostics.map((d) => d.code)).toEqual([
      "fence.unquoted-attribute",
    ]);
  });

  test("template whose value is never closed: fence.unterminated (value runs to EOF)", () => {
    // A body with NO quotes cannot close the template's opening quote — the
    // value runs to EOF and the fence must reject.
    const body = render("plain para", BASE).html;
    let err: unknown;
    try {
      finalizeDocument(html`<div title="${body}`, {
        siteUrl: "https://site.dev",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    expect((err as BuildError).diagnostics.map((d) => d.code)).toEqual(["fence.unterminated"]);
  });
});

describe("feature surface + extraction", () => {
  test("GFM tables and strikethrough render", () => {
    const out = renderToString(render("a|b\n-|-\n1|~~x~~").html);
    expect(out).toContain("<table>");
    expect(out).toContain("<s>x</s>");
  });

  test("fences carry the language- prefix", () => {
    expect(renderToString(render("```ts\nx\n```").html)).toContain('class="language-ts"');
  });

  test("firstParagraph is plain text of the first top-level paragraph", () => {
    const r = render("- [x] tight list first\n\nA **bold** sentence & more.");
    expect(r.firstParagraph).toBe("A bold sentence & more.");
  });

  test("a tight list before the first paragraph does not become the description source", () => {
    const r = render("- one\n- two\n\nreal paragraph");
    expect(r.firstParagraph).toBe("real paragraph");
  });
});
