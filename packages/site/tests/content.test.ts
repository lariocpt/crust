import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSite, resolveConfigPaths } from "../src/config.ts";
import { buildRouteTable, discoverContent, type PrecomputedRoute } from "../src/content.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import { trustedHtml } from "../src/html.ts";
import type { Page, ResolvedSite, SiteConfig } from "../src/types.ts";

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "crust-site-content-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  const config = resolveConfigPaths(
    defineSite({
      site: "https://x.dev",
      content: { directory: "content", include: ["**/*.md"], defaultLayout: "docs" },
      layouts: { docs: () => "", blog: () => "" },
      output: { directory: "dist" },
    }),
    dir,
  );
  return { dir, config };
}

function site(overrides: Partial<SiteConfig> = {}): ResolvedSite {
  return resolveConfigPaths(
    defineSite({
      site: "https://crust.dev",
      content: { directory: "content", defaultLayout: "docs" },
      layouts: { docs: () => "", blog: () => "" },
      output: { directory: "dist" },
      ...overrides,
    }),
    "/virtual",
  );
}

/** A minimal Page as parsePage would hand it to buildRouteTable. */
function pageWith(
  rel: string,
  fm: { route?: string; layout?: string; draft?: boolean } = {},
): Page {
  return {
    sourcePath: `content/${rel}`,
    relativePath: rel.replace(/\.md$/, ""),
    ...(fm.route !== undefined ? { route: fm.route } : {}),
    ...(fm.layout !== undefined ? { layout: fm.layout } : {}),
    title: "T",
    description: "d",
    headings: [],
    data: {},
    draft: fm.draft === true,
    body: trustedHtml("<p>b</p>"),
    links: [],
    warnings: [],
    diagnostics: [],
  };
}

const errors = (diagnostics: Diagnostic[]) => diagnostics.filter((d) => d.severity === "error");

