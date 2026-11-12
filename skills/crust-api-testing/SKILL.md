---
name: crust-api-testing
description: Test HTTP APIs with crust — .pipes suites (one fixture pipeline per line, request chaining via capture, inline SQL verification), .crust.ts fixtures with setup/matchers, and gen-fixtures which derives negative-case matrices and CRUD flow suites from an OpenAPI spec. Use for API integration tests, contract tests from a spec, auth/authz negative cases, or DB-verified endpoint tests.
---

# crust API testing

## The shared principle: the lightest CORRECT layer

Choose the lightest native layer that preserves correctness, observability,
and safety — not merely the shortest syntax.

- Use `.pipes` for straightforward requests, assertions, and supported request chaining.
- Use `.crust.ts` when setup, custom matchers, or required safety controls cannot be expressed in pipes.
- Use `gen-fixtures` for supported contract-derived cases, followed by review.
- Use native load pipelines for paced traffic, measurements, and explicit success gates.
- Do not force a case into pipes when doing so removes a required guarantee.
- Consult repository-specific execution and credential policies before running examples.

Three layers, one binary:

| Layer | File | Best for |
|---|---|---|
| `test-pipes` | `.pipes` — one pipeline per line | readable CRUD suites, chaining, SQL cross-checks |
| `test-fixture` | `.crust.ts` — TS fixture modules | complex setup, matcher functions, stress (`-n`) |
| `gen-fixtures` | generated from `openapi.json` | negative matrices + CRUD flows for every documented op |

## .pipes suites (test-pipes)

One shorthand pipeline per line; `#` comments; lines run sequentially per
file. `capture` chains requests; `sql` verifies the database inline:

```crust
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
DELETE $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 204
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 404
```

Run: `test-pipes 'tests/**/*.pipes' [-b] [-t ms] [-s mod.ts] [-o report.xml]`.
PASS/FAIL report lines are prefixed `file:LINE` with real file line numbers.
`-o`'s extension picks the format: `.xml` is JUnit (testcase per line),
`.json` the raw report — both CI-ingestable. Any other extension (or none)
writes the same text report stdout shows; the file never changes the exit code.

- **Setup module**: `-s mod.ts`, else sibling `<name>.setup.ts`; its
  default export is awaited before the file and seeds `process.env`
  ($BASE/$TOKEN). `sql` needs `$DATABASE_URL`.
- **SQL row types**: rows arrive as the driver returns them — uuid and enum
  columns as strings, but `count(*)` and `numeric` may arrive as
  strings/bigints. Cast in SQL when comparing numbers
  (`count(*)::int AS c`), and compare ids as strings.
- **Hermetic per file**: `process.env` is snapshotted/restored around each
  file — captures and setup vars never leak across files.
- Status-check placement: `expect N` when the check ends the line;
  `assert (r => r.status === N)` when more stages follow (expect only
  throws at drain).
- Redirect control: `--redirect error|manual|follow` on any http line —
  `error` refuses a 3xx (a moved endpoint cannot pass by landing elsewhere;
  the line fails with `redirect refused (--redirect error)`), `manual`
  yields the 3xx so `GET … --redirect manual | expect 301` asserts a
  redirect exists, `follow` is the default. This is the pipe-side twin of a
  fixture's `input.redirect` — when a pipe cannot express a case, the
  fixture can, and it has always had this control. In per-item/load position
  a refusal is a `{status: 0, redirectRefused: true}` RECORD and the line
  exits 0 — gate with `expect 200` or `stats | assert (s =>
  s.redirectRefused === 0)`; exit 0 alone is never request success in load
  mode.
- Result shapes per execution context (`Response` vs timed `{status, ms, url}`
  records, body draining, `.json()` availability): canonical table at
  https://lariocpt.github.io/crust-website/docs/http-result-shapes/.
- Exit codes: 0 all pass · 1 any fail · 2 no files/bad args.

## .crust.ts fixtures (test-fixture)

