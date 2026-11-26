import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "../src/index.ts";

const PKG = path.resolve(import.meta.dir, "..");
const FIXTURE = path.join(PKG, "tests", "fixtures", "docs-example");

test("documentation gate: every ```ts fence typechecks and every diagnostic code is documented", async () => {
  const proc = Bun.spawn(["bun", "scripts/lint-docs.mjs"], {
    cwd: PKG,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`lint-docs.mjs exited ${code}\n${out}${err}`);
  }
}, 60_000);

// The quickstart fence in docs/USAGE.md is this fixture. If the documented
// example cannot build, the gate above still passes (it only typechecks), so
// the contract needs a real build behind it.
test("the documented quickstart project builds exactly as documented", async () => {
  const dist = path.join(FIXTURE, "dist");
  try {
    const result = await build({
      configFile: path.join(FIXTURE, "site.config.ts"),
    });
    expect(result.warnings).toEqual([]);
    expect(result.pages.map((p) => p.route).sort()).toEqual(["/", "/guide/getting-started"]);
    expect(Object.keys(result.assets)).toEqual(["main", "site"]);
    // Exact names are asserted: the entrypoints here are single-file, and a
    // single-file bundle's cwd-relative banner is stripped before hashing,
    // so the hash is a function of the content alone — stable across
    // machines AND working directories. (A multi-file bundle would keep its
    // cwd-relative per-file banners and its names would not be pinnable.)
    expect(result.assets.main).toBe("assets/main-8f1a92802d4c9533.js");
    expect(result.assets.site).toBe("assets/site-4302d8f61557770f.css");

    const index = await Bun.file(path.join(dist, "index.html")).text();
    expect(index).toContain('<meta charset="utf-8" />');
    expect(index).toContain("<title>Home</title>");
    expect(index).toContain('href="/guide/getting-started"');
    expect(index).toContain(`href="https://example.dev/${result.assets.site}"`);
    expect(index).toContain(`<script defer src="https://example.dev/${result.assets.main}">`);

    expect(existsSync(path.join(dist, "404.html"))).toBe(true);
    expect(existsSync(path.join(dist, "guide", "getting-started.html"))).toBe(true);
    expect(existsSync(path.join(dist, "drafts/wip.html"))).toBe(false);

    expect(await Bun.file(path.join(dist, "sitemap.xml")).text()).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.dev/</loc></url>
<url><loc>https://example.dev/guide/getting-started</loc></url>
</urlset>
`,
    );
    expect(await Bun.file(path.join(dist, "robots.txt")).text()).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://example.dev/sitemap.xml\n",
    );

    const css = await Bun.file(path.join(dist, result.assets.site)).text();
    expect(css).toContain("max-width: 46rem");
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});
