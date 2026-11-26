# @crust/site — reference

`@crust/site` is the crust site generator: a static-site compiler with a
fenced template API, strict content validation, and a publish contract that
never corrupts your last good build. It ships as a **plain npm package run
under Bun** — it is *not* part of the compiled `crust` binary (a compiled Bun
binary cannot resolve bare npm specifiers from files outside its own bundle,
and a site's `site.config.ts` and layouts are imported from disk at run
time). The crust binary carries only a `site` redirect stub that points here.

Everything on the public surface follows one contract (`contractVersion: 1`):
additive fields and enum widening are minor changes; renames, removals, and
narrowing are major; **diagnostic codes are never repurposed**.

---

## Install and requirements

- **Bun >= 1.4.** The package is TypeScript source executed by Bun directly
  (`bunx @crust/site build`); there is no compiled artifact and no transpile
  step. The asset pipeline is measured against Bun 1.4.4.
- **Windows is supported for this package** under plain `bun`/`bunx`. The
  crust *binary* stays linux/darwin-only — see [Windows support](#windows-support).
- The site URL must be reachable as an absolute `http(s)` URL at build time
  (it is only concatenated into canonical/og tags — nothing is fetched).

```sh
bun add -d @crust/site     # or: bunx @crust/site build (no install)
```

Run it from the directory that holds `site.config.ts` (or pass the config
path explicitly):

```sh
bunx @crust/site build [configFile]   # render the site (default configFile: ./site.config.ts)
bunx @crust/site dev   [configFile]   # dev server, rebuilds on change
```

---

## Quickstart

A complete site is one config file, a content directory, and (optionally)
script/style entrypoints and a public directory. This example is the fixture
at `tests/fixtures/docs-example/` in this package — the docs gate
type-checks it and the test suite builds it end to end, so it is known to
work.

`site.config.ts`:

```ts
import type { LayoutContext } from "@crust/site";
import { defineSite, html } from "@crust/site";

export default defineSite({
  site: "https://example.dev",
  lang: "en",
  content: {
    directory: "content",
    defaultLayout: "base",
    route: ({ relativePath }) => (relativePath === "index" ? "/" : `/${relativePath}`),
  },
  layouts: {
    base: (ctx: LayoutContext) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="${ctx.publicAsset("favicon.svg")}" />
    ${ctx.head()} ${ctx.stylesheet("site")} ${ctx.script("main")}
  </head>
  <body>
    <main>${ctx.content}</main>
    <footer><a href="${ctx.url("/")}">Home</a></footer>
  </body>
</html>`,
  },
  assets: {
    styles: { site: "assets/site.css" },
    scripts: { main: "assets/main.ts" },
    publicDirectory: "public",
  },
  output: { directory: "dist" },
  robots: { indexable: true },
});
```

Content — every `.md` file needs a `---` frontmatter block with at least a
`title`:

```markdown
---
title: Home
description: The home page.
---

# Welcome

Start with the [getting-started guide](./guide/getting-started.md).
```

Relative `.md` links resolve against the page's **route** (not the source
path) and are rewritten to the destination route; a `.md` link to a page
that does not exist fails the build with `link.broken`.

Then build:

```sh
bunx @crust/site build
# crust-site: built 2 pages, 2 assets, 29 ms → /path/to/dist
```

The output tree:

```
dist/
├── index.html                  # route /
├── guide/getting-started.html  # route /guide/getting-started
├── 404.html                    # generated, see "The 404 page"
├── sitemap.xml
├── robots.txt
├── favicon.svg                 # copied verbatim from public/
└── assets/
    ├── main-8f1a92802d4c9533.js    # name + sha256-16 of the final bytes
    └── site-4302d8f61557770f.css
```

The hashes are stable across machines and working directories (single-file
entrypoints — see “Assets”); this tree is a real run, and the build test
asserts the exact names.

The draft page (`content/drafts/wip.md`, `draft: true`) is **not** in the
output — production builds never render drafts. The dev server does, with a
banner.

---

## Configuration reference

`defineSite(config)` validates the whole config at definition time and
throws a `BuildError` carrying **every** problem found (never just the
first). Unknown keys at any level are errors, not ignored extras — a typo'd
key that silently does nothing is a false pass. Relative paths resolve
against the **config file's directory**, never the process cwd.

```ts
// The smallest legal config: one layout, one content directory, one output.
const config = defineSite({
  site: "https://example.dev",
  content: { directory: "content", defaultLayout: "base" },
  layouts: { base: () => html`<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>` },
  output: { directory: "dist" },
});
```

### `site` — required

An absolute `http(s)` URL. It **may include a path prefix** (GitHub Pages
under `/docs`), and must **not** end in `/` — a trailing slash is an error,
not stripped. The value must already be in canonical form: anything the
WHATWG parser would silently normalize (padding, a dangling `?` or `#`, the
default port, an upper-case host, userinfo) is a `config.site` error,
because `canonicalUrl` is plain concatenation of this value.

`canonicalUrl = site + route` (the root route adds the single `/`):

```ts
canonicalUrl("https://example.dev/docs", "/guide"); // "https://example.dev/docs/guide"
canonicalUrl("https://example.dev", "/");           // "https://example.dev/"
```

### `content` — required

| Key | Type | Default | Notes |
|---|---|---|---|
| `directory` | path string | — (required) | Relative to the config file; absolute allowed. |
| `include` | `string[]` | `["**/*.md"]` | Globs run with `cwd = content.directory`. |
| `exclude` | `string[]` | `[]` | Exclude **wins** over include. |
| `defaultLayout` | string | — (required) | Must be a key of `layouts`. |
| `route` | `(arg: { relativePath: string }) => string` | none | Maps a source file to a route. |
| `parseData` | `(value: unknown, ctx: { sourcePath: string }) => unknown` | none | Data-layer hook; may be async. |

