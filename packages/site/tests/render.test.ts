// The layout render engine contract (plan §3): the per-render head sink
// (first-call vs repeat dedup, closed when the render finishes), the
// deep-frozen page view, the asset tag helpers, the confined readText, and
// the renderPage/renderAll engine (sequential, lexicographic, never crashes
// the pass). No real Bun.build here — the manifest is faked; the asset
// pipeline itself is pinned in assets.test.ts.
//
// Honest-failure pattern throughout: every guard has a case that VIOLATES it
// and a control that PASSES, so removing a guard turns a test red.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AssetManifest } from "../src/assets.ts";
import type { RoutedPage } from "../src/content.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import { compareStrings } from "../src/diagnostics.ts";
import { escapeHtml, type Html, html, trustedHtml } from "../src/html.ts";
import {
  collectUnusedAssets,
  type Layout,
  type LayoutContext,
  type PageRender,
  renderAll,
  renderPage,
} from "../src/render.ts";
import { canonicalUrl } from "../src/routes.ts";
import type { Heading, LayoutFn } from "../src/types.ts";
import { urlBase } from "../src/url.ts";

const SITE = "https://crust.dev";

/** The readText size cap (plan §1). A file of EXACTLY this many bytes is legal. */
const CAP = 10 * 1024 * 1024;

// The faked manifest (no Bun.build here): one JS entry, two CSS entries.
const MANIFEST: AssetManifest = new Map([
  ["app", { file: "assets/app-0123456789abcdef.js", bytes: 128 }],
  ["orphan", { file: "assets/orphan-aaaa1111bbbb2222.css", bytes: 16 }],
  ["site", { file: "assets/site-fedcba9876543210.css", bytes: 64 }],
]);

const APP_JS = "https://crust.dev/assets/app-0123456789abcdef.js";
const SITE_CSS = "https://crust.dev/assets/site-fedcba9876543210.css";
const SCRIPT_TAG = `<script defer src="${APP_JS}"></script>`;
const LINK_TAG = `<link rel="stylesheet" href="${SITE_CSS}">`;

/** The exact asset.unused message for one name (module scope: the
 * collectUnusedAssets describe reuses it for the extra-documents case). */
const unused = (name: string): string =>
  `asset "${name}" is declared but referenced by no page (never passed to script() or stylesheet())`;

const created: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

// One shared, empty config dir for renders that plant no files (the engine
// realpath's it up front even when readText is never called).
let sharedCfg: string | undefined;
async function configDir(): Promise<string> {
  if (sharedCfg === undefined) sharedCfg = await tmp("crust-site-render-cfg-");
  return sharedCfg;
}

function makePage(overrides: Partial<RoutedPage> = {}): RoutedPage {
  return {
    sourcePath: "content/index.md",
    relativePath: "index",
    route: "/",
    layout: "docs",
    title: "Crust",
    description: "A fenced site generator",
    headings: [{ level: 2, id: "hello", text: "Hello" }],
    data: { tag: "home" },
    draft: false,
    body: trustedHtml("<p>hi</p>"),
    links: [],
    warnings: [],
    diagnostics: [],
    canonicalUrl: "https://crust.dev/",
    ...overrides,
  };
}

/** The reference layout every test starts from: head + content, nothing else. */
const docs: Layout = (ctx) =>
  html`<html lang="en"><head>${ctx.head()}</head><body>${ctx.content}</body></html>`;

/**
 * The expected head block: <title>, description meta, canonical, og:title,
 * og:description, og:url, og:type=website — LF-joined, no trailing newline,
 * every value escaped. Built with \n ESCAPES (never raw newlines in a
 * template literal — html.test.ts documents a mangled one).
 */
