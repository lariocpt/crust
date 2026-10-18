# G20 — agent-skills mock-server page: the conformance-gate line omits the required `(r => r.json())` decode stage

**Doc:** website `src/pages/docs/agent-skills/mock-server.mdx` L76–78
(audit T26, parity check 2026-10-18).

## Measured (site page vs `skills/crust-mock-server/SKILL.md`, both fully read 2026-10-18)

Site L77 (the page's "actual gate"):

```crust
GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)
```

SKILL.md L118–125 (the canonical skill — the line WITH the decode stage, plus the warning):

```crust
GET :4747/__crust/violations | (r => r.json()) | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)
```

> The `(r => r.json())` stage is not optional: an HTTP stage hands you the
> response object, so reading `.violations` off it straight away is `undefined`
> and the gate dies with `predicate threw` — which looks like a broken assert
> rather than a missing decode.

The site's line is the skill's line with the decode stage removed — the exact
anti-pattern the skill warns about. `v` is the HTTP response object,
`v.violations` is `undefined`, `.filter` throws, and the line dies with
`predicate threw`. The failure is loud, not a false pass — but the page's
recommended gate is one that can never pass, and a user who hits the error sees
"predicate threw" and is pointed at the assert instead of the missing stage.

The site's own mock-server recipe page uses the decode stage in BOTH of its
findings examples — `recipes/mock-server.mdx` L482
(`GET :4000/__crust/violations | (r => r.json()) | (v => v.count + …)`) and
L521 (`crust -c 'GET :4000/__crust/violations | (r => r.json()) |
assert (v => v.count === 0)'`). The agent-skills page is the odd one out.

Why the site CI cannot catch this: the Grammar stage runs `crust --check`
(parse only, no execution). The line parses fine; only a live run produces the
throw.

## Out of scope for this gap (cross-refs, NOT closed here)

T26 also records the section's other omissions — `DELETE /__crust/violations`
clears between runs, `--report file.ndjson` appends NDJSON (requires `--proxy`),
the suite-base-URL workflow — all pure condensation carried by W522/W524 and
SK66 with probes queued. They are not part of this finding.

## Fix

Website: in `agent-skills/mock-server.mdx`, insert the `(r => r.json())` stage
between `GET :4747/__crust/violations` and the filter, and add the one-line
"not optional" note (without it the gate dies with `predicate threw`),
mirroring SKILL.md L118–125.

Verification is NOT lint-examples (that is `--check` = parse-only). A live run
is required: boot `mock-server spec.json -p4747 --proxy <scratch upstream>` and
run the line — the current form must throw `predicate threw`, the fixed form
must exit 0. Then the usual website gates (`bun run build`,
`bun scripts/lint-examples.mjs …`, `bun run check-links`).

## Commit

`docs(agent-skills): mock-server gate line — restore the required r.json() decode stage` (site).