Discovery is deterministic: lexicographic (code-unit) order, dotfiles
excluded unless the include pattern itself starts with `.`, symlinks never
followed, only `.md` files kept. `relativePath` is posix, relative to
`content.directory`, extension stripped, case preserved.

`route()` **must return an already-normalized route** — there is no
auto-normalization. A bad return (or a throw) is an error naming the page;
without `route()` and without frontmatter `route`, a page gets
`route.missing`.

```ts
const content: SiteConfig["content"] = {
  directory: "docs",
  defaultLayout: "doc",
  exclude: ["private/**"],
  route: ({ relativePath }) => (relativePath === "index" ? "/" : `/docs/${relativePath}`),
};
```

`parseData` receives the page's raw frontmatter `data` (or `{}`) and its
`sourcePath`; a returned Promise is awaited. It **must resolve to a plain
object** — a throw, a rejection, or a non-object is `frontmatter.data-invalid`
located at the `data` key. Without `parseData`, `page.data` is always `{}`
even when the frontmatter carried `data` — raw data is never passed through
unvalidated.

```ts
const content: SiteConfig["content"] = {
  directory: "content",
  defaultLayout: "base",
  parseData: (data) => {
    if (typeof data === "object" && data !== null && "tags" in data) return data;
    return {};
  },
};
```

### `layouts` — required

A non-empty registry of layout functions (`name => (ctx) => Html`). A
non-function value, or an empty registry, is `config.layout-type`; a
`defaultLayout` (or frontmatter `layout`) naming a key that is not here is
the same code with the available keys listed.

### `assets` — optional

| Key | Notes |
|---|---|
| `scripts` | `name → entrypoint path`. |
| `styles` | `name → entrypoint path`. |
| `publicDirectory` | Copied to the output root, unhashed. |

Names must match `/^[A-Za-z0-9_-]+$/` (`config.asset-name`) and **scripts
and styles share ONE namespace** — the same name in both maps is
`config.asset-name-clash`, because there is one manifest and one output
directory.

### `output` — required

| Key | Default | Notes |
|---|---|---|
| `directory` | — (required) | Relative to the config file. |
| `trailingSlash` | `"never"` | v1 accepts only `"never"` (typed as an open union for future widening; any other value is a `config.type` error). |

The output directory must not overlap its own inputs
(`config.output-overlap`): it may not contain or be contained by
`content.directory` or `assets.publicDirectory`, it may not contain any
asset entrypoint, and it may not be the config directory itself. An output
*inside* the project directory (the common `dist/`) is explicitly allowed.

### `sitemap`, `robots`, `dev`, `lang` — optional

| Key | Default | Notes |
|---|---|---|
| `sitemap` | `true` | Emit `sitemap.xml`. |
| `robots` | none | `{ indexable: boolean }`; absent means **no `robots.txt` at all**. |
| `dev.hostname` | `"localhost"` | Dev server bind host. |
| `dev.port` | ephemeral | Integer 1..65535 (`config.port` otherwise). |
| `lang` | `"en"` | BCP 47. Stored on the resolved config; the layout hand-writes the `<html lang>` attribute — v1 injects it nowhere. |

### Paths and overlap, programmatically

`defineSite` stores raw paths; `resolveConfigPaths(site, configDir)` makes
them absolute against the config file's directory, and
`checkOutputOverlap(resolved)` enforces the overlap rules above. `build()`
runs both for you.

```ts
const config = defineSite({
  site: "https://example.dev",
  content: { directory: "content", defaultLayout: "base" },
  layouts: { base: () => html`` },
  output: { directory: "dist" },
});
const resolved = resolveConfigPaths(config, "/home/me/site");
checkOutputOverlap(resolved); // throws BuildError with config.output-overlap diagnostics
```

---

## Frontmatter

Every `.md` file starts with a `---` YAML block: the delimiter is `---` at
**column 0** (trailing space/tab allowed; `----` is not a delimiter),
closed by another column-0 `---`. A leading BOM is stripped and CRLF/CR are
normalized to LF before anything is counted. Parsing uses `yaml`
(eemeli) with a line counter, so **every error is located with line and
column in the full file's coordinates**.

Built-in keys — everything else is `frontmatter.unknown-key`:

| Key | Type | Notes |
|---|---|---|
| `title` | non-empty string | **Required.** Missing → `frontmatter.missing-title`. |
| `description` | non-empty string | Absent → derived from the first paragraph (see below). |
| `layout` | non-empty string | Must name a key of `layouts`. |
| `route` | normalized route | Validated at parse time; overrides `content.route`. |
| `draft` | boolean | Excluded from production builds. |
| `data` | plain YAML mapping | Reaches `page.data` only through `content.parseData`. |

Strictness — all of these are **errors**, collected into one `BuildError`:
a missing or unclosed block (`frontmatter.missing`), a block that parses but
is not a mapping (`frontmatter.not-mapping`), YAML syntax errors
(`frontmatter.parse-error`, all of them), duplicate keys
(`frontmatter.duplicate-key`, located), unknown keys, non-string keys, and
bad values (`frontmatter.bad-value`).

```ts
const parsed = parseFrontmatter("---\ntitle: Hello\n---\n\n# Hello\n", "content/hello.md");
parsed.frontmatter.title; // "Hello"
parsed.body;              // "\n# Hello\n"
parsed.bodyStartLine;     // 4 — the body's first line, in full-file coordinates
```

When `description` is absent it is derived from the first **top-level**
paragraph (whitespace collapsed, cut at 160 chars on a word boundary) and
the build reports `frontmatter.derived-description` as a **warning naming
the derived value**. If there is no text to derive from, the description
stays `""` with a `frontmatter.missing-description` warning — the build
never claims a derivation that did not happen.

---

## Templates: the `html` runtime

