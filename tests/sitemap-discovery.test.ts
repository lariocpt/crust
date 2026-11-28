import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSeeds } from "../src/verifyWebLinks/sitemap";

const servers: ReturnType<typeof Bun.serve>[] = [];
const opts = { timeoutMs: 1000, userAgent: "crust-sitemap-test" };

function xml(kind: "urlset" | "sitemapindex", locs: string[]): Response {
  const tag = kind === "urlset" ? "url" : "sitemap";
  return new Response(
    `<${kind}>${locs.map((loc) => `<${tag}><loc>${loc}</loc></${tag}>`).join("")}</${kind}>`,
    { headers: { "content-type": "application/xml" } },
  );
}

function serve(handler: (path: string, origin: string) => Response): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      return handler(url.pathname, url.origin);
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

describe("sitemap discovery must not claim incomplete work is complete", () => {
  test.each([404, 500])("a healthy index child cannot hide an HTTP %s sibling", async (status) => {
    const base = serve((path, origin) => {
      if (path === "/index.xml") {
        return xml("sitemapindex", [`${origin}/good.xml`, `${origin}/bad.xml`]);
      }
      if (path === "/good.xml") return xml("urlset", [`${origin}/ok`]);
      return new Response("broken", { status });
    });
    await expect(discoverSeeds({ ...opts, sitemapUrl: `${base}/index.xml` })).rejects.toThrow(
      `${base}/bad.xml`,
    );
  });

  test("all robots-declared sitemaps must load, even when another is healthy", async () => {
    const base = serve((path, origin) => {
      if (path === "/robots.txt") {
        return new Response(`Sitemap: ${origin}/good.xml\nSitemap: ${origin}/bad.xml\n`);
      }
      if (path === "/good.xml" || path === "/sitemap.xml") {
        return xml("urlset", [`${origin}/ok`]);
      }
      return new Response("missing", { status: 404 });
    });
    await expect(discoverSeeds({ ...opts, baseUrl: base })).rejects.toThrow(`${base}/bad.xml`);
  });

  test("fallback cannot hide a broken child with a healthy second convention", async () => {
    const base = serve((path, origin) => {
      if (path === "/sitemap.xml") {
        return xml("sitemapindex", [`${origin}/good.xml`, `${origin}/bad.xml`]);
      }
      if (path === "/good.xml" || path === "/sitemap-index.xml") {
        return xml("urlset", [`${origin}/ok`]);
      }
      return new Response("missing", { status: 404 });
    });
    await expect(discoverSeeds({ ...opts, baseUrl: base })).rejects.toThrow(`${base}/bad.xml`);
  });

  test("an existing but unreadable conventional root is not a probe miss", async () => {
    const base = serve((path, origin) => {
      if (path === "/sitemap.xml") return new Response("broken", { status: 500 });
      if (path === "/sitemap-index.xml") return xml("urlset", [`${origin}/ok`]);
      return new Response("missing", { status: 404 });
    });
    await expect(discoverSeeds({ ...opts, baseUrl: base })).rejects.toThrow("HTTP 500");
  });

  test.each([404, 410])("an absent conventional root (HTTP %s) can fall back", async (status) => {
    const base = serve((path, origin) => {
      if (path === "/sitemap-index.xml") return xml("urlset", [`${origin}/ok`]);
      return new Response("absent", { status });
    });
    const result = await discoverSeeds({ ...opts, baseUrl: base });
    expect(result.seeds).toEqual([`${base}/ok`]);
  });

  test.each(["self", "mutual"])(
    "%s-referencing indexes fail with a cycle diagnostic",
    async (mode) => {
      let requests = 0;
      const base = serve((path, origin) => {
        requests++;
        return xml("sitemapindex", [
          `${origin}/${mode === "self" || path === "/b.xml" ? "a.xml" : "b.xml"}`,
        ]);
      });
      await expect(discoverSeeds({ ...opts, sitemapUrl: `${base}/a.xml` })).rejects.toThrow(
        "sitemap cycle",
      );
      expect(requests).toBe(mode === "self" ? 1 : 2);
    },
  );

  test.each([31, 32])("index depth is bounded (leaf depth %s)", async (leaf) => {
    let requests = 0;
    const base = serve((path, origin) => {
      requests++;
      const depth = Number(path.slice(1, -4));
      return depth < leaf
        ? xml("sitemapindex", [`${origin}/${depth + 1}.xml`])
        : xml("urlset", [`${origin}/ok`]);
    });
    const pending = discoverSeeds({ ...opts, sitemapUrl: `${base}/0.xml` });
    if (leaf === 31) expect((await pending).seeds).toEqual([`${base}/ok`]);
    else await expect(pending).rejects.toThrow("sitemap depth limit (32)");
    expect(requests).toBe(32);
  });

  test("shared children are not cycles, and valid nested indexes still work", async () => {
    const base = serve((path, origin) => {
      if (path === "/index.xml") {
        return xml("sitemapindex", [`${origin}/a.xml`, `${origin}/b.xml`]);
      }
      if (path === "/a.xml" || path === "/b.xml") {
        return xml("sitemapindex", [`${origin}/leaf.xml`]);
      }
      return xml("urlset", [`${origin}/ok`]);
    });
    expect((await discoverSeeds({ ...opts, sitemapUrl: `${base}/index.xml` })).seeds).toEqual([
      `${base}/ok`,
      `${base}/ok`,
    ]);
  });

  test("an empty declared child is an error, not an omitted subtree", async () => {
    const base = serve((path, origin) =>
      path === "/index.xml"
        ? xml("sitemapindex", [`${origin}/good.xml`, `${origin}/empty.xml`])
        : xml("urlset", path === "/good.xml" ? [`${origin}/ok`] : []),
    );
    await expect(discoverSeeds({ ...opts, sitemapUrl: `${base}/index.xml` })).rejects.toThrow(
      `sitemap at ${base}/empty.xml contained no URLs`,
    );
  });

  test("local sitemap cycles are bounded too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-sitemap-cycle-"));
    try {
      const path = join(dir, "index.xml");
      await Bun.write(path, `<sitemapindex><sitemap><loc>${path}</loc></sitemap></sitemapindex>`);
      await expect(discoverSeeds({ ...opts, sitemapUrl: path })).rejects.toThrow("sitemap cycle");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
