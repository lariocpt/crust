import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSite, resolveConfigPaths } from "../src/config.ts";
import { BuildError } from "../src/diagnostics.ts";
import { renderToString } from "../src/html.ts";
import { parsePage } from "../src/pages.ts";
import type { Page, ResolvedSite } from "../src/types.ts";

async function fixture(files: Record<string, string> = {}, extraContent = {}) {
  const dir = await mkdtemp(join(tmpdir(), "crust-site-pages-"));
  await mkdir(join(dir, "content"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, "content", rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  const resolvedSite = resolveConfigPaths(
    defineSite({
      site: "https://x.dev",
      content: {
        directory: "content",
        include: ["**/*.md"],
        defaultLayout: "docs",
        ...extraContent,
      },
      layouts: { docs: () => "" },
      output: { directory: "dist" },
    }),
    dir,
  );
  const page = (rel: string, site: ResolvedSite = resolvedSite) =>
    parsePage({
      absolutePath: join(dir, "content", rel),
      relativePath: rel.replace(/\.md$/, ""),
      sourcePath: `content/${rel}`,
      resolvedSite: site,
    });
  return { dir, resolvedSite, page };
}

const codes = (page: Page) => page.diagnostics.map((d) => d.code);

describe("parsePage", () => {
  test("parses frontmatter, body and derived fields", async () => {
    const f = await fixture({
      "hello.md": `---
title: Hello
layout: docs
description: From frontmatter
---
# Hello

First paragraph.
`,
    });
    const page = await f.page("hello.md");
    expect(page.title).toBe("Hello");
    expect(page.description).toBe("From frontmatter");
    expect(page.layout).toBe("docs");
    expect(page.relativePath).toBe("hello");
    expect(page.sourcePath).toBe("content/hello.md");
    expect(page.draft).toBe(false);
    expect(page.data).toEqual({});
    expect(renderToString(page.body)).toContain("<p>First paragraph.</p>");
    expect(page.headings.map((h) => h.id)).toEqual(["hello"]);
    expect(page.diagnostics).toEqual([]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("frontmatter route is carried through verbatim", async () => {
    const f = await fixture({
      "x.md": "---\ntitle: Custom\nroute: /guides/intro\n---\nbody\n",
    });
    const page = await f.page("x.md");
    expect(page.route).toBe("/guides/intro");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a missing title is a fatal BuildError naming the file", async () => {
    const f = await fixture({ "hello.md": "---\nlayout: docs\n---\nbody\n" });
    let err: unknown;
    try {
      await f.page("hello.md");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BuildError);
    const diags = (err as BuildError).diagnostics;
    expect(diags.map((d) => d.code)).toContain("frontmatter.missing-title");
    expect(diags[0].sourcePath).toBe("content/hello.md");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("an invalid frontmatter route is a fatal route error at the key line", async () => {
    const f = await fixture({ "hello.md": "---\ntitle: X\nroute: not a route\n---\nbody\n" });
    let err: unknown;
    try {
      await f.page("hello.md");
    } catch (e) {
      err = e;
    }
    const diags = (err as BuildError).diagnostics;
    expect(diags.map((d) => d.code)).toContain("route.shape");
    expect(diags[0].line).toBe(3);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("description is derived from the first paragraph, syntax stripped", async () => {
    const f = await fixture({
      "d.md": `---
title: Derived
---
# Heading

See [the **docs**](https://example.com) and \`code\`.

- not this
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("See the docs and code.");
    const warning = page.diagnostics.find((d) => d.code === "frontmatter.derived-description");
    expect(warning?.severity).toBe("warning");
    expect(page.warnings.map((d) => d.code)).toContain("frontmatter.derived-description");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("derived description truncates at a word boundary within 160 chars", async () => {
    const body = `${Array(40).fill("lorem").join(" ")}.`;
    const f = await fixture({ "d.md": `---\ntitle: Long\n---\n${body}\n` });
    const page = await f.page("d.md");
    expect(page.description.length).toBeLessThanOrEqual(160);
    expect(page.description.endsWith("lorem")).toBe(true);
    expect(page.description).not.toContain("lorem.");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("parseData receives the data value and sourcePath, and its result is page.data", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndescription: d\ndata:\n  n: 1\n---\nbody\n" },
      {
        parseData: (value: unknown, ctx: { sourcePath: string }) => ({
          ...ctx,
          ...(value as Record<string, unknown>),
          parsed: true,
        }),
      },
    );
    const page = await f.page("d.md");
    expect(page.data).toEqual({ sourcePath: "content/d.md", n: 1, parsed: true });
    expect(codes(page)).toEqual([]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a throwing parseData becomes frontmatter.data-invalid at the data line", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndata:\n  n: 1\n---\nbody\n" },
      {
        parseData: () => {
          throw new Error("bad yaml");
        },
      },
    );
    const page = await f.page("d.md");
    const diag = page.diagnostics.find((d) => d.code === "frontmatter.data-invalid");
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toContain("bad yaml");
    expect(diag?.line).toBe(3); // the `data:` key line
    expect(page.data).toEqual({});
    await rm(f.dir, { recursive: true, force: true });
  });

  test("parseData returning a non-plain-object is data-invalid, not a silent pass", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndata:\n  n: 1\n---\nbody\n" },
      { parseData: () => "nope" },
    );
    const page = await f.page("d.md");
    const diag = page.diagnostics.find((d) => d.code === "frontmatter.data-invalid");
    expect(diag?.message).toContain("plain object");
    expect(page.data).toEqual({});
    await rm(f.dir, { recursive: true, force: true });
  });

  test("frontmatter data without parseData configured stays empty", async () => {
    const f = await fixture({ "d.md": "---\ntitle: D\ndata:\n  n: 1\n---\nbody\n" });
    const page = await f.page("d.md");
    expect(page.data).toEqual({});
    await rm(f.dir, { recursive: true, force: true });
  });

  test("draft pages are flagged and keep their route", async () => {
    const f = await fixture({ "w.md": "---\ntitle: Wip\ndraft: true\n---\nbody\n" });
    const page = await f.page("w.md");
    expect(page.draft).toBe(true);
    expect(page.route).toBeUndefined();
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a first paragraph INSIDE a blockquote is not the description source (block-level only)", async () => {
    const f = await fixture({
      "d.md": `---
title: Q
---
> A quoted first line.
> More quote.

A real first paragraph.
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("A real first paragraph.");
    expect(page.diagnostics.map((d) => d.code)).toEqual(["frontmatter.derived-description"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a first paragraph in a LOOSE list item is not the description source", async () => {
    // Loose items (blank line between them) emit VISIBLE <p> tags — the old
    // hidden-flag test would let the first item's paragraph through.
    const f = await fixture({
      "d.md": `---
title: L
---
- one

- two

A real first paragraph.
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("A real first paragraph.");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("a list nested in a blockquote is not the description source", async () => {
    const f = await fixture({
      "d.md": `---
title: N
---
> - item in a quoted list

A real first paragraph.
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("A real first paragraph.");
    await rm(f.dir, { recursive: true, force: true });
  });

  test("no description and no paragraph to derive from: empty description + frontmatter.missing-description (pinned)", async () => {
    // A title-only page is LEGAL. The description stays "" and the warning
    // must NOT claim a derivation happened (rule 1 — the code must be true).
    const f = await fixture({
      "d.md": `---
title: Bare
---
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("");
    const warnings = page.warnings;
    expect(warnings.map((d) => d.code)).toEqual(["frontmatter.missing-description"]);
    expect(warnings[0].severity).toBe("warning");
    expect(page.diagnostics.every((d) => d.severity === "warning")).toBe(true);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("first paragraph with no text (image, empty alt) also yields missing-description, not a fake derivation", async () => {
    // An empty-alt image has no text to derive from. (An alt-bearing image
    // is text: plainText recurses into the image's re-parsed label.)
    const f = await fixture({
      "d.md": `---
title: Pic
---
![](https://x.dev/i.png)
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("");
    expect(page.warnings.map((d) => d.code)).toEqual(["frontmatter.missing-description"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("an image-only first paragraph derives the description from its alt text", async () => {
    const f = await fixture({
      "d.md": `---
title: Pic
---
![the alt text](https://x.dev/i.png)
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("the alt text");
    expect(page.warnings.map((d) => d.code)).toEqual(["frontmatter.derived-description"]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("frontmatter description present + empty body: no warning at all", async () => {
    const f = await fixture({
      "d.md": `---
title: Bare
description: Given
---
`,
    });
    const page = await f.page("d.md");
    expect(page.description).toBe("Given");
    expect(page.diagnostics).toEqual([]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("async parseData that resolves is awaited; result becomes page.data (pinned: await, never reject-as-error)", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndescription: d\ndata:\n  n: 1\n---\nbody\n" },
      {
        parseData: async (value: unknown, ctx: { sourcePath: string }) => ({
          n: (value as { n: number }).n + 1,
          via: ctx.sourcePath,
        }),
      },
    );
    const page = await f.page("d.md");
    expect(page.data).toEqual({ n: 2, via: "content/d.md" });
    expect(codes(page)).toEqual([]);
    await rm(f.dir, { recursive: true, force: true });
  });

  test("async parseData that REJECTS → frontmatter.data-invalid with the rejection message, data {}", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndescription: d\ndata:\n  n: 1\n---\nbody\n" },
      {
        parseData: async () => {
          throw new Error("rejected boom");
        },
      },
    );
    const page = await f.page("d.md");
    const diag = page.diagnostics.find((d) => d.code === "frontmatter.data-invalid");
    expect(diag?.severity).toBe("error");
    expect(diag?.message).toContain("rejected boom");
    expect(page.data).toEqual({});
    await rm(f.dir, { recursive: true, force: true });
  });

  test("async parseData resolving to a non-plain-object → data-invalid, not a silent pass", async () => {
    const f = await fixture(
      { "d.md": "---\ntitle: D\ndescription: d\ndata:\n  n: 1\n---\nbody\n" },
      { parseData: async () => "nope" },
    );
    const page = await f.page("d.md");
    const diag = page.diagnostics.find((d) => d.code === "frontmatter.data-invalid");
    expect(diag?.message).toContain("plain object");
    expect(page.data).toEqual({});
    await rm(f.dir, { recursive: true, force: true });
  });

  test("CRLF file end-to-end: BOM-free, lines counted on the normalized text, body is LF-only", async () => {
    const f = await fixture({
      "crlf.md":
        "---\r\ntitle: Win\r\ndescription: d\r\nroute: /win\r\n---\r\n\r\npara [bad](javascript:alert(1))\r\n",
    });
    const page = await f.page("crlf.md");
    expect(page.title).toBe("Win");
    expect(page.route).toBe("/win");
    // file lines: 1 ---, 2 title, 3 description, 4 route, 5 ---, 6 blank,
    // 7 the paragraph → the bad link is on file line 7.
    expect(page.diagnostics.map((d) => [d.code, d.line])).toEqual([["link.invalid", 7]]);
    expect(renderToString(page.body)).not.toContain("\r");
    expect(renderToString(page.body)).toContain("<p>para <a>bad</a></p>");
    await rm(f.dir, { recursive: true, force: true });
  });
});
