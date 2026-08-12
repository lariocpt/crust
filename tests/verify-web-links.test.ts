import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, "-c", `verify-web-links ${args.join(" ")}`], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-vwl-test-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

let server: Server;
let base: string;

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "content-type": "application/xml" },
  });
}
function html(inner: string): Response {
  return new Response(`<!doctype html><html>${inner}</html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/sitemap-good.xml") {
        return xml(
          `<urlset><url><loc>${base}/good-page</loc></url><url><loc>${base}/about</loc></url></urlset>`,
        );
      }
      if (p === "/sitemap-broken.xml") {
        return xml(
          `<urlset><url><loc>${base}/good-page</loc></url><url><loc>${base}/does-not-exist</loc></url></urlset>`,
        );
      }
      if (p === "/sitemap-anchor.xml") {
        return xml(
          `<urlset><url><loc>${base}/anchor-bad</loc></url><url><loc>${base}/about</loc></url></urlset>`,
        );
      }
      if (p === "/sitemap-redirect.xml") {
        return xml(
          `<urlset><url><loc>${base}/redirect-old</loc></url><url><loc>${base}/about</loc></url></urlset>`,
        );
      }
      if (p === "/sitemap-og-broken.xml") {
        return xml(`<urlset><url><loc>${base}/og-broken</loc></url></urlset>`);
      }
      if (p === "/sitemap-meta.xml") {
        return xml(`<urlset><url><loc>${base}/about</loc></url></urlset>`);
      }
      if (p === "/sitemap-index.xml") {
        return xml(
          `<sitemapindex><sitemap><loc>${base}/sitemap-good.xml</loc></sitemap></sitemapindex>`,
        );
      }

      if (p === "/robots.txt") {
        return new Response(`User-agent: *\nSitemap: ${base}/sitemap-good.xml\n`, {
          headers: { "content-type": "text/plain" },
        });
      }

      if (p === "/good-page") {
        return html(`<head><title>Good</title></head><body><a href="/about">About</a></body>`);
      }
      if (p === "/about") {
        return html(
          `<head>
            <title>About Us</title>
            <meta property="og:title" content="About Us">
            <meta property="og:image" content="${base}/og.png">
            <meta name="description" content="The about page">
          </head>
          <body><h2 id="team">Team</h2><p>About content.</p></body>`,
        );
      }
      if (p === "/anchor-bad") {
        return html(`<body><a href="/about#nope">missing</a><a href="/about#team">ok</a></body>`);
      }
      if (p === "/redirect-old") {
        return new Response(null, { status: 301, headers: { location: `${base}/about` } });
      }
      if (p === "/og-broken") {
        return html(
          `<head><meta property="og:image" content="${base}/missing-image.png"></head><body>x</body>`,
        );
      }
      if (p === "/og.png") {
        return new Response("PNGFAKE", { headers: { "content-type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe("verify-web-links CLI", () => {
  test("--help exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("verify-web-links");
  });

  test("missing args exit 2", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--site-map-url or --base-url is required");
  });

  test("mutually exclusive site-map + base url exits 2", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--base-url", base]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("unknown arg exits 2", async () => {
    const r = await runCli(["--banana"]);
    expect(r.code).toBe(2);
  });

  test("all pages healthy → exit 0", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0 failure(s)");
  });

  test("broken link → exit 1", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-broken.xml`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("broken-link");
    expect(r.stdout).toContain("/does-not-exist");
  });

  test("missing anchor → exit 1; --no-anchors → exit 0", async () => {
    const r1 = await runCli(["--site-map-url", `${base}/sitemap-anchor.xml`]);
    expect(r1.code).toBe(1);
    expect(r1.stdout).toContain("missing-anchor");
    expect(r1.stdout).toContain("#nope");

    const r2 = await runCli(["--site-map-url", `${base}/sitemap-anchor.xml`, "--no-anchors"]);
    expect(r2.code).toBe(0);
  });

  test("redirect chain → exit 1; --no-redirect-warnings → exit 0", async () => {
    const r1 = await runCli(["--site-map-url", `${base}/sitemap-redirect.xml`]);
    expect(r1.code).toBe(1);
    expect(r1.stdout).toContain("redirect-chain");

    const r2 = await runCli([
      "--site-map-url",
      `${base}/sitemap-redirect.xml`,
      "--no-redirect-warnings",
    ]);
    expect(r2.code).toBe(0);
  });

  test("--base-url discovers via robots.txt", async () => {
    const r = await runCli(["--base-url", base]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("page(s)");
  });

  test("sitemap-index recursion", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-index.xml`]);
    expect(r.code).toBe(0);
  });

  test("og-image broken → exit 1", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-og-broken.xml`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("og-image-broken");
  });

  test("meta fixture pass + mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-vwl-meta-"));
    try {
      const passFixture = join(dir, "about.pass.crust.ts");
      const failFixture = join(dir, "about.fail.crust.ts");
      await Bun.write(
        passFixture,
        `export default { url: "${base}/about", meta: { "og:title": "About Us", description: "The about page" } };\n`,
      );
      await Bun.write(
        failFixture,
        `export default { url: "${base}/about", meta: { "og:title": "Wrong Title" } };\n`,
      );

      const r1 = await runCli([
        "--site-map-url",
        `${base}/sitemap-meta.xml`,
        "--fixtures",
        passFixture,
      ]);
      expect(r1.code).toBe(0);

      const r2 = await runCli([
        "--site-map-url",
        `${base}/sitemap-meta.xml`,
        "--fixtures",
        failFixture,
      ]);
      expect(r2.code).toBe(1);
      expect(r2.stdout).toContain("meta-mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--exclude skips redirecting subtree; sitemap seeds excluded too", async () => {
    // /redirect-old 301s to /about — a failure without the flag (proven above),
    // clean with it. Also excluded as a link target: /anchor-bad links /about.
    const r1 = await runCli([
      "--site-map-url",
      `${base}/sitemap-redirect.xml`,
      "--exclude",
      "/redirect-old",
    ]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("0 failure(s)");

    const r2 = await runCli([
      "--site-map-url",
      `${base}/sitemap-broken.xml`,
      "--exclude",
      "/does-not-exist",
    ]);
    expect(r2.code).toBe(0);
  });

  test("--max-pages caps the crawl and reports what was dropped", async () => {
    // sitemap-good has 2 pages; page 1 links /about and /about links nothing
    // new, so capping at 1 must drop at least the second seed and say so.
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--max-pages", "1"]);
    expect(r.stdout).toContain("NOT checked");
    expect(r.stdout).toMatch(/1 page\(s\)/);

    const rJson = await runCli([
      "--site-map-url",
      `${base}/sitemap-good.xml`,
      "--max-pages",
      "1",
      "--json",
    ]);
    const parsed = JSON.parse(rJson.stdout);
    expect(parsed.totals.dropped).toBeGreaterThan(0);
  });

  test("--max-pages 0 means unlimited; negative exits 2", async () => {
    const r0 = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--max-pages", "0"]);
    expect(r0.code).toBe(0);
    expect(r0.stdout).not.toContain("NOT checked");

    const rNeg = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--max-pages", "-1"]);
    expect(rNeg.code).toBe(2);
  });

  test("--no-progress is accepted and output stays clean", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--no-progress"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("pending");
  });

  test("--exclude without a value exits 2", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--exclude"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--exclude requires a value");
  });

  test("--json emits machine-readable output", async () => {
    const r = await runCli(["--site-map-url", `${base}/sitemap-good.xml`, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.totals.failures).toBe(0);
    expect(parsed.totals.pages).toBeGreaterThan(0);
  });
});

describe("entity decoding in extracted URLs", () => {
  test("&#038; and &amp; decode to & — no phantom fragments or trailing &", async () => {
    const { extractFromHtml } = await import("../src/verifyWebLinks/extractors");
    const html = `<html><body>
      <a href="/shop?filter=60&#038;type=or">wp-style</a>
      <a href="/shop?a=1&amp;b=2">amp-style</a>
      <link rel="alternate" href="/wp-json/oembed?url=x&#038;format=xml" />
    </body></html>`;
    const res = new Response(html, { headers: { "content-type": "text/html" } });
    const { links } = await extractFromHtml(res);
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain("/shop?filter=60&type=or");
    expect(hrefs).toContain("/shop?a=1&b=2");
    expect(hrefs).toContain("/wp-json/oembed?url=x&format=xml");
    expect(hrefs.some((h) => h.includes("#038;"))).toBe(false);
    expect(hrefs.some((h) => h.endsWith("&"))).toBe(false);
  });
});
