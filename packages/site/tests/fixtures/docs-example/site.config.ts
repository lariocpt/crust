// The docs-example fixture: this is the quickstart site of docs/USAGE.md,
// mirrored here so the docs gate (scripts/lint-docs.mjs) type-checks it and
// tests/docs.test.ts builds it end to end. The ONLY difference from the docs
// fence is the import specifier: users write `from "@crust/site"`; inside the
// package the same symbols come from the source next door.

import type { LayoutContext } from "../../../src/index.ts";
import { defineSite, html } from "../../../src/index.ts";

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
