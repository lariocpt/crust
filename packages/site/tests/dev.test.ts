// The dev server e2e (plan §4.3/§4.4, chunk 9): a REAL site served from a dev
// staging tree by startDev, exercised over real HTTP. Pins:
//
//   - the E1 route table (the single resolver, shared with sitemap/canonical/
//     link validation): `/` → index.html, `/a` → a.html, `/a/b` → a/b.html,
//     `/a/` → 404 (v1), `/a.html` → the SAME file `/a` serves (lenient form,
//     canonical stays extensionless), unmatched → the 404 page with HTTP 404;
//     a page whose route genuinely ends in `.html` wins at its own URL over
//     the lenient rule (literal route first — exact beats lenient);
//   - draft pages: served in dev, byte-pinned banner (DRAFT_BANNER_HTML),
//     never on non-draft pages; link.draft is a WARNING in dev mode (an
//     error in a production build — the production half is pinned in
//     build.test.ts);
//   - headers: HTML `no-store`, hashed `assets/<name>-<hash>.<ext>`
//     `public, max-age=31536000, immutable`, public-directory files `no-store`;
//     content types for html/js/css/xml/txt, unknown → octet-stream;
//   - live rebuild: a content edit is rebuilt (debounced) into a fresh
//     staging tree and the serve root is swapped on success; a FAILED
//     rebuild (broken frontmatter) keeps serving the last complete build —
//     never a half tree, never a crash, never a false "rebuilt" line;
//   - EADDRINUSE → `dev.port-in-use` diagnostic (no auto-increment), staging
//     deleted, the holder untouched;
//   - the dev staging family: a killed predecessor's tree is swept at
//     startup (dead pid), a live pid's tree and the PRODUCTION family are
//     never touched by the dev sweep.
//
// Honest-failure pattern: the banner bytes (toContain of the exported
// constant), the `no-store` pins, the failed-rebuild pin (the last complete
// build must keep serving byte-identical content after a failed rebuild) and
// the literal-route-beats-lenient pin all go RED when the behavior is broken
// (verified by mutation during development).
//
// Ports: every test uses an ephemeral port (startDev `port: 0`) except the
// EADDRINUSE case, which probes a free high random port with a retry (the
// test-only collision escape hatch — the dev server itself never
// auto-increments).

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { required } from "../../../tests/support/required";
import { build, DRAFT_BANNER_HTML, devBuild } from "../src/build.ts";
import { type DevServer, startDev } from "../src/dev.ts";
import { BuildError } from "../src/diagnostics.ts";
import { sweepDeadDevStaging } from "../src/emit.ts";

/** Absolute paths the generated site.config.ts imports from. */
const SRC_INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SITE = "https://example.dev";

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

