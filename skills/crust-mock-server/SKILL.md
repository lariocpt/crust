---
name: crust-mock-server
description: Mock an API from an OpenAPI spec with crust mock-server — example-first responses, in-memory stateful CRUD, request validation with 422s, and validation-proxy mode that checks a REAL API's spec conformance. Use for mocking backends, frontend dev without a server, contract/conformance testing, or checking whether an API matches its openapi.json.
---

# crust mock-server

One builtin, four modes, all driven by an OpenAPI 3.x spec (Swagger 2.0
auto-converts; URL or local json/yaml):

```
mock-server --swagger ./openapi.json --port 4000                      # example-first mock
mock-server --swagger ./openapi.json --port 4000 --stateful           # + in-memory CRUD
mock-server --swagger ./openapi.json --port 4000 --validate           # + reject bad requests (422)
mock-server --swagger ./openapi.json --port 4747 --proxy http://localhost:3001   # conformance proxy
```

Builtins can't be piped — run the server in one terminal (or `procs()`), and
pipe against it from another line.

## Mock + stateful

Responses prefer the spec's `example`/`examples`, then synthesize from the
schema (enum[0], format-aware strings, nested objects). Status pick:
200 → 201 → other 2xx → `default`. Unknown path → 404; known path, wrong
method → 405.

`--stateful` pairs `/things` with `/things/{id}` automatically: POST stores
(id from body or a UUID), GET lists what you stored (shaped to the spec's
envelope), GET/{id} → 404 for unknown ids, PUT/PATCH shallow-merge, DELETE
→ 204. Untouched collections keep serving spec examples. State is
per-process memory.

```crust
{"name": "x"} | POST :4000/api/things | assert (r => r.status === 201) | (r => r.json()) | capture TID (t => t.id)
GET :4000/api/things/$TID | expect 200
```

Caveat: the stateful store keeps ids top-level; if the spec's 201 example
wraps the entity (`{thing: {id}}`), capture against a REAL server, not the
mock.

## Request validation (`--validate`)

Spec-violating requests get **422** (not the API's own 400 — deliberately
distinguishable) with header `x-crust-validation: request` and body
`{error, violations: [{pointer, rule, message, expected?, received?, location}]}`.
Checks: JSON body (type/required/enum/format/pattern/lengths/ranges,
anyOf/oneOf/allOf), path + query params (coerced by declared type). The
governing rule: a schema the validator can't judge PASSES — it never
invents a violation (notably `additionalProperties: false` is not
enforced). Composes with `--stateful`: an invalid POST creates nothing.

## Validation proxy (`--proxy <upstream>`) — spec-conformance testing

Forwards every request to the real upstream, returns the response
UNTOUCHED, and records spec violations out-of-band in BOTH directions:
request violations, undocumented response statuses, undocumented
content-types, response-schema mismatches (only where the spec has response
schemas), and `undocumented-operation` for paths the spec doesn't know
(still forwarded — a browsing frontend keeps working). Upstream down → 502,
not a violation. Mutually exclusive with `--stateful`.

The findings are pipeable — this is the conformance gate:

```crust
GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)
```

`DELETE /__crust/violations` clears between runs; `--report file.ndjson`
appends every violation as NDJSON for CI artifacts (requires `--proxy`).

Workflow: point your existing test suite's base URL at the proxy port, run
the suite, then assert zero response-direction violations. (Request-direction
violations are EXPECTED if your suite includes negative cases — filter by
direction.)

## Exit codes

0 clean shutdown (SIGINT/SIGTERM) · 1 spec load failure · 2 bad args
(including `--proxy` + `--stateful`, or `--report` without `--proxy`).
