---
title: Getting started
description: How the docs-example fixture builds with bunx @crust/site.
---

## Install

Add the package and run the build from the directory that holds
`site.config.ts`:

```sh
bun add -d @crust/site
bunx @crust/site build
```

## What you get

Every page renders through the `base` layout declared in `site.config.ts`,
the script and style entrypoints are bundled and content-hashed into
`assets/`, and `public/favicon.svg` is copied verbatim to the output root.
