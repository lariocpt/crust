---
name: crust-site
description: Build a static site with @crust/site — a strict SSG with a fenced html template API, content-hashed assets, deterministic output, and a dev server. The crust binary only carries a `site` REDIRECT stub; the generator runs under plain Bun via `bunx @crust/site build|dev`. Use for docs/marketing sites, or when a build must fail loudly on broken links and bad metadata instead of shipping them.
---

# @crust/site — the crust site generator

Two things share the name, and mixing them up wastes time:

- **The crust binary's `site` builtin is a redirect stub, not a builder.** It
  checks the argument shape, prints where the real tool lives, and exits
  nonzero — never a silent 0, never `sh`'s 127. No compiled binary can carry
  the builder: a site's `site.config.ts` and layouts are imported from disk at
  run time, and a compiled Bun binary cannot resolve npm packages from files
  outside its own bundle.
- **The generator is the `@crust/site` npm package**, run under plain
  **Bun >= 1.4** (`bunx @crust/site …`). Windows is supported for this
  package; the prebuilt crust binaries stay linux/darwin-only.

Full reference: `packages/site/docs/USAGE.md` in the crust repo (shipped as
`node_modules/@crust/site/docs/USAGE.md`). This skill is the driver's seat;
that file is the contract.

## Workflow

```bash
bun add -d @crust/site
bunx @crust/site build                    # render ./site.config.ts → output.directory
bunx @crust/site build ./site.config.ts   # explicit config path
bunx @crust/site dev                      # dev server: drafts + banner, rebuilds on change
```

The crust stub answers every valid invocation with the redirect (exit 1);
only `--help` exits 0:

```bash
site                          # → the redirect, exit 1 (by design — nothing was built)
site build                    # same — the argument shape is checked first
site build ./site.config.ts   # same
site --help                   # usage, exit 0
```

`crust --check 'site build'` validates the stub's argument shape without
running it — unknown flags or subcommands are refused like every builtin.

## Exit codes

- `0` — success, or `--help`. `build` prints exactly one summary line on
  stdout (`crust-site: built N pages, M assets, T ms → <dir>`); diagnostics
  never touch stdout.
- `1` — runtime failure: a failed build prints **every** collected diagnostic
  on stderr (`severity[code]: message` + `--> path:line:col`) and the previous
  output stays untouched (publish is an atomic swap). Dev Ctrl-C exits 130.
- `2` — argument error (unknown subcommand, second positional, flag-shaped
  argument), with the usage.

## Config shape essentials

`site.config.ts` default-exports a `defineSite()` result. The minimum:

```ts
import { defineSite, html } from "@crust/site";
import type { LayoutContext } from "@crust/site";

export default defineSite({
  site: "https://example.dev", // absolute http(s), path prefix ok, NO trailing slash
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
  output: { directory: "dist" }, // trailingSlash: "never" is the only accepted value
});
```

Hard rules that bite first:

- **Unknown config keys are errors** at any level — there is no lenient mode.
- Every content page needs a `---` frontmatter block with a **required
  `title`**; unknown frontmatter keys and duplicate keys are errors.
- The layout must hand-write `<meta charset>` and call `ctx.head()` exactly
  once (it emits title/description/canonical/og tags); `ctx.stylesheet(name)`
  / `ctx.script(name)` take **manifest keys** from `assets`, never paths.
- Inline `<script>`/`<style>` bodies are banned; all JS/CSS ships through the
  asset pipeline.

## Common diagnostics and fixes

| Code | Meaning | Fix |
|---|---|---|
| `route.duplicate` | Two files produce the same route; the message names **both** sources. | Rename one file, or disambiguate in `content.route` / a frontmatter `route:`. (Related: `route.case-collision` — routes differing only by case, fatal on case-insensitive filesystems.) |
| `link.broken` | An internal link's destination is not a page of the site. **Error in `build`, warning in `dev`.** | Relative `.md` links resolve against the page's **route**, not its source path — fix the path or add the page. A link to the generated `/404` counts as broken. |
| `frontmatter.missing-title` | A page's frontmatter has no `title`. | Add `title: "…"` to the `---` block. (`description` is optional — absent it is derived from the first paragraph with a `frontmatter.derived-description` warning carrying the derived value.) |
| `asset.unknown-entrypoint` | `ctx.script()`/`ctx.stylesheet()` named a manifest key that was never declared. | Declare the name under `assets.scripts`/`assets.styles` or fix the call — names are map keys, not paths. |
| `build.busy` | Another live build holds the lock for this output directory (e.g. a concurrent `build` while `dev` is running on the same tree). | Let the other build finish; never point two builds at one `output.directory`. |

A failed build rejects with **all** diagnostics at once — fix them in one
pass, don't rerun per error. The full code vocabulary (codes are never
repurposed) is the table in the reference's *Diagnostics* section.

## Verifying a built site with crust

Set `dev: { port: 6100 }` in the config (dev's port is ephemeral when unset),
then crawl the served site with crust's own link checker:

```crust
procs({ site: "bunx @crust/site dev" })
wait :6100 --timeout 30s
verify-web-links --base-url http://localhost:6100
```

The build already validates internal links and fragments against the emitted
HTML; `verify-web-links` adds live status checks and meta/OG diffs on top.
