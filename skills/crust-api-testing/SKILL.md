---
name: crust-api-testing
description: Test HTTP APIs with crust — .pipes suites (one fixture pipeline per line, request chaining via capture, inline SQL verification), .crust.ts fixtures with setup/matchers, and gen-fixtures which derives negative-case matrices and CRUD flow suites from an OpenAPI spec. Use for API integration tests, contract tests from a spec, auth/authz negative cases, or DB-verified endpoint tests.
---

# crust API testing

Three layers, one binary. Pick the lightest that fits:

| Layer | File | Best for |
|---|---|---|
| `test-pipes` | `.pipes` — one pipeline per line | readable CRUD suites, chaining, SQL cross-checks |
| `test-fixture` | `.crust.ts` — TS fixture modules | complex setup, matcher functions, stress (`--count`) |
| `gen-fixtures` | generated from `openapi.json` | negative matrices + CRUD flows for every documented op |

## .pipes suites (test-pipes)

One shorthand pipeline per line; `#` comments; lines run sequentially per
file. `capture` chains requests; `sql` verifies the database inline:

```crust
{"name": "Court", "floors": 3} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
sql "SELECT count(*)::int AS c FROM buildings WHERE name = 'Court'" | assert (r => r.c === 1)
{} | DELETE $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 204
GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 404
```

Run: `test-pipes --target 'tests/**/*.pipes' [--bail] [--timeout ms] [--setup m]`.
PASS/FAIL report lines are prefixed `file:LINE` with real file line numbers.

- **Setup module**: `--setup mod.ts`, else sibling `<name>.setup.ts`; its
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

Run: `test-fixture --target 'tests/*.crust.ts' --threads 8 [--count N] [--timeout ms] [--bail]`.

`output.schema` is a RESERVED key: give it an inline JSON Schema and the
response body must conform — violations fail with per-field pointer paths.
Unknown schema keywords pass (never-invent-a-violation). gen-fixtures emits
this automatically when the spec documents a response schema for a case's
expected status.
Fixtures may run CONCURRENTLY under --threads — share state only via a
module-scope promise-cached factory. Fixture files may import ONLY relative
modules and Bun builtins (the binary can't resolve npm at runtime) —
`Bun.SQL`, `Bun.file`, `Bun.jwt`.

## gen-fixtures — spec-driven cases

```
gen-fixtures --swagger ./openapi.json --out tests/gen --setup ./tests/gen-setup.ts [--no-flows]
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

## Workflow for a new API

1. `gen-fixtures` against the spec → run matrix + flows → fix what fails.
2. Hand-write `.pipes` for business flows the spec can't express (SQL
   checks, multi-resource invariants).
3. Reach for `.crust.ts` only when a case needs real code (crypto, files,
   custom matchers).
