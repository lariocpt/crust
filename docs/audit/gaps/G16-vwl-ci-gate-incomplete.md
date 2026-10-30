# G16 — verify-web-links page: the 4-line pre-deploy gate is incomplete as written

**FIXED 2026-10-31** — site `ec4791e` (one page:
`src/pages/docs/recipes/verify-web-links.mdx`) · W600 line `?` → **X** —
(1) the `&` claim and (2) the `wait` form both resolved **C**; (3) the
incomplete gate is the **X** (confirmed 2026-10-18, re-run red-first
2026-10-31, `~/tmp/g16/`) · X-census entry annotated · audit (this commit) ·
KB (crust-agent submodule, local commit only — ingest is operator-controlled,
`dc70a4b1`): `round-9-verify-web-links.md` gains the dead-port /
gate-premise section. **MCP reviewed — no overlap**: website-docs-only fix
(the gate's lines are shell-level `crust -c` invocations; nothing about how a
CI gate is composed reaches the nine `crust_*` tools), no functional usage
changed, so the MCP surface stays as-is (the standing order's display-only
case, recorded not skipped).

## The gap (as filed — site `verify-web-links.mdx` L155–175, "## Pairing with CI", read 2026-10-18)

The section's first example (L161–164) is the complete form:

```
# After a build, run against the deployed preview URL
verify-web-links "$PREVIEW_URL" --fixtures site/**/*.meta.crust.ts
```

The 4-line gate that follows (L170–175) drops that premise:

```
crust -c 'mock-server ./openapi.yaml -p4000' &
crust -c 'wait :4000/pets --timeout 20s'
crust -c 'test-fixture fixtures/*.crust.ts'
crust -c 'verify-web-links http://localhost:3000 --fixtures site/*.meta.crust.ts'
```

