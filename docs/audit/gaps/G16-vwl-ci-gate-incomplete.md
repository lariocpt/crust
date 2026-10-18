# G16 — verify-web-links page: the 4-line pre-deploy gate is incomplete as written

**Doc:** website `src/pages/docs/recipes/verify-web-links.mdx` L155–175
(audit W600).

## Measured (probed 2026-10-18, fresh `bin/crust-bin`)

Scratch rig (minimal `/pets` spec, one fixture, one meta fixture), the gate's
logic run with a free port in place of :4000:

```
$ crust -c 'mock-server ./openapi.yaml -p4123' &        # mock-server: 1 route(s) … listening
$ crust -c 'wait :4123/pets --timeout 20s'
{"target":":4123/pets","ready":true,"ms":1,"attempts":1}     # exit 0
$ crust -c 'test-fixture fixtures/w600-4123.crust.ts'
1 file(s), 1 run(s): 1 pass, 0 fail, 0 error                 # exit 0
$ crust -c 'verify-web-links http://localhost:3000 --fixtures site/*.meta.crust.ts'
verify-web-links: no sitemap entries found via robots.txt, /sitemap.xml or /sitemap-index.xml on http://localhost:3000
exit=2
```

Steps 1–3 pass; **step 4 can never pass as written** — nothing in the gate
starts a site on `:3000`. The earlier `verify-web-links "$PREVIEW_URL" …`
example on the same page (L159–162) is the complete form; the 4-line gate
silently drops the premise that the site is already running.

Note: the as-written :4000 twin could not run on this box — :4000 is held by
an unrelated local service, and the mock refused correctly
(`mock-server: Failed to start server. Is port 4000 in use?`), which is the
right behavior.

## Secondary observation (flag, don't force)

A dead port surfaces as `no sitemap entries found … on <url>` (exit 2), which
reads like a sitemap problem. A distinct "target unreachable" message would
save the reader the exact confusion this gate causes. Candidate for a small
crust change; only if the decision says so.

## Fix (decision: which form)

(a) Add the missing boot line for the built site on :3000 (the recipe lives
on the crust-website repo, whose preview/build owns that port); or
(b) make the 4th line `$PREVIEW_URL`-shaped and state "the site must already
be running (build + preview, or the pipeline's preview step)".

Website commit + gates (build, lint-examples, check-links).

## Commit

`docs(verify-web-links): …` (site).
