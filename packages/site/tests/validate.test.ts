// The step-7 validator (plan §4.7) — unit tests over hand-built EmittedPage
// records. The build wires the real ones (tests/build.test.ts pins the e2e:
// a broken .md link and a link to a draft each fail a production build with
// the line named and the previous output untouched).
//
// Severity (plan §5, pinned here — the honest-failure mutations verified
// during development are the fragment check and the draft severity):
//   - link.broken and link.draft: ERROR in mode "build", WARNING in "dev"
//     (the dev server renders and serves drafts, so those links resolve
//     there — they are demoted, never silenced);
//   - link.missing-fragment and every metadata.* code: ERROR in every mode;
//   - a link to the generated /404 route: link.broken in every mode, at the
//     mode's link severity (the 404 page is not a link target — plan,
//     "Locked decisions" 2);
//   - a draft page's OWN links: not validated in "build" mode (the draft is
//     not emitted — validating bytes that will never be published would
//     produce false errors), validated in "dev".
//
// External URLs never reach the validator: the renderer records only
// INTERNAL destinations in page.links (pinned in tests/markdown.test.ts),
// so "no fragment checks on external URLs" holds by construction.

import { describe, expect, test } from "bun:test";
import type { DiagnosticCode } from "../src/diagnostics";
import { renderToString } from "../src/html";
import { renderMarkdown } from "../src/markdown";
import type { InternalLink } from "../src/types";
import { collectIds, type EmittedPage, type KnownRoute, validatePages } from "../src/validate";

const SITE = "https://site.dev";

/**
 * A well-formed emitted document: hand-written charset, N <title> tags,
 * N rel="canonical" links (head() shape), and a raw body. Counts of 0
 * build the "missing" variants; >1 the "duplicate" variants.
 */
function DOC(
  opts: { body?: string; charset?: number; titles?: number; canonical?: number } = {},
): string {
  const head: string[] = [];
  for (let i = 0; i < (opts.charset ?? 1); i++) head.push('<meta charset="utf-8">');
  const titles = opts.titles ?? 1;
  for (let i = 0; i < titles; i++) head.push(`<title>T${titles === 1 ? "" : i + 1}</title>`);
  for (let i = 0; i < (opts.canonical ?? 1); i++)
    head.push('<link rel="canonical" href="https://site.dev/">');
  return `<!doctype html><html lang="en"><head>${head.join("")}</head><body>${opts.body ?? ""}</body></html>`;
}

/** An internal link with the field under test overridden. */
function link(partial: Partial<InternalLink> & { route: string }): InternalLink {
  return { fragment: null, line: null, exists: true, isDraft: false, kind: "page", ...partial };
}

/** One emitted page record. */
function page(
  route: string,
  sourcePath: string,
  html: string,
  links: InternalLink[] = [],
): EmittedPage {
  return { route, sourcePath, html, links };
}

/** The known-route map: [route, isDraft] pairs. */
function routes(...entries: Array<[string, boolean]>): Map<string, KnownRoute> {
  return new Map(entries.map(([route, draft]) => [route, { draft }] as [string, KnownRoute]));
}

// ---------------------------------------------------------------------------
// link.broken
// ---------------------------------------------------------------------------

