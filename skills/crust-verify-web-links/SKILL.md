---
name: crust-verify-web-links
description: Crawl a site from its sitemap and verify every link, #anchor, redirect chain, OG image and meta tag against .crust.ts fixtures. `--base-url` auto-discovers the sitemap (robots.txt → /sitemap.xml → /sitemap-index.xml), `--site-map-url` takes a local sitemap so you can check build output, `--fixtures` diffs meta. Use when link or SEO health must gate a deploy, when a built site should be checked before publishing, or when OG/meta regressions need catching.
---

# crust verify-web-links

## What it verifies

| Check | Fails when |
| --- | --- |
| internal + external links | any status that is not 2xx |
| `#fragment` targets | the id/name is not on the fetched page |
| redirect chains | a link 301s/302s somewhere (informational with `--no-redirect-warnings`) |
| OG / twitter images | the image URL is unreachable |
| meta vs `--fixtures` | a keyed value differs, or a predicate returns falsy |

Exit codes: `0` all clear, `1` verification failures, `2` bad args or an
unreachable sitemap. `2` also covers `--site-map-url` together with
`--base-url`, neither of them given, `no fixture files matched <glob>`,
`--concurrency must be >= 1`, and `unexpected argument`.

## Getting it pointed at the right thing

```crust
verify-web-links --base-url https://example.com
verify-web-links --site-map-url https://example.com/sitemap.xml
verify-web-links --site-map-url ./dist/sitemap.xml --no-recurse
verify-web-links --base-url https://staging.example.com --fixtures site/*.meta.crust.ts
```

`--base-url` probes `robots.txt` for `Sitemap:` lines, then `/sitemap.xml`, then
`/sitemap-index.xml`; when none answer it names all three. `--site-map-url`
(aliased `--sitemap`) also takes a **local path**, which is the CI move: crawl
the build output rather than a deployed site. With `--no-recurse` only the URLs
in the sitemap are fetched.

## Green does not mean checked

Three ways to get exit 0 with nothing actually verified. Read the note lines and
`totals` before believing a green run:

| Symptom | What it means |
| --- | --- |
| `0 page(s), 3 asset(s), 0 failure(s)` | the responses were not `text/html` — a page served as `text/plain` is counted as an **asset** and its links are never read. Same bytes, only the header changed: `text/plain` → 0 pages / 0 failures / exit 0, `text/html` → 1 page / 1 failure / exit 1 |
| a note naming a count (`anchors skipped…`, `stopped at --max-pages…`) | that work did not happen. `--no-recurse` and `--no-anchors` produce it deliberately |
| `"parsed": false` on a page in `--json` | no links and no ids were extracted from that page |

`--max-pages N` is a safety valve, not a fast mode: the crawl stops early, the
unchecked count is reported, and the exit code still says 0. Treat it as
inconclusive.

## In CI

A builtin runs in-process and cannot sit mid-pipeline —
`verify-web-links … | assert (…)` is refused with *"give it a line of its own"*.
Redirect the whole invocation instead, then judge the report:

```bash
crust -c 'verify-web-links --base-url https://example.com --json --no-progress' > report.json
```

```crust
read report.json | (s => JSON.parse(s)) | assert (r => r.totals.failures === 0)
read report.json | (s => JSON.parse(s)) | assert (r => r.totals.dropped === 0 && r.totals.anchorsSkipped === 0)
```

`read` yields each file's **contents as one item**, so `JSON.parse` receives the
whole document. The first line fails on a real failure; the second catches the
inconclusive case above.

## Meta fixtures

```ts
export default {
  url: "https://example.com/about",
  meta: {
    title: "About Us",
    description: (d: string) => d.length > 50 && d.length < 160,
    "og:image": (u: string) => u.endsWith(".png") || u.endsWith(".jpg"),
    "twitter:card": "summary_large_image",
  },
};
```

A value is compared for equality; a function is a predicate over the extracted
value. A key a page does not have is **asked about**, not ignored — so asserting
`og:image` on a page that lost it is a failure, which is the point.

Fixture `url`s match **URL-normalized**: scheme+host case and default ports
don't matter, `https://x.com` and `https://x.com/` are the same page, but a
trailing slash on a non-root path stays significant (`/login/` ≠ `/login`). A
fixture whose url never appears in the crawl fails as `meta-fixture-no-page` —
a fixture for a page you deleted is a failure, not a skip.

## Tuning

```crust
verify-web-links --base-url https://example.com --exclude /checkout/ --exclude /go/
verify-web-links --base-url https://example.com --include-external --max-depth 2
verify-web-links --base-url https://example.com --concurrency 16 --timeout 3000
```

- `--exclude <substring>` is repeatable. Use it for subtrees that redirect **by
  design** (short-link senders, locale switches); redirect chains are failures
  otherwise. `--no-redirect-warnings` silences them globally — only when you
  mean it.
- Off-origin links are not queued at all without `--include-external`, and even
  then they are never recursed into.
- `--max-depth` (default 5) bounds the crawl, `--concurrency` (default 4) and
  `--timeout` (default 10000 ms) bound each fetch.
- Anchors come from the crawl: with `--no-recurse` the internal links found on
  sitemap pages are not fetched, so their `#fragments` are not checked — the
  report says how many were skipped.