Layouts build documents with the `html` tagged template. A tagged template
cannot enforce rules by inspecting its literal (`html\`<scr${"i"}pt>\``
defeats any literal check), so the enforcement is a **value-range fence**:
every interpolated value's character range is recorded (recursively, through
arbitrary nesting), and a post-render pass over the assembled document
fails the build when a value range crosses a protected boundary.

### Escaping

One escape function, applied to every interpolated value: `& < > " '` →
entities, with `&` replaced first so emitted entities are never
double-escaped. A value can never contribute a raw structural character —
which also kills entity smuggling (`java&#10;script:`) and neutralizes
RCDATA elements like `<title>`/`<textarea>`.

```ts
const doc = html`<p>${'a < b & "c"'}</p>`; // <p>a &lt; b &amp; &quot;c&quot;</p>
```

### What may be interpolated (`HtmlValue`)

`string`, finite `number` (`0` renders `"0"`, never falsy-dropped),
`false`/`null`/`undefined` (render nothing), `Html`, and arrays of those
(flattened, joined with no separator). **Everything else throws a
`render.bad-value` diagnostic before any `toString`/`valueOf` runs**:
`true`, `NaN`, ±`Infinity`, Promises and other thenables (values are never
awaited), `Symbol`, `bigint`, functions, class instances, plain objects.
A value that is its own ancestor (a cycle) is rejected; a shared array used
twice is legal and renders live. Nesting is capped at depth 64.

```ts
// The TYPE system already excludes `true` (and objects, and thenables) from
// HtmlValue; the runtime check is what catches values that arrive untyped —
// from JS callers or `unknown` frontmatter data:
try {
  const value: unknown = true;
  finalizeDocument(html`<p>${value as unknown as HtmlValue}</p>`, { siteUrl: "https://example.dev" });
} catch (e) {
  // BuildError carrying the render.bad-value diagnostic
}
```

### What the fence enforces

These are build errors, checked against the final document and the tracked
ranges (all linear-time scans):

| Code | Rule |
|---|---|
| `fence.script-body` / `fence.style-body` | A tracked value inside a `<script>`/`<style>` body. Inline script and style are banned outright — all JS/CSS ships as hashed assets. |
| `fence.comment-value` | A tracked value inside a `<!-- … -->` comment. |
| `fence.dynamic-tag-name` / `fence.dynamic-attr-name` | An interpolated value in a tag-name or attribute-name position. |
| `fence.event-handler` | Any `on*` attribute, however it got there. |
| `fence.unquoted-attribute` | A present attribute value without quotes. |
| `fence.unterminated` | An opening attribute quote never closed. |
| `fence.url-attribute` | A URL-bearing attribute (`href src action formaction poster cite background data`) whose tracked value fails the URL policy — so forgetting `url()` is not a hole. |
| `fence.ping-attr` / `fence.srcdoc-attr` | `ping` and `srcdoc` are banned outright. |

Documented **convention only** (a build-time fence cannot enforce them):
SVG foreign-content semantics, deploy-time response headers, and
supply-chain trust of what you import.

### The `url()` policy

`url(value, opts)` (alias `validateUrl`) is the one policy for anything
landing in a URL position; `ctx.url(value)` is the same policy with `opts`
bound to the page. It returns the value unchanged when valid and throws a
located diagnostic when not. Allowed schemes: `http`, `https`, `mailto`,
`tel`, `sms`. Rejected before `new URL()` even runs — because a parser that
"fixes" input is a fence that misses attacks:

- control characters and spaces (`url.control-char`),
- `" ' \` \` and backslash (`url.bad-char`),
- `&#` and named entity references like `&Tab;` (`url.entity-escape`) —
  browsers decode them before the URL parser runs,
- protocol-relative `//host/…` (`url.protocol-relative`) — v1 rejects it
  outright rather than guessing the scheme,
- `http:`/`https:` without the `//` authority form, userinfo, an empty
  host, or any other scheme (`url.scheme`, `url.no-host`, `url.userinfo`).

Pure fragments (`#top`) are valid; relative refs must resolve on the site's
origin. Absolute cross-origin `http(s)` URLs are accepted — external links
are legitimate.

```ts
const opts = { siteUrl: "https://example.dev", pageRoute: "/guide" };
url("https://example.dev/docs/intro", opts); // returned unchanged
url("mailto:hello@example.dev", opts);
try {
  url("java\tscript:alert(1)", opts); // url.control-char
} catch (diagnostic) {
  // a Diagnostic object: { code, message, severity }
}
```

The fence re-runs this same policy over every URL-bearing attribute in the
final output, so a hand-written `href=${value}` that skipped `url()` is
still caught.

---

## Layouts and the render context

A layout is `(ctx: LayoutContext) => Html | Promise<Html>`. The context is
bound to exactly one render: its helpers close over a fresh per-render
state object, so dedup is plain per-render state and concurrent renders are
isolated. Calling a helper **after the render finished** (a captured `ctx`
used late) throws.

