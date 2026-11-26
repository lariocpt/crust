// The build pipeline e2e (chunk 7): a REAL site (config + content + layouts +
// client ts/css + public files) built into tmp dirs. Pins the emitted tree,
// the byte-exact sitemap/robots, determinism (two fresh dirs AND a rebuild
// into the SAME dir), the failed-build contract (previous output untouched by
// hash, no litter), the publish rename contract through its fs seam (restore
// on failure in BOTH directions, copy fallback, the EINVAL reason for the
// sibling layout), the crash-recovery contract (a build killed between its
// two publish renames must not lose the previous output), the concurrent-
// build lock (build.busy), the public-vs-generated collision e2e, the
// chunk-8 link-validation e2e (a .md link to a nonexistent page and a link to
// a draft each fail a production build with the line named, the previous
// output untouched), and the publicAsset existence check's traversal bypass.
//
// Honest-failure pattern: the sitemap draft-exclusion, the publish restore,
// the collision guard, the 404 asset audit, and the lock are exercised by
// cases that go RED when the guard is removed (verified by mutation during
// development), with controls that pass.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildInternal, verifyPublicAssets } from "../src/build.ts";
import type { RoutedPage } from "../src/content.ts";
import { BuildError, compareStrings, type Diagnostic } from "../src/diagnostics.ts";
import {
  acquireBuildLock,
  buildLockHash,
  cleanupStale,
  notFoundPage,
  publish,
  robotsTxt,
  sitemapXml,
  stagingDirFor,
  writePages,
} from "../src/emit.ts";
import { trustedHtml } from "../src/html.ts";
import { canonicalUrl } from "../src/routes.ts";

/** Absolute paths the generated site.config.ts / child scripts import from. */
const SRC_INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SRC_BUILD = fileURLToPath(new URL("../src/build.ts", import.meta.url));
const SITE = "https://example.dev";

/** Result paths are posix (docs, "Paths"); join() is native. */
const posixOf = (p: string): string => p.replace(/\\/g, "/");

const created: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a short-lived process, wait for exit. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["bun", "--version"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface ConfigOptions {
  site?: string;
  output?: string;
  sitemap?: boolean;
  indexable?: boolean;
  /** A path the base layout references via ctx.publicAsset() (embedded in body). */
  publicAsset?: string;
  /** false omits assets.publicDirectory entirely. */
  publicDirectory?: boolean;
  /** false omits the robots key from the generated config entirely. */
  robots?: boolean;
  /** When set, route()/parseData() append one line per call to this file. */
  countFile?: string;
  /** When true, content.route throws for every page (pre-pass attribution). */
  routeThrows?: boolean;
}

function configSource(opts: ConfigOptions = {}): string {
  const pa =
    opts.publicAsset === undefined
      ? ""
      : `${"$"}{ctx.publicAsset(${JSON.stringify(opts.publicAsset)})}`;
  const pubDir = opts.publicDirectory === false ? "" : ' publicDirectory: "public",';
  const robots = opts.robots === false ? "" : `  robots: { indexable: ${opts.indexable ?? true} },`;
  // route()/parseData() variants: the counting form appends one line per
  // call so a test can prove each hook fires EXACTLY once per page (the
  // pre-pass must not double-fire user callbacks).
  const routeLine = opts.routeThrows
    ? '    route: () => { throw new Error("route boom"); },'
    : opts.countFile === undefined
      ? '    route: ({ relativePath }) => (relativePath === "index" ? "/" : "/" + relativePath),'
      : [
          "    route: ({ relativePath }) => {",
          '      appendFileSync(COUNTER, "route " + relativePath + "\\n");',
          '      return relativePath === "index" ? "/" : "/" + relativePath;',
          "    },",
        ].join("\n");
  const parseDataLine =
    opts.countFile === undefined
      ? ""
      : [
          "    parseData: (data, ctx) => {",
          '      appendFileSync(COUNTER, "parseData " + ctx.sourcePath + "\\n");',
          "      return data ?? {};",
          "    },",
        ].join("\n");
  const counterImport =
    opts.countFile === undefined
      ? ""
      : `import { appendFileSync } from "node:fs";\nconst COUNTER = ${JSON.stringify(opts.countFile)};`;
  return [
    `import { defineSite, html } from ${JSON.stringify(SRC_INDEX)};`,
    counterImport,
    "export default defineSite({",
    `  site: ${JSON.stringify(opts.site ?? SITE)},`,
    "  content: {",
    '    directory: "content",',
    '    defaultLayout: "base",',
    routeLine,
    parseDataLine,
    "  },",
    "  layouts: {",
    "    base: (ctx) => html`<!doctype html>",
    // `$` built via interpolation so this file itself carries no `${` text
    // (biome's noTemplateCurlyInString would flag the literal).
    `<html lang="en"><head><meta charset="utf-8">${"$"}{ctx.head()}${"$"}{ctx.stylesheet("site")}${"$"}{ctx.script("app")}</head><body>${"$"}{ctx.content}${pa}</body></html>\`,`,
    "  },",
    `  assets: { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" },${pubDir} },`,
    `  output: { directory: ${JSON.stringify(opts.output ?? "dist")} },`,
    `  sitemap: ${opts.sitemap ?? true},`,
    `${robots}`,
    "});",
    "",
  ].join("\n");
}

/** Writes a complete site into root; returns the config file path. */
async function makeSite(root: string, config?: string): Promise<string> {
  await mkdir(join(root, "content", "a"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "site.config.ts"), config ?? configSource());
  await writeFile(
    join(root, "content", "index.md"),
    "---\ntitle: Home\ndescription: The home page\n---\n\n# Hello\n\nWelcome to crust.\n\n" +
      "[b](a/b.md#b) and [top](#hello).\n",
  );
  await writeFile(
    join(root, "content", "a", "b.md"),
    "---\ntitle: B\ndescription: Page B\n---\n\n# B\n\nDeep page.\n",
  );
  await writeFile(
    join(root, "content", "draft.md"),
    "---\ntitle: Draft\ndescription: Work in progress\ndraft: true\n---\n\n# Draft\n",
  );
  await writeFile(join(root, "src", "app.ts"), 'console.log("hi");\n');
  await writeFile(join(root, "src", "site.css"), "body { color: red; }\n");
  await writeFile(join(root, "public", "favicon.txt"), "icon\n");
  return join(root, "site.config.ts");
}

/** Recursive file map: output-relative posix path → bytes. */
async function tree(dir: string, rel = "", out: Record<string, Buffer> = {}) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const r = rel === "" ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) await tree(join(dir, d.name), r, out);
    else out[r] = await readFile(join(dir, d.name));
  }
  return out;
}

function treesEqual(a: Record<string, Buffer>, b: Record<string, Buffer>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k].equals(b[k]));
}