function headBlock(title: string, description: string, canonicalUrl: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const c = escapeHtml(canonicalUrl);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<link rel="canonical" href="${c}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${c}">`,
    `<meta property="og:type" content="website">`,
  ].join("\n");
}

async function render(
  page: RoutedPage,
  layouts: Readonly<Record<string, LayoutFn>>,
  site: string = SITE,
  manifest: AssetManifest = MANIFEST,
  dir?: string,
): Promise<PageRender> {
  return renderPage({ page, site, manifest, layouts, configDir: dir ?? (await configDir()) });
}

/** readText tests get their own config dir (they plant files in it). */
async function renderWithDir(page: RoutedPage, layout: Layout, dir: string): Promise<PageRender> {
  return renderPage({
    page,
    site: SITE,
    manifest: MANIFEST,
    layouts: { docs: layout },
    configDir: dir,
  });
}

describe("head()", () => {
  test("the head block is seven pinned tags, LF-joined, values escaped", async () => {
    const title = 'A "B" & C <D>';
    const description = 'A "B" & C <D>';
    const page = makePage({ title, description });
    // The escape table is pinned here as well as in html.test.ts: these are
    // the bytes the head block is built from.
    expect(escapeHtml(title)).toBe("A &quot;B&quot; &amp; C &lt;D&gt;");
    const escaped = "A &quot;B&quot; &amp; C &lt;D&gt;";
    const expected =
      "<title>" +
      escaped +
      "</title>" +
      "\n" +
      '<meta name="description" content="' +
      escaped +
      '">' +
      "\n" +
      '<link rel="canonical" href="https://crust.dev/">' +
      "\n" +
      '<meta property="og:title" content="' +
      escaped +
      '">' +
      "\n" +
      '<meta property="og:description" content="' +
      escaped +
      '">' +
      "\n" +
      '<meta property="og:url" content="https://crust.dev/">' +
      "\n" +
      '<meta property="og:type" content="website">';
    const layout: Layout = (ctx) => html`${ctx.head()}`;
    const result = await render(page, { docs: layout });
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(expected);
  });

  test("the standard layout document is head + content, byte for byte", async () => {
    const title = 'A "B" & C <D>';
    const page = makePage({ title });
    const result = await render(page, { docs });
    const expected =
      '<html lang="en"><head>' +
      headBlock(title, "A fenced site generator", "https://crust.dev/") +
      "</head><body><p>hi</p></body></html>";
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(expected);
  });

  test("a second head() call emits nothing and records head.duplicate", async () => {
    // Three calls: only the first emits; EVERY extra call is recorded (two
    // diagnostics), and the page still renders (plan §3: a diagnostic, not
    // a throw).
    const layout: Layout = (ctx) => {
      const first = ctx.head();
      const second = ctx.head();
      const third = ctx.head();
      return html`<html lang="en"><head>${first}${second}${third}</head><body>${ctx.content}</body></html>`;
    };
    const result = await render(makePage(), { docs: layout });
    const expected =
      '<html lang="en"><head>' +
      headBlock("Crust", "A fenced site generator", "https://crust.dev/") +
      "</head><body><p>hi</p></body></html>";
    expect(result.html).toBe(expected);
    const dups = result.diagnostics.filter((d) => d.code === "head.duplicate");
    expect(dups).toHaveLength(2);
    for (const d of dups) {
      expect(d.severity).toBe("error");
      expect(d.sourcePath).toBe("content/index.md");
    }
  });

  test("head() NEVER emits charset or viewport (the layout hand-writes those)", async () => {
    const layout: Layout = (ctx) => html`${ctx.head()}`;
    const result = await render(makePage(), { docs: layout });
    expect(result.html).not.toBeNull();
    expect(result.html).not.toContain("charset");
    expect(result.html).not.toContain("viewport");
  });

  test("a prefixed site: canonical and og:url carry the prefix (site + route, exact bytes)", async () => {
    // GH Pages under /docs/: the head's two URL-bearing tags must carry the
    // prefix. They use the page's canonicalUrl (site + normalizedRoute —
    // never the origin), so a regression to an origin-based canonical drops
    // /docs and every og:url on the site points at a 404.
    const page = makePage({ route: "/about", canonicalUrl: "https://x.dev/docs/about" });
    const layout: Layout = (ctx) => html`${ctx.head()}`;
    const result = await render(page, { docs: layout }, "https://x.dev/docs");
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(
      headBlock("Crust", "A fenced site generator", "https://x.dev/docs/about"),
    );
    expect(result.html).toContain('<link rel="canonical" href="https://x.dev/docs/about">');
    expect(result.html).toContain('<meta property="og:url" content="https://x.dev/docs/about">');
  });

  test("a prefixed site: asset and publicAsset URLs carry the prefix", async () => {
    // Asset URLs are site + "/" + file (render.ts pins this), so a prefixed
    // site serves them under the prefix — a bare-origin site URL would 404
    // every asset on GH Pages.
    const page = makePage({ route: "/about", canonicalUrl: "https://x.dev/docs/about" });
    const layout: Layout = (ctx) =>
      html`<head>${ctx.stylesheet("site")}${ctx.script("app")}</head><img src="${ctx.publicAsset(
        "img/logo.png",
      )}" alt="">`;
    const result = await render(page, { docs: layout }, "https://x.dev/docs");
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(
      "<head>" +
        '<link rel="stylesheet" href="https://x.dev/docs/assets/site-fedcba9876543210.css">' +
        '<script defer src="https://x.dev/docs/assets/app-0123456789abcdef.js"></script>' +
        "</head>" +
        '<img src="https://x.dev/docs/img/logo.png" alt="">',
    );
    expect(result.publicAssets).toEqual(["img/logo.png"]);
  });

  test("newlines, quotes and entities in title/description cannot break the head's attribute framing", async () => {
    // Every value goes through the ONE escaper (& FIRST, so a pre-existing
    // entity can never re-decode); a newline is NOT escaped — it is legal
    // inside a QUOTED attribute value and inside <title> RCDATA, so it
    // survives as-is and cannot terminate the attribute. Pinned byte for
    // byte with \n escapes (never raw newlines in a template literal — the
    // file header documents a mangled one).
    const title = 'A "B" & <D>\nline2';
    const description = 'It\'s "fine" & more\nnext';
    expect(escapeHtml(title)).toBe("A &quot;B&quot; &amp; &lt;D&gt;\nline2");
    expect(escapeHtml(description)).toBe("It&#x27;s &quot;fine&quot; &amp; more\nnext");
    const T = "A &quot;B&quot; &amp; &lt;D&gt;\nline2";
    const D = "It&#x27;s &quot;fine&quot; &amp; more\nnext";
    const C = "https://x.dev/docs/about";
    const expected =
      "<title>" +
      T +
      "</title>" +
      "\n" +
      '<meta name="description" content="' +
      D +
      '">' +
      "\n" +
      '<link rel="canonical" href="' +
      C +
      '">' +
      "\n" +
      '<meta property="og:title" content="' +
      T +
      '">' +
      "\n" +
      '<meta property="og:description" content="' +
      D +
      '">' +
      "\n" +
      '<meta property="og:url" content="' +
      C +
      '">' +
      "\n" +
      '<meta property="og:type" content="website">';
    const page = makePage({
      route: "/about",
      canonicalUrl: "https://x.dev/docs/about",
      title,
      description,
    });
    const layout: Layout = (ctx) => html`${ctx.head()}`;
    const result = await render(page, { docs: layout }, "https://x.dev/docs");
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(expected);
  });
});

