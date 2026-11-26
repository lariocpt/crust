# @crust/site

The crust site generator: a static-site compiler with a **fenced template
API** (interpolated values are escaped and range-tracked; a post-render
fence fails the build when a value crosses a script/comment/attribute
boundary), strict content validation that never reports a false pass,
content-hashed assets, and a publish swap that never corrupts your last
good build.

It runs under **plain Bun (>= 1.4)** — `bunx @crust/site build` — and is
deliberately *not* part of the compiled `crust` binary (user-authored
configs and layouts are imported from disk at run time; the binary carries
only a `site` redirect stub). **Windows is supported for this package**
under `bun`/`bunx`; the crust binary stays linux/darwin-only.

Full reference: **[docs/USAGE.md](./docs/USAGE.md)**.

## Quickstart

```ts
// site.config.ts
import { defineSite, html } from "@crust/site";
import type { LayoutContext } from "@crust/site";

export default defineSite({
  site: "https://example.dev",
  content: {
    directory: "content",
    defaultLayout: "base",
    route: ({ relativePath }) => (relativePath === "index" ? "/" : `/${relativePath}`),
  },
  layouts: {
    base: (ctx: LayoutContext) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">${ctx.head()}${ctx.stylesheet("site")}</head>
<body>${ctx.content}</body></html>`,
  },
  assets: { styles: { site: "assets/site.css" } },
  output: { directory: "dist" },
});
```

Add a `content/index.md` whose first line is a `---` frontmatter block with
a `title`, then:

```sh
bun add -d @crust/site
bunx @crust/site build   # → dist/index.html, 404.html, sitemap.xml, assets/site-<hash>.css
bunx @crust/site dev     # dev server: drafts + banner, rebuilds on change
```

## What you get

```ts
const result = await build({ configFile: "./site.config.ts" });
// result.pages — every route with its source file and emitted file
// result.assets — manifest name → assets/<name>-<sha256-16>.<ext>
// result.warnings — every warning-severity diagnostic, sorted
```

- **No false passes.** Broken internal links, dead fragments, missing
  metadata, fence violations — every problem is a located diagnostic, and a
  failed build rejects with all of them while the previous output stays
  untouched.
- **Deterministic.** Byte-identical rebuilds: lexicographic ordering, no
  timestamps, LF-only output.
- **Strict by design.** Unknown config keys and unknown frontmatter keys
  are errors; routes are never silently normalized.

```ts
try {
  await build({ configFile: "./site.config.ts" });
} catch (e) {
  if (e instanceof BuildError) {
    for (const d of e.diagnostics) console.error(`${d.severity}[${d.code}] ${d.message}`);
  } else throw e;
}
```

## Docs

Markdown links rewritten from relative `.md` destinations preserve the site's
deployment prefix. `ctx.publicAsset(path)` takes a literal filesystem path and
percent-encodes its URL segments. Generated output collisions (including `/`
versus `/index`, or authored `/404`) fail the build rather than overwriting a
page; the previous published output is preserved.

- Reference (config, frontmatter, safety model, diagnostics table, dev
  server, Windows support): [docs/USAGE.md](./docs/USAGE.md)
- The crust test-stack tooling: <https://lariocpt.github.io/crust-website/>

## License

MIT — © Lario Borges