/** A content hash over a file map: the "previous output untouched" proof. */
function treeHash(t: Record<string, Buffer>): string {
  return createHash("sha256")
    .update(
      Object.keys(t)
        .sort()
        .map((k) => `${k}:${t[k]}`)
        .join("\n"),
    )
    .digest("hex");
}

async function seed(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
}

function errnoError(code: string): Error {
  const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ---------------------------------------------------------------------------
// e2e: the happy path
// ---------------------------------------------------------------------------

describe("build — happy path", () => {
  test("full tree, exact sitemap/robots bytes, 404 present and excluded", async () => {
    const root = await tmp("crust-site-build-");
    const cfg = await makeSite(root);
    const result = await build({ configFile: cfg });
    const dist = join(root, "dist");
    const t = await tree(dist);

    const assetKeys = Object.keys(t)
      .filter((k) => k.startsWith("assets/"))
      .sort();
    expect(assetKeys.length).toBe(2);
    expect(assetKeys[0]).toMatch(/^assets\/app-[0-9a-f]{16}\.js$/);
    expect(assetKeys[1]).toMatch(/^assets\/site-[0-9a-f]{16}\.css$/);
    expect(Object.keys(t).sort()).toEqual(
      [
        "404.html",
        "a/b.html",
        "favicon.txt",
        "index.html",
        "robots.txt",
        "sitemap.xml",
        ...assetKeys,
      ].sort(),
    );

    const index = t["index.html"].toString("utf8");
    expect(index).toContain('<meta charset="utf-8">');
    expect(index).toContain("<title>Home</title>");
    expect(index).toContain(`<link rel="stylesheet" href="${SITE}/assets/site-`);
    expect(index).toContain(`<script defer src="${SITE}/assets/app-`);
    expect(index).toContain("<h1");
    // chunk 8: the relative .md link rewrites against the route table
    // (a/b.md#b → /a/b#b) and the pure fragment keeps the page's own route
    // (#hello). Both destinations resolve and carry the fragment's id, so
    // step 7 passes them silently — the failure modes (a link to a missing
    // page, a link to a draft) are pinned in the "link validation" block.
    expect(index).toContain('href="/a/b#b"');
    expect(index).toContain('href="#hello"');
    expect(t["a/b.html"].toString("utf8")).toContain("<title>B</title>");

    // the generated 404: rendered through the default layout, fixed title.
    const notFound = t["404.html"].toString("utf8");
    expect(notFound).toContain("<title>Not found</title>");
    expect(notFound).toContain("The page you are looking for does not exist.");

    // drafts: no file, no sitemap entry.
    expect(t["draft.html"]).toBeUndefined();

    // byte-pinned sitemap: lexicographic URL order, root as site+"/",
    // no lastmod/changefreq/priority, no draft, no 404.
    expect(t["sitemap.xml"].toString("utf8")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "<url><loc>https://example.dev/</loc></url>\n" +
        "<url><loc>https://example.dev/a/b</loc></url>\n" +
        "</urlset>\n",
    );
    expect(t["robots.txt"].toString("utf8")).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://example.dev/sitemap.xml\n",
    );

    // public file at the output root, byte-for-byte.
    expect(t["favicon.txt"].toString("utf8")).toBe("icon\n");

    // the BuildResult contract. pages = CONTENT pages only: the generated 404
    // is emitted and it is in the sitemap exclusion, but it is NOT a page
    // (decision pinned here — the sitemap assertion above pins the other half).
    expect(result.pages).toEqual([
      { route: "/", sourcePath: "content/index.md", file: "index.html" },
      { route: "/a/b", sourcePath: "content/a/b.md", file: "a/b.html" },
    ]);
    expect(result.pages.some((p) => p.route === "/404")).toBe(false);
    expect(result.assets).toEqual({ app: assetKeys[0], site: assetKeys[1] });
    expect(result.warnings).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("internal result carries the per-page readText deps map; public one does not", async () => {
    const root = await tmp("crust-site-build-deps-");
    const cfg = await makeSite(root);
    const internal = await buildInternal({ configFile: cfg });
    expect(Object.keys(internal.pageDeps).sort()).toEqual([
      "<generated>",
      "content/a/b.md",
      "content/index.md",
    ]);
    for (const deps of Object.values(internal.pageDeps)) expect(deps).toEqual([]);
    const publicResult = await build({ configFile: cfg });
    expect("pageDeps" in publicResult).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// determinism + rebuild
// ---------------------------------------------------------------------------

describe("build — determinism and rebuild", () => {
  test("two output dirs are byte-identical (plan §4.6)", async () => {
    const root = await tmp("crust-site-determinism-");
    await makeSite(root);
    await writeFile(join(root, "site.a.ts"), configSource({ output: "dist-a" }));
    await writeFile(join(root, "site.b.ts"), configSource({ output: "dist-b" }));
    await build({ configFile: join(root, "site.a.ts") });
    await build({ configFile: join(root, "site.b.ts") });
    expect(treesEqual(await tree(join(root, "dist-a")), await tree(join(root, "dist-b")))).toBe(
      true,
    );
  });

  test("rebuild over an existing output replaces it (the ENOTEMPTY blocker)", async () => {
    const root = await tmp("crust-site-rebuild-");
    const cfg = await makeSite(root);
    await build({ configFile: cfg });
    const first = await tree(join(root, "dist"));
    await build({ configFile: cfg }); // rename(out→old)+rename(staging→out), not ENOTEMPTY
    expect(treesEqual(await tree(join(root, "dist")), first)).toBe(true);

    // and stale content is really replaced, not merged:
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello again\n",
    );
    await build({ configFile: cfg });
    const t = await tree(join(root, "dist"));
    expect(t["index.html"].toString("utf8")).toContain("<title>Home v2</title>");
    expect(t["index.html"].toString("utf8")).not.toContain("Welcome to crust.");
    // no staging/old litter survives a successful build
    const siblings = await readdir(root);
    expect(siblings.filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("rebuild into the SAME dir: every BuildResult field identical except durationMs", async () => {
    const root = await tmp("crust-site-redet-");
    const cfg = await makeSite(root);
    const r1 = await build({ configFile: cfg });
    const r2 = await build({ configFile: cfg });
    // durationMs is the only field allowed to vary; everything else is a
    // deterministic contract (plan §4.6) — pinned field by field so a new
    // nondeterministic field cannot hide inside a toEqual of the whole result.
    expect(r2.contractVersion).toBe(r1.contractVersion);
    expect(r2.outputDirectory).toBe(r1.outputDirectory);
    expect(r2.pages).toEqual(r1.pages);
    expect(r2.assets).toEqual(r1.assets);
    expect(r2.warnings).toEqual(r1.warnings);
    // BuildResult.pages is sorted by route
    const routes = r1.pages.map((p) => p.route);
    expect(routes).toEqual([...routes].sort(compareStrings));
  });
});

// ---------------------------------------------------------------------------
// failed builds
// ---------------------------------------------------------------------------

describe("build — failure contract", () => {
  test("broken frontmatter rejects with BuildError; previous output untouched", async () => {
    const root = await tmp("crust-site-fail-");
    const cfg = await makeSite(root);
    await build({ configFile: cfg });
    const before = treeHash(await tree(join(root, "dist")));

    await writeFile(
      join(root, "content", "broken.md"),
      "---\ndescription: no title here\n---\n\n# Broken\n",
    );
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics as Diagnostic[];
    expect(diagnostics.some((d) => d.code === "frontmatter.missing-title")).toBe(true);

    // the previous output is byte-identical (by hash), and no litter remains.
    expect(treeHash(await tree(join(root, "dist")))).toBe(before);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("one run reports a page error, a page warning AND an asset failure together", async () => {
    const root = await tmp("crust-site-collect-");
    const cfg = await makeSite(root);
    // five production pages; p3 starts healthy.
    for (const name of ["p4", "p5"]) {
      await writeFile(
        join(root, "content", `${name}.md`),
        `---\ntitle: ${name}\ndescription: Page ${name}\n---\n\n# ${name}\n\nParagraph for ${name}.\n`,
      );
    }
    await writeFile(
      join(root, "content", "p3.md"),
      "---\ntitle: P3\ndescription: Page P3\n---\n\n# P3\n\nParagraph for p3.\n",
    );
    await build({ configFile: cfg });
    const before = treeHash(await tree(join(root, "dist")));

    // break THREE different stages at once:
    //   asset stage — the app.ts entrypoint no longer parses
    await writeFile(join(root, "src", "app.ts"), "const x = ; // syntax error\n");
    //   parse stage, page 3 of 5 — the title disappears
    await writeFile(
      join(root, "content", "p3.md"),
      "---\ndescription: No title on this page\n---\n\n# P3\n\nParagraph for p3.\n",
    );
    //   parse stage, another page — the description disappears (a warning)
    await writeFile(
      join(root, "content", "a", "b.md"),
      "---\ntitle: B\n---\n\n# B\n\nDeep page.\n",
    );

    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    // the asset failure (bundling stage)
    expect(diagnostics.some((d) => d.code === "asset.bundle-failed")).toBe(true);
    // the page error (parse stage)
    expect(
      diagnostics.some(
        (d) => d.code === "frontmatter.missing-title" && d.sourcePath === "content/p3.md",
      ),
    ).toBe(true);
    // the page warning (parse stage) — warnings are collected, not dropped
    expect(
      diagnostics.some(
        (d) =>
          d.code === "frontmatter.derived-description" &&
          d.severity === "warning" &&
          d.sourcePath === "content/a/b.md",
      ),
    ).toBe(true);
    // the previous output is untouched (by hash), and no litter remains.
    expect(treeHash(await tree(join(root, "dist")))).toBe(before);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// link validation (chunk 8): the real route table as the link resolver, and
// step 7's link.broken / link.draft as build-blocking errors
// ---------------------------------------------------------------------------

describe("build — link validation (chunk 8)", () => {
  test("rewritten Markdown links retain the site prefix through final validation", async () => {
    const root = await tmp("crust-site-link-prefix-");
    const cfg = await makeSite(root, configSource({ site: "https://example.dev/docs" }));
    const result = await build({ configFile: cfg });
    expect(result.warnings).toEqual([]);
    const index = await readFile(join(root, "dist", "index.html"), "utf8");
    expect(index).toContain('href="/docs/a/b#b"');
    expect(index).toContain('href="#hello"');
  });

  test("a .md link to a nonexistent page is link.broken (source + line + destination); previous output untouched", async () => {
    const root = await tmp("crust-site-link-broken-");
    const cfg = await makeSite(root);
    await build({ configFile: cfg });
    const before = treeHash(await tree(join(root, "dist")));

    // the link paragraph sits on file line 6 (4 frontmatter lines + blank)
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home\ndescription: The home page\n---\n\n[nope](missing.md)\n",
    );
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    // exactly one problem in the whole run: the broken link
    expect(diagnostics).toEqual([
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
    // the previous output is untouched (by hash), and no litter remains
    expect(treeHash(await tree(join(root, "dist")))).toBe(before);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("a .md link to a draft page is link.draft (ERROR in a production build); previous output untouched", async () => {
    const root = await tmp("crust-site-link-draft-");
    const cfg = await makeSite(root);
    await build({ configFile: cfg });
    const before = treeHash(await tree(join(root, "dist")));

    // the draft exists (content/draft.md, draft: true) but is excluded from
    // the production build — the link resolves (the resolver saw it) and
    // step 7 must turn it into an error, never let it pass silently.
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home\ndescription: The home page\n---\n\n[work](draft.md)\n",
    );
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    expect(diagnostics).toEqual([
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
    // the previous output is untouched (by hash), and no litter remains
    expect(treeHash(await tree(join(root, "dist")))).toBe(before);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pre-pass discipline (chunk 8): one read + one frontmatter parse per file,
// user hooks fired exactly once, broken pages diagnosed once and never routed,
// a throwing content.route attributed to its page.
// ---------------------------------------------------------------------------

describe("build — pre-pass and hook discipline (chunk 8)", () => {
  test("route() and parseData() fire EXACTLY once per page (pre-pass must not double-fire user hooks)", async () => {
    const root = await tmp("crust-site-hooks-");
    const counter = join(root, "calls.log");
    const cfg = await makeSite(root, configSource({ countFile: counter }));
    await build({ configFile: cfg });
    const lines = (await readFile(counter, "utf8")).trim().split("\n").sort();
    // 3 content pages (index, a/b, draft): route() once each in the pre-pass
    // (the route table REPLAYS the decisions, never re-derives), parseData
    // once each in parsePage (the pre-pass never renders markdown).
    expect(lines.filter((l) => l.startsWith("route "))).toEqual([
      "route a/b",
      "route draft",
      "route index",
    ]);
    expect(lines.filter((l) => l.startsWith("parseData "))).toEqual([
      "parseData content/a/b.md",
      "parseData content/draft.md",
      "parseData content/index.md",
    ]);
    // nothing else called the hooks
    expect(lines).toHaveLength(6);
  });

  test("a page failing the frontmatter pre-pass is diagnosed ONCE and never routed", async () => {
    const root = await tmp("crust-site-badfm-");
    const cfg = await makeSite(root);
    await writeFile(join(root, "content", "bad.md"), "---\ntitle: [unclosed\n---\n\nbody\n");
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    // the frontmatter failure surfaces EXACTLY once — the pre-pass reports
    // it and parsePage is never called for the file (no double-fire).
    expect(diagnostics.filter((d) => d.sourcePath === "content/bad.md")).toEqual([
      {
        code: "frontmatter.parse-error",
        severity: "error",
        sourcePath: "content/bad.md",
        line: 2,
        column: 17,
        message: expect.stringContaining("frontmatter YAML is not parseable"),
      },
    ]);
    // the page was never routed (no Page, no table entry). Its broken link
    // is NOT additionally reported: the pre-existing error gate throws before
    // step 7 whenever any earlier error exists ("emit only reached
    // error-free") — the build fails either way, never a false pass. The
    // link.broken path itself is pinned by the missing.md e2e above.
    expect(diagnostics.map((d) => d.code).filter((c) => c.startsWith("link."))).toEqual([]);
  });

  test("a throwing content.route is attributed to each page exactly once (pre-pass), never re-thrown by the table", async () => {
    const root = await tmp("crust-site-routethrow-");
    const cfg = await makeSite(root, configSource({ routeThrows: true }));
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const invalid = (error as BuildError).diagnostics.filter((d) => d.code === "route.invalid");
    // one per page — the pre-pass caught the throw with the page's
    // sourcePath, and the route table replayed (never re-derived) it.
    expect(invalid.map((d) => d.sourcePath).sort()).toEqual([
      "content/a/b.md",
      "content/draft.md",
      "content/index.md",
    ]);
    expect(invalid.every((d) => d.message.includes("route boom"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// config loading
// ---------------------------------------------------------------------------

describe("build — config loading", () => {
  test("a missing config file is a config.load diagnostic, not a raw crash", async () => {
    const root = await tmp("crust-site-cfg-missing-");
    await mkdir(root, { recursive: true });
    let error: unknown;
    try {
      await build({ configFile: join(root, "site.config.ts") });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0]?.code).toBe("config.load");
  });

  test("a config with no default export is config.load", async () => {
    const root = await tmp("crust-site-cfg-nodefault-");
    const cfg = join(root, "site.config.ts");
    await mkdir(root, { recursive: true });
    await writeFile(cfg, "export const notAConfig = 1;\n");
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0]?.code).toBe("config.load");
  });

  test("a default export that is not a defineSite result is config.load", async () => {
    const root = await tmp("crust-site-cfg-badexport-");
    const cfg = join(root, "site.config.ts");
    await mkdir(root, { recursive: true });
    await writeFile(cfg, "export default { site: 'https://x.dev' };\n");
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0]?.code).toBe("config.load");
  });

  test("a config that throws on import (syntax error) is config.load", async () => {
    const root = await tmp("crust-site-cfg-syntax-");
    const cfg = join(root, "site.config.ts");
    await mkdir(root, { recursive: true });
    await writeFile(cfg, "export default defineSite({ this is not valid TypeScript\n");
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0]?.code).toBe("config.load");
  });

  test("a relative configFile resolves against the cwd, in a real child process", async () => {
    const root = await tmp("crust-site-cfg-relative-");
    await makeSite(root); // site.config.ts at root
    const script = join(root, "relative-child.ts");
    await writeFile(
      script,
      [
        `import { build } from ${JSON.stringify(SRC_BUILD)};`,
        `const result = await build({ configFile: "site.config.ts" });`,
        `console.log("OUT " + result.outputDirectory);`,
        `console.log("PAGES " + result.pages.length);`,
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    expect(code).toBe(0);
    expect(stderr).toBe("");
    // the relative configFile resolved against the child's CWD, not the
    // config's own directory or the importing file's directory
    expect(stdout).toContain(`OUT ${posixOf(join(root, "dist"))}`);
    expect(stdout).toContain("PAGES 2");
    expect(
      await stat(join(root, "dist"))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// publicAsset existence check (the emitter verifies render's recorded paths)
// ---------------------------------------------------------------------------

describe("publicAsset existence check", () => {
  test("URL encoding preserves the literal path for existence checks and copying", async () => {
    const root = await tmp("crust-site-pa-encoded-");
    const path = "logo# 100%.svg";
    const cfg = await makeSite(
      root,
      configSource({ publicAsset: path, site: "https://example.dev/docs" }),
    );
    await writeFile(join(root, "public", path), "literal asset");
    const result = await build({ configFile: cfg });
    expect(result.warnings).toEqual([]);
    const index = await readFile(join(root, "dist", "index.html"), "utf8");
    expect(index).toContain(`https://example.dev/docs/${encodeURIComponent(path)}`);
    expect(await readFile(join(root, "dist", path), "utf8")).toBe("literal asset");
  });

  test("a path that exists under publicDirectory builds and renders", async () => {
    const root = await tmp("crust-site-pa-ok-");
    const cfg = await makeSite(root, configSource({ publicAsset: "favicon.txt" }));
    const result = await build({ configFile: cfg });
    expect(result.warnings).toEqual([]);
    const html = await readFile(join(root, "dist", "index.html"), "utf8");
    expect(html).toContain(`${SITE}/favicon.txt`);
  });

  test("a missing path fails the build with public-asset.missing", async () => {
    const root = await tmp("crust-site-pa-missing-");
    const cfg = await makeSite(root, configSource({ publicAsset: "nope.txt" }));
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    const missing = diagnostics.filter((d) => d.code === "public-asset.missing");
    // every page rendered through the layout recorded it (index, a/b, the 404)
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((d) => d.message.includes("nope.txt"))).toBe(true);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("publicAsset with no publicDirectory configured is missing", async () => {
    const root = await tmp("crust-site-pa-nodir-");
    const cfg = await makeSite(
      root,
      configSource({ publicAsset: "favicon.txt", publicDirectory: false }),
    );
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    expect(diagnostics.some((d) => d.code === "public-asset.missing")).toBe(true);
    expect(diagnostics.some((d) => d.message.includes("not configured"))).toBe(true);
  });

  test("hostile recorded paths cannot bypass the public directory (no stat outside)", async () => {
    const root = await tmp("crust-site-pa-hostile-");
    await mkdir(join(root, "public", "sub"), { recursive: true });
    await mkdir(join(root, "private"), { recursive: true });
    // REAL files outside the public directory: a plain join+stat would bless
    // them (join drops publicDir for an absolute path; ".." and Windows
    // backslashes traverse) — the check must refuse them as malformed.
    await writeFile(join(root, "private", "secret.txt"), "top secret\n");
    await writeFile(join(root, "etc-target.txt"), "target\n");
    await writeFile(join(root, "public", "ok.txt"), "fine\n");
    const page = { sourcePath: "content/x.md" };
    const diagnostics = await verifyPublicAssets(join(root, "public"), [
      { page, publicAssets: [] },
      { page, publicAssets: ["../private/secret.txt"] }, // traversal, REAL target outside
      { page, publicAssets: ["ok.txt"] }, // the only legal path
      { page, publicAssets: ["/etc-target.txt"] }, // absolute: join drops publicDir
      { page, publicAssets: ["sub\\..\\private\\secret.txt"] }, // backslash: a Windows traversal
    ]);
    // every hostile path is flagged as missing — none may pass an outside stat
    const missing = diagnostics.filter((d) => d.code === "public-asset.missing");
    expect(missing.length).toBe(3);
    // and the legal path is NOT flagged
    expect(diagnostics.some((d) => d.message.includes("ok.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the 404 page: asset audit, pages contract
// ---------------------------------------------------------------------------

describe("build — the generated 404 page", () => {
  test("an asset referenced ONLY by the 404's layout is not reported unused", async () => {
    const root = await tmp("crust-site-404-audit-");
    await makeSite(root);
    // defaultLayout "nf" references script("only404"); the content pages pin
    // layout "base" (frontmatter), which references script("app"). If the
    // audit ran over the content pages only, "only404" would be a false
    // asset.unused warning — this test goes red when the 404 render is not
    // fed to the audit (honest-failure guard).
    await writeFile(
      join(root, "site.config.ts"),
      [
        `import { defineSite, html } from ${JSON.stringify(SRC_INDEX)};`,
        "export default defineSite({",
        `  site: ${JSON.stringify(SITE)},`,
        "  content: {",
        '    directory: "content",',
        '    defaultLayout: "nf",',
        '    route: ({ relativePath }) => (relativePath === "index" ? "/" : "/" + relativePath),',
        "  },",
        "  layouts: {",
        // backticks (not single quotes): the ${"$"} → $ interpolation trick
        // only works inside template literals, so the generated config must
        // carry REAL ${ctx...} substitutions (the same pattern as configSource)
        `    base: (ctx) => html\`<html><head><meta charset="utf-8">` +
          `${"$"}{ctx.head()}` +
          `${"$"}{ctx.script("app")}</head><body>` +
          `${"$"}{ctx.content}</body></html>\`,`,
        `    nf: (ctx) => html\`<html><head><meta charset="utf-8">` +
          `${"$"}{ctx.head()}` +
          `${"$"}{ctx.script("only404")}</head><body>` +
          `${"$"}{ctx.content}</body></html>\`,`,
        "  },",
        '  assets: { scripts: { app: "src/app.ts", only404: "src/only404.ts" }, publicDirectory: "public" },',
        '  output: { directory: "dist" },',
        "  sitemap: true,",
        "  robots: { indexable: true },",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "src", "only404.ts"), "console.log(404);\n");
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home\ndescription: The home page\nlayout: base\n---\n\n# Hello\n\nBody.\n",
    );
    await writeFile(
      join(root, "content", "a", "b.md"),
      "---\ntitle: B\ndescription: Page B\nlayout: base\n---\n\n# B\n\nBody.\n",
    );

    const result = await build({ configFile: join(root, "site.config.ts") });
    // no warning: the 404's usage of "only404" counts
    expect(result.warnings).toEqual([]);
    // and the 404 really carries the asset
    const html404 = await readFile(join(root, "dist", "404.html"), "utf8");
    expect(html404).toContain("assets/only404-");
    expect(html404).not.toContain("assets/app-");
  });
});

// ---------------------------------------------------------------------------
// sitemap / robots
// ---------------------------------------------------------------------------

function fakePage(route: string, site: string, draft = false): RoutedPage {
  return {
    sourcePath: `content/${route === "/" ? "index" : route.slice(1)}.md`,
    relativePath: route === "/" ? "index" : route.slice(1),
    route,
    canonicalUrl: canonicalUrl(site, route),
    layout: "base",
    title: "T",
    description: "D",
    headings: [],
    data: {},
    draft,
    body: trustedHtml(""),
    links: [],
    warnings: [],
    diagnostics: [],
  };
}

describe("sitemapXml / robotsTxt", () => {
  test("lexicographic order, prefixed site root, drafts and 404 excluded", () => {
    const pages = [
      fakePage("/b", SITE),
      fakePage("/", SITE),
      fakePage("/a", SITE),
      fakePage("/draft", SITE, true), // must NEVER appear
      fakePage("/404", SITE), // must NEVER appear
    ];
    expect(sitemapXml(pages)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "<url><loc>https://example.dev/</loc></url>\n" +
        "<url><loc>https://example.dev/a</loc></url>\n" +
        "<url><loc>https://example.dev/b</loc></url>\n" +
        "</urlset>\n",
    );
    // a path-prefixed site: the root URL keeps the prefix and gets its slash.
    expect(sitemapXml([fakePage("/", "https://x.dev/docs")])).toContain(
      "<url><loc>https://x.dev/docs/</loc></url>",
    );
  });

  test("URLs with & are XML-escaped (& FIRST); unicode stays literal UTF-8", () => {
    const pages = [fakePage("/c", "https://x.dev/a&b"), fakePage("/", "https://x.dev/a&b")];
    expect(sitemapXml(pages)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "<url><loc>https://x.dev/a&amp;b/</loc></url>\n" +
        "<url><loc>https://x.dev/a&amp;b/c</loc></url>\n" +
        "</urlset>\n",
    );
    // a unicode prefix is legal URL text and stays literal (the file is
    // UTF-8) — only & < > " ' become entities
    expect(sitemapXml([fakePage("/", "https://x.dev/путь")])).toContain(
      "<url><loc>https://x.dev/путь/</loc></url>",
    );
  });

  test("e2e: a site with & in its prefix escapes the sitemap and the canonical URLs", async () => {
    const root = await tmp("crust-site-escape-");
    const cfg = await makeSite(root, configSource({ site: "https://example.dev/x&y" }));
    await build({ configFile: cfg });
    const t = await tree(join(root, "dist"));
    expect(t["sitemap.xml"].toString("utf8")).toContain(
      "<url><loc>https://example.dev/x&amp;y/</loc></url>",
    );
    // head() emits the canonical through the html runtime's one escaper
    expect(t["index.html"].toString("utf8")).toContain(
      '<link rel="canonical" href="https://example.dev/x&amp;y/">',
    );
  });

  test("robots bodies are byte-exact in both modes", () => {
    expect(robotsTxt(SITE, { indexable: true }, true)).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://example.dev/sitemap.xml\n",
    );
    expect(robotsTxt(SITE, { indexable: true }, false)).toBe("User-agent: *\nAllow: /\n");
    // not indexable: bare Disallow, NO Sitemap line — even with the sitemap on
    // (the file is still emitted; it is a link-checker input, not a crawler hint).
    expect(robotsTxt(SITE, { indexable: false }, true)).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt(SITE, undefined, true)).toBeNull();
  });

  test("e2e: not-indexable emits the Disallow robots and keeps the sitemap file", async () => {
    const root = await tmp("crust-site-robots-");
    const cfg = await makeSite(root, configSource({ indexable: false }));
    await build({ configFile: cfg });
    const t = await tree(join(root, "dist"));
    expect(t["robots.txt"].toString("utf8")).toBe("User-agent: *\nDisallow: /\n");
    expect(t["sitemap.xml"]).toBeDefined();
  });

  test("e2e: no robots config emits NO robots.txt (absent, not empty) and keeps the sitemap", async () => {
    const root = await tmp("crust-site-norobots-");
    const cfg = await makeSite(root, configSource({ robots: false }));
    await build({ configFile: cfg });
    const t = await tree(join(root, "dist"));
    expect(t["robots.txt"]).toBeUndefined();
    expect(t["sitemap.xml"]).toBeDefined();
  });
});
// ---------------------------------------------------------------------------
// startup cleanup + crash recovery
// ---------------------------------------------------------------------------

describe("startup cleanup / crash recovery", () => {
  test("dead builds' stale trees are removed; a LIVE build's trees are kept", async () => {
    const root = await tmp("crust-site-stale-");
    const cfg = await makeSite(root);
    const hash = buildLockHash(join(root, "dist"));
    const dead = await deadPid();
    await seed(join(root, `.crust-staging-${dead}-aaaaaa`), { "junk.txt": "x" });
    await seed(join(root, `.crust-out-old-${hash}-${dead}-bbbbbb`), { "junk.txt": "x" });
    await writeFile(join(root, `.crust-out-lock-${hash}-${dead}-cccccc`), "");
    // trees of a LIVE build in the same parent (same output): must survive
    // this build's cleanup — deleting them would clobber a running build
    await seed(join(root, `.crust-staging-${process.pid}-dddddd`), { "wip.txt": "x" });
    await seed(join(root, `.crust-out-old-${hash}-${process.pid}-eeeeee`), { "wip.txt": "x" });
    await seed(join(root, ".crust-keep-me"), { "junk.txt": "x" }); // not our pattern
    await build({ configFile: cfg });
    const names = await readdir(root);
    expect(names).not.toContain(`.crust-staging-${dead}-aaaaaa`);
    expect(names).not.toContain(`.crust-out-old-${hash}-${dead}-bbbbbb`);
    expect(names).not.toContain(`.crust-out-lock-${hash}-${dead}-cccccc`);
    expect(names).toContain(`.crust-staging-${process.pid}-dddddd`);
    expect(names).toContain(`.crust-out-old-${hash}-${process.pid}-eeeeee`);
    expect(names).toContain(".crust-keep-me");
    // the build's OWN trees are all gone after success
    expect(names.filter((n) => n.startsWith(".crust-")).sort()).toEqual([
      ".crust-keep-me",
      `.crust-out-old-${hash}-${process.pid}-eeeeee`,
      `.crust-staging-${process.pid}-dddddd`,
    ]);
  });

  test("cleanupStale on a missing parent is a no-op", async () => {
    await cleanupStale(join(await tmp("crust-site-noparent-"), "missing", "dist"));
  });

  test("a build killed between its two publish renames: the previous output is RESTORED, not deleted", async () => {
    const root = await tmp("crust-site-recover-");
    const out = join(root, "dist");
    const hash = buildLockHash(out);
    const dead = await deadPid();
    await writeFile(join(root, `.crust-out-lock-${hash}-${dead}-aaaaaa`), "");
    await seed(join(root, `.crust-out-old-${hash}-${dead}-bbbbbb`), {
      "index.html": "previous output\n",
      "sub/x.txt": "kept\n",
    });
    await seed(join(root, `.crust-staging-${dead}-cccccc`), { "junk.txt": "x" });
    // no dist: the kill left the output path missing
    await cleanupStale(out);
    // the previous output is back, byte-identical — a kill between the two
    // renames must never lose it (crust rule 1; the old unconditional sweep
    // DELETED the orphan, which is exactly the data loss this pins against)
    expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe("previous output\n");
    expect(await readFile(join(root, "dist", "sub", "x.txt"), "utf8")).toBe("kept\n");
    const names = await readdir(root);
    expect(names).not.toContain(`.crust-out-old-${hash}-${dead}-bbbbbb`);
    expect(names).not.toContain(`.crust-out-lock-${hash}-${dead}-aaaaaa`);
    expect(names).not.toContain(`.crust-staging-${dead}-cccccc`);
  });

  test("a double-kill edge: the orphaned tree is restored deterministically (sorted first wins)", async () => {
    const root = await tmp("crust-site-recover2-");
    const out = join(root, "dist");
    const hash = buildLockHash(out);
    const dead = await deadPid();
    // no lock at all: the orphan's own tag (output hash + dead pid) suffices
    await seed(join(root, `.crust-out-old-${hash}-${dead}-aaaaaa`), { "index.html": "second\n" });
    await seed(join(root, `.crust-out-old-${hash}-${dead}-bbbbbb`), { "index.html": "first\n" });
    await cleanupStale(out);
    expect(await readFile(join(root, "dist", "index.html"), "utf8")).toBe("second\n");
    const names = await readdir(root);
    expect(names).not.toContain(`.crust-out-old-${hash}-${dead}-aaaaaa`);
    expect(names).not.toContain(`.crust-out-old-${hash}-${dead}-bbbbbb`);
  });

  test("an orphan for ANOTHER output is left alone (its recovery belongs to its own builds)", async () => {
    const root = await tmp("crust-site-recover3-");
    const out = join(root, "dist");
    const otherHash = buildLockHash(join(root, "other"));
    const dead = await deadPid();
    await seed(join(root, `.crust-out-old-${otherHash}-${dead}-aaaaaa`), { "other.txt": "x" });
    await cleanupStale(out);
    const names = await readdir(root);
    expect(names).toContain(`.crust-out-old-${otherHash}-${dead}-aaaaaa`);
    expect(names).not.toContain("dist");
  });

  test("e2e: after a killed mid-publish build, the next build succeeds and leaves no litter", async () => {
    const root = await tmp("crust-site-recover-e2e-");
    const cfg = await makeSite(root);
    const out = join(root, "dist");
    const hash = buildLockHash(out);
    const dead = await deadPid();
    await writeFile(join(root, `.crust-out-lock-${hash}-${dead}-aaaaaa`), "");
    await seed(join(root, `.crust-out-old-${hash}-${dead}-bbbbbb`), { "index.html": "previous\n" });
    const result = await build({ configFile: cfg });
    expect(result.pages).toHaveLength(2);
    const t = await tree(join(root, "dist"));
    expect(t["index.html"].toString("utf8")).toContain("<title>Home</title>");
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// publish (fs seam)
// ---------------------------------------------------------------------------

describe("publish", () => {
  test("no existing output: rename staging into place", async () => {
    const root = await tmp("crust-site-pub-new-");
    const staging = join(root, ".crust-staging-1-aa");
    await seed(staging, { "index.html": "new", "sub/deep.txt": "d" });
    await publish(staging, join(root, "out"));
    expect(Object.keys(await tree(join(root, "out"))).sort()).toEqual([
      "index.html",
      "sub/deep.txt",
    ]);
    await expect(stat(staging)).rejects.toThrow();
  });

  test("existing output: replaced wholesale, no old tree left behind", async () => {
    const root = await tmp("crust-site-pub-swap-");
    const staging = join(root, ".crust-staging-1-bb");
    await seed(staging, { "index.html": "new" });
    await seed(join(root, "out"), { "old.html": "old" });
    await publish(staging, join(root, "out"));
    const t = await tree(join(root, "out"));
    expect(Object.keys(t)).toEqual(["index.html"]);
    expect(t["index.html"].toString("utf8")).toBe("new");
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("failure after the output moved aside restores the previous output", async () => {
    const root = await tmp("crust-site-pub-restore-");
    const staging = join(root, ".crust-staging-1-cc");
    await seed(staging, { "index.html": "new" });
    await seed(join(root, "out"), { "old.html": "old" });
    const real = rename;
    let calls = 0;
    const deps = {
      rename: async (from: string, to: string) => {
        calls += 1;
        if (calls === 2) throw errnoError("EIO"); // the staging→out rename fails
        await real(from, to);
      },
    };
    let error: unknown;
    try {
      await publish(staging, join(root, "out"), deps);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("simulated EIO");
    // the previous output is exactly back, and the old tree is gone from it.
    const t = await tree(join(root, "out"));
    expect(Object.keys(t)).toEqual(["old.html"]);
    expect(t["old.html"].toString("utf8")).toBe("old");
    await rm(staging, { recursive: true, force: true });
  });

  test("a failed swap AND a failed restore keep the old tree, named in the error (no loss)", async () => {
    const root = await tmp("crust-site-pub-restorefail-");
    const staging = join(root, ".crust-staging-1-cc2");
    await seed(staging, { "index.html": "new" });
    await seed(join(root, "out"), { "old.html": "old" });
    const real = rename;
    let calls = 0;
    const deps = {
      rename: async (from: string, to: string) => {
        calls += 1;
        // 1st: out→old (real). 2nd: staging→out fails. 3rd: old→out (restore) fails.
        if (calls === 2 || calls === 3) throw errnoError("EIO");
        await real(from, to);
      },
    };
    let error: unknown;
    try {
      await publish(staging, join(root, "out"), deps);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("restoring the previous output failed");
    // the previous output survived the whole mess — it is at the named old
    // tree, byte-identical; the output path itself is simply absent.
    const oldNames = (await readdir(root)).filter((n) => n.startsWith(".crust-out-old-"));
    expect(oldNames.length).toBe(1);
    const t = await tree(join(root, oldNames[0]));
    expect(t["old.html"].toString("utf8")).toBe("old");
    // publish() posix-normalizes its own paths (toPosix + posix.resolve)
    // before naming the kept tree — the message carries the posix form
    expect((error as Error).message).toContain(JSON.stringify(posixOf(join(root, oldNames[0]))));
    await expect(stat(join(root, "out"))).rejects.toThrow();
    await rm(staging, { recursive: true, force: true });
    await rm(join(root, oldNames[0]), { recursive: true, force: true });
  });

  test("EPERM everywhere: full copy fallback replaces the output", async () => {
    const root = await tmp("crust-site-pub-copy-");
    const staging = join(root, ".crust-staging-1-dd");
    await seed(staging, { "index.html": "new", "sub/deep.txt": "d" });
    await seed(join(root, "out"), { "old.html": "old" });
    const deps = {
      rename: async () => {
        throw errnoError("EPERM");
      },
    };
    await publish(staging, join(root, "out"), deps);
    const t = await tree(join(root, "out"));
    expect(Object.keys(t).sort()).toEqual(["index.html", "sub/deep.txt"]);
    expect(t["index.html"].toString("utf8")).toBe("new");
    await expect(stat(staging)).rejects.toThrow();
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("staging is a SIBLING of the output (same filesystem), never inside it", () => {
    const parent = posixOf(join(tmpdir(), "crust-site-staging-parent"));
    const out = posix.join(parent, "dist");
    const staging = stagingDirFor(out);
    // same parent as the output: same filesystem by construction, and
    // cleanupStale globs exactly this directory
    expect(posix.dirname(staging)).toBe(parent);
    expect(staging.startsWith(`${out}/`)).toBe(false);
    expect(staging).not.toBe(out);
    expect(posix.basename(staging)).toMatch(/^\.crust-staging-\d+-[0-9a-f]{12}$/);
    // pid + nonce: distinct per process and per attempt
    expect(stagingDirFor(out)).not.toBe(staging);
  });

  test("the sibling layout exists because a dir cannot be renamed INTO ITSELF (EINVAL)", async () => {
    const root = await tmp("crust-site-einval-");
    await mkdir(join(root, "out"), { recursive: true });
    let error: unknown;
    try {
      await rename(join(root, "out"), join(root, "out", "inner"));
    } catch (e) {
      error = e;
    }
    expect((error as NodeJS.ErrnoException).code).toBe("EINVAL");
  });
});

// ---------------------------------------------------------------------------
// concurrent builds (the lock)
// ---------------------------------------------------------------------------

describe("concurrent builds (the lock)", () => {
  test("two builds of the same output at once: exactly one wins, the other is build.busy", async () => {
    const root = await tmp("crust-site-conc-");
    const cfg = await makeSite(root);
    const results = await Promise.allSettled([
      build({ configFile: cfg }),
      build({ configFile: cfg }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const busy = results.filter(
      (r) =>
        r.status === "rejected" &&
        (r.reason as BuildError)?.diagnostics?.[0]?.code === "build.busy",
    ).length;
    expect(ok).toBe(1);
    expect(busy).toBe(1);
    // the winner's output is complete and undamaged
    const t = await tree(join(root, "dist"));
    expect(t["index.html"]).toBeDefined();
    expect(t["a/b.html"]).toBeDefined();
    expect(t["404.html"]).toBeDefined();
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("a live lock for the output (another holder) refuses the build with build.busy", async () => {
    const root = await tmp("crust-site-lock-live-");
    const cfg = await makeSite(root);
    await seed(join(root, "dist"), { "cur.html": "current\n" });
    const hash = buildLockHash(join(root, "dist"));
    await writeFile(join(root, `.crust-out-lock-${hash}-${process.pid}-aaaaaa`), "");
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0].code).toBe("build.busy");
    expect((error as BuildError).diagnostics[0].message).toContain(String(process.pid));
    // the output is untouched by the refused build
    expect(await readFile(join(root, "dist", "cur.html"), "utf8")).toBe("current\n");
    await rm(join(root, `.crust-out-lock-${hash}-${process.pid}-aaaaaa`), { force: true });
  });

  test("a dead holder's lock is reclaimed and the build proceeds", async () => {
    const root = await tmp("crust-site-lock-dead-");
    const cfg = await makeSite(root);
    const dead = await deadPid();
    await writeFile(
      join(root, `.crust-out-lock-${buildLockHash(join(root, "dist"))}-${dead}-aaaaaa`),
      "",
    );
    const result = await build({ configFile: cfg });
    expect(result.pages).toHaveLength(2);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("acquireBuildLock releases: the claim is free again after release", async () => {
    const root = await tmp("crust-site-lock-rel-");
    const cfg = await makeSite(root);
    const out = join(root, "dist");
    const release = await acquireBuildLock(out);
    // while held, a second same-process claim is refused
    let error: unknown;
    try {
      await acquireBuildLock(out);
    } catch (e) {
      error = e;
    }
    expect((error as BuildError).diagnostics[0].code).toBe("build.busy");
    await release();
    const release2 = await acquireBuildLock(out); // claimable again
    await release2();
    const result = await build({ configFile: cfg });
    expect(result.pages).toHaveLength(2);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });

  test("a child process building while the parent holds the lock fails with build.busy", async () => {
    const root = await tmp("crust-site-xproc-");
    const cfg = await makeSite(root);
    await seed(join(root, "dist"), { "cur.html": "current\n" });
    const hash = buildLockHash(join(root, "dist"));
    await writeFile(join(root, `.crust-out-lock-${hash}-${process.pid}-aaaaaa`), "");
    const script = join(root, "busy-child.ts");
    await writeFile(
      script,
      [
        `import { build } from ${JSON.stringify(SRC_BUILD)};`,
        "let error: unknown;",
        `try { await build({ configFile: ${JSON.stringify(cfg)} }); } catch (e) { error = e; }`,
        'if (!error) { console.log("UNEXPECTED-OK"); process.exit(3); }',
        "const d = (error as { diagnostics?: { code: string }[] }).diagnostics?.[0];",
        'console.log("CODE " + (d?.code ?? "none"));',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    const code = await child.exited;
    expect(code).toBe(1);
    expect(stdout).toContain("CODE build.busy");
    // the parent's output is untouched by the refused child
    expect(await readFile(join(root, "dist", "cur.html"), "utf8")).toBe("current\n");
    await rm(join(root, `.crust-out-lock-${hash}-${process.pid}-aaaaaa`), { force: true });
  });
});

// ---------------------------------------------------------------------------
// writePages containment + the 404 page shape
// ---------------------------------------------------------------------------

describe("writePages / notFoundPage", () => {
  test("a write path outside staging is output.escape; normal paths write", async () => {
    const root = await tmp("crust-site-write-");
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    await writePages(staging, [{ route: "/", file: "index.html", html: "<html></html>" }]);
    expect(await readFile(join(staging, "index.html"), "utf8")).toBe("<html></html>");

    let error: unknown;
    try {
      await writePages(staging, [{ route: "/x", file: "../evil.html", html: "x" }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    expect((error as BuildError).diagnostics[0]?.code).toBe("output.escape");
    await expect(stat(join(root, "evil.html"))).rejects.toThrow();
  });

  test("the synthetic 404 page has the locked-decision shape", () => {
    const page = notFoundPage(SITE, "base");
    expect(page.route).toBe("/404");
    expect(page.title).toBe("Not found");
    expect(page.sourcePath).toBe("<generated>");
    expect(page.canonicalUrl).toBe(`${SITE}/404`);
    expect(page.draft).toBe(false);
    expect(page.layout).toBe("base");
  });
});

// ---------------------------------------------------------------------------
// output collisions: public files vs generated files (e2e)
// ---------------------------------------------------------------------------

describe("output collisions — generated vs generated (e2e)", () => {
  for (const route of ["/index", "/INDEX", "/404"]) {
    test(`${route} cannot overwrite another generated page; previous output untouched`, async () => {
      const root = await tmp("crust-site-generated-collide-");
      const cfg = await makeSite(root);
      await build({ configFile: cfg });
      const before = treeHash(await tree(join(root, "dist")));
      await writeFile(
        join(root, "content", "conflict.md"),
        `---\ntitle: Conflict\ndescription: Conflict\nroute: ${route}\n---\n\n# Conflict\n`,
      );
      let error: unknown;
      try {
        await build({ configFile: cfg });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BuildError);
      const collisions = (error as BuildError).diagnostics.filter(
        (d) => d.code === "output.collision",
      );
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.sourcePath).toBe(route === "/404" ? "404.html" : "index.html");
      expect(collisions[0]?.message).toContain("content/conflict.md");
      expect(collisions[0]?.message).toContain(
        route === "/404" ? "the generated 404 page" : "content/index.md",
      );
      expect(treeHash(await tree(join(root, "dist")))).toBe(before);
      expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
    });
  }

  test("similar routes with distinct output files still build", async () => {
    const root = await tmp("crust-site-generated-distinct-");
    const cfg = await makeSite(root);
    await writeFile(
      join(root, "content", "other.md"),
      "---\ntitle: Other\ndescription: Other\nroute: /index-other\n---\n\n# Other\n",
    );
    const result = await build({ configFile: cfg });
    expect(result.pages.some((p) => p.file === "index-other.html")).toBe(true);
    expect((await tree(join(root, "dist")))["index.html"]?.toString()).toContain(
      "<title>Home</title>",
    );
  });
});

describe("output collisions — public vs generated (e2e)", () => {
  test("a public file colliding with a generated file is an output.collision error, never a silent overwrite", async () => {
    const root = await tmp("crust-site-collide-");
    const cfg = await makeSite(root);
    await build({ configFile: cfg });
    const before = treeHash(await tree(join(root, "dist")));
    // plant public files that would clobber generated files. The public copy
    // lands in staging FIRST, then the collision check runs, and the build
    // THROWS before any page file is written — so neither the public file
    // nor the page can silently win; the build fails naming every offender.
    await writeFile(join(root, "public", "index.html"), "clobber root\n"); // route "/"
    await mkdir(join(root, "public", "a"), { recursive: true });
    await writeFile(join(root, "public", "a", "b.html"), "clobber a/b\n"); // route "/a/b"
    await writeFile(join(root, "public", "404.html"), "clobber 404\n"); // the generated 404
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const diagnostics = (error as BuildError).diagnostics;
    const collisions = diagnostics.filter((d) => d.code === "output.collision");
    expect(collisions.length).toBe(3);
    expect(collisions.map((d) => d.sourcePath).sort()).toEqual([
      "404.html",
      "a/b.html",
      "index.html",
    ]);
    // the previous output is untouched (by hash) and no litter remains
    expect(treeHash(await tree(join(root, "dist")))).toBe(before);
    expect((await readdir(root)).filter((n) => n.startsWith(".crust-"))).toEqual([]);
  });
});