Step 4 points at `http://localhost:3000`, but nothing in the gate starts a
site on `:3000` — the lines start a `mock-server` on `:4000` (and `wait` on
it). The `:3000` is a leftover from the sibling `$PREVIEW_URL` example, whose
premise (its L162 comment: "After a build, run against the deployed preview
URL") is a deployed preview — a different context. The gate therefore cannot
pass: steps 1–3 can go green, step 4 can never go. (The as-filed dossier's
line refs were corrected in place here: it placed the sibling `$PREVIEW_URL`
example at L159–162; the pre-edit file has it at L161–164. The section itself
is L155–175, the 4-line block L170–175 — those refs were already right.)

The as-filed dossier offered two fix shapes and flagged a secondary
observation:

- (a) add the missing boot line for the built site on `:3000` ("the recipe
  lives on the crust-website repo, whose preview/build owns that port") —
  **falsified, corrected in place here**: `astro.config.mjs` sets no preview
  port (`astro preview` defaults to 4321, not `:3000`), and the website
  pipeline's Links stage runs `verify-web-links --base-url $SITE_URL` against
  the LIVE deployed site — nothing in the repo or the pipeline owns `:3000`,
  so there is no "missing boot line" to add;
- (b) make the 4th line `$PREVIEW_URL`-shaped and state the site-running
  premise in prose — **the fix taken**;
- secondary observation: a dead target surfaces as `no sitemap entries
  found … on <url>` (exit 2), which reads like a sitemap problem — left
  flagged, no code change (below).

## Measured (probed 2026-10-18, fresh `bin/crust-bin`; re-run red-first 2026-10-31, same rig, `~/tmp/g16/`)

Scratch rig (minimal `/pets` spec, one fixture, one meta fixture). Probe A
isolates the defect — the gate's logic with the mock on a free port
(:4123), step 4 kept exactly as written:

```
$ crust -c 'mock-server ./openapi.yaml -p4123' &
mock-server: 1 route(s) from ./openapi.yaml
mock-server: listening on http://0.0.0.0:4123
$ crust -c 'wait :4123/pets --timeout 20s'
{"target":":4123/pets","ready":true,"ms":1,"attempts":1}     # exit 0
$ crust -c 'test-fixture fixtures/*.crust.ts'
1 file(s), 1 run(s): 1 pass, 0 fail, 0 error                 # exit 0
$ crust -c 'verify-web-links http://localhost:3000 --fixtures site/*.meta.crust.ts'
verify-web-links: no sitemap entries found via robots.txt, /sitemap.xml or /sitemap-index.xml on http://localhost:3000
exit=2
```

Steps 1–3 pass; **step 4 can never pass as written** — the gate can never
pass. (The `*.crust.ts` globs in steps 3–4 are expanded by crust itself —
`expandTarget`, `src/fixtures.ts` L10–34, `new Glob` at L23 — so the
single-quoted lines run unmodified.)

Probe B records the environment caveat: the gate's literal line 1 uses
`:4000`, which on this box is held by an unrelated local service
(127.0.0.1:4000), so the mock refuses to bind and the gate dies at line 1:

```
$ crust -c 'mock-server ./openapi.yaml -p4000'
mock-server: Failed to start server. Is port 4000 in use?
exit=1
```

That is the correct refusal behavior, not a probe defect; the defect is
Probe A. (If `:4000` ever frees up, Probe B would bind instead of refusing —
the rig notes it in `~/tmp/g16/probe.sh`; the 2026-10-18 run had the port
held, matching the as-filed note.)

## Secondary observation (flagged, no code change)

A dead target surfaces as `no sitemap entries found via robots.txt,
/sitemap.xml or /sitemap-index.xml on <origin>` (exit 2 — the `discoverSeeds`
give-up, `src/verifyWebLinks/sitemap.ts` L44–46), which reads like a sitemap
problem. `verify-web-links`' first network touch is sitemap discovery, so a
target that is not running fails at discovery, and the message names the
discovery give-up, not the cause. A distinct "target unreachable" message
would save the reader the exact confusion this gate caused. Left flagged —
the gap was the incomplete gate, and the page's prose now documents the
failure mode ("if nothing is listening on `$PREVIEW_URL`'s port, the line
fails on sitemap discovery rather than reporting the pages it was asked to
check").

## The fix (option (b))

`verify-web-links.mdx`, "## Pairing with CI":

- the 4th gate line now uses the sibling example's shape:
  `crust -c 'verify-web-links "$PREVIEW_URL" --fixtures site/*.meta.crust.ts'`
- the prose states the premise — "The last line assumes the built site is
  already running: build the site and serve its output — `astro preview`, a
  static file server, or your pipeline's preview step — on the port
  `$PREVIEW_URL` points at, the same premise as the example above. The gate
  never starts that site itself; if nothing is listening on `$PREVIEW_URL`'s
  port, the line fails on sitemap discovery rather than reporting the pages
  it was asked to check."
- line 1 keeps its concrete `-p4000` (a mock example port — environment-
  specific, not part of the defect).

Both the old and the new line 4 parse under `crust --check` (the website
Grammar gate's mechanism), with `$PREVIEW_URL` set and unset
(`~/tmp/g16/check-parse.mjs`: 3/3 PASS).

Site gates at `ec4791e`: build 31 pages, lint-examples 362 checked / 0
failed, check-links 1313 (41 with an anchor) / 0 dead — all at baseline.

## W600 resolution (this commit, `full-audit.md`)

- **W600** (L1353): line's `?` → **X**. The row's subject IS the pre-deploy
  gate, and the gate is the incomplete part: (1) the `&` claim (in-crust
  refusal + shell-level backgrounding) and (2) the `wait` path form both
  resolved **C** as documented (probed, `ready:true` exit 0), (3) the
  incomplete gate is the **X** — confirmed 2026-10-18 by the (b) capture,
  re-run 2026-10-31 in `~/tmp/g16/` red-first for the fix. (W543's `?`
  closed as C by contrast — its subject was the `--every` windowing
  mechanism, with the bad sentence carved out as the exception.)
- **X census** (L103): `W600 (incomplete CI gate → CONFIRMED, G16)`
  annotated with the resolution — `CONFIRMED 2026-10-18 … FIXED 2026-10-31
  via site `ec4791e`` (the R24/W235 "FIXED" convention for closed census
  entries).
- The 2026-10-18 (b) capture (L1613–1626) and the gap-listing entry
  (L1730) stand as filed — the resolution lives in the row and this dossier.

## Commit

- site `ec4791e` — `docs(verify-web-links): the pre-deploy gate's 4th line assumed a site the gate never starts` (10 insertions / 4 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W600 row/X-census in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `dc70a4b1`) — `round-9-verify-web-links.md` gains "## 6. A dead port masquerades as a missing sitemap — a gate must start everything it checks"
