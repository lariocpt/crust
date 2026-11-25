// The document fence: every rule gets a violation case AND a control case
// (honest-failure pattern — removing a guard must turn a test red).
//
// Documented policy decisions tested here:
//  - LITERAL (untracked) attribute values are trusted author markup: a
//    literal `href="javascript:..."` PASSES the fence. Only values that
//    contain a TRACKED template value are url-checked. This is deliberate:
//    the fence polices DATA (interpolated values), not the author's own
//    markup — the author is the trust boundary.
//  - An UNCLOSED quoted attribute value consumes the rest of the document
//    (exactly what the HTML tokenizer does) and is a fence.unterminated
//    violation — the document is rejected.
//  - Whitespace-only script/style bodies pass; any non-whitespace body
//    fails (v1 bans inline JS/CSS entirely).
import { describe, expect, test } from "bun:test";
import { BuildError } from "../src/diagnostics";
import { finalizeDocument, type Html, html, renderToString, trustedHtml } from "../src/html";

const ORIGIN = "https://site.dev";

function render(doc: Html, pageRoute?: string): string {
  return finalizeDocument(doc, { siteOrigin: ORIGIN, pageRoute });
}

/** Diagnostic codes of the thrown BuildError, or [] when the doc passes. */
function codes(doc: Html, pageRoute?: string): string[] {
  try {
    render(doc, pageRoute);
    return [];
  } catch (e) {
    if (e instanceof BuildError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
}

function expectViolation(doc: Html, expected: string, pageRoute?: string): void {
  const all = codes(doc, pageRoute);
  expect(all).toContain(expected);
}

function expectClean(doc: Html, pageRoute?: string): void {
  expect(codes(doc, pageRoute)).toEqual([]);
}

describe("fence.script-body / fence.style-body — inline JS/CSS is banned", () => {
  test("a <script> with a body fails", () => {
    expectViolation(html`<script>var x=1</script>`, "fence.script-body");
  });

  test("a <script> built from a split literal (scr + 'i' + pt) still fails", () => {
    // The classic literal-inspection bypass: the template literal never
    // contains the word "script". The fence scans the OUTPUT instead.
    expectViolation(html`<scr${"i"}pt>alert(1)</scr${"i"}pt>`, "fence.script-body");
    // and the dynamic tag name is reported too (two distinct rules)
    expect(codes(html`<scr${"i"}pt>alert(1)</scr${"i"}pt>`)).toContain("fence.dynamic-tag-name");
  });

  test("uppercase <SCRIPT> fails (tag names are case-insensitive)", () => {
    expectViolation(html`<SCRIPT>alert(1)</SCRIPT>`, "fence.script-body");
    expectViolation(html`<Style>body{}</Style>`, "fence.style-body");
  });

  test("a <style> with a body fails; empty and whitespace-only bodies pass", () => {
    expectViolation(html`<style>body{color:red}</style>`, "fence.style-body");
    expectClean(html`<style></style>`);
    expectClean(html`<style>\n  \n</style>`);
    expectClean(html`<script></script>`);
    expectClean(html`<script>   </script>`);
  });

  test("<script src> with no body passes — all JS ships as hashed assets", () => {
    expectClean(html`<script src="/a.js"></script>`);
    expectClean(html`<script src="/a.js">\n</script>`);
    expectClean(html`<script src="/a.js" defer></script>`);
  });

  test("<script/> is NOT self-closed in HTML: its raw-text body runs to </script> or EOF", () => {
    // HTML5 tokenizer: the '/' is ignored and the element is raw-text.
    // So <script/>x</script> has the body "x" and must fail; <script/>
    // alone has an empty body (everything to EOF is the body — nothing here)
    // and passes, but anything after it in the document becomes body.
    expectViolation(html`<script/>x</script>`, "fence.script-body");
    expectClean(html`<script src="/a.js"/>`);
  });
});

describe("fence.comment-value — nothing is escapable inside a comment", () => {
  test("a value inside a comment fails", () => {
    expectViolation(html`<!--${"foo"}-->`, "fence.comment-value");
  });

  test("a value that spells '-->' still fails (the comment region is found in the output, where the value is escaped)", () => {
    const doc = html`<!--${"--> <script>alert(1)</script>"}-->`;
    // the escaped value can no longer close the comment with raw '-->',
    // but the value is still INSIDE the comment region — the rule fires.
    expectViolation(doc, "fence.comment-value");
  });

  test("an unterminated comment to EOF still fences its values", () => {
    expectViolation(html`<!--${"x"}`, "fence.comment-value");
  });

  test("the '<!-->' shape: per the HTML tokenizer the '>' CLOSES an empty comment", () => {
    // Spec (comment-start state, '>'): incorrect-comment-syntax parse error,
    // comment emitted — `<!-->` is a closed empty comment, NOT an open one.
    // The value after it is ordinary escaped text; the trailing `-->` is
    // literal text. The old fence ran the comment to EOF and falsely fenced
    // the value.
    expectClean(html`<!--> ${"x"} -->`);
    // `<!--->` (comment-start-dash sees '>') closes the same way:
    expectClean(html`<!--->${"x"}`);
    // `--!>` (comment end-bang state) also closes:
    expectClean(html`<!--a--!>${"x"}`);
    expectClean(html`<!--a--->${"x"}`); // `--->` closes at the second dash pair
    // and the genuinely unterminated shape still fences its values:
    expectViolation(html`<!--${"x"}`, "fence.comment-value");
  });

  test("a value ADJACENT to a comment (not inside it) passes", () => {
    expectClean(html`<!--c-->${"x"}`);
    expectClean(html`${"x"}<!--c-->`);
  });

  test("a doctype is not a comment region and carries no values", () => {
    expectClean(html`<!DOCTYPE html><html><body>${"x"}</body></html>`);
  });
});

describe("fence.dynamic-tag-name / fence.dynamic-attr-name — static names only", () => {
  test("a dynamic tag name fails", () => {
    expectViolation(html`<${"div"}>`, "fence.dynamic-tag-name");
  });

  test("a dynamic tag name that only PARTIALLY overlaps the name still fails", () => {
    // the value renders "foo" into "<foodiv>" — the name is "foodiv", the
    // value range covers its first three chars: partial overlap is overlap.
    expectViolation(html`<${"foo"}div>`, "fence.dynamic-tag-name");
  });

  test("a dynamic attribute name fails", () => {
    expectViolation(html`<a ${"title"}="x">`, "fence.dynamic-attr-name");
  });

  test("static tag/attribute names pass", () => {
    expectClean(html`<div class="x">text</div>`);
    expectClean(html`<a title="x" href="/y">z</a>`);
  });
});

describe("fence.event-handler — /^on/i attributes are banned", () => {
  test("a literal onclick fails", () => {
    expectViolation(html`<a onclick="x()">`, "fence.event-handler");
  });

  test("literal onmouseover / onchange variants fail", () => {
    expectViolation(html`<a onmouseover="x()">`, "fence.event-handler");
    expectViolation(html`<form onchange="x()">`, "fence.event-handler");
  });

  test("a dynamic value that renders 'onclick' fails (the RENDERED name is checked)", () => {
    const all = codes(html`<a ${"onclick"}="x()">`);
    expect(all).toContain("fence.event-handler");
    expect(all).toContain("fence.dynamic-attr-name");
  });

  test("uppercase ONCLICK fails", () => {
    expectViolation(html`<a ONCLICK="x()">`, "fence.event-handler");
  });

  test("non-handler attributes pass (controls)", () => {
    expectClean(html`<a class="onward" title="only once">x</a>`);
  });
});

describe("fence.ping-attr / fence.srcdoc-attr — banned outright", () => {
  test("a literal ping attribute fails", () => {
    expectViolation(html`<a ping="/x" href="/y">`, "fence.ping-attr");
  });

  test("uppercase PING and SRCDOC fail (names are case-insensitive)", () => {
    expectViolation(html`<a PING="/x">`, "fence.ping-attr");
    expectViolation(html`<iframe SRCDOC="x">`, "fence.srcdoc-attr");
  });

  test("a dynamic ping/srcdoc name fails too", () => {
    expect(codes(html`<a ${"ping"}="/x">`)).toContain("fence.ping-attr");
    expect(codes(html`<iframe ${"srcdoc"}="x">`)).toContain("fence.srcdoc-attr");
  });

  test("other attributes with similar spellings pass (controls)", () => {
    expectClean(html`<a ping-pong="x" href="/y">`);
  });
});

describe("fence.unquoted-attribute — values must be quoted", () => {
  test("an unquoted value fails", () => {
    expectViolation(html`<a href=/x>y</a>`, "fence.unquoted-attribute");
  });

  test("an unquoted value containing '>' is cut at the '>', not swallowed", () => {
    // the value is "/x"; the tag continues after the '>'
    expectViolation(html`<a href=/x y=1></a>`, "fence.unquoted-attribute");
    // control: a quoted value containing '>' is one value, no violation
    expectClean(html`<a title="a>b" href="/x"></a>`);
  });

  test("a quoted value containing '>' does not confuse the scanner (tag boundaries stay correct)", () => {
    // If the scanner ended the <a> tag at the '>' INSIDE the quotes, the
    // onclick below would be parsed as text and the event-handler violation
    // would be MISSED — a false pass. The violation must fire.
    expectViolation(html`<a title="a>b" onclick="x()">`, "fence.event-handler");
    // the task's literal shape: src belongs to the <script> tag; the
    // unquoted value is flagged on that tag, proving correct attribution.
    expectViolation(html`<a title="a>b"><script src=x></a>`, "fence.unquoted-attribute");
    // and the benign version of the same shape is clean
    expectClean(html`<a title="a>b"><script src="/x.js"></script></a>`);
  });

  test("a value-less attribute is NOT an unquoted value (empty URLs are same-origin by construction)", () => {
    expectClean(html`<a href></a>`);
    expectClean(html`<a href= ></a>`);
  });

  test("uppercase attribute names with unquoted values fail", () => {
    expectViolation(html`<A HREF=/x>`, "fence.unquoted-attribute");
    expectClean(html`<A HREF="/x">`);
  });

  test("a quoted value that never closes is fence.unterminated (the rest of the document is consumed by it)", () => {
    // Note: `<a href="/x">` (with the closing quote) is NOT unterminated —
    // the value is "/x" and the tag closes normally. The violation needs a
    // genuinely unclosed quote.
    expectViolation(html`<a href="/x`, "fence.unterminated");
    // everything after the opening quote — including what looks like a
    // second tag — is consumed by the value: the scanner must NOT parse the
    // swallowed markup, and the violation must still be reported
    const all = codes(html`<a href="/x<b onclick y>`);
    expect(all).toContain("fence.unterminated");
    expect(all).not.toContain("fence.event-handler");
  });
});

describe("fence.url-attribute — tracked values in URL-bearing attributes are policy-checked", () => {
  test("a tracked javascript: value is caught even though the author never called url()", () => {
    expectViolation(html`<a href="${"javascript:alert(1)"}">x</a>`, "fence.url-attribute");
  });

  test("a LITERAL javascript: value passes (trusted author markup — the fence polices data, not the author)", () => {
    // Documented policy: the author's own static markup is the trust
    // boundary. If the author writes a javascript: URL by hand, that is
    // their decision — the fence exists for interpolated VALUES, which the
    // author may not control. (Deploy-time CSP is the second line.)
    expectClean(html`<a href="javascript:alert(1)">x</a>`);
  });

  test("every URL-bearing attribute is checked, not just href", () => {
    expectViolation(html`<img src="${"javascript:alert(1)"}">`, "fence.url-attribute");
    expectViolation(html`<form action="${"data:text/html,x"}">`, "fence.url-attribute");
    expectViolation(html`<button formaction="${"vbscript:x"}">`, "fence.url-attribute");
    expectViolation(html`<video poster="${"file:///etc/passwd"}">`, "fence.url-attribute");
    expectViolation(html`<q cite="${"blob:https://x/uuid"}">`, "fence.url-attribute");
    expectViolation(html`<td background="${"about:blank"}">`, "fence.url-attribute");
    expectViolation(html`<object data="${"ftp://files.example"}">`, "fence.url-attribute");
  });

  test("the ENTIRE decoded value is checked, so literal+value mixes cannot split a scheme", () => {
    // The value renders "java"; the literal completes "script:x". The
    // browser sees one URL — the check must run on the whole thing.
    expectViolation(html`<a href="${"java"}script:alert(1)">x</a>`, "fence.url-attribute");
  });

  test("entity smuggling is killed: the fence decodes the value before the policy, so &#10; reappears", () => {
    // Author value "java&#10;script:alert(1)" is escaped to
    // "java&amp;#10;script:alert(1)" in the document. WITHOUT a decode step
    // the raw text has no `&#` and resolves as a same-origin relative — a
    // false pass, while the browser decodes once and executes javascript:.
    expectViolation(html`<a href="${"java&#10;script:alert(1)"}">x</a>`, "fence.url-attribute");
  });

  test("protocol-relative, userinfo, and control-char values are caught through the fence", () => {
    expectViolation(html`<a href="${"//evil.example"}">x</a>`, "fence.url-attribute");
    expectViolation(html`<a href="${"https://user:pass@x.dev"}">x</a>`, "fence.url-attribute");
    expectViolation(html`<a href="${"java\tscript:x"}">x</a>`, "fence.url-attribute");
  });

  test("an unquoted value that is also a tracked URL value reports BOTH violations", () => {
    const all = codes(html`<a href=${"javascript:x"}>`);
    expect(all).toContain("fence.unquoted-attribute");
    expect(all).toContain("fence.url-attribute");
  });

  test("legitimate values pass: same-site relatives, fragments, and EXTERNAL absolute http(s)", () => {
    expectClean(html`<a href="${"/about"}">x</a>`);
    expectClean(html`<a href="${"./about"}">x</a>`, "/docs");
    expectClean(html`<a href="${"#section"}">x</a>`);
    expectClean(html`<a href="${"https://other.example/x?q=1#f"}">x</a>`);
    expectClean(html`<a href="${"mailto:x@y.com"}">x</a>`);
    expectClean(html`<a href="${"tel:+15551234567"}">x</a>`);
    expectClean(html`<a href="${"sms:1555"}">x</a>`);
  });
});

describe("scanner shapes — doctype, self-closing, closing tags, plain text", () => {
  test("a doctype is inert", () => {
    expectClean(html`<!DOCTYPE html>`);
    expectClean(html`<!doctype html><html>`);
  });

  test("self-closing tags parse; the '/' is just a marker", () => {
    expectClean(html`<br/>`);
    expectClean(html`<img src="/x.png" alt="a>b" />`);
  });

  test("closing tags are consumed (no attribute checks apply to them)", () => {
    expectClean(html`<div><span>x</span></div>`);
  });

  test("a '<' that is not a tag is plain text (e.g. a < b)", () => {
    expectClean(html`a < b and 5 > 3`);
  });

  test("a real page shape passes end to end", () => {
    const doc = html`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>t</title>
    <link rel="stylesheet" href="/assets/main.css">
    <script src="/assets/app.js" defer></script>
  </head>
  <body>
    <main><a href="/docs" title="a>b">docs</a></main>
    <!-- nothing dynamic here -->
  </body>
</html>`;
    expectClean(doc);
  });
});

describe("named entities cannot smuggle a scheme — conservative `&name;` rejection", () => {
  // Browsers decode the FULL HTML5 named-entity set in attribute values
  // BEFORE the URL parser runs. &Tab;/&NewLine; decode to characters the
  // URL parser strips; &colon; decodes to ':'. The fence decodes only the
  // five entities html.ts emits plus numeric references, so ANY surviving
  // `&name;` in a tracked URL value is rejected outright.
  test("&Tab; / &NewLine; / &colon; smuggling is caught through the fence", () => {
    expectViolation(html`<a href="${"java&Tab;script:alert(1)"}">x</a>`, "fence.url-attribute");
    expectViolation(html`<a href="${"java&NewLine;script:alert(1)"}">x</a>`, "fence.url-attribute");
    expectViolation(html`<a href="${"javascript&colon;alert(1)"}">x</a>`, "fence.url-attribute");
  });

  test("numeric references are DECODED first, so the scheme reappears", () => {
    expectViolation(html`<a href="${"&#106;avascript:alert(1)"}">x</a>`, "fence.url-attribute");
    expectViolation(html`<a href="${"&#x6a;avascript:x"}">x</a>`, "fence.url-attribute");
    // `&#106` WITHOUT a semicolon is still decoded by browsers — but the raw
    // `&#` substring check catches it regardless of the decoder:
    expectViolation(html`<a href="${"&#106avascript:x"}">x</a>`, "fence.url-attribute");
  });

  test("legitimate `&` usage in URLs passes (controls)", () => {
    expectClean(html`<a href="${"https://x.dev/?a=1&b=2"}">x</a>`);
    expectClean(html`<a href="${"/search?q=a&lang=en"}">x</a>`);
    expectClean(html`<a href="${"mailto:x@y.com?subject=hi&body=2"}">x</a>`);
  });
});

describe("raw-text end tags are case-insensitive (</SCRIPT> closes <script>)", () => {
  test("uppercase end tag does not leak the rest of the document into the body", () => {
    // A case-sensitive `</script` match would run the body to EOF: a false
    // script-body here, AND the rest of the document never scanned (a real
    // violation after it could be missed).
    expectClean(html`<SCRIPT src="/a.js"></SCRIPT><p>${"hi"}</p>`);
    expectClean(html`<script src="/a.js"></SCRIPT>`);
    expectClean(html`<Style></STYLE>${"x"}`);
  });

  test("a body is still caught when the end tag never matches", () => {
    expectViolation(html`<SCRIPT>alert(1)</SCRIPT>`, "fence.script-body");
    expectViolation(html`<script src="/a.js"></scriptX><p>${"hi"}</p>`, "fence.script-body");
  });
});

describe("markup split across template boundaries — the scanner sees the FINAL string", () => {
  test("an attribute assembled from two Html nodes is still one attribute", () => {
    // `<a hr` + `ef="…"` concatenate to `<a href="…"` — provenance does not
    // matter; ranges merge by offset and the scanner parses the output.
    const evil = "javascript:alert(1)";
    expectViolation(html`<a hr${html`ef="${evil}">`}x</a>`, "fence.url-attribute");
  });

  test("a tag name assembled across three levels is caught", () => {
    const i = html`i`;
    expectViolation(html`<scr${i}pt>alert(1)</scr${i}pt>`, "fence.script-body");
  });

  test("the same child interpolated TWICE is policed at BOTH positions", () => {
    const f = html`<a href="${"javascript:alert(1)"}">x</a>`;
    const all = codes(html`<div>${f}</div><span>${f}</span>`);
    expect(all.filter((c) => c === "fence.url-attribute").length).toBe(2);
  });
});

describe("RCDATA-ish contexts — a raw `</textarea>` can only come from trusted markup", () => {
  test("a value cannot close a <textarea> (escaped; the fence sees inert text)", () => {
    const evil = "</textarea><img src=x onerror=alert(1)>";
    const doc = html`<textarea>${evil}</textarea>`;
    expectClean(doc);
    expect(renderToString(doc)).toContain("&lt;/textarea&gt;");
  });

  test("same for <title> and <style>-adjacent markup", () => {
    expectClean(html`<title>${"</title><script>alert(1)</script>"}</title>`);
    expectClean(html`<title>${"</title>"}</title><p>${"x"}</p>`);
  });

  test("a raw </textarea> from trusted markup is plain text (no RCDATA model needed)", () => {
    // Because values are ALWAYS escaped, the only way a raw `</textarea>`
    // enters the document is trusted literal markup — the author's own text,
    // which is the trust boundary. The fence therefore does not need a
    // textarea/title model: no tracked range can ever sit inside RCDATA
    // without also being escaped text.
    expectClean(trustedHtml("<textarea></textarea>"));
    expectClean(html`<textarea>${""}</textarea>`);
  });
});

describe("EOF and stray-< shapes — the scanner never crashes, never hangs", () => {
  test("unclosed tag at EOF", () => {
    expectClean(html`<a href="/x"`);
    expectClean(html`<a`);
    expectClean(html`<a href=`);
    // an unclosed QUOTE is still fence.unterminated (document rejected):
    expectViolation(html`<a href="${"/x"}`, "fence.unterminated");
  });

  test("stray '<' and '<' followed by non-letter are text", () => {
    expectClean(html`a < b`);
    expectClean(html`5<1 and 2<=3`);
    expectClean(html`<1><3>`);
    expectClean(html`<`);
    expectClean(html`</`);
    expectClean(html`</div`);
  });

  test("doctype variants, processing instructions, CDATA, bogus comments are inert", () => {
    expectClean(html`<!doctype html>`);
    expectClean(html`<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">`);
    expectClean(html`<?xml version="1.0"?>`);
    expectClean(html`<![CDATA[ raw & <stuff> ]]>`);
    expectClean(html`<!bogus>`);
  });

  test("conditional comments are comments — values inside them are fenced", () => {
    expectViolation(html`<!--[if IE]>${"x"}<![endif]-->`, "fence.comment-value");
  });
});

describe("composition — ranges survive three levels of nesting", () => {
  test("a value three templates deep still trips the fence (javascript: into an outer href)", () => {
    const scheme = "javascript:"; // the value: lives at the innermost level
    const inner = html`${scheme}alert(1)`;
    const mid = html`<a href="${inner}">x</a>`;
    const outer = html`<html><body>${mid}</body></html>`;
    expectViolation(outer, "fence.url-attribute");
  });
});

describe("performance — the fence is linear, no backtracking", () => {
  test("a ~1MB document renders and finalizes well under a second", () => {
    const items: Html[] = [];
    for (let i = 0; i < 20000; i++) {
      items.push(
        html`<div class="item"><a href="/item/${i}" title="lorem ipsum dolor sit amet">link ${i}</a></div>`,
      );
    }
    const doc = html`<!DOCTYPE html><html><head><title>t</title></head><body>${items}</body></html>`;

    const start = Date.now();
    const out = render(doc);
    const elapsed = Date.now() - start;

    expect(out.length).toBeGreaterThan(900_000);
    expect(elapsed).toBeLessThan(1000);
  });

  test("20k comments × 20k tracked values stays linear (merge, not nested loop)", () => {
    // The naive range×comment loop is quadratic here (~400M ops). The merge
    // scan must keep this in the same ballpark as the plain 1MB doc above.
    const items: Html[] = [];
    for (let i = 0; i < 20000; i++) items.push(html`<!--c--><b>${"v"}</b>`);
    const doc = html`<body>${items}</body>`;
    const start = Date.now();
    const out = render(doc);
    const elapsed = Date.now() - start;
    expect(out.length).toBeGreaterThan(300_000);
    expect(elapsed).toBeLessThan(1000);
  });

  test("`&` soup and long attribute runs are linear (no backtracking)", () => {
    // 1MB of `&` in text positions, plus a huge tracked URL value full of
    // entities (decodeEntities must stay single-pass).
    const soup = "&".repeat(500_000);
    const urlValue = "https://x.dev/?".padEnd(400_000, "&a=1");
    const doc = html`<p>${soup}</p><a href="${urlValue}">x</a>`;
    const start = Date.now();
    const out = render(doc);
    const elapsed = Date.now() - start;
    expect(out.length).toBeGreaterThan(1_000_000);
    expect(elapsed).toBeLessThan(1500);
  });
});