describe("discoverContent", () => {
  test("finds markdown files, sorted, excluding dotfiles and non-md", async () => {
    const f = await fixture({
      "content/b.md": "b",
      "content/a.md": "a",
      "content/sub/c.md": "c",
      "content/notes.txt": "text",
      "content/.hidden.md": "hidden",
      "content/sub/.dot/x.md": "deep hidden",
    });
    expect(await discoverContent(f.config)).toEqual([
      { absolutePath: join(f.dir, "content/a.md"), relativePath: "a" },
      { absolutePath: join(f.dir, "content/b.md"), relativePath: "b" },
      { absolutePath: join(f.dir, "content/sub/c.md"), relativePath: "sub/c" },
    ]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("exclude wins over include", async () => {
    const f = await fixture({
      "content/keep.md": "k",
      "content/draft-old.md": "d",
      "content/sub/skip.md": "s",
    });
    const config: ResolvedSite = {
      ...f.config,
      content: { ...f.config.content, exclude: ["draft-*.md", "sub/**"] },
    };
    const found = await discoverContent(config);
    expect(found.map((d) => d.relativePath)).toEqual(["keep"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("symlinks are skipped", async () => {
    const f = await fixture({ "content/real.md": "r" });
    await symlink(join(f.dir, "content", "real.md"), join(f.dir, "content", "link.md"));
    const found = await discoverContent(f.config);
    expect(found.map((d) => d.relativePath)).toEqual(["real"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("filenames with spaces and unicode sort in code-unit order (locale-free, pinned)", async () => {
    const f = await fixture({
      "content/B file.md": "b",
      "content/a.md": "a",
      "content/b file.md": "b2",
      "content/Ä.md": "a-sharp",
      "content/ä.md": "a-ring",
    });
    // Code-unit compare: 'B'(0x42) < 'a'(0x61) < 'b'(0x62) < 'Ä'(0xC4) < 'ä'(0xE4).
    // A locale collation (ICU) would order these differently — this pins
    // compareStrings, the plan §4.6 byte-identical-rebuild guarantee.
    expect(await discoverContent(f.config)).toEqual([
      { absolutePath: join(f.dir, "content/B file.md"), relativePath: "B file" },
      { absolutePath: join(f.dir, "content/a.md"), relativePath: "a" },
      { absolutePath: join(f.dir, "content/b file.md"), relativePath: "b file" },
      { absolutePath: join(f.dir, "content/Ä.md"), relativePath: "Ä" },
      { absolutePath: join(f.dir, "content/ä.md"), relativePath: "ä" },
    ]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("an include pattern matching a DIRECTORY (not a file) matches nothing (pinned)", async () => {
    const f = await fixture({ "content/sub/a.md": "a", "content/keep.md": "k" });
    const config: ResolvedSite = {
      ...f.config,
      content: { ...f.config.content, include: ["sub"] },
    };
    // Glob patterns only match files (onlyFiles) — "sub" names a directory,
    // so it is not a content source. Directory-scoped includes must be file
    // patterns (sub/*.md, sub/**/*.md).
    expect(await discoverContent(config)).toEqual([]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a directory-scoped file pattern (sub/*.md) DOES discover", async () => {
    const f = await fixture({ "content/sub/a.md": "a", "content/keep.md": "k" });
    const config: ResolvedSite = {
      ...f.config,
      content: { ...f.config.content, include: ["sub/*.md"] },
    };
    expect((await discoverContent(config)).map((d) => d.relativePath)).toEqual(["sub/a"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("exclude with a directory prefix (docs/**) drops the whole subtree", async () => {
    const f = await fixture({
      "content/keep.md": "k",
      "content/docs/a.md": "a",
      "content/docs/nested/b.md": "b",
    });
    const config: ResolvedSite = {
      ...f.config,
      content: { ...f.config.content, exclude: ["docs/**"] },
    };
    expect((await discoverContent(config)).map((d) => d.relativePath)).toEqual(["keep"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("an empty content directory discovers zero files (not an error)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-site-content-empty-"));
    await mkdir(join(dir, "content"), { recursive: true });
    const config = resolveConfigPaths(
      defineSite({
        site: "https://x.dev",
        content: { directory: "content", include: ["**/*.md"], defaultLayout: "docs" },
        layouts: { docs: () => "" },
        output: { directory: "dist" },
      }),
      dir,
    );
    expect(await discoverContent(config)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("buildRouteTable", () => {
  test("builds routes, canonical URLs and a route index in route order", () => {
    const result = buildRouteTable(
      [pageWith("guide.md", { layout: "docs" }), pageWith("blog/post.md", { layout: "blog" })],
      site({
        content: {
          directory: "content",
          defaultLayout: "docs",
          route: ({ relativePath }) => `/${relativePath}`,
        },
      }),
    );
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.pages.map((p) => p.route)).toEqual(["/blog/post", "/guide"]);
    expect(result.routeIndex.get("/guide")?.canonicalUrl).toBe("https://crust.dev/guide");
    expect(result.routeIndex.get("/blog/post")?.sourcePath).toBe("content/blog/post.md");
    expect(result.routeIndex.get("/guide")?.layout).toBe("docs");
  });

  test("frontmatter route wins over the file path", () => {
    const result = buildRouteTable([pageWith("x.md", { route: "/custom" })], site());
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.routeIndex.has("/custom")).toBe(true);
    expect(result.routeIndex.has("/x")).toBe(false);
  });

  test("a whitespace route is fatal and names the page", () => {
    const result = buildRouteTable([pageWith("bad.md", { route: "   " })], site());
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toContain("route.shape");
    expect(errs[0].sourcePath).toBe("content/bad.md");
    expect(result.routeIndex.size).toBe(0);
  });

  test("no route and no content.route is a route.missing error", () => {
    const result = buildRouteTable([pageWith("a.md")], site());
    expect(errors(result.diagnostics).map((d) => d.code)).toEqual(["route.missing"]);
  });

  test("content.route is used when frontmatter has no route", () => {
    const result = buildRouteTable(
      [pageWith("blog/post.md")],
      site({
        content: {
          directory: "content",
          defaultLayout: "docs",
          route: ({ relativePath }) => `/${relativePath}`,
        },
      }),
    );
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.routeIndex.has("/blog/post")).toBe(true);
  });

  test("content.route throwing is a route.invalid error, not an exception", () => {
    const result = buildRouteTable(
      [pageWith("a.md")],
      site({
        content: {
          directory: "content",
          defaultLayout: "docs",
          route: () => {
            throw new Error("nope");
          },
        },
      }),
    );
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toEqual(["route.invalid"]);
    expect(errs[0].message).toContain("nope");
  });

  test("drafts are excluded from the route table but listed with their route", () => {
    const result = buildRouteTable(
      [pageWith("live.md", { route: "/live" }), pageWith("wip.md", { route: "/wip", draft: true })],
      site(),
    );
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.pages.map((p) => p.route)).toEqual(["/live"]);
    expect(result.drafts.map((p) => [p.relativePath, p.route])).toEqual([["wip", "/wip"]]);
    expect(result.routeIndex.has("/wip")).toBe(false);
  });

  test("route collisions between pages are fatal, naming both files", () => {
    const result = buildRouteTable(
      [pageWith("a.md", { route: "/dup" }), pageWith("b.md", { route: "/dup" })],
      site(),
    );
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toEqual(["route.duplicate"]);
    expect(errs[0].message).toContain("content/a.md");
    expect(errs[0].message).toContain("content/b.md");
  });

  test("a draft colliding with a production page is still fatal", () => {
    const result = buildRouteTable(
      [pageWith("a.md", { route: "/dup" }), pageWith("w.md", { route: "/dup", draft: true })],
      site(),
    );
    expect(errors(result.diagnostics).map((d) => d.code)).toContain("route.duplicate");
  });

  test("case-only route collisions are fatal", () => {
    const result = buildRouteTable(
      [pageWith("a.md", { route: "/Foo" }), pageWith("b.md", { route: "/foo" })],
      site(),
    );
    expect(errors(result.diagnostics).map((d) => d.code)).toContain("route.case-collision");
  });

  test("an unknown layout names the page and lists the configured layouts", () => {
    const result = buildRouteTable([pageWith("a.md", { route: "/a", layout: "nope" })], site());
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toEqual(["layout.unknown"]);
    expect(errs[0].message).toContain("nope");
    expect(errs[0].message).toContain("blog, docs");
    expect(errs[0].sourcePath).toBe("content/a.md");
  });

  test("the default layout applies when frontmatter omits it", () => {
    const result = buildRouteTable([pageWith("a.md", { route: "/a" })], site());
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.routeIndex.get("/a")?.layout).toBe("docs");
  });

  test("pages with error diagnostics are reported and never routed", () => {
    const page: Page = {
      ...pageWith("a.md"),
      diagnostics: [
        {
          severity: "error",
          code: "link.invalid",
          message: "blocked destination",
          sourcePath: "content/a.md",
          line: 3,
        },
      ],
    };
    const result = buildRouteTable([page], site());
    expect(errors(result.diagnostics).map((d) => d.code)).toEqual(["link.invalid"]);
    expect(result.routeIndex.size).toBe(0);
    expect(result.pages).toHaveLength(0);
  });

  test("page warnings survive into the table without blocking", () => {
    const warning: Diagnostic = {
      severity: "warning",
      code: "frontmatter.derived-description",
      message: "derived",
      sourcePath: "content/a.md",
    };
    const page: Page = {
      ...pageWith("a.md", { route: "/a" }),
      // parsePage puts warnings in BOTH fields — diagnostics is what the
      // route table consumes.
      warnings: [warning],
      diagnostics: [warning],
    };
    const result = buildRouteTable([page], site());
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toContain("frontmatter.derived-description");
    expect(result.routeIndex.size).toBe(1);
  });

  test("content.route returning a NUMBER → route.invalid naming the page, never routed, no crash", () => {
    const result = buildRouteTable(
      [pageWith("a.md")],
      site({
        content: {
          directory: "content",
          defaultLayout: "docs",
          route: () => 42 as unknown as string,
        },
      }),
    );
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toEqual(["route.invalid"]);
    expect(errs[0].message).toContain("number");
    expect(errs[0].sourcePath).toBe("content/a.md");
    expect(result.routeIndex.size).toBe(0);
  });

  test("content.route returning UNDEFINED → route.invalid, distinct from route.missing", () => {
    // A configured route() that returns undefined is a BROKEN generator
    // (route.invalid), not "no route configured" (route.missing).
    const result = buildRouteTable(
      [pageWith("a.md")],
      site({
        content: {
          directory: "content",
          defaultLayout: "docs",
          route: () => undefined as unknown as string,
        },
      }),
    );
    const errs = errors(result.diagnostics);
    expect(errs.map((d) => d.code)).toEqual(["route.invalid"]);
    expect(errs[0].message).toContain("undefined");
    expect(result.routeIndex.size).toBe(0);
  });

  test("a page with OTHER errors and a usable route is never routed; only its own errors surface", () => {
    const page: Page = {
      ...pageWith("a.md", { route: "/a" }),
      diagnostics: [
        {
          severity: "error",
          code: "link.invalid",
          message: "blocked destination",
          sourcePath: "content/a.md",
          line: 3,
        },
      ],
    };
    const result = buildRouteTable([page], site());
    // All of the page's diagnostics surface, the route is never attempted
    // (no spurious route.* or layout.* follow-ups), and the table stays
    // sound. The page was the only one, so production is empty and the
    // content.no-pages warning fires too — it sorts first (sourcePath "").
    expect(result.diagnostics.map((d) => d.code)).toEqual(["content.no-pages", "link.invalid"]);
    expect(result.routeIndex.size).toBe(0);
    expect(result.pages).toHaveLength(0);
  });

  test("precomputed route diagnostics replay even when the page already failed (one run reports every problem)", () => {
    // The build's pre-pass has ALREADY derived the route (and called
    // content.route) before parsePage can fail the page — dropping the
    // decision's diagnostics for an already-failing page would silently
    // swallow a real problem the pre-pass paid for.
    const page: Page = {
      ...pageWith("a.md"),
      diagnostics: [
        {
          severity: "error",
          code: "link.invalid",
          message: "blocked destination",
          sourcePath: "content/a.md",
          line: 3,
        },
      ],
    };
    const routeDiag: Diagnostic = {
      severity: "error",
      code: "route.invalid",
      message: "content.route threw for page content/a.md: boom",
      sourcePath: "content/a.md",
    };
    const pre = new Map<string, PrecomputedRoute>([
      ["content/a.md", { draft: false, diagnostics: [routeDiag] }],
    ]);
    const result = buildRouteTable([page], site(), pre);
    // line-less route.invalid sorts before the lined link.invalid
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "content.no-pages",
      "route.invalid",
      "link.invalid",
    ]);
    expect(result.routeIndex.size).toBe(0);
  });

  test("a failing page is excluded from collision detection (it can never go live)", () => {
    const failing: Page = {
      ...pageWith("a.md", { route: "/dup" }),
      diagnostics: [
        {
          severity: "error",
          code: "link.invalid",
          message: "blocked",
          sourcePath: "content/a.md",
          line: 2,
        },
      ],
    };
    const result = buildRouteTable([failing, pageWith("b.md", { route: "/dup" })], site());
    // Pinned: the failing page is dropped before the collision pass, so no
    // route.duplicate — the build already fails on the page's own error, and
    // a dead page cannot squat a route. The survivor is routed normally.
    expect(result.diagnostics.map((d) => d.code)).toEqual(["link.invalid"]);
    expect(result.routeIndex.get("/dup")?.sourcePath).toBe("content/b.md");
  });

  test("zero pages (empty content dir) is a content.no-pages WARNING, not an error and not silence", () => {
    const result = buildRouteTable([], site());
    expect(errors(result.diagnostics)).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "content.no-pages",
        severity: "warning",
        sourcePath: "",
        message: expect.any(String),
      },
    ]);
    expect(result.diagnostics[0].message).not.toContain("1 draft");
    expect(result.pages).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(result.routeIndex.size).toBe(0);
  });

  test("drafts-only site: production is empty → content.no-pages warning names the drafts (pinned)", () => {
    const result = buildRouteTable([pageWith("w.md", { route: "/w", draft: true })], site());
    expect(errors(result.diagnostics)).toEqual([]);
    const w = result.diagnostics.find((d) => d.code === "content.no-pages");
    expect(w?.severity).toBe("warning");
    expect(w?.message).toContain("1 draft");
    // The drafts still carry their resolved route + layout for dev/link checks.
    expect(result.drafts.map((p) => [p.route, p.layout])).toEqual([["/w", "docs"]]);
    expect(result.pages).toEqual([]);
    expect(result.routeIndex.size).toBe(0);
  });
});