One fixture = one request. `setup()` returns a ctx; `input` fields that are
1-arg functions receive it; `output` fields that are 1+-arg functions are
matchers `(actual, ctx)` — async matchers awaited:

```ts
export default {
  name: "creates a user",
  setup: async () => ({ token: await login() }),
  input: {
    url: "http://localhost:3000/api/users",
    method: "POST",
    headers: (ctx) => ({ authorization: `Bearer ${ctx.token}` }),
    body: { name: "x" },
  },
  output: {
    status: 201,
    data: async (d, ctx) => (await db.userById(d.id)) !== null,
  },
};
```

Run: `test-fixture 'tests/*.crust.ts' -j8 [-n N] [-t ms] [-b] [-o report.xml]`.
`-o`'s extension picks the format — `.xml` is JUnit for CI: testcase per
run (stress iterations individually), percentiles in `<system-out>`; `.json` is
the raw report, `.md` markdown, anything else the text report.

`input.redirect: "error" | "manual" | "follow"` reaches fetch like any other
`RequestInit` field — the fixture-side twin of the http stage's `--redirect`
flag. `"error"` fails the fixture with the field named when the upstream
answers 3xx (a moved endpoint cannot pass by landing elsewhere); `"manual"`
records the 3xx so `output: { status: 301 }` asserts a redirect exists. Any
other value is a loud fixture error, not a fetch mystery.

`output.schema`: give it an inline JSON Schema and the response body must
conform — violations fail with per-field pointer paths. Inline means
$ref-free: a `$ref` anywhere in the schema is a loud error (the runner has
no spec to resolve it against — it would otherwise pass silently).
Unknown schema keywords pass (never-invent-a-violation). gen-fixtures emits
this automatically when the spec documents a response schema for a case's
expected status.
Fixtures may run CONCURRENTLY under -j/--threads — share state only via a
module-scope promise-cached factory. Fixture files may import ONLY relative
modules and Bun builtins (the binary can't resolve npm at runtime) —
`Bun.SQL`, `Bun.file`, `Bun.jwt`.

## gen-fixtures — spec-driven cases

```
gen-fixtures ./openapi.json [--no-flows]   # --out/--setup default to tests/gen
```

Emits (deterministic, byte-stable — check the output in, regenerate, review
the `git diff`):

- **Negative matrix** per op (`<tag>.gen.crust.ts`): 401 no-creds, 403
  authenticated-outsider (scope-gated paths), 404 unknown-id, and a 400
  matrix per body field — missing required, wrong type, bad enum, too
  short/long (minLength/maxLength), below/above numeric bounds, pattern
  violations, unexpected extra property. Nullable `anyOf` fields unwrapped.
- **CRUD flows** (`flows/flows.gen.pipes` + sibling setup, run by
  test-pipes with zero extra flags): create → read (body round-trips the
  captured id) → update → delete → read-after-delete-404, chained with
  `capture`, auth via `$GEN_AUTH_HEADER`. SQL assertions are NOT derivable
  from a spec — add those by hand in your own .pipes.

Setup-module contract (imported lazily): `shared()` promise-cached context,
`headersFor(ctx, "none"|"member"|"outsider")`, `resolvePath(ctx, template)`,
`scopeParam`, `scopeRoots?`, `JSON_HEADERS`, and optional
`flowOverrides: { "<template>": { body?: {...}, skip?: true } }` for creates
whose values a spec can't express (business date rules → `body` merge;
required foreign keys → `skip`).

The `--out` dir is DELETED and recreated every run — never hand-edit
generated files.

What crust cannot attribute it does not emit. The pattern sampler returns a
knowingly-wrong placeholder for a pattern it cannot read — a lookahead, Python
`\A`/`\Z` anchors, a JavaScript regex literal written into `pattern` (groups
it reads: `(?:…)`, `(a|b)`, `(…){n}`, so an AWS id like
`^(subnet-[0-9a-f]{8}|subnet-[0-9a-f]{17})$` yields `subnet-00000000`); in a
base body a placeholder makes a case about `name` invalid in `subnetId`, so its
400 names the wrong field. Those cases — and a CRUD flow
whose create body cannot be filled — are dropped and NAMED on stdout
(`gen-fixtures: 2 case(s) skipped for POST /things …`, `skipping flow for
/things …`). A silently smaller suite would look like coverage.