/** Poll `fn` until truthy or the budget is spent (the ~5 s rebuild budget). */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs} ms): ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function seed(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface ConfigOptions {
  /** The xhtml variant routes `y` → /x and `x2` → /x.html (the literal-
   *  route-beats-lenient disambiguation); default is the plain map. */
  xhtml?: boolean;
}

function configSource(opts: ConfigOptions = {}): string {
  const routeLine = opts.xhtml
    ? [
        "    route: ({ relativePath }) =>",
        '      relativePath === "index" ? "/"',
        '        : relativePath === "y" ? "/x"',
        '        : relativePath === "x2" ? "/x.html"',
        '        : "/" + relativePath,',
      ].join("\n")
    : '    route: ({ relativePath }) => (relativePath === "index" ? "/" : "/" + relativePath),';
  // No `dev` key: the tests pass the port to startDev directly (ephemeral,
  // except the EADDRINUSE case), so the config stays the same in every test.
  return [
    `import { defineSite, html } from ${JSON.stringify(SRC_INDEX)};`,
    "export default defineSite({",
    `  site: ${JSON.stringify(SITE)},`,
    "  content: {",
    '    directory: "content",',
    '    defaultLayout: "base",',
    routeLine,
    "  },",
    "  layouts: {",
    "    base: (ctx) => html`<!doctype html>",
    // `$` built via interpolation so this file itself carries no `${` text
    // (biome's noTemplateCurlyInString would flag the literal).
    `<html lang="en"><head><meta charset="utf-8">${"$"}{ctx.head()}${"$"}{ctx.stylesheet("site")}${"$"}{ctx.script("app")}</head><body>${"$"}{ctx.content}</body></html>\`,`,
    "  },",
    '  assets: { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" }, publicDirectory: "public" },',
    '  output: { directory: "dist" },',
    "  sitemap: true,",
    "  robots: { indexable: true },",
    "});",
    "",
  ].join("\n");
}

/** Writes a complete site into root (no dev key); returns the config path. */
async function makeSite(root: string, opts: ConfigOptions = {}): Promise<string> {
  await mkdir(join(root, "content", "a"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "site.config.ts"), configSource(opts));
  await writeFile(
    join(root, "content", "index.md"),
    "---\ntitle: Home\ndescription: The home page\n---\n\n# Hello\n\nRebuild marker: V1.\n\n" +
      "[b](a/b.md) and [d](draft.md).\n",
  );
  await writeFile(
    join(root, "content", "a", "b.md"),
    "---\ntitle: B\ndescription: Page B\n---\n\n# B\n\nDeep page.\n",
  );
  if (opts.xhtml) {
    await writeFile(
      join(root, "content", "a.md"),
      "---\ntitle: A\ndescription: Page A\n---\n\n# A\n\nPage A body.\n",
    );
    await writeFile(
      join(root, "content", "y.md"),
      "---\ntitle: Y\ndescription: The /x page\n---\n\n# Y\n\nPAGE-X marker.\n",
    );
    await writeFile(
      join(root, "content", "x2.md"),
      "---\ntitle: X2\ndescription: The /x.html page\n---\n\n# X2\n\nPAGE-XHTML marker.\n",
    );
  }
  await writeFile(
    join(root, "content", "draft.md"),
    "---\ntitle: Draft\ndescription: Work in progress\ndraft: true\n---\n\n# Draft\n\nDraft body here.\n",
  );
  await writeFile(join(root, "src", "app.ts"), 'console.log("hi");\n');
  await writeFile(join(root, "src", "site.css"), "body { color: red; }\n");
  await writeFile(join(root, "public", "favicon.txt"), "icon\n");
  await writeFile(join(root, "public", "blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
  // content-type spot-table extras (the table promises these types)
  await writeFile(
    join(root, "public", "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
  );
  await writeFile(join(root, "public", "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  await writeFile(join(root, "public", "data.json"), '{"a":1}\n');
  return join(root, "site.config.ts");
}

interface Handle {
  readonly server: DevServer;
  readonly base: string;
  readonly root: string;
}

/** startDev on the tmpdir site with an ephemeral port; fetch base from the bound port. */
async function start(root: string, opts: ConfigOptions = {}): Promise<Handle> {
  await makeSite(root, opts);
  const server = await startDev({ configFile: join(root, "site.config.ts"), port: 0 });
  return { server, base: `http://localhost:${server.port}`, root };
}

/** The dev staging siblings left in a site root (there should be none after stop). */
async function devStagingSiblings(root: string): Promise<string[]> {
  return (await readdir(root)).filter((n) => n.startsWith(".crust-dev-staging-"));
}

/** Probe a free high random port, retrying on collision (test-only escape
 *  hatch — the dev server itself refuses to move ports). */
async function freePort(): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });
      probe.stop(true);
      return port;
    } catch {
      // someone else took it — try again
    }
  }
  throw new Error("could not find a free port after 10 tries");
}

// ---------------------------------------------------------------------------
// E1 route table
// ---------------------------------------------------------------------------

describe("dev — the E1 route table", () => {
  test("every row of the table, .html disambiguation, and the 404 rows", async () => {
    const h = await start(await tmp("crust-site-dev-e1-"), { xhtml: true });
    const get = (p: string): Promise<Response> => fetch(`${h.base}${p}`);

    // / → index.html
    let res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Home</title>");

    // /a → a.html
    res = await get("/a");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>A</title>");

    // /a/b → a/b.html
    res = await get("/a/b");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>B</title>");

    // /a/ → 404 (an empty segment is not a route; pinned in v1)
    res = await get("/a/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<title>Not found</title>");

    // /a.html → the SAME file /a serves (the lenient form); byte-identical,
    // and the canonical URL in the served head stays extensionless
    const aBody = await get("/a").then((r) => r.text());
    const aHtmlBody = await get("/a.html").then(async (r) => {
      expect(r.status).toBe(200);
      return r.text();
    });
    expect(aHtmlBody).toBe(aBody);
    expect(aHtmlBody).toContain(`<link rel="canonical" href="${SITE}/a">`);

    // /x → y's page (route /x → file x.html)
    res = await get("/x");
    expect(res.status).toBe(200);
    const xBody = await res.text();
    expect(xBody).toContain("PAGE-X marker");
    expect(xBody).not.toContain("PAGE-XHTML marker");

    // /x.html → the LITERAL route's file wins over the lenient form:
    // x2's page (route /x.html → file x.html.html) is served, NOT y's page
    // (whose file x.html is the lenient candidate behind it). This pin goes
    // red if the candidate order flips.
    res = await get("/x.html");
    expect(res.status).toBe(200);
    const xHtmlBody = await res.text();
    expect(xHtmlBody).toContain("PAGE-XHTML marker");
    expect(xHtmlBody).not.toContain("PAGE-X marker");
    expect(xHtmlBody).toContain(`<link rel="canonical" href="${SITE}/x.html">`);

    // the source file name is NOT a route: no page at /x2
    res = await get("/x2");
    expect(res.status).toBe(404);

    // unmatched → the 404 page with an HTTP 404 (never a 200 with a 404 body)
    res = await get("/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<title>Not found</title>");

    // traversal: the URL parser itself collapses dot-segments before the
    // resolver sees them (measured: /%2e%2e/secret → /secret) — the resolver
    // then answers a plain 404, which is what a client must never get
    // anything else for
    for (const p of ["/%2e%2e/secret", "/a/%2e%2e/../../etc/passwd"]) {
      res = await get(p);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("<title>Not found</title>");
    }

    await h.server.stop();
    expect(await devStagingSiblings(h.root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// draft pages
// ---------------------------------------------------------------------------

describe("dev — draft pages", () => {
  test("a draft is served in dev with the pinned banner bytes; non-draft pages never carry it", async () => {
    const h = await start(await tmp("crust-site-dev-draft-"));
    const draft = await fetch(`${h.base}/draft`);
    expect(draft.status).toBe(200);
    const body = await draft.text();
    // the banner is byte-pinned: the exact constant, verbatim, before the
    // body — AND pinned as literal bytes, so editing the constant itself
    // (the honest-failure mutation) cannot keep the test green by tracking
    // it (crust rule: a test that follows the implementation proves nothing).
    expect(body).toContain(DRAFT_BANNER_HTML);
    expect(body).toContain('<div data-crust-draft="true"');
    expect(body).toContain("<strong>DRAFT</strong>");
    expect(body).toContain("will not be published");
    expect(body.indexOf(DRAFT_BANNER_HTML)).toBeLessThan(body.indexOf("<h1"));
    // the page's own content follows the banner
    expect(body).toContain("Draft body here.");

    const home = await (await fetch(`${h.base}/`)).text();
    expect(home).not.toContain("data-crust-draft");
    await h.server.stop();
  });

  test("devBuild: a link to a draft is a WARNING in dev mode; the same link ERRORS a production build", async () => {
    const root = await tmp("crust-site-dev-linkdraft-");
    const cfg = await makeSite(root);
    const dev = await devBuild({ configFile: cfg });
    const draftWarnings = dev.result.warnings.filter((d) => d.code === "link.draft");
    expect(draftWarnings.length).toBe(1);
    expect(draftWarnings[0].severity).toBe("warning");
    expect(draftWarnings[0].sourcePath).toBe("content/index.md");
    expect(dev.result.draftPages.map((p) => p.route)).toEqual(["/draft"]);
    await rm(dev.staging, { recursive: true, force: true });

    // the SAME site in a production build: the link is an error (the
    // production half of the pair, pinned end-to-end in build.test.ts)
    let error: unknown;
    try {
      await build({ configFile: cfg });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BuildError);
    const prod = (error as BuildError).diagnostics.filter((d) => d.code === "link.draft");
    expect(prod.length).toBe(1);
    expect(prod[0].severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// the 404 page
// ---------------------------------------------------------------------------

describe("dev — the 404 page", () => {
  test("an unmatched URL answers the 404 page with HTTP 404 and no-store", async () => {
    const h = await start(await tmp("crust-site-dev-404-"));
    const res = await fetch(`${h.base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("<title>Not found</title>");
    expect(body).toContain("The page you are looking for does not exist.");
    await h.server.stop();
  });
});

// ---------------------------------------------------------------------------
// response headers + content types
// ---------------------------------------------------------------------------

describe("dev — response headers and content types", () => {
  test("HTML no-store; hashed assets immutable; public files no-store; types mapped, unknown octet-stream", async () => {
    const h = await start(await tmp("crust-site-dev-headers-"));
    const head = async (p: string): Promise<{ type: string | null; cache: string | null }> => {
      const res = await fetch(`${h.base}${p}`);
      expect(res.status).toBe(200);
      return { type: res.headers.get("content-type"), cache: res.headers.get("cache-control") };
    };
    const home = await (await fetch(`${h.base}/`)).text();
    const jsPath = required(home.match(/assets\/app-[0-9a-f]{16}\.js/))[0];
    const cssPath = required(home.match(/assets\/site-[0-9a-f]{16}\.css/))[0];

    // HTML: no-store, text/html
    expect(await head("/")).toEqual({
      type: "text/html; charset=utf-8",
      cache: "no-store",
    });
    // hashed assets: immutable (the hash IS the version)
    expect(await head(`/${jsPath}`)).toEqual({
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    });
    expect(await head(`/${cssPath}`)).toEqual({
      type: "text/css; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    });
    // public-directory files: no-store (a preview, not a cache)
    expect(await head("/favicon.txt")).toEqual({
      type: "text/plain; charset=utf-8",
      cache: "no-store",
    });
    // sitemap xml: no-store default, xml type
    expect(await head("/sitemap.xml")).toEqual({
      type: "application/xml; charset=utf-8",
      cache: "no-store",
    });
    // robots txt
    expect(await head("/robots.txt")).toEqual({
      type: "text/plain; charset=utf-8",
      cache: "no-store",
    });
    // an unknown public extension: octet-stream (a guess is a lie)
    expect(await head("/blob.bin")).toEqual({
      type: "application/octet-stream",
      cache: "no-store",
    });
    // the promised spot entries of the type table
    expect(await head("/logo.svg")).toEqual({
      type: "image/svg+xml",
      cache: "no-store",
    });
    expect(await head("/favicon.ico")).toEqual({
      type: "image/x-icon",
      cache: "no-store",
    });
    expect(await head("/data.json")).toEqual({
      type: "application/json; charset=utf-8",
      cache: "no-store",
    });

    await h.server.stop();
  });
});

// ---------------------------------------------------------------------------
// live rebuild: debounced, atomic swap, honest failure
// ---------------------------------------------------------------------------

describe("dev — live rebuild", () => {
  test("a content edit rebuilds in place; a failed rebuild keeps serving the last complete build; recovery rebuilds", async () => {
    const h = await start(await tmp("crust-site-dev-rebuild-"));
    const get = (): Promise<string> =>
      fetch(`${h.base}/`).then((r) => {
        expect(r.status).toBe(200);
        return r.text();
      });

    // V1 (the initial build) is served
    expect(await get()).toContain("Rebuild marker: V1.");

    // V2 (a valid edit) — debounced rebuild, serve-root swapped on success
    await writeFile(
      join(h.root, "content", "index.md"),
      "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello v2\n\nRebuild marker: V2.\n",
    );
    await waitFor(
      async () => (await get()).includes("Rebuild marker: V2."),
      5000,
      "the V2 rebuild",
    );
    // the swap is WHOLE: the old content is gone, not merged
    const afterV2 = await get();
    expect(afterV2).toContain("Rebuild marker: V2.");
    expect(afterV2).not.toContain("Rebuild marker: V1.");

    // a BROKEN edit (missing title): the rebuild FAILS. The last complete
    // build (V2) must keep serving, byte-identical — no half tree, no crash,
    // no false "rebuilt" state. Wait past the debounce for the failed
    // rebuild to have had its chance, then pin the stale-but-complete tree.
    await writeFile(
      join(h.root, "content", "index.md"),
      "---\ndescription: no title here\n---\n\n# Broken\n\nRebuild marker: V3.\n",
    );
    await new Promise((r) => setTimeout(r, 1500));
    const afterBroken = await get(); // 200: the server did not die
    expect(afterBroken).toBe(afterV2);

    // V4 (valid again): the loop recovers and swaps to the new tree
    await writeFile(
      join(h.root, "content", "index.md"),
      "---\ntitle: Home v4\ndescription: Restored\n---\n\n# Hello v4\n\nRebuild marker: V4.\n",
    );
    await waitFor(
      async () => (await get()).includes("Rebuild marker: V4."),
      5000,
      "the V4 rebuild",
    );
    expect(await get()).not.toContain("Rebuild marker: V3.");

    await h.server.stop();
    expect(await devStagingSiblings(h.root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// port binding
// ---------------------------------------------------------------------------

describe("dev — port binding", () => {
  test("EADDRINUSE → dev.port-in-use (no auto-increment), staging deleted, the holder untouched", async () => {
    const root = await tmp("crust-site-dev-portinuse-");
    const cfg = await makeSite(root);
    const port = await freePort();
    const holder = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("held") });
    try {
      let error: unknown;
      try {
        await startDev({ configFile: cfg, port });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BuildError);
      const diagnostics = (error as BuildError).diagnostics;
      expect(diagnostics).toEqual([
        {
          code: "dev.port-in-use",
          severity: "error",
          message: expect.stringContaining(String(port)),
        },
      ]);
      // no staging litter from the refused start
      expect(await devStagingSiblings(root)).toEqual([]);
      // the holder is untouched and still serves
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("held");
    } finally {
      holder.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// the dev staging family (custodian reaper)
// ---------------------------------------------------------------------------

describe("dev — dev staging sweep", () => {
  test("a dead pid's dev staging is swept at startup; a live pid's and the PRODUCTION family are untouched", async () => {
    const root = await tmp("crust-site-dev-sweep-");
    const out = join(root, "dist");
    const dead = await deadPid();
    // dead-pid DEV staging: swept by sweepDeadDevStaging
    await seed(join(root, `.crust-dev-staging-${dead}-abcdef012345`), { "junk.html": "dead dev" });
    // live-pid DEV staging (this process is a running dev server as far as
    // the liveness probe is concerned): kept
    await seed(join(root, `.crust-dev-staging-${process.pid}-123456abcdef`), {
      "wip.html": "live dev",
    });
    // dead-pid PRODUCTION staging: the dev sweep must NOT touch it —
    // restoring/reclaiming production orphans is the build's cleanupStale
    await seed(join(root, `.crust-staging-${dead}-abcdef012345`), { "junk.html": "prod staging" });

    await sweepDeadDevStaging(out);

    const names = await readdir(root);
    expect(names).not.toContain(`.crust-dev-staging-${dead}-abcdef012345`);
    expect(names).toContain(`.crust-dev-staging-${process.pid}-123456abcdef`);
    expect(names).toContain(`.crust-staging-${dead}-abcdef012345`);
  });

  test("startDev sweeps a killed predecessor's dev staging; stop() leaves no litter", async () => {
    const root = await tmp("crust-site-dev-startstop-");
    const dead = await deadPid();
    // a predecessor the user killed (SIGKILL): its staging survives the kill
    await seed(join(root, `.crust-dev-staging-${dead}-deadbeef1234`), { "leftover.html": "x" });

    const h = await start(root);
    // the sweep ran at startup: the dead tree is gone, our own tree exists
    const names = await readdir(root);
    expect(names).not.toContain(`.crust-dev-staging-${dead}-deadbeef1234`);
    expect(names.filter((n) => n.startsWith(".crust-dev-staging-"))).toHaveLength(1);

    // stop: server closed, staging deleted, the port really freed
    await h.server.stop();
    expect(await devStagingSiblings(root)).toEqual([]);
    await expect(fetch(`${h.base}/`)).rejects.toThrow();

    // a fresh startDev on the same site comes up again (the sweep was a
    // no-op this time, the config and content are intact)
    const again = await startDev({ configFile: join(root, "site.config.ts"), port: 0 });
    expect(await (await fetch(`http://localhost:${again.port}/`)).text()).toContain(
      "<title>Home</title>",
    );
    await again.stop();
    expect(await devStagingSiblings(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hostile and edge-case URLs (attack surface beyond the E1 table)
// ---------------------------------------------------------------------------

describe("dev — edge-case URLs", () => {
  test("double slashes, query strings, trailing spaces, and Windows-reserved names", async () => {
    const h = await start(await tmp("crust-site-dev-edge-"));
    const get = (p: string): Promise<Response> => fetch(`${h.base}${p}`);

    // double slashes: a LEADING `//` is collapsed to `/` by Bun.serve's own
    // HTTP parser before the handler runs (measured: req.url for `//a` is
    // `/a`) — the dev server cannot observe it, so the honest contract is
    // "same as the single-slash form". An INTERIOR double slash survives to
    // the resolver, where an empty segment is not a route → 404.
    for (const [p, marker] of [
      ["//a/b", "<title>B</title>"],
      ["//", "<title>Home</title>"],
    ] as const) {
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(marker);
    }
    for (const p of ["/a//b", "/a///"]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("<title>Not found</title>");
    }

    // query strings are ignored for routing: the page still serves
    let res = await get("/?x=1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Home</title>");
    res = await get("/a/b?utm=42#frag".split("#")[0]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>B</title>");

    // a trailing space is NOT the same path: `/a ` must not serve a.html
    // (the encoder percent-encodes the space; no such file exists → 404)
    res = await get("/a%20");
    expect(res.status).toBe(404);
    res = await get("/a.html%20");
    expect(res.status).toBe(404);

    // Windows-reserved names are ORDINARY file names off-Windows: they must
    // never crash the resolver into a 500 (routeToFile rejects them as
    // routes on every platform; the dev server must degrade to a plain 404
    // when no such file exists — and this test must stay writable on the
    // windows-latest CI leg, so no file named `con` is created here).
    for (const p of ["/con", "/nul", "/aux", "/com1", "/LPT9.html"]) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(await r.text()).toContain("<title>Not found</title>");
    }

    await h.server.stop();
  });
});

// ---------------------------------------------------------------------------
// the output directory is NEVER touched by dev (plan §4.4)
// ---------------------------------------------------------------------------

/** A content hash over a file map: the "output untouched" proof. */
async function treeHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const r = rel === "" ? name.name : `${rel}/${name.name}`;
      if (name.isDirectory()) await walk(join(d, name.name), r);
      else h.update(`${r}:${await readFile(join(d, name.name))}`);
    }
  };
  await walk(dir, "");
  return h.digest("hex");
}

describe("dev — the output directory is never written", () => {
  test("a full dev session (initial build + a rebuild) leaves dist/ byte-identical", async () => {
    const root = await tmp("crust-site-dev-readonly-");
    const cfg = await makeSite(root);
    // drop the fixture's link-to-draft (a production ERROR by design — the
    // dev half is pinned elsewhere) so the production build succeeds
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home\ndescription: The home page\n---\n\n# Hello\n\nRebuild marker: V1.\n",
    );
    const dist = join(root, "dist");
    await build({ configFile: cfg }); // a real production output exists first
    const before = await treeHash(dist);

    const server = await startDev({ configFile: cfg, port: 0 });
    const base = `http://localhost:${server.port}`;
    expect(await (await fetch(`${base}/`)).text()).toContain("Rebuild marker: V1.");
    // a content edit forces a full rebuild cycle (new staging, serve swap)
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello v2\n\nRebuild marker: V2.\n",
    );
    await waitFor(
      async () => (await (await fetch(`${base}/`)).text()).includes("Rebuild marker: V2."),
      5000,
      "the V2 rebuild",
    );
    await server.stop();

    // byte-identical: dev never wrote, renamed, or even created anything in
    // the output tree (no publish, no cleanupStale restore, no staging inside)
    expect(await treeHash(dist)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// rebuild hygiene: bounded staging, complete trees under load
// ---------------------------------------------------------------------------

describe("dev — rebuild hygiene", () => {
  test("N successful rebuilds leave exactly ONE staging tree (the serve root swaps, old trees die)", async () => {
    const h = await start(await tmp("crust-site-dev-accum-"));
    const get = (): Promise<string> => fetch(`${h.base}/`).then((r) => r.text());
    for (const v of ["V2", "V3", "V4"]) {
      await writeFile(
        join(h.root, "content", "index.md"),
        `---\ntitle: Home\ndescription: d\n---\n\n# Hello\n\nRebuild marker: ${v}.\n`,
      );
      await waitFor(
        async () => (await get()).includes(`Rebuild marker: ${v}.`),
        5000,
        `${v} rebuild`,
      );
      // after EVERY swap the previous tree is gone: never more than one
      expect(await devStagingSiblings(h.root)).toHaveLength(1);
    }
    await h.server.stop();
    expect(await devStagingSiblings(h.root)).toEqual([]);
  });

  test("during a slow (many-page) rebuild every response is a COMPLETE tree — old or new, never a mix", async () => {
    const root = await tmp("crust-site-dev-slow-");
    const cfg = await makeSite(root);
    // 200 extra pages make the rebuild long enough to sample mid-flight
    for (let i = 0; i < 200; i++) {
      await writeFile(
        join(root, "content", `p${String(i).padStart(3, "0")}.md`),
        `---\ntitle: P${i}\ndescription: filler page ${i}\n---\n\n# P${i}\n\n${"filler text ".repeat(40)}\n`,
      );
    }
    const server = await startDev({ configFile: cfg, port: 0 });
    const base = `http://localhost:${server.port}`;
    expect(await (await fetch(`${base}/`)).text()).toContain("Rebuild marker: V1.");

    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello v2\n\nRebuild marker: V2.\n",
    );
    // hammer the server through the whole debounce + rebuild window: every
    // answer must be a 200 carrying EXACTLY ONE marker — the swap is a
    // pointer move, so a half tree is never observable.
    const deadline = Date.now() + 4000;
    let sawV2 = false;
    while (Date.now() < deadline && !sawV2) {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      const hasV1 = body.includes("Rebuild marker: V1.");
      const hasV2 = body.includes("Rebuild marker: V2.");
      expect(hasV1 !== hasV2).toBe(true); // complete old OR complete new, never both/neither
      sawV2 = hasV2;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sawV2).toBe(true);
    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// a killed dev process: the dead-pid staging is reclaimed by the next start
// ---------------------------------------------------------------------------

describe("dev — a killed worker's staging is swept", () => {
  test("SIGKILL mid-rebuild leaves a dead-pid tree; the next startDev reaps it (a live pid's tree survives)", async () => {
    const root = await tmp("crust-site-dev-kill-");
    const cfg = await makeSite(root);
    const SRC_DEV = fileURLToPath(new URL("../src/dev.ts", import.meta.url));
    const worker = join(root, "worker.mjs");
    await writeFile(
      worker,
      [
        `import { startDev } from ${JSON.stringify(SRC_DEV)};`,
        `const s = await startDev({ configFile: ${JSON.stringify(cfg)}, port: 0 });`,
        "console.log(String(s.port));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", worker], { stdout: "pipe", stderr: "ignore" });
    // wait for the bound-port line (the initial build is complete, its
    // staging tree exists and is being served)
    const reader = child.stdout.getReader();
    const td = new TextDecoder();
    let line = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      line += td.decode(value, { stream: true });
      if (line.includes("\n")) break;
    }
    expect(Number(line.trim())).toBeGreaterThan(0);

    // trigger a rebuild and kill immediately: the process dies mid-cycle
    await writeFile(
      join(root, "content", "index.md"),
      "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello v2\n\nRebuild marker: V2.\n",
    );
    child.kill(9); // SIGKILL: no handler can clean up
    await child.exited;

    // the killed process could not delete its tree: exactly one dev staging
    // survives, owned by the now-dead worker pid
    const litter = await devStagingSiblings(root);
    expect(litter).toHaveLength(1);
    expect(litter[0]).toContain(`-${child.pid}-`);

    // the next startDev sweeps the dead-pid tree at startup and serves the
    // updated content (the sweep must not have eaten the content edit).
    // NOT `start(root)` — that would re-seed the content and erase V2.
    const server = await startDev({ configFile: cfg, port: 0 });
    const base = `http://localhost:${server.port}`;
    const names = await devStagingSiblings(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(`-${process.pid}-`);
    expect(await (await fetch(`${base}/`)).text()).toContain("Rebuild marker: V2.");
    await server.stop();
    expect(await devStagingSiblings(root)).toEqual([]);
  });
});