describe("stylesheet()/script()", () => {
  test("first calls emit the tag with the site-absolute hashed URL", async () => {
    const layout: Layout = (ctx) =>
      html`<head>${ctx.stylesheet("site")}${ctx.script("app")}</head>`;
    const result = await render(makePage(), { docs: layout });
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(`<head>${LINK_TAG}${SCRIPT_TAG}</head>`);
    expect(result.usedAssets.scripts).toEqual(["app"]);
    expect(result.usedAssets.styles).toEqual(["site"]);
  });

  test("stylesheet() on a JS entry emits <script defer> (the extension decides)", async () => {
    // The manifest is the one source of truth for the bytes: a helper/ext
    // mismatch must never emit a broken <link> for JS.
    const layout: Layout = (ctx) => html`${ctx.stylesheet("app")}`;
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBe(SCRIPT_TAG);
    expect(result.usedAssets.scripts).toEqual(["app"]);
    expect(result.usedAssets.styles).toEqual([]);
  });

  test("repeats and cross-helper repeats emit nothing (ONE dedup namespace)", async () => {
    const layout: Layout = (ctx) => {
      const tags = [
        ctx.script("app"),
        ctx.script("app"),
        ctx.stylesheet("app"),
        ctx.script("app"),
        ctx.stylesheet("site"),
        ctx.stylesheet("site"),
      ];
      return html`${tags}`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBe(SCRIPT_TAG + LINK_TAG);
    expect(result.usedAssets.scripts).toEqual(["app"]);
    expect(result.usedAssets.styles).toEqual(["site"]);
  });

  test("an unknown name aborts this page only (other pages keep rendering, no partial html)", async () => {
    // The bad layout emits a REAL tag first ("app"), then aborts on "nope":
    // the page's html must be null (nothing leaks out of an aborted render),
    // the diagnostic is page-attributed, and the page still COUNTS as having
    // referenced what it called before failing (the audit contract — pinned
    // so a later "cleanup" cannot silently drop pre-abort usage).
    const bad: Layout = (ctx) => {
      ctx.script("app");
      ctx.script("nope");
      return html`<i>x</i>`;
    };
    const layouts: Readonly<Record<string, LayoutFn>> = { docs, bad };
    const badPage = makePage({
      sourcePath: "content/b.md",
      route: "/b",
      layout: "bad",
      canonicalUrl: "https://crust.dev/b",
    });
    const okPage = makePage({
      sourcePath: "content/a.md",
      route: "/a",
      canonicalUrl: "https://crust.dev/a",
    });
    const result = await renderAll([badPage, okPage], {
      site: SITE,
      manifest: MANIFEST,
      layouts,
      configDir: await configDir(),
    });
    const [ok, failed] = result.pages;
    expect(ok.page.route).toBe("/a");
    expect(ok.html).not.toBeNull();
    expect(ok.diagnostics).toEqual([]);
    expect(ok.usedAssets.scripts).toEqual([]); // the good page never emitted
    expect(failed.page.route).toBe("/b");
    expect(failed.html).toBeNull(); // no partial html leaks out of an abort
    expect(failed.deps).toEqual([]);
    expect(failed.publicAssets).toEqual([]);
    expect(failed.usedAssets).toEqual({ scripts: ["app"], styles: [] });
    const d = failed.diagnostics[0];
    expect(failed.diagnostics).toHaveLength(1);
    expect(d.code).toBe("asset.unknown-entrypoint");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/b.md");
    expect(d.message).toBe(
      'asset "nope" is not in the build manifest (declared: app, orphan, site)',
    );
  });

  test("a non-string asset name is asset.unknown-entrypoint (page aborts)", async () => {
    const layout: Layout = (ctx) => {
      ctx.script(42 as unknown as string);
      return html`<i>x</i>`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("asset.unknown-entrypoint");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toBe("script()/stylesheet() require a string asset name, received number");
  });

  test("two renders get independent first-call memory (fresh sink per page)", async () => {
    const layout: Layout = (ctx) => html`${ctx.script("app")}${ctx.script("app")}`;
    const a = await render(
      makePage({ sourcePath: "content/a.md", route: "/a", canonicalUrl: "https://crust.dev/a" }),
      { docs: layout },
    );
    const b = await render(
      makePage({ sourcePath: "content/b.md", route: "/b", canonicalUrl: "https://crust.dev/b" }),
      { docs: layout },
    );
    expect(a.html).toBe(SCRIPT_TAG);
    expect(b.html).toBe(SCRIPT_TAG);
  });
});
describe("url()", () => {
  test("a valid relative ref passes through unchanged (base: site + route)", async () => {
    let seen: string | undefined;
    const layout: Layout = (ctx) => {
      seen = ctx.url("about.md");
      return html`<a href="${seen}">a</a>`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(seen).toBe("about.md");
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe('<a href="about.md">a</a>');
  });

  test("a prefixed site resolves relative refs against site + route", async () => {
    const page = makePage({
      route: "/about",
      canonicalUrl: "https://crust.dev/docs/about",
    });
    let seen: string | undefined;
    const layout: Layout = (ctx) => {
      seen = ctx.url("next.md");
      return html`<a href="${seen}">n</a>`;
    };
    const result = await render(page, { docs: layout }, "https://crust.dev/docs");
    expect(seen).toBe("next.md");
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe('<a href="next.md">n</a>');
  });

  test("a javascript: URL records url.scheme (page-attributed) and aborts", async () => {
    const layout: Layout = (ctx) => {
      ctx.url("javascript:alert(1)");
      return html`<i>x</i>`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("url.scheme");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("javascript:alert(1)");
  });

  test("a non-string url() argument records url.scheme and aborts the page", async () => {
    const layout: Layout = (ctx) => {
      ctx.url(42 as unknown as string);
      return html`<i>x</i>`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("url.scheme");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toBe("url() requires a string, received number");
  });
});

describe("the URL base invariant (url.ts contract, pinned here)", () => {
  test("the base the engine resolves relative refs against IS the page's canonicalUrl", async () => {
    // url.ts: urlBase({siteUrl, pageRoute}) === canonicalUrl(site, route).
    // The engine builds both sides from the same inputs (opts.site and
    // page.route) — for a PREFIXED site they must still agree, which they
    // cannot if either side regresses to the origin (that is the chunk-6
    // flagged bug, see the renderAll/pages regression tests).
    const site = "https://x.dev/docs";
    const page = makePage({ route: "/about", canonicalUrl: canonicalUrl(site, "/about") });
    let seen: string | undefined;
    const layout: Layout = (ctx) => {
      seen = ctx.url("../other");
      return html`<a href="${seen}">o</a>`;
    };
    const result = await render(page, { docs: layout }, site);
    expect(seen).toBe("../other");
    expect(result.diagnostics).toEqual([]);
    // explicit bytes on both sides:
    expect(page.canonicalUrl).toBe("https://x.dev/docs/about");
    expect(urlBase({ siteUrl: site, pageRoute: page.route })).toBe(page.canonicalUrl);
  });
});

describe("publicAsset()", () => {
  test("returns site + '/' + posix-normalized path, and records the path", async () => {
    let seen: string | undefined;
    const layout: Layout = (ctx) => {
      seen = ctx.publicAsset("img/./logo.png");
      return html`<img src="${seen}" alt="">`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(seen).toBe("https://crust.dev/img/logo.png");
    expect(result.diagnostics).toEqual([]);
    expect(result.publicAssets).toEqual(["img/logo.png"]);
  });

  // [label, the literal path, a substring of the recorded reason]
  const TRAVERSAL: [string, string, string][] = [
    ["an empty string", "", "the path is empty"],
    ["a leading /", "/etc/passwd", "is absolute"],
    ["a .. segment", "a/../../etc/passwd", "`..` segment"],
    ["a backslash", "a\\b.png", "backslash"],
    ["a drive letter", "C:/logo.png", "drive-letter"],
    ["a NUL character", "a\0b.png", "NUL"],
  ];

  test.each(TRAVERSAL)(
    "%s is rejected (public-asset.traversal, page aborts, nothing recorded)",
    async (_label, path, reason) => {
      const layout: Layout = (ctx) => {
        ctx.publicAsset(path);
        return html`<i>x</i>`;
      };
      const result = await render(makePage(), { docs: layout });
      expect(result.html).toBeNull();
      expect(result.publicAssets).toEqual([]);
      const d = result.diagnostics[0];
      expect(d.code).toBe("public-asset.traversal");
      expect(d.severity).toBe("error");
      expect(d.sourcePath).toBe("content/index.md");
      expect(d.message).toContain(reason);
    },
  );
});

describe("readText()", () => {
  test("reads a file under the config dir and records its realpath as a dep", async () => {
    const dir = await tmp("crust-site-render-rt-");
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, "notes", "hello.txt"), "hello world");
    const layout: Layout = async (ctx) => {
      const text = await ctx.readText("notes/hello.txt");
      return html`<i>${text}</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe("<i>hello world</i>");
    const expected = (await realpath(join(dir, "notes", "hello.txt"))).replace(/\\/g, "/");
    expect(result.deps).toEqual([expected]);
  });

  test("a missing file is read-text.failed (the path stayed inside)", async () => {
    const dir = await tmp("crust-site-render-rt-");
    const layout: Layout = async (ctx) => {
      await ctx.readText("nope.txt");
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    expect(result.deps).toEqual([]);
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.failed");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("no such file or directory");
  });

  test("a .. path is rejected BEFORE resolution, even if the target exists", async () => {
    const dir = await tmp("crust-site-render-rt-");
    const outsideDir = await tmp("crust-site-render-outside-");
    await writeFile(join(outsideDir, "real.txt"), "exists, but unreachable");
    const layout: Layout = async (ctx) => {
      await ctx.readText(`../${basename(outsideDir)}/real.txt`);
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.escape");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("`..` segment");
  });

  test("an absolute path is rejected before resolution (read-text.escape)", async () => {
    const dir = await tmp("crust-site-render-rt-");
    const layout: Layout = async (ctx) => {
      await ctx.readText("/etc/hostname");
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.escape");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("is absolute");
  });

  // Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows (admin
  // or developer mode) — an unprivileged machine fails with EPERM before the
  // behaviour under test is even reachable. Gated, never a false pass.
  test.skipIf(process.platform === "win32")(
    "a symlink that resolves outside the root is read-text.escape",
    async () => {
      const dir = await tmp("crust-site-render-rt-");
      const outsideDir = await tmp("crust-site-render-outside-");
      await writeFile(join(outsideDir, "secret.txt"), "top secret");
      await symlink(join(outsideDir, "secret.txt"), join(dir, "link.txt"));
      const layout: Layout = async (ctx) => {
        await ctx.readText("link.txt");
        return html`<i>x</i>`;
      };
      const result = await renderWithDir(makePage(), layout, dir);
      expect(result.html).toBeNull();
      expect(result.deps).toEqual([]);
      const d = result.diagnostics[0];
      expect(d.code).toBe("read-text.escape");
      expect(d.sourcePath).toBe("content/index.md");
      expect(d.message).toContain(basename(outsideDir));
      expect(d.message).toContain(basename(dir));
    },
  );

  test("a file over the 10 MiB cap is read-text.toobig", async () => {
    const dir = await tmp("crust-site-render-rt-");
    await writeFile(join(dir, "big.bin"), Buffer.alloc(CAP + 1));
    const layout: Layout = async (ctx) => {
      await ctx.readText("big.bin");
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.toobig");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain(String(CAP + 1));
    expect(d.message).toContain(String(CAP));
  });

  test("a file of EXACTLY the 10 MiB cap is legal", async () => {
    const dir = await tmp("crust-site-render-rt-");
    await writeFile(join(dir, "exact.bin"), Buffer.alloc(CAP));
    const layout: Layout = async (ctx) => {
      const text = await ctx.readText("exact.bin");
      return html`<i>${text.length}</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe(`<i>${CAP}</i>`);
  });

  test("invalid UTF-8 bytes are read-text.failed", async () => {
    const dir = await tmp("crust-site-render-rt-");
    await writeFile(join(dir, "binary.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const layout: Layout = async (ctx) => {
      await ctx.readText("binary.bin");
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.failed");
    expect(d.message).toContain("UTF-8");
  });

  test("a directory is read-text.failed (readText reads regular files only)", async () => {
    const dir = await tmp("crust-site-render-rt-");
    await mkdir(join(dir, "sub"));
    const layout: Layout = async (ctx) => {
      await ctx.readText("sub");
      return html`<i>x</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("read-text.failed");
    expect(d.message).toContain("directory");
  });

  // Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows (admin
  // or developer mode) — an unprivileged machine fails with EPERM before the
  // behaviour under test is even reachable. Gated, never a false pass.
  test.skipIf(process.platform === "win32")(
    "a symlink that stays INSIDE the root is allowed (dep = the target's realpath)",
    async () => {
      // Control to the outside-symlink escape case above: containment is
      // judged on the FINAL realpath, so a symlink whose target is inside the
      // root is plain file access. The dependency recorded is the target's
      // realpath (chunk 8's dev invalidation keys on real files, not symlink
      // names).
      const dir = await tmp("crust-site-render-rt-");
      await mkdir(join(dir, "notes"), { recursive: true });
      await writeFile(join(dir, "notes", "real.txt"), "inside target");
      await symlink(join(dir, "notes", "real.txt"), join(dir, "link.txt"));
      const layout: Layout = async (ctx) => {
        const text = await ctx.readText("link.txt");
        return html`<i>${text}</i>`;
      };
      const result = await renderWithDir(makePage(), layout, dir);
      expect(result.diagnostics).toEqual([]);
      expect(result.html).toBe("<i>inside target</i>");
      const expected = (await realpath(join(dir, "notes", "real.txt"))).replace(/\\/g, "/");
      expect(result.deps).toEqual([expected]);
      expect(expected).not.toContain("link.txt"); // the target, not the link
    },
  );

  test("Promise.all of readText in one async layout: every dep completes on THIS render's sink", async () => {
    // The engine must await the layout's Promise to full completion before it
    // closes the sink — no await gap after which a still-running readText
    // would hit a closed sink. Parallel reads therefore all land their
    // realpaths on the render's own dep set.
    const dir = await tmp("crust-site-render-rt-");
    await writeFile(join(dir, "a.txt"), "A");
    await writeFile(join(dir, "b.txt"), "B");
    const layout: Layout = async (ctx) => {
      const [x, y] = await Promise.all([ctx.readText("a.txt"), ctx.readText("b.txt")]);
      return html`<i>${x}${y}</i>`;
    };
    const result = await renderWithDir(makePage(), layout, dir);
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe("<i>AB</i>");
    const expected = [
      (await realpath(join(dir, "a.txt"))).replace(/\\/g, "/"),
      (await realpath(join(dir, "b.txt"))).replace(/\\/g, "/"),
    ].sort(compareStrings);
    expect(result.deps).toEqual(expected);
  });

  test("readText called after the sink closed throws BEFORE any fs work and cannot touch the next page's deps", async () => {
    // Detached work gated until AFTER both renders have finished: the
    // readText call then hits the CLOSED sink of page A. It must throw
    // (requireOpen is the first line — no filesystem access at all) and its
    // never-arriving realpath must land on A's already-collected sink, never
    // on B's.
    const dirA = await tmp("crust-site-render-rt-");
    await writeFile(join(dirA, "a.txt"), "A");
    const dirB = await tmp("crust-site-render-rt-"); // empty on purpose
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let releaseLate: (() => void) | undefined;
    const lateDone = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const late: unknown[] = [];
    const keep: Layout = (ctx) => {
      void (async () => {
        await gate;
        try {
          await ctx.readText("a.txt");
        } catch (e) {
          late.push(e);
        } finally {
          // readText is ASYNC: its throw surfaces as a rejected Promise one
          // microtask turn later than a sync helper's — signal completion
          // explicitly so the test never races the event loop.
          releaseLate?.();
        }
      })();
      return html`<i>a</i>`;
    };
    const pageA = makePage({
      sourcePath: "content/a.md",
      route: "/a",
      canonicalUrl: "https://crust.dev/a",
    });
    const pageB = makePage({
      sourcePath: "content/b.md",
      route: "/b",
      canonicalUrl: "https://crust.dev/b",
    });
    const a = await render(pageA, { docs: keep }, SITE, MANIFEST, dirA);
    const b = await render(pageB, { docs: (_ctx) => html`<i>b</i>` }, SITE, MANIFEST, dirB);
    expect(a.html).toBe("<i>a</i>");
    expect(a.diagnostics).toEqual([]);
    expect(b.html).toBe("<i>b</i>");
    expect(b.diagnostics).toEqual([]);
    releaseGate?.();
    await gate;
    await lateDone; // the detached work has run (and been caught) — no race
    expect(late).toHaveLength(1);
    expect(late[0]).toBeInstanceOf(Error);
    expect(String((late[0] as Error).message)).toContain("layout context is closed");
    // Isolation is the deterministic half of the contract: B's sink is a
    // different object and its dep set was never written by A's late work.
    expect(b.deps).toEqual([]);
    // A's result snapshot was taken at close, BEFORE the gate released: the
    // late readText throws on the closed sink before recording anything, so
    // the returned result holds exactly the deps that landed before close —
    // here, none. (Not `every(startsWith("/"))`: an absolute realpath starts
    // with a drive letter on Windows, so a root-anchored check would test
    // the platform, not the isolation.)
    expect(a.deps).toEqual([]);
  });

  test("a fire-and-forget readText (never awaited) cannot pollute the next page's deps", async () => {
    // The author's hazard the header documents: a readText the layout never
    // awaited is still pending when the render returns. It may resolve before
    // or after the sink closes (fs timing — not asserted), but the contract
    // that IS deterministic is isolation: the next page's dep set stays
    // untouched, and the finished result is never retroactively changed.
    const dirA = await tmp("crust-site-render-rt-");
    await writeFile(join(dirA, "a.txt"), "A");
    const dirB = await tmp("crust-site-render-rt-"); // empty on purpose
    const ff: Layout = (ctx) => {
      void ctx.readText("a.txt"); // never awaited
      return html`<i>a</i>`;
    };
    const pageA = makePage({
      sourcePath: "content/a.md",
      route: "/a",
      canonicalUrl: "https://crust.dev/a",
    });
    const pageB = makePage({
      sourcePath: "content/b.md",
      route: "/b",
      canonicalUrl: "https://crust.dev/b",
    });
    const a = await render(pageA, { docs: ff }, SITE, MANIFEST, dirA);
    const b = await render(pageB, { docs: (_ctx) => html`<i>b</i>` }, SITE, MANIFEST, dirB);
    expect(a.html).toBe("<i>a</i>");
    expect(b.html).toBe("<i>b</i>");
    expect(b.deps).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    // whatever A's snapshot caught, it only caught its own file:
    expect(a.deps.every((d) => d.endsWith("/a.txt"))).toBe(true);
    expect(a.deps.length).toBeLessThanOrEqual(1);
  });
});
describe("layout results", () => {
  test("a non-Html string result is render.bad-result", async () => {
    const bad: Layout = () => "a plain string" as unknown as Html;
    const result = await render(makePage(), { docs: bad });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.bad-result");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toBe(
      'the layout for page "content/index.md" returned a string "a plain string"; ' +
        "a layout must return an Html (or a Promise that resolves to an Html)",
    );
  });

  test("a non-Html object result is render.bad-result", async () => {
    const bad: Layout = () => ({ a: 1 }) as unknown as Html;
    const result = await render(makePage(), { docs: bad });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.bad-result");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("returned an object of type Object;");
  });

  test("a Promise resolving to a non-Html is render.bad-result", async () => {
    const bad: Layout = async () => "late string" as unknown as Html;
    const result = await render(makePage(), { docs: bad });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.bad-result");
    expect(d.message).toContain('returned a Promise that resolved to a string "late string";');
  });

  test("a throwing layout is render.threw with the error's message AND stack", async () => {
    const boom: Layout = () => {
      throw new Error("boom-from-layout");
    };
    const result = await render(makePage(), { docs: boom });
    expect(result.html).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.threw");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("boom-from-layout");
    // the stack is folded into the message: the "Error:" prefix only appears in it
    expect(d.message).toContain("Error: boom-from-layout");
    expect(d.message).toContain("\n");
  });

  test("a layout throwing a non-Error is render.threw (no stack, value named)", async () => {
    const boom: Layout = () => {
      throw "kaboom";
    };
    const result = await render(makePage(), { docs: boom });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.threw");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toBe('the layout for page "content/index.md" threw: kaboom');
  });

  test("a rejecting layout Promise is render.threw", async () => {
    const boom: Layout = async () => {
      throw new Error("rejected-promise");
    };
    const result = await render(makePage(), { docs: boom });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.threw");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("rejected-promise");
  });

  test("an async layout is awaited before the result returns", async () => {
    let resolved = false;
    const slow: Layout = async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
      return html`<i>done</i>`;
    };
    const result = await render(makePage(), { docs: slow });
    expect(resolved).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.html).toBe("<i>done</i>");
  });

  test("a fence violation keeps its code and gets re-stamped to the page", async () => {
    // An author who forgets ctx.url(): the raw value still reaches a URL
    // attribute, and the fence re-runs the policy over it.
    const badLink: Layout = () => html`<a href="${"javascript:alert(1)"}">x</a>`;
    const result = await render(makePage(), { docs: badLink });
    expect(result.html).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.code).toBe("fence.url-attribute");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("url.scheme");
    expect(d.message).toContain("javascript:alert(1)");
  });

  // A fence violation thrown by finalizeDocument must surface with its
  // ORIGINAL fence code and the page's sourcePath — never flattened into a
  // generic render.threw (crust rule 1: the diagnostic must say what
  // actually happened). Pinned for every fence code the layout can trip.
  const FENCE_CASES: [string, () => Html, Diagnostic["code"]][] = [
    ["an inline <script> body", () => html`<script>alert(1)</script>`, "fence.script-body"],
    ["an inline <style> body", () => html`<style>body{color:red}</style>`, "fence.style-body"],
    ["an event handler attribute", () => html`<a onclick="x()">y</a>`, "fence.event-handler"],
    ["a value inside a comment", () => html`<!--${"x"}-->`, "fence.comment-value"],
    ["a ping attribute", () => html`<a ping="/y" href="/z">w</a>`, "fence.ping-attr"],
    ["a srcdoc attribute", () => html`<iframe srcdoc="x"></iframe>`, "fence.srcdoc-attr"],
  ];

  test.each(FENCE_CASES)(
    "%s: the fence code is preserved (not render.threw) with the page's sourcePath",
    async (_label, build, code) => {
      const layout: Layout = () => build();
      const result = await render(makePage(), { docs: layout });
      expect(result.html).toBeNull();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe(code);
      expect(result.diagnostics[0].severity).toBe("error");
      expect(result.diagnostics[0].sourcePath).toBe("content/index.md");
      expect(result.diagnostics.some((d) => d.code === "render.threw")).toBe(false);
    },
  );
});

describe("renderPage — layout resolution", () => {
  test("an unknown layout key is layout.unknown (the pass never crashes)", async () => {
    const result = await render(makePage({ layout: "nope" }), { docs });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("layout.unknown");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain('layout "nope"');
    expect(d.message).toContain("available: docs");
  });

  test("a non-function layout value is layout.unknown", async () => {
    const layouts: Readonly<Record<string, LayoutFn>> = {
      docs: "not a function" as unknown as LayoutFn,
    };
    const result = await render(makePage(), layouts);
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("layout.unknown");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain('layout "docs"');
    expect(d.message).toContain("is not a function");
  });
});

describe("renderPage — total on hand-built input", () => {
  test("a missing config dir is render.threw with the honest stage (the layout never ran)", async () => {
    // The readText root is realpath'd before the layout runs. A hand-built
    // input with a missing config dir must come back as a located diagnostic
    // that says WHICH setup step failed — the old wording blamed "the
    // layout" for a step the layout had not even reached (a false statement;
    // crust rule 1).
    const parent = await tmp("crust-site-render-cfg-");
    const missing = join(parent, "does-not-exist");
    const result = await renderPage({
      page: makePage(),
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs },
      configDir: missing,
    });
    expect(result.html).toBeNull();
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.threw");
    expect(d.severity).toBe("error");
    expect(d.sourcePath).toBe("content/index.md");
    expect(d.message).toContain("readText root");
    expect(d.message).toContain(missing.replace(/\\/g, "/"));
    expect(d.message).not.toContain("the layout for page");
  });
});

describe("the frozen page view", () => {
  test("mutating the view throws (render.threw); the original keeps mutable containers", async () => {
    const page = makePage();
    const mutator: Layout = (ctx) => {
      (ctx.page as { title: string }).title = "hacked";
      return html`<i>x</i>`;
    };
    const result = await render(page, { docs: mutator });
    expect(result.html).toBeNull();
    const d = result.diagnostics[0];
    expect(d.code).toBe("render.threw");
    expect(d.sourcePath).toBe("content/index.md");
    // the engine's assignment-to-frozen error; neither V8 ("read only
    // property 'title'") nor JSC ("readonly property") names the property
    // consistently, so match both spellings:
    expect(d.message).toMatch(/read.?only property/i);
    // the route table's own page keeps its original containers (chunk 7
    // appends to them) — the view is a copy, not the same array:
    expect(result.page.headings).not.toBe(page.headings);
    expect(() => page.headings.push({ level: 1, id: "x", text: "x" })).not.toThrow();
    // ...while the view's container is frozen in place:
    const viewHeadings = result.page.headings as unknown as { push(h: Heading): number };
    expect(() => viewHeadings.push({ level: 1, id: "y", text: "y" })).toThrow();
  });

  test("shared leaves are frozen in place (the original's data is frozen too)", async () => {
    const page = makePage({ data: { inner: { x: 1 } } });
    const noop: Layout = () => html`<i>x</i>`;
    await render(page, { docs: noop });
    const inner = (page.data as { inner: { x: number } }).inner;
    expect(() => {
      inner.x = 2;
    }).toThrow();
    expect(inner.x).toBe(1);
  });

  test("a nested data mutation through the view throws render.threw (leaves are frozen in place)", async () => {
    const page = makePage({ data: { inner: { x: 1 } } });
    const layout: Layout = (ctx) => {
      (ctx.page.data as { inner: { x: number } }).inner.x = 5;
      return html`<i>x</i>`;
    };
    const result = await render(page, { docs: layout });
    expect(result.html).toBeNull();
    expect(result.diagnostics[0].code).toBe("render.threw");
    expect(result.diagnostics[0].sourcePath).toBe("content/index.md");
    expect(result.diagnostics[0].message).toMatch(/read.?only property/i);
    // the original value is unmutated:
    expect((page.data as { inner: { x: number } }).inner.x).toBe(1);
  });

  test("freezing is per-render: a mutation attempt in page 1 cannot affect page 2 (shared data)", async () => {
    // Two pages share ONE data object (the same nested record). Page 1's
    // layout tries to mutate it: the attempt throws (the record is frozen
    // in place before any layout runs) and page 1 aborts. Page 2 — frozen
    // by its OWN render, idempotently re-freezing the shared record — must
    // see the unmutated value. A later engine change that froze the view
    // some other way (or let the mutation through) would surface here.
    const shared = { count: 1 };
    const data = { shared };
    const page1 = makePage({
      sourcePath: "content/a.md",
      route: "/a",
      layout: "mut",
      data,
      canonicalUrl: "https://crust.dev/a",
    });
    const page2 = makePage({
      sourcePath: "content/b.md",
      route: "/b",
      layout: "read",
      data,
      canonicalUrl: "https://crust.dev/b",
    });
    const mut: Layout = (ctx) => {
      (ctx.page.data as { shared: { count: number } }).shared.count = 99;
      return html`<i>a</i>`;
    };
    const read: Layout = (ctx) =>
      html`<i>${(ctx.page.data as { shared: { count: number } }).shared.count}</i>`;
    const result = await renderAll([page1, page2], {
      site: SITE,
      manifest: MANIFEST,
      layouts: { mut, read },
      configDir: await configDir(),
    });
    expect(result.pages).toHaveLength(2);
    const [a, b] = result.pages;
    expect(a.page.route).toBe("/a");
    expect(a.html).toBeNull();
    expect(a.diagnostics[0].code).toBe("render.threw"); // the mutation threw in page 1
    expect(b.page.route).toBe("/b");
    expect(b.diagnostics).toEqual([]);
    expect(b.html).toBe("<i>1</i>"); // page 2 saw the unmutated value
    // the shared record is frozen in place after either render (idempotent):
    expect(() => {
      shared.count = 2;
    }).toThrow();
    expect(shared.count).toBe(1);
  });
});
describe("renderAll", () => {
  test("renders in lexicographic (code-unit) route order, not input order", async () => {
    const order: string[] = [];
    const logger: Layout = (ctx) => {
      order.push(ctx.page.route);
      return html`<i>${ctx.page.route}</i>`;
    };
    const pages = [
      makePage({ sourcePath: "content/z.md", route: "/z", canonicalUrl: "https://crust.dev/z" }),
      makePage({ sourcePath: "content/m.md", route: "/m", canonicalUrl: "https://crust.dev/m" }),
      makePage({ sourcePath: "content/a.md", route: "/a", canonicalUrl: "https://crust.dev/a" }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs: logger },
      configDir: await configDir(),
    });
    expect(order).toEqual(["/a", "/m", "/z"]);
    expect(result.pages.map((p) => p.page.route)).toEqual(["/a", "/m", "/z"]);
  });

  test("each page gets a fresh sink (dedup does not leak across pages)", async () => {
    const useApp: Layout = (ctx) => html`${ctx.script("app")}${ctx.script("app")}`;
    const pages = [
      makePage({ sourcePath: "content/a.md", route: "/a", canonicalUrl: "https://crust.dev/a" }),
      makePage({ sourcePath: "content/b.md", route: "/b", canonicalUrl: "https://crust.dev/b" }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs: useApp },
      configDir: await configDir(),
    });
    for (const p of result.pages) {
      expect(p.html).toBe(SCRIPT_TAG);
      expect(p.usedAssets.scripts).toEqual(["app"]);
    }
  });

  test("assets no page referenced become asset.unused warnings (sorted)", async () => {
    const pages = [
      makePage({ sourcePath: "content/a.md", route: "/a", canonicalUrl: "https://crust.dev/a" }),
      makePage({ sourcePath: "content/b.md", route: "/b", canonicalUrl: "https://crust.dev/b" }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs }, // the standard layout uses no assets
      configDir: await configDir(),
    });
    expect(result.pages).toHaveLength(2);
    expect(result.unusedAssets).toHaveLength(3);
    for (const d of result.unusedAssets) {
      expect(d.code).toBe("asset.unused");
      expect(d.severity).toBe("warning");
      expect(d.sourcePath).toBe("");
    }
    expect(result.unusedAssets.map((d) => d.message)).toEqual([
      unused("app"),
      unused("orphan"),
      unused("site"),
    ]);
  });

  test("an asset used by ANY page is not unused", async () => {
    const useApp: Layout = (ctx) => html`${ctx.script("app")}`;
    const pages = [
      makePage({
        sourcePath: "content/a.md",
        route: "/a",
        layout: "assets",
        canonicalUrl: "https://crust.dev/a",
      }),
      makePage({
        sourcePath: "content/b.md",
        route: "/b",
        layout: "docs",
        canonicalUrl: "https://crust.dev/b",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs, assets: useApp },
      configDir: await configDir(),
    });
    expect(result.pages[0].usedAssets.scripts).toEqual(["app"]);
    expect(result.unusedAssets.map((d) => d.message)).toEqual([unused("orphan"), unused("site")]);
  });

  test("a failing page does not stop the pass (failures stay page-attributed)", async () => {
    const boom: Layout = () => {
      throw new Error("page-b boom");
    };
    const pages = [
      makePage({
        sourcePath: "content/b.md",
        route: "/b",
        layout: "boom",
        canonicalUrl: "https://crust.dev/b",
      }),
      makePage({
        sourcePath: "content/a.md",
        route: "/a",
        layout: "docs",
        canonicalUrl: "https://crust.dev/a",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { boom, docs },
      configDir: await configDir(),
    });
    expect(result.pages).toHaveLength(2);
    const [a, b] = result.pages;
    expect(a.page.route).toBe("/a");
    expect(a.html).not.toBeNull();
    expect(a.diagnostics).toEqual([]);
    expect(b.page.route).toBe("/b");
    expect(b.html).toBeNull();
    expect(b.diagnostics[0].code).toBe("render.threw");
    expect(b.diagnostics[0].sourcePath).toBe("content/b.md");
  });

  test("zero pages: the pass completes and every declared asset is unused", async () => {
    const result = await renderAll([], {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs },
      configDir: await configDir(),
    });
    expect(result.pages).toEqual([]);
    expect(result.unusedAssets).toHaveLength(MANIFEST.size);
  });

  test("route order is CODE-UNIT lexicographic, NOT locale collation", async () => {
    // "B" (0x42) sorts before "b" (0x62) by code unit. ICU en collation
    // treats case as a SECONDARY key and would order "/ab" before "/aB" —
    // so a localeCompare regression in compareStrings flips exactly this
    // order, and with it the byte-identical-rebuild guarantee across
    // machines (plan §4.6). Pinned so the flip is red, not a silent drift.
    const order: string[] = [];
    const logger: Layout = (ctx) => {
      order.push(ctx.page.route);
      return html`<i>${ctx.page.route}</i>`;
    };
    const pages = [
      makePage({
        sourcePath: "content/lower.md",
        route: "/ab",
        canonicalUrl: "https://crust.dev/ab",
      }),
      makePage({
        sourcePath: "content/upper.md",
        route: "/aB",
        canonicalUrl: "https://crust.dev/aB",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs: logger },
      configDir: await configDir(),
    });
    expect(order).toEqual(["/aB", "/ab"]);
    expect(result.pages.map((p) => p.page.route)).toEqual(["/aB", "/ab"]);
  });

  test("equal routes tie-break on sourcePath (code-unit)", async () => {
    // renderAll is total over hand-built input (real builds never contain
    // duplicate routes — buildRouteTable rejects them first); the sort must
    // still be deterministic on the tie.
    const order: string[] = [];
    const logger: Layout = (ctx) => {
      order.push(ctx.page.sourcePath);
      return html`<i>${ctx.page.sourcePath}</i>`;
    };
    const pages = [
      makePage({
        sourcePath: "content/z.md",
        route: "/dup",
        canonicalUrl: "https://crust.dev/dup",
      }),
      makePage({
        sourcePath: "content/a.md",
        route: "/dup",
        canonicalUrl: "https://crust.dev/dup",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs: logger },
      configDir: await configDir(),
    });
    expect(order).toEqual(["content/a.md", "content/z.md"]);
    expect(result.pages.map((p) => p.page.sourcePath)).toEqual(["content/a.md", "content/z.md"]);
  });

  test("module-level state in a layout is shared across pages (pinned hazard); the head sink is NOT", async () => {
    // The engine isolates its OWN state (the per-render sink) but does not
    // police a layout's own module-level state: two pages served by the same
    // layout function instance share whatever that function closes over.
    // Pinned so nobody later "fixes" it into fake isolation (and so the
    // documented hazard stays a documented hazard, not a surprise).
    const writes: string[] = [];
    const stateful: Layout = (ctx) => {
      writes.push(ctx.page.route);
      return html`${ctx.script("app")}`;
    };
    const pages = [
      makePage({
        sourcePath: "content/b.md",
        route: "/b",
        layout: "stateful",
        canonicalUrl: "https://crust.dev/b",
      }),
      makePage({
        sourcePath: "content/a.md",
        route: "/a",
        layout: "stateful",
        canonicalUrl: "https://crust.dev/a",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { stateful },
      configDir: await configDir(),
    });
    // page 2 renders after page 1 and sees its write — the order is the
    // code-unit one, the sharing is by reference:
    expect(writes).toEqual(["/a", "/b"]);
    // …while the head sink is per-render by construction: EVERY page's first
    // call still emits the full tag.
    for (const p of result.pages) {
      expect(p.html).toBe(SCRIPT_TAG);
      expect(p.usedAssets.scripts).toEqual(["app"]);
    }
  });
});

describe("collectUnusedAssets — the cross-page audit", () => {
  test("accepts extra documents beyond the renderAll pass (chunk 7's 404 page)", async () => {
    // renderAll audits exactly the pages IT rendered; a caller that renders
    // more documents afterwards (the generated 404 page) re-runs the audit
    // over the FULL list. Extra documents are simply more inputs to the
    // usage union: a name referenced only by the 404 render is not unused.
    const pages = [
      makePage({
        sourcePath: "content/a.md",
        route: "/a",
        canonicalUrl: "https://crust.dev/a",
      }),
      makePage({
        sourcePath: "content/b.md",
        route: "/b",
        canonicalUrl: "https://crust.dev/b",
      }),
    ];
    const result = await renderAll(pages, {
      site: SITE,
      manifest: MANIFEST,
      layouts: { docs }, // the standard layout uses no assets
      configDir: await configDir(),
    });
    // The pass's own audit: nothing was referenced — all three are unused.
    expect(result.unusedAssets.map((d) => d.message)).toEqual([
      unused("app"),
      unused("orphan"),
      unused("site"),
    ]);
    // The caller's full list (content pages + a 404 render that uses
    // "orphan"): exactly that one name drops out of the audit.
    const with404 = collectUnusedAssets(MANIFEST, [
      ...result.pages,
      { usedAssets: { scripts: [], styles: ["orphan"] } },
    ]);
    expect(with404.map((d) => d.message)).toEqual([unused("app"), unused("site")]);
    // …and the union works the other way: a document using nothing changes
    // nothing.
    const withEmpty = collectUnusedAssets(MANIFEST, [
      ...result.pages,
      { usedAssets: { scripts: [], styles: [] } },
    ]);
    expect(withEmpty.map((d) => d.message)).toEqual([
      unused("app"),
      unused("orphan"),
      unused("site"),
    ]);
  });
});

describe("the sink closes when the render finishes", () => {
  test("helpers called after the render (a captured ctx) throw", async () => {
    // Array capture: a `let` assigned inside the layout closure is not
    // narrowed by TS after the await (the closure may have run), but an
    // element of a pushed-into array is.
    const seen: LayoutContext[] = [];
    const keep: Layout = (ctx) => {
      seen.push(ctx);
      return html`<i>ok</i>`;
    };
    const result = await render(makePage(), { docs: keep });
    expect(result.html).toBe("<i>ok</i>");
    expect(seen).toHaveLength(1);
    const captured = seen[0];
    expect(() => captured.head()).toThrow(/closed/);
    expect(() => captured.stylesheet("site")).toThrow(/closed/);
    expect(() => captured.script("app")).toThrow(/closed/);
    expect(() => captured.url("about.md")).toThrow(/closed/);
    expect(() => captured.publicAsset("img/logo.png")).toThrow(/closed/);
    let readErr: unknown;
    try {
      await captured.readText("nope.txt");
    } catch (e) {
      readErr = e;
    }
    expect(readErr).toBeInstanceOf(Error);
    expect(String((readErr as Error).message)).toContain("closed");
  });

  test("late async work on a captured ctx throws after the render finished", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let late: unknown;
    const layout: Layout = (ctx) => {
      // Detached work that runs ONLY after the render has finished: it waits
      // for the test's gate (released below, after renderPage returned),
      // while the render's own result resolves immediately — so the sink is
      // closed before the detached work touches the ctx.
      void (async () => {
        await gate;
        try {
          ctx.head();
        } catch (e) {
          late = e;
        }
      })();
      return html`<i>ok</i>`;
    };
    const result = await render(makePage(), { docs: layout });
    expect(result.html).toBe("<i>ok</i>");
    expect(result.diagnostics).toEqual([]);
    releaseGate?.();
    await gate;
    expect(late).toBeInstanceOf(Error);
    expect(String((late as Error).message)).toContain("layout context is closed");
  });

  test("a closed sink cannot corrupt the NEXT page's sink (first-emit memory stays per-page)", async () => {
    // The interleaving the engine must survive: page A's captured ctx is
    // used BETWEEN A and B. Every helper on it throws (closed) — and the
    // throw must land on A's own sink object, never writing into B's
    // first-emit memory. If it did, B's first script("app") would emit
    // nothing and B's document would silently lose its script tag.
    const captured: LayoutContext[] = [];
    const keep: Layout = (ctx) => {
      captured.push(ctx);
      return html`<i>a</i>`;
    };
    const useApp: Layout = (ctx) => html`${ctx.script("app")}`;
    const pageA = makePage({
      sourcePath: "content/a.md",
      route: "/a",
      canonicalUrl: "https://crust.dev/a",
    });
    const pageB = makePage({
      sourcePath: "content/b.md",
      route: "/b",
      canonicalUrl: "https://crust.dev/b",
    });
    const a = await render(pageA, { docs: keep });
    expect(a.html).toBe("<i>a</i>");
    // Between the renders: A's sink is closed.
    expect(() => captured[0].script("app")).toThrow(/closed/);
    expect(() => captured[0].stylesheet("app")).toThrow(/closed/);
    expect(() => captured[0].head()).toThrow(/closed/);
    // B's own first call still emits the full tag…
    const b = await render(pageB, { docs: useApp });
    expect(b.html).toBe(SCRIPT_TAG);
    expect(b.usedAssets.scripts).toEqual(["app"]);
    expect(b.diagnostics).toEqual([]);
    // …and a THIRD render of the same page is equally unaffected:
    const b2 = await render(pageB, { docs: useApp });
    expect(b2.html).toBe(SCRIPT_TAG);
  });
});