## Generated cases are candidates, not certified coverage

A generator can derive request mutations from a schema. It cannot universally
infer backend-specific status codes, error envelopes, authorization
concealment policies, business preconditions, or cleanup behavior.

For negative tests:

- Begin with an otherwise valid request.
- Mutate one intended condition.
- Ensure authentication and resource preconditions allow the request to
  reach the intended validation layer (a request that dies at auth never
  proves the validation code).
- Assert the documented status.
- Where the contract provides structured error evidence, verify the relevant
  field, location, or error code.
- Avoid exact human-readable message matching unless wording is contractual.

A generic error status is insufficient evidence when the request could have
failed for an unrelated reason. And the generated **400 validation matrix is
a generator assumption, not a universal API convention** — some contracts
specify `422` (or another status) for validation failures; when the contract
disagrees, say so in review and adjust expectations to the CONTRACT, never
the other way around. Document unsupported assumptions and skipped cases
rather than silently reducing coverage or normalizing the contract to fit
generation.

## Contract review before generation

Review the contract BEFORE generating and record the review beside the
generated output. Record fields (one per line):

```
API/service:
Contract path:
Contract revision:
Backend revision, if available:
Crust version:
Reviewer:
Review date:
Generated output directory:
Intended execution scope:
Unresolved discrepancies:
```

Highest-risk checks (full checklist:
https://lariocpt.github.io/crust-website/docs/contract-review/):

- Expected statuses come from the reviewed contract — validation cases do
  NOT default to 400 (a 422 contract must generate 422 expectations).
- Authorization cases account for intentional 404 concealment; unknown-id
  cases use syntactically valid identifiers.
- One intended condition per negative case; unrelated fields stay valid so
  the request reaches the intended validation layer.
- Dedicated `--out` dir; regeneration cannot touch manual fixtures; never
  hand-edit generated files.
- Classify every failure (backend · contract · generator · environment ·
  incorrect test) BEFORE changing any expectation.
- Execution is approved separately — target, identity, resource scope,
  writes, cleanup. This review grants no permission beyond the recorded
  execution scope.

## Workflow for a new API

1. Identify the authoritative contract and record its version or revision.
2. Review generation assumptions against that contract: validation status
   codes; authentication and authorization behavior; error envelopes;
   resource identifiers; response schemas; CRUD lifecycle support.
3. Generate into a dedicated output directory (`--out`, default `tests/gen`).
   Generation DELETES and recreates that directory; never target manually
   authored sources.
4. Review generated cases, expected responses, setup requirements, and
   skipped cases (they are NAMED on stdout) before execution.
5. Obtain the required target, identity, resource, write, cleanup, and load
   approvals from repository policy — the skill never grants any of them.
6. Execute only the approved scope.
7. Classify failures before changing expectations or implementation:
   backend defect · contract defect · unsupported generator assumption ·
   environment/setup failure · incorrect test.
8. Add manually authored native fixtures or pipelines for unsupported cases.
   Do not hand-edit generated files (the next regeneration erases the edit).
9. Record remaining coverage gaps explicitly.

> Never change an expected result solely because the backend returned
> something different. A passing test must reflect a reviewed contract.

## Version and evidence

Behavior described here was verified against **crust v0.3.5** (source-read
and run through the compiled binary where it matters: `--redirect` record
shapes, `output.schema` $ref refusal, gen-fixtures skip reporting). Newer
crust versions may extend behavior; re-verify before documenting it. Keep
approved targets, credentials, transport exceptions, resource ownership, and
execution restrictions in repository policy, not in this skill.