| Member | Exact semantics |
|---|---|
| `ctx.page` | The page, **deep-frozen** — every mutation throws in strict mode. Carries `route`, `canonicalUrl`, `title`, `description`, `headings`, `data`, `draft`, `links`, `warnings`, `diagnostics`, `sourcePath`, `relativePath`. |
| `ctx.content` | The page's rendered markdown body (`Html`). |
| `ctx.site` | `{ url }` — the site base URL, path prefix included. |
| `ctx.head()` | The head block, see below. |
| `ctx.stylesheet(name)` / `ctx.script(name)` | The asset tag for a manifest name, see below. |
| `ctx.url(value)` | The URL policy with this page as base (relative refs resolve against `site + route`, exactly the page's canonical URL). Invalid → diagnostic + this page's render aborts. |
| `ctx.publicAsset(path)` | The public file's URL, see below. |
| `ctx.readText(path)` | Confined text read under the config directory, see below. |

```ts
const page: Layout = (ctx) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    ${ctx.head()} ${ctx.stylesheet("site")}
  </head>
  <body class="${ctx.page.draft ? "draft" : ""}">${ctx.content}</body>
</html>`;
```

### `head()`

Emits **exactly seven tags**, LF-joined: `<title>`, the description meta,
the canonical link, `og:title`, `og:description`, `og:url`,
`og:type=website` (the `og:` values use `property=`, not `name=`). Every
value goes through the one escaper. It **never emits `charset` or
`viewport`** — the layout hand-writes those; a later validation step errors
when the emitted document does not carry exactly one `<meta charset>`, one
`<title>`, and one `rel="canonical"` (see `metadata.*`). There is no length
cap: title and description are emitted verbatim (the plan floated
128/200-char caps; shipping one would silently rewrite metadata, which this
package refuses to do).

A **second** `head()` call in the same render emits nothing and records
`head.duplicate` — a build-error diagnostic, not a throw; the page still
renders.

### `stylesheet(name)` and `script(name)`

Both take a **manifest map key** (never a path). The first call for a name
in a render returns the full tag; repeats return an empty `Html`
(dedup-per-render, one shared namespace for both helpers). The tag's kind
follows the **manifest entry's extension** — `.js` → `<script defer src>`,
`.css` → `<link rel="stylesheet" href>` — never which helper you called:
the manifest is the source of truth for what the asset's bytes are, so a
mismatched call still emits the tag the bytes require. Asset URLs are
absolute against the site (path prefix included). An unknown name records
`asset.unknown-entrypoint` and aborts that page's render.

### `publicAsset(path)`

The argument is a **file path, not a URL** — never percent-decoded, so the
only traversal vectors are literal ones. Empty, NUL, backslash, a drive
letter, a leading `/`, or any `..` segment is rejected
(`public-asset.traversal`) before any filesystem access. It returns
`site + "/" + normalizedPath` and records the path for the emitter's
existence check: a recorded path that is not a readable file under
`assets.publicDirectory` is `public-asset.missing` (and no configured
public directory makes every recorded path missing).

```ts
const head: Layout = (ctx) => html`<link rel="icon" href="${ctx.publicAsset("favicon.svg")}">`;
```

### `readText(path)`

The confinement contract: the root is the **realpath of the config
directory**; the final realpath must stay inside it (a symlink never
extends a boundary). Literal escapes (absolute, `..`, NUL, backslash, drive
letter) are rejected before resolution; a path that stays inside but is
missing, a directory, unreadable, or not valid UTF-8 is `read-text.failed`;
a size cap of 10 MiB is checked via `stat` **before** the bytes are read
(`read-text.toobig`; exactly the cap is legal). The final realpath is
recorded as a dependency of the page's render.

```ts
const withNotice: Layout = async (ctx) => {
  const notice = await ctx.readText("partials/notice.md");
  return html`<footer>${notice}</footer>`;
};
```

### Failure semantics

A helper failure records a page-attributed diagnostic and aborts **that
page's render only** (its html is null); the pass continues with the other
pages. A layout that throws → `render.threw` (message and stack); a layout
returning a non-Html → `render.bad-result`; a fence violation → the fence
diagnostics re-stamped to the page. The engine never throws out of a render
pass.

---

## Routing and URLs

Routes are file-write inputs, so validation is strict and total:
`normalizeRoute` **never auto-normalizes** — a route that is not already in
normal form is an error naming the offender (a generator that quietly
rewrites routes produces two URLs for one page).

Normal form: starts with `/`; each segment is percent-decoded then
NFKC-normalized (so `%2e%2e` and look-alike characters become the traversal
they hide behind), re-encoded with the WHATWG path set, joined with single
slashes, no trailing slash, root is `/`, case preserved. Rejected outright:
non-strings (`route.invalid`), a query or fragment (`route.query-fragment`),
`.`/`..` segments (`route.traversal`), and — all `route.shape` — control or
invisible format characters, backslashes, drive letters, empty segments,
invalid percent escapes, Windows reserved device names, and anything whose
normalized form differs from the input.

```ts
normalizeRoute("/guide/intro", { sourcePath: "content/guide/intro.md" }); // unchanged
isNormalizedRoute("/a/"); // false — a trailing slash is not a route
routeToFile("/"); // "index.html"
routeToFile("/guide/intro"); // "guide/intro.html"
```

### The URL ↔ file table (normative)

One resolver is shared by the emitter, the sitemap, `ctx.url()`, the link
validator, and the dev server, so they cannot drift:

| URL | File | Notes |
|---|---|---|
| `/` | `index.html` | |
| `/a` | `a.html` | |
| `/a/b` | `a/b.html` | |
| `/a/` | — | **404 in v1** (an empty segment is not a route). |
| `/a.html` | `a.html` | The **lenient form**, answered by the dev server: it serves the same file `/a` serves — unless a page owns the route `/a.html` itself (an exact route beats the lenient form; that page's file is `a.html.html`). The canonical URL stays extensionless. |
| unmatched | `404.html` | Served with real HTTP 404, never a 200 with a 404 body. |

### Collisions

`findRouteCollisions` runs two passes over the route table: exact duplicates
(`route.duplicate`, naming **all** colliding source files) and a
case-insensitive pass (`route.case-collision`) that always runs — the same
config must not build on Linux and half-emit on a case-insensitive
filesystem. A draft and a page on the same route collide in every mode.

```ts
const diags = findRouteCollisions([
  { route: "/a", sourcePath: "a.md" },
  { route: "/A", sourcePath: "A.md" },
]);
// one route.case-collision diagnostic naming both files
```

---

## Markdown

The v1 feature list is exact — everything else renders as plain text:

- ATX headings (`#` … `######`) with generated `id` slugs, paragraphs,
  bullet and ordered lists, **GFM task-list items** (`- [ ]` / `- [x]`,
  emitted as a disabled checkbox in a `<label>` — GitHub's shape),
- fenced code blocks (```` ``` ```` and `~~~`, with a `language-` class) and
  indented code blocks, inline code,
- links, autolinks (`<https://…>`), images, emphasis/strong, GFM
  strikethrough (`~~x~~`), GFM tables, blockquotes, thematic breaks.

**Not enabled:** raw HTML (`html: false` — raw HTML in the source is
**escaped to inert text**, never emitted), linkify, typographer/smart
quotes, syntax highlighting, footnotes, definition lists.

### Heading ids

GitHub-style slugs: lowercase → NFKD with combining marks stripped
(`"Ünïcödé"` → `unicode`) → whitespace runs to `-` → keep unicode letters,
digits, `-`, `_` → collapse repeated `-` → trim `-`. An empty slug (an
emoji-only heading) becomes `section`. Collisions get `-1`/`-2`/… suffixes
in document order, incremented past ids already taken (`Foo`, `foo-1`,
`Foo` → `foo`, `foo-1`, `foo-2`). `page.headings[].id` is the final id.

### Internal links and fragments

Relative `.md` links resolve against the page's **route**, are stripped of
`.md`, and are rewritten to the destination route when the destination is a
page. A destination that is not in the route table is `link.broken`; a
destination that is a draft is `link.draft`. Both are **errors in a
production build and warnings in dev** (the dev server renders drafts, so
the link really resolves there). A link carrying `#fragment` requires the
destination page's **final emitted HTML** to contain that id
(`link.missing-fragment`, always an error).

Fragment checking scans emitted bytes for **quoted id attributes only**
(`id="x"` or `id='x'`), and HTML comments are stripped first. The
quoted-only rule is deliberate: an unquoted `id=x` inside a code sample
contains no character that escaping would touch, so it survives to the
output byte-identical to real markup — broadening the scan to unquoted
values would let code samples false-satisfy fragment checks. A quoted
`id="x"` can never survive escaping (`&quot;`), so a quoted match is always
a real attribute. Layouts must quote their ids; a hand-written unquoted id
is not recognized.

---

## Assets

Each declared script/style entrypoint is bundled with **one `Bun.build`
call per entrypoint into a fresh temp directory** (measured: Bun's `outdir`
is not cleared between builds, so a naive shared outdir leaks stale files).
The bundler's output name is never used: the SSG computes
**sha256 over the final emitted bytes and takes the first 16 hex chars**,
emitting `assets/<name>-<hash>.<ext>`. Only `.js` and `.css` outputs are
accepted.

An entrypoint that emits **more than one file** — real code-splitting, an
imported asset (`import logo from "./x.svg"`), JS importing CSS — is
refused with `asset.entrypoint-chunked`: v1 emits exactly one hashed file
per declared entrypoint. A bundler failure is `asset.bundle-failed` with
the bundler's own messages folded in, located when the bundler located
them. An asset that no page ever passed to `script()`/`stylesheet()` is an
`asset.unused` **warning**.

Two more measured behaviors of the bundler, both pinned by tests:

- **Bun prefixes each output with a one-line banner naming the bundled
  file relative to the process cwd** (a `../`-prefixed path when the file
  is outside the cwd — never an absolute path). For a single-file
  entrypoint the banner sits at the head of the file (after a preserved
  hashbang and one blank line, when the entry starts with `#!`) and names
  the entry itself, so the SSG strips it before hashing. A multi-file
  bundle (the entry imports other files, a CSS `@import`s, an npm package
  import) emits one banner per bundled file, and the leading one names a
  dependency, not the entry — the SSG strips those as well: every input
  file of the build is enumerated from Bun's build metafile, whose keys
  carry the same cwd-relative paths as the banners (measured
  byte-identical), so the exact banner line is computable for every
  bundled file. The strip removes any output line byte-identical to a
  computed banner — but only after the file's FIRST line has matched one
  of them, so a bannerless or changed-shape output is never touched: a
  future Bun that changes the banner shape degrades that asset to the old
  cwd-sensitive hash instead of pattern-stripping and corrupting code.
  Result: **every asset, single- or multi-file, is byte-identical — hashes
  included — across builds from any working directory**; no pinning of the
  build's cwd is needed. One honest caveat, pinned by tests: the transpile
  drops every source comment, so a bare comment-shaped line in the output
  can only be a banner or template-literal content — if the latter is
  byte-identical to one of the computed banners, the exact match strips it
  with them (one line of string data changes; the backtick boundaries
  survive, so the code still parses).
- **The transpile drops every source comment** (leading, mid-file,
  trailing; `//` and `/* */`, CSS included) before the bundle is emitted:
  shipped assets contain no source comments. String data is otherwise
  untouched — a template-literal line that merely looks like a comment
  survives verbatim (the one exception: a line byte-identical to a
  computed banner of a multi-file bundle, per the previous bullet). An
  entry that is only comments or type declarations therefore emits zero
  bytes (and no banner).

```ts
// Declared once in the config; referenced from layouts by map key.
// First call in a render emits the tag; the repeat emits "" (dedup per render):
const head: Layout = (ctx) =>
  html`<head>${ctx.stylesheet("site")}${ctx.stylesheet("site")}</head>`;
```

### The public directory

`assets.publicDirectory` is copied to the output root **byte-for-byte,
unhashed** — public files get **no cache-busting** (that is the deal: put a
fingerprint in the file name yourself if you need one). A configured-but-
missing directory is `asset.public-missing`; a symlink inside it is
`asset.public-symlink` (never copied, never silently skipped). A public
file that would clobber a generated file — exactly, case-only, or inside
the reserved `assets/` prefix — is `output.collision`.

---

## Output and publish

A build writes into a **staging directory that is a sibling of the output**
(same filesystem — never `/tmp`, because a cross-device rename is `EXDEV`)
and publishes with two renames: `out → .crust-out-old-…`, then
`staging → out`. On `EPERM`/`EXDEV` (Windows locked files, cross-device)
each rename falls back to a recursive copy. **Any failure after the output
was moved aside restores the previous output** and rethrows — a failed
build leaves the previous output exactly as it was, and a failed build
never publishes: every stage collects diagnostics, staging is deleted, and
the run rejects with a `BuildError` carrying all of them.

A build **killed between the two renames** loses nothing: the next build's
startup sweep restores the orphaned `out-old` tree to the output path
(crash recovery), and dead processes' staging/lock litter is reclaimed.

Concurrent builds of the same output are refused with **`build.busy`**
(naming the live holder's pid) via a per-output lock file — a second build
interleaving its renames with the first's is a measured false-pass race.
Dead holders' locks are reclaimed automatically, so a killed build never
blocks the output forever.

---

## sitemap.xml and robots.txt

The sitemap has one `<url><loc>` per non-draft page (the generated 404 is
excluded), in lexicographic URL order, and **no `<lastmod>`** — a timestamp
would make byte-identical rebuilds impossible:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.dev/</loc></url>
<url><loc>https://example.dev/guide/getting-started</loc></url>
</urlset>
```

The `robots.txt` bodies are pinned byte-for-byte. With
`robots: { indexable: true }` (and the sitemap on):

```
User-agent: *
Allow: /
Sitemap: https://example.dev/sitemap.xml
```

With `robots: { indexable: false }`:

```
User-agent: *
Disallow: /
```

(no `Sitemap:` line — but the sitemap **file** is still emitted when
`sitemap: true`; it is a link-checker input for `crust verify-web-links`,
not just a crawler hint). No `robots` config → no `robots.txt` at all.

---

## The 404 page

Every build emits a generated `404.html`, rendered through
`content.defaultLayout` like any page, with fixed `title: "Not found"`,
`sourcePath: "<generated>"`, and `route: "/404"`. It is excluded from the
sitemap and is **not a link target** — a link to `/404` is `link.broken` —
while its own links are validated like any page's. The dev server serves it
with a real HTTP 404. There is no config knob in v1 (`output.notFound` is a
documented v1.1 candidate).

---

## Diagnostics

Every problem the package reports is a `Diagnostic`:

```ts
const d: Diagnostic = {
  code: "link.broken",
  message: 'internal link on line 7 of "content/index.md" points at "/gone"',
  severity: "error",
  sourcePath: "content/index.md", // always posix
  line: 7, // 1-based, in the named file's coordinates
};
```

A failed build rejects with a `BuildError` carrying **all** collected
diagnostics, sorted by `sourcePath`, then `line`, then `code` (code-unit
order — locale collation would make output machine-dependent). The CLI
formats each as `severity[code]: message` plus a ` --> path:line:col` line,
on stderr, with ANSI only when stderr is a TTY.

Severity rules that vary by mode: **`link.broken` and `link.draft` are
errors in a production build and warnings in dev** (the dev server serves
drafts and shows the rest of the site). `asset.unused`,
`frontmatter.derived-description`, `frontmatter.missing-description`, and
`content.no-pages` are warnings everywhere else. Everything else is an
error in every mode.

The full code vocabulary (codes are never repurposed or removed):

| Code | Severity | Meaning |
|---|---|---|
| `config.unknown-key` | error | A config key that is not in the schema, at any level. |
| `config.site` | error | `site` is not a canonical absolute http(s) URL (trailing slash, query/fragment, userinfo, non-canonical form). |
| `config.layout-type` | error | A layout value is not a function, the registry is empty, or `defaultLayout` names no layout. |
| `config.asset-name-clash` | error | The same asset name is declared in both `assets.scripts` and `assets.styles`. |
| `config.asset-name` | error | An asset name does not match `/^[A-Za-z0-9_-]+$/`. |
| `config.output-overlap` | error | The output directory overlaps an input root (content, public dir, entrypoints, or the config dir itself). |
| `config.port` | error | `dev.port` is not an integer in 1..65535. |
| `config.load` | error | The config file could not be imported, or its default export is not a `defineSite()` result. |
| `config.type` | error | A known config key has the wrong type/shape (including `output.trailingSlash` ≠ `"never"`). |
| `route.invalid` | error | A route is not a string, or `content.route` threw / returned a non-string. |
| `route.query-fragment` | error | A route contains `?` or `#`. |
| `route.traversal` | error | A route contains a `.` or `..` segment (raw or hidden by encoding). |
| `route.shape` | error | A route is not in normalized form (control/format chars, backslash, drive letter, empty segment, bad escape, Windows reserved name, or any needed normalization). |
| `route.case-collision` | error | Two routes differ only by case — they collide on case-insensitive filesystems. |
| `route.duplicate` | error | The same route is produced by several files; the message names all of them. |
| `frontmatter.missing` | error | No column-0 `---` delimiter at the top, or the block is never closed. |
| `frontmatter.not-mapping` | error | The frontmatter parses but is not a YAML mapping. |
| `frontmatter.duplicate-key` | error | A frontmatter key appears twice (located). |
| `frontmatter.unknown-key` | error | A frontmatter key outside the built-ins (or a non-string key). |
| `frontmatter.missing-title` | error | The required `title` key is absent. |
| `frontmatter.bad-value` | error | A frontmatter key has the wrong value type/shape. |
| `frontmatter.parse-error` | error | The block is delimited but is not parseable YAML (all syntax errors reported). |
| `frontmatter.derived-description` | warning | `description` was absent and derived from the first paragraph; the message carries the derived value. |
| `frontmatter.missing-description` | warning | `description` absent and there was no text to derive from; it stays `""`. |
| `content.no-pages` | warning | The content directory produced zero non-draft pages (a production build would emit only the 404). |
| `frontmatter.data-invalid` | error | `content.parseData` threw, rejected, or returned a non-plain-object. |
| `route.missing` | error | Neither frontmatter `route` nor `content.route` produced a route for the page. |
| `layout.unknown` | error | A page's layout names a key that is not in the layouts registry. |
| `link.invalid` | error | A markdown link/image destination failed the URL policy (the attribute is stripped, so the output stays inert). |
| `markdown.parse-error` | error | The markdown renderer itself threw (otherwise it treats everything as text). |
| `link.broken` | error in build / warning in dev | An internal link's destination is not a page of the site (including a link to the generated `/404`). |
| `link.draft` | error in build / warning in dev | An internal link points at a draft page, which production builds do not render. |
| `link.missing-fragment` | error | A `#fragment` link whose destination's emitted HTML has no such quoted id. |
| `metadata.charset-missing` | error | The emitted document has no `<meta charset>` (the layout must hand-write it). |
| `metadata.charset-duplicate` | error | More than one `<meta charset>`. |
| `metadata.title-missing` | error | No `<title>` — the layout never called `head()`. |
| `metadata.title-duplicate` | error | More than one `<title>` (`<svg><title>` icon labels do not count). |
| `metadata.canonical-duplicate` | error | More than one `rel="canonical"`. |
| `metadata.head-missing` | error | No `rel="canonical"` — `head()` (the only canonical producer) was never called. |
| `render.bad-value` | error | An interpolated template value has no safe rendering (thrown before any `toString`). |
| `render.bad-result` | error | A layout returned (or resolved to) something that is not an `Html`. |
| `render.threw` | error | The layout (or the render/fence stage) threw; the message carries the error message and stack. |
| `head.duplicate` | error | `head()` called a second time in one render (the second call emits nothing). |
| `public-asset.traversal` | error | `publicAsset()` got a path that is empty, absolute, contains `..`, a backslash, a drive letter, or NUL. |
| `public-asset.missing` | error | A recorded `publicAsset()` path is not a readable file under the public directory. |
| `read-text.escape` | error | `readText()` resolved (literally or via a symlink) outside the config directory. |
| `read-text.toobig` | error | A `readText()` file exceeds the 10 MiB cap (checked before reading). |
| `read-text.failed` | error | A `readText()` path inside the root is missing, a directory, unreadable, or not valid UTF-8. |
| `fence.script-body` | error | A tracked value inside a `<script>` body. |
| `fence.style-body` | error | A tracked value inside a `<style>` body. |
| `fence.comment-value` | error | A tracked value inside an HTML comment. |
| `fence.dynamic-tag-name` | error | An interpolated value in a tag-name position. |
| `fence.dynamic-attr-name` | error | An interpolated value in an attribute-name position. |
| `fence.event-handler` | error | An `on*` event-handler attribute in the output. |
| `fence.unquoted-attribute` | error | An attribute value without quotes in the output. |
| `fence.unterminated` | error | An attribute quote opened and never closed. |
| `fence.url-attribute` | error | A URL-bearing attribute whose tracked value fails the URL policy. |
| `fence.ping-attr` | error | A `ping` attribute (banned outright). |
| `fence.srcdoc-attr` | error | A `srcdoc` attribute (banned outright). |
| `asset.entrypoint-chunked` | error | An entrypoint emitted more than one file (code-splitting / imported assets are not supported in v1). |
| `asset.bundle-failed` | error | `Bun.build` failed (or emitted nothing usable); the bundler's messages are folded in. |
| `asset.public-missing` | error | `assets.publicDirectory` is configured but absent or not a directory. |
| `asset.public-symlink` | error | A symlink inside the public directory (never copied, never silently skipped). |
| `asset.unknown-entrypoint` | error | `script()`/`stylesheet()` named a manifest key that was never declared. |
| `asset.unused` | warning | A declared asset that no rendered page ever referenced. |
| `output.collision` | error | A public file would overwrite a generated file (exact, case-only, inside the reserved `assets/` prefix, or case-only against another public file). |
| `content.read-failed` | error | A discovered `.md` file could not be read at parse time. |
| `content.parse-failed` | error | A non-read failure while parsing a page (an engine bug, labeled honestly). |
| `output.escape` | error | A resolved write path left the staging directory (defense in depth — an internal-bug tripwire). |
| `build.busy` | error | Another live build holds the lock for this output. |
| `dev.port-in-use` | error | The configured dev port is already bound (v1 does not auto-increment). |
| `url.control-char` | error | A URL contains a control character or space. |
| `url.bad-char` | error | A URL contains `"`, `'`, a backtick, or a backslash. |
| `url.entity-escape` | error | A URL contains `&#` or a named entity reference (browsers decode it before the URL parser runs). |
| `url.protocol-relative` | error | A protocol-relative `//host/…` URL (rejected outright in v1). |
| `url.scheme` | error | A URL is unparseable or uses a scheme outside `http https mailto tel sms`. |
| `url.no-host` | error | An `http(s)` URL with an empty host. |
| `url.userinfo` | error | An `http(s)` URL carrying `user:pass@`. |

---

## CLI

```
crust-site — the crust site generator (run under Bun)
usage:
  crust-site build [configFile]   render the site into output.directory
  crust-site dev [configFile]     start the dev server (rebuilds on change)
  crust-site --help               show this help

configFile defaults to ./site.config.ts
exit codes: 0 ok/help, 1 runtime failure, 2 argument error
```

- **`build`** prints warnings (if any) as formatted diagnostics on stderr,
  then exactly one summary line on stdout
  (`crust-site: built N pages, M assets, T ms → <dir>`), and exits 0. A
  failed build prints **every** collected diagnostic on stderr and exits 1 —
  stdout carries no diagnostics, ever.
- **`dev`** runs a thin supervisor: it spawns a worker child and restarts
  it when a **code or config change** lands (a fresh process is the only
  way to re-import transitively imported code). A worker death for any
  other reason (initial build failure, port in use, a crash) ends the
  wrapper with that code — a failing build never respawns in a loop.
  Ctrl-C stops the server and exits 130 (SIGTERM → 143).
- Argument errors (unknown subcommand, a second positional, a flag-shaped
  argument) exit 2 with the usage; `--help`/`-h` exits 0.

The crust binary's `site` builtin is only a redirect stub pointing at this
package (exit 1, never a silent 0, never `sh`'s 127).

---

## Dev server contract

`bunx @crust/site dev` serves the site from a **dev staging tree** and
**never writes to `output.directory`** — the output is only ever written by
a production build's publish swap.

- **Drafts are rendered** in dev, each with a fixed DRAFT banner prepended
  to its body, and `link.draft`/`link.broken` are **warnings** (the links
  really resolve here).
- **No HMR, ever.** A content change triggers a debounced (~100 ms) full
  in-process rebuild into a fresh staging tree; the serve root is swapped
  only on success, so a failed rebuild prints its diagnostics while the
  **last complete build keeps serving** — a half tree is never served. The
  dev server injects no live-reload client: the browser picks the new tree
  up on a full reload. (v1 rebuilds the whole site in-process; the per-page
  `readText` dependency index is collected but no page-level skipping is
  claimed.)
- A **code or config change** (anything under the config directory that is
  not content) restarts the dev worker (CLI) or prints a restart hint
  (library use) — never a partial in-process reload.
- **Headers:** HTML and public-directory files are `no-store`; hashed
  `assets/<name>-<hash>.<ext>` files are `public, max-age=31536000,
  immutable` (the hash is the version).
- **Watcher:** off Windows, `fs.watch` (recursive) is primary with a
  polling fallback; **on Windows polling is the primary path** (500 ms,
  `fs.watch` is unreliable there). Both backends diff against one shared
  (mtime, size) baseline taken before the initial build, so a watch replay
  of the pre-watch state never fires a spurious rebuild while an edit made
  even during the initial build is caught. The package's own staging/lock
  traffic is never treated as a change.
- **Port:** `dev.port` (or an ephemeral port when unset). A bound port is
  an error (`dev.port-in-use`) — v1 never auto-increments, because a
  silently different port serves the site where you are not looking.
- URL resolution is the shared table above, including `/a/` → 404 and the
  lenient `/a.html` form.

---

## Determinism contract

A rebuild with unchanged inputs is **byte-identical**:

- lexicographic **code-unit** ordering everywhere (never locale collation —
  two machines must not order the same strings differently),
- pages render sequentially in route order,
- no timestamps in any emitted byte (no sitemap `<lastmod>`),
- LF-only output; CRLF/CR input is normalized and a leading BOM stripped,
- diagnostics are sorted by sourcePath, line, code,
- no cwd-sensitivity in any emitted byte: the per-file path banners Bun
  prepends to bundled asset files embed cwd-relative paths, and the SSG
  strips every one of them before hashing — single-file and multi-file
  bundles alike (see “Assets”) — so a rebuild is byte-identical from any
  working directory. The one residual is a future Bun that changes the
  banner shape: the strip is an exact match, so it then leaves the bytes
  untouched, and that asset's hash can become cwd-sensitive again rather
  than risk a corrupted strip.

---

## Windows support

Windows support means **this package under `bun`/`bunx`**. The prebuilt
crust binaries stay linux/darwin-only; the `site` builtin in the binary is
only a redirect. The package's CI runs its suite on `windows-latest` (the
crust release CI only executes linux-x64 — this package does not inherit
that blind spot).

| Area | What the package does |
|---|---|
| Publish | Copy fallback is mandatory on Windows (locked files → `EPERM`): retry-with-copy, restore-on-failure. |
| Case-insensitive FS | The duplicate-route pass runs a case-insensitive pass on top of the exact one, on every platform, and names which route is which. |
| Reserved names | `CON`/`NUL`/`PRN`/`AUX`/`COM1-9`/`LPT1-9` and trailing dots/spaces are rejected at route validation (`route.shape`) on every platform, so one config behaves identically everywhere. The dev server rejects them as request paths only on win32, where they are devices; off Windows they are ordinary file names. |
| Paths | Internal paths are posix-normalized; `sourcePath` in diagnostics is always posix. |
| Determinism | CRLF normalized on input; LF-only output. |
| Watcher | Polling is the **primary** path on Windows. |
| `readText` | realpath-based containment works on both platforms (junctions included). |
| Terminal | Diagnostics degrade gracefully without ANSI (color only when the stream is a TTY). |

---

## Programmatic API

```ts
const result = await build({ configFile: "./site.config.ts" });
result.contractVersion; // 1
result.outputDirectory; // absolute
result.pages; // [{ route, sourcePath, file }] — content pages by route; the generated 404 is NOT here
result.assets; // { name: "assets/<name>-<hash>.<ext>" }
result.durationMs;
result.warnings; // every warning-severity diagnostic, sorted
```

`build()` rejects with a `BuildError` carrying every collected diagnostic
when anything failed; the previous output is untouched and staging is
deleted.

```ts
try {
  await build({ configFile: "./site.config.ts" });
} catch (e) {
  if (e instanceof BuildError) {
    for (const d of e.diagnostics) console.error(`${d.severity}[${d.code}]: ${d.message}`);
  } else {
    throw e;
  }
}
```

The remaining exports (`normalizeRoute`, `routeToFile`, `canonicalUrl`,
`findRouteCollisions`, `isNormalizedRoute`, `parseFrontmatter`, `html`,
`url`/`validateUrl`, `defineSite`, `resolveConfigPaths`,
`checkOutputOverlap`, `BuildError`, `DiagnosticCodes`, `sortDiagnostics`,
`contractVersion`, and the public types) are the same contracts documented
above. `renderPage`/`renderAll` are exported for the package's own
pipeline wiring — site authors write layouts, they never call the engine.