describe("link.broken", () => {
  test("names the source page, the line and the destination (error in build)", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/missing", line: 6, exists: false })]),
      ],
      routes: routes(["/", false]),
    });
    expect(diags).toEqual([
      {
        code: "link.broken",
        severity: "error",
        sourcePath: "content/index.md",
        line: 6,
        message:
          'internal link on line 6 of "content/index.md" points at "/missing": ' +
          "that route is not a page of this site (not in the route table, not a draft)",
      },
    ]);
  });

  test('a link with no line coordinate says "in", never "on line"', () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [
          link({ route: "/missing", line: null, exists: false }),
        ]),
      ],
      routes: routes(["/", false]),
    });
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("link.broken");
    expect(diags[0].line).toBeUndefined();
    expect(diags[0].message).toContain('in "content/index.md"');
    expect(diags[0].message).not.toContain("on line");
  });

  test("demoted to a WARNING in dev mode (plan §5 — the dev server serves the rest of the site)", () => {
    const options = {
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/missing", line: 6, exists: false })]),
      ],
      routes: routes(["/", false]),
    };
    expect(validatePages({ mode: "build", ...options })[0].severity).toBe("error");
    expect(validatePages({ mode: "dev", ...options })[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// the /404 destination
// ---------------------------------------------------------------------------

describe("the /404 destination", () => {
  test("a link to the 404 route is link.broken — the generated 404 is not a link target (every mode)", () => {
    const options = {
      pages: [page("/", "content/index.md", DOC(), [link({ route: "/404", line: 9 })])],
      // the build excludes /404 from the map; the special case fires either way
      routes: routes(["/", false]),
    };
    const buildDiags = validatePages({ mode: "build", ...options });
    expect(buildDiags).toEqual([
      {
        code: "link.broken",
        severity: "error",
        sourcePath: "content/index.md",
        line: 9,
        message:
          'internal link on line 9 of "content/index.md" points at "/404": ' +
          "the 404 page is generated, not authored content, and is not a link target",
      },
    ]);
    // dev keeps the diagnosis, at the mode's link severity
    expect(validatePages({ mode: "dev", ...options })[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// link.draft
// ---------------------------------------------------------------------------

describe("link.draft", () => {
  test("a link to a draft page: ERROR in a production build, WARNING in dev", () => {
    const options = {
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/draft", line: 6, isDraft: true })]),
      ],
      routes: routes(["/", false], ["/draft", true]),
    };
    const buildDiags = validatePages({ mode: "build", ...options });
    expect(buildDiags).toEqual([
      {
        code: "link.draft",
        severity: "error",
        sourcePath: "content/index.md",
        line: 6,
        message:
          'internal link on line 6 of "content/index.md" points at the draft page "/draft": ' +
          "drafts are not published — the link would 404 on the production site",
      },
    ]);
    const devDiags = validatePages({ mode: "dev", ...options });
    expect(devDiags).toHaveLength(1);
    expect(devDiags[0].code).toBe("link.draft");
    expect(devDiags[0].severity).toBe("warning");
    expect(devDiags[0].message).toContain("would 404 on the production build");
  });

  test("a fragment on a link to a draft is NOT fragment-checked in build (the draft is not emitted — no double report)", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [
          link({ route: "/draft", fragment: "nope", line: 6, isDraft: true }),
        ]),
      ],
      routes: routes(["/", false], ["/draft", true]),
    });
    expect(diags.map((d) => d.code)).toEqual(["link.draft"]);
  });
});

// ---------------------------------------------------------------------------
// a draft page's OWN links
// ---------------------------------------------------------------------------

describe("a draft page's own links", () => {
  test("are NOT validated in build mode (a draft is not emitted — validating it would be a false error)", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/d", "content/d.md", DOC(), [link({ route: "/missing", line: 8, exists: false })]),
      ],
      routes: routes(["/d", true]),
    });
    expect(diags).toEqual([]);
  });

  test("in dev the draft IS emitted: its broken link is flagged (warning) like any page's", () => {
    const diags = validatePages({
      mode: "dev",
      pages: [
        page("/d", "content/d.md", DOC(), [link({ route: "/missing", line: 8, exists: false })]),
      ],
      routes: routes(["/d", true]),
    });
    expect(diags).toEqual([
      {
        code: "link.broken",
        severity: "warning",
        sourcePath: "content/d.md",
        line: 8,
        message:
          'internal link on line 8 of "content/d.md" points at "/missing": ' +
          "that route is not a page of this site (not in the route table, not a draft)",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// fragments (against the FINAL EMITTED ids)
// ---------------------------------------------------------------------------

describe("fragments", () => {
  test("a fragment that matches a markdown heading id in the destination's emitted html passes", () => {
    // the id is produced by the real renderer (GitHub slug of "Hello World")
    const destBody = renderMarkdown("# Hello World\n\nText.", {
      sourcePath: "content/d.md",
      bodyStartLine: 5,
      siteUrl: SITE,
      pageRoute: "/d",
    }).html;
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [
          link({ route: "/d", fragment: "hello-world", line: 6 }),
        ]),
        page("/d", "content/d.md", DOC({ body: renderToString(destBody) })),
      ],
      routes: routes(["/", false], ["/d", false]),
    });
    expect(diags).toEqual([]);
  });

  test("a fragment that matches a HAND-WRITTEN id in the destination's layout markup passes", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/d", fragment: "toc", line: 6 })]),
        page("/d", "content/d.md", DOC({ body: '<div id="toc">jump</div>' })),
      ],
      routes: routes(["/", false], ["/d", false]),
    });
    expect(diags).toEqual([]);
  });

  test("a fragment the destination's emitted html lacks is link.missing-fragment (error in every mode)", () => {
    const options = {
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/d", fragment: "nope", line: 6 })]),
        page("/d", "content/d.md", DOC({ body: '<h1 id="present">Present</h1>' })),
      ],
      routes: routes(["/", false], ["/d", false]),
    };
    const buildDiags = validatePages({ mode: "build", ...options });
    expect(buildDiags).toEqual([
      {
        code: "link.missing-fragment",
        severity: "error",
        sourcePath: "content/index.md",
        line: 6,
        message:
          'internal link on line 6 of "content/index.md" carries fragment "nope" ' +
          'but the emitted document for "/d" contains no id="nope"',
      },
    ]);
    // metadata problems are errors in every mode; so is a dead anchor
    expect(validatePages({ mode: "dev", ...options })[0].severity).toBe("error");
  });

  test("same-page fragments (a pure #link) check the page's OWN emitted ids", () => {
    const options = {
      pages: [
        page("/self", "content/self.md", DOC({ body: '<h1 id="hello">Hello</h1>' }), [
          link({ route: "/self", fragment: "hello", kind: "fragment", line: 7 }),
        ]),
      ],
      routes: routes(["/self", false]),
    };
    expect(validatePages({ mode: "build", ...options })).toEqual([]);
    const missing = validatePages({
      mode: "build",
      pages: [
        page("/self", "content/self.md", DOC({ body: '<h1 id="hello">Hello</h1>' }), [
          link({ route: "/self", fragment: "nope", kind: "fragment", line: 7 }),
        ]),
      ],
      routes: routes(["/self", false]),
    });
    expect(missing[0].code).toBe("link.missing-fragment");
    expect(missing[0].message).toContain('for "/self"');
  });

  test("a link to a destination that was NOT emitted (e.g. a dropped page) is not fragment-checked", () => {
    // no /d in `pages`: the fragment is silently skipped (the link itself is
    // still judged — here /d is a known draft, so only link.draft reports)
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/d", fragment: "nope", line: 6 })]),
      ],
      routes: routes(["/", false], ["/d", false]),
    });
    expect(diags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// metadata (per emitted page, INCLUDING the generated 404)
// ---------------------------------------------------------------------------

describe("metadata", () => {
  const options = (html: string, mode: "build" | "dev" = "build") => ({
    mode,
    pages: [page("/", "content/index.md", html)],
    routes: routes(["/", false]),
  });

  test("a document with no <meta charset> is metadata.charset-missing", () => {
    const diags = validatePages(options(DOC({ charset: 0 })));
    expect(diags).toEqual([
      {
        code: "metadata.charset-missing",
        severity: "error",
        sourcePath: "content/index.md",
        message:
          'the emitted document for "content/index.md" has no <meta charset>: ' +
          "the layout must hand-write one (head() never emits charset)",
      },
    ]);
  });

  test("a document with two <meta charset> tags is metadata.charset-duplicate", () => {
    const diags = validatePages(options(DOC({ charset: 2 })));
    expect(diags).toEqual([
      {
        code: "metadata.charset-duplicate",
        severity: "error",
        sourcePath: "content/index.md",
        message:
          'the emitted document for "content/index.md" carries 2 <meta charset> tags: exactly one is required',
      },
    ]);
  });

  test("a document with no <title> is metadata.title-missing", () => {
    const diags = validatePages(options(DOC({ titles: 0 })));
    expect(diags).toEqual([
      {
        code: "metadata.title-missing",
        severity: "error",
        sourcePath: "content/index.md",
        message:
          'the emitted document for "content/index.md" has no <title>: ' +
          "the layout must include ctx.head() (head() is the only <title> producer)",
      },
    ]);
  });

  test("a document with two <title> tags is metadata.title-duplicate", () => {
    const diags = validatePages(options(DOC({ titles: 2 })));
    expect(diags).toEqual([
      {
        code: "metadata.title-duplicate",
        severity: "error",
        sourcePath: "content/index.md",
        message:
          'the emitted document for "content/index.md" carries 2 <title> tags: exactly one is required',
      },
    ]);
  });

  test("a layout that never called head() (no canonical) is metadata.head-missing", () => {
    const diags = validatePages(options(DOC({ titles: 0, canonical: 0 })));
    // no canonical IS head-missing (head() is the only canonical producer);
    // the missing title is reported too — every broken head fact surfaces
    expect(diags.map((d) => d.code)).toEqual(["metadata.head-missing", "metadata.title-missing"]);
    expect(diags.map((d) => d.severity)).toEqual(["error", "error"]);
  });

  test('a document with two rel="canonical" links is metadata.canonical-duplicate', () => {
    const diags = validatePages(options(DOC({ canonical: 2 })));
    expect(diags).toEqual([
      {
        code: "metadata.canonical-duplicate",
        severity: "error",
        sourcePath: "content/index.md",
        message:
          'the emitted document for "content/index.md" carries 2 rel="canonical" links: exactly one is required',
      },
    ]);
  });

  test("a well-formed document (one of each) is silent", () => {
    expect(validatePages(options(DOC()))).toEqual([]);
  });

  test("metadata problems are ERRORS in dev mode too (a broken head is broken output everywhere)", () => {
    for (const html of [DOC({ charset: 0 }), DOC({ titles: 0 }), DOC({ canonical: 0 })]) {
      const diags = validatePages(options(html, "dev"));
      expect(diags.length).toBeGreaterThan(0);
      expect(diags.every((d) => d.severity === "error")).toBe(true);
    }
  });

  test("the generated 404 page is metadata-checked like any page", () => {
    const diags = validatePages({
      mode: "build",
      pages: [page("/404", "<generated>", DOC({ titles: 0, canonical: 0 }))],
      routes: new Map(),
    });
    expect(diags.map((d) => d.code).sort()).toEqual([
      "metadata.head-missing",
      "metadata.title-missing",
    ]);
    expect(diags.every((d) => d.sourcePath === "<generated>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectIds + output order
// ---------------------------------------------------------------------------

describe("collectIds", () => {
  test("matches both quote styles and case-insensitive attribute names, in any position", () => {
    const html = '<div ID="top"></div><section id=\'mid\'></section><h1 class="x" Id="end"></h1>';
    expect([...collectIds(html)].sort()).toEqual(["end", "mid", "top"]);
  });

  test("only a real id attribute (whitespace-delimited) — not data-id, not text", () => {
    const html = '<div data-id="fake">id="escaped&quot; in text</div><span id="real">';
    expect(collectIds(html)).toEqual(new Set(["real"]));
  });
});

describe("output order", () => {
  test("diagnostics are sorted (sourcePath, line, code) regardless of input order", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page("/b", "content/b.md", DOC({ charset: 0 }), [
          link({ route: "/missing", line: 3, exists: false }),
        ]),
        page("/a", "content/a.md", DOC({ titles: 0 }), [
          link({ route: "/missing", line: 2, exists: false }),
        ]),
      ],
      routes: routes(["/a", false], ["/b", false]),
    });
    // line-less diagnostics (metadata) sort before lined ones per page
    expect(diags.map((d) => [d.sourcePath, d.line ?? -1, d.code] as const)).toEqual([
      ["content/a.md", -1, "metadata.title-missing"],
      ["content/a.md", 2, "link.broken"],
      ["content/b.md", -1, "metadata.charset-missing"],
      ["content/b.md", 3, "link.broken"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// scanning honesty (chunk 8 review): the scanners must not be fooled by
// bytes that LOOK like metadata/ids but are not (escaped code, comments,
// svg titles) — each case failed against the naive first implementation.
// ---------------------------------------------------------------------------

describe("fragment scanning honesty", () => {
  test("an id inside a markdown code fence is escaped text — never collected", () => {
    // html:false escaping turns `id="fence-id"` into id=&quot;fence-id&quot;,
    // which the quoted-only scanner cannot match. This is WHY quoted-only is
    // sound: a quoted id can never survive escaping, so a regex hit is always
    // a real attribute.
    const body = renderToString(
      renderMarkdown('```html\n<div id="fence-id">x</div>\n```\n\n`id="inline-id"`\n', {
        sourcePath: "content/d.md",
        bodyStartLine: 1,
        siteUrl: SITE,
        pageRoute: "/d",
      }).html,
    );
    expect(body).not.toContain('id="fence-id"');
    expect(collectIds(body)).toEqual(new Set());
  });

  test("PINNED DECISION: ids are quoted-only — unquoted id= in layout markup is NOT recognized", () => {
    // Broadening to unquoted values is UNSOUND, not just unfinished: an
    // unquoted `id=x` inside a code fence contains no escapable characters,
    // survives escaping verbatim, and would be byte-identical to layout
    // markup — false-passing fragments from code samples. Quoted-only is the
    // sound line; layouts must quote their ids (documented in the header).
    expect(collectIds("<div id=toc>x</div>")).toEqual(new Set());
    expect(collectIds("<div id=\"toc\">x</div><span id='sq'></span>")).toEqual(
      new Set(["sq", "toc"]),
    );
  });

  test("an id inside an HTML comment is not an id — a fragment link to it is link.missing-fragment", () => {
    const diags = validatePages({
      mode: "build",
      pages: [
        page(
          "/",
          "content/index.md",
          DOC({ body: '<!-- <h1 id="ghost">g</h1> --><h1 id="real">r</h1>' }),
          [
            link({ route: "/", fragment: "ghost", kind: "fragment", line: 4 }),
            link({ route: "/", fragment: "real", kind: "fragment", line: 5 }),
          ],
        ),
      ],
      routes: routes(["/", false]),
    });
    // only the ghost fragment fails; the real one passes
    expect(diags.map((d) => [d.code, d.message.includes('"ghost"')])).toEqual([
      ["link.missing-fragment", true],
    ]);
  });
});

describe("metadata scanning honesty", () => {
  const check = (html: string, mode: "build" | "dev" = "build") =>
    validatePages({
      mode,
      pages: [page("/", "content/index.md", html)],
      routes: routes(["/", false]),
    }).map((d) => d.code);

  test("a commented-out <meta charset> does NOT satisfy the charset check", () => {
    expect(
      check(
        '<!doctype html><html><head><!-- <meta charset="utf-8"> --><title>T</title>' +
          '<link rel="canonical" href="x"></head><body></body></html>',
      ),
    ).toEqual(["metadata.charset-missing"]);
  });

  test("a commented-out <title> and canonical do NOT satisfy their checks", () => {
    expect(
      check(
        '<!doctype html><html><head><meta charset="utf-8">' +
          '<!-- <title>T</title><link rel="canonical" href="x"> --></head><body></body></html>',
      ),
    ).toEqual(["metadata.head-missing", "metadata.title-missing"]);
  });

  test("an svg <title> is not the document title: alone it does not satisfy the check", () => {
    // (the missing canonical still fires — head() was never called)
    expect(
      check(
        '<!doctype html><html><head><meta charset="utf-8"></head><body><svg><title>icon</title></svg>' +
          "</body></html>",
      ),
    ).toEqual(["metadata.head-missing", "metadata.title-missing"]);
  });

  test("an svg <title> alongside head()'s title is NOT a title-duplicate", () => {
    expect(
      check(
        '<!doctype html><html><head><meta charset="utf-8"><title>T</title>' +
          '<link rel="canonical" href="x"></head><body><svg><title>icon</title></svg></body></html>',
      ),
    ).toEqual([]);
  });

  test("a real <title> after a closed svg still counts (depth tracking does not swallow it)", () => {
    expect(
      check(
        '<!doctype html><html><head><meta charset="utf-8"><title>T</title>' +
          '<link rel="canonical" href="x"></head><body><svg><title>i</title></svg><p>t</p></body></html>',
      ),
    ).toEqual([]);
  });

  test("rel='canonical' single-quoted (hand-written layout markup) is detected", () => {
    expect(
      check(
        "<!doctype html><html><head><meta charset='utf-8'><title>T</title>" +
          "<link href='x' rel='canonical'></head><body></body></html>",
      ),
    ).toEqual([]);
  });
});

describe("severity matrix — every cell", () => {
  test("every metadata code is an ERROR in BOTH modes", () => {
    const cases: Array<[DiagnosticCode, string]> = [
      ["metadata.charset-missing", DOC({ charset: 0 })],
      ["metadata.charset-duplicate", DOC({ charset: 2 })],
      ["metadata.title-missing", DOC({ titles: 0 })],
      ["metadata.title-duplicate", DOC({ titles: 2 })],
      ["metadata.head-missing", DOC({ canonical: 0 })],
      ["metadata.canonical-duplicate", DOC({ canonical: 2 })],
    ];
    for (const mode of ["build", "dev"] as const) {
      for (const [code, html] of cases) {
        const diags = validatePages({
          mode,
          pages: [page("/", "content/index.md", html)],
          routes: routes(["/", false]),
        });
        expect(diags.map((d) => d.code)).toEqual([code]);
        expect(diags[0].severity).toBe("error");
      }
    }
  });

  test("link.missing-fragment is an ERROR in both modes (dead anchor, never demoted)", () => {
    const options = {
      pages: [
        page("/", "content/index.md", DOC(), [link({ route: "/d", fragment: "nope", line: 6 })]),
        page("/d", "content/d.md", DOC({ body: '<h1 id="present">P</h1>' })),
      ],
      routes: routes(["/", false], ["/d", false]),
    };
    for (const mode of ["build", "dev"] as const) {
      const diags = validatePages({ mode, ...options });
      expect(diags.map((d) => d.code)).toEqual(["link.missing-fragment"]);
      expect(diags[0].severity).toBe("error");
    }
  });
});
