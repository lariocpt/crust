// examples/gen-setup.ts — a complete, runnable --setup module for gen-fixtures.
//
// Copy it next to your specs, adjust the login/scope helpers to your API,
// and run:
//
//   gen-fixtures --swagger ./openapi.json --out tests/gen --setup ./gen-setup.ts
//   test-fixture --target 'tests/gen/*.gen.crust.ts' --threads 8
//
// The generator imports this module at GENERATION time only to read
// `scopeParam` / `scopeRoots`, so everything below must be lazy — no side
// effects at import time. `shared()` runs when test-fixture executes the
// generated fixtures, and fixtures may run CONCURRENTLY under --threads,
// which is why the scenario must be promise-cached: built once on first
// call, the same promise returned ever after.
//
// Only relative imports and Bun builtins are allowed here — the compiled
// crust binary cannot resolve npm packages at runtime.

const BASE = process.env.BASE ?? "http://localhost:3000";

/** Plain unauthenticated JSON headers — used verbatim for the 401 cases. */
export const JSON_HEADERS = { "content-type": "application/json" };

/**
 * The path-template param that marks an operation as scope-gated (403
 * derivation). An op is scope-gated when its path's FIRST `{param}` has
 * this name. Set to `null` if your API has no scope concept — 403 cases
 * are then skipped entirely.
 */
export const scopeParam = "buildingId";

/**
 * Optional: path prefixes whose immediately-following first `{param}` is
 * the scope id even when it has a different name (`/api/buildings/{id}`).
 */
export const scopeRoots = ["/api/buildings"];

/**
 * Optional: reviewed expectation overrides for when the backend's contract
 * disagrees with the 400 convention. A DOCUMENTED status always wins — this
 * only fills gaps the contract leaves silent, and the manifest records
 * `configured:<module>` provenance for what it fills. `validationEnvelope`
 * (0.3.8) sets the expected validation-response shape — "crust" keeps the
 * existing form, "fastapi" expects a `detail` array whose error `loc`
 * matches the case's mutated field; it never changes the expected status and
 * is never inferred from one. Configured statuses are 4xx: a fixture cannot
 * hold a server to "this request makes it fail", so a 5xx needs the explicit
 * `serverErrorStatus: true` opt-in and prints a notice every generation.
 * `validationErrorTypes` maps a crust constraint name to the error code this
 * API emits for it, which is what upgrades a fastapi matcher from "an error
 * named this field" to "this rule failed". Bad config (unknown keys, statuses
 * outside 400–499, an envelope value that is neither, typo'd "METHOD /path"
 * keys) refuses generation with exit 2. See docs/USAGE.md §gen-fixtures for
 * the schema.
 */
// export const expectations = {
//   validationStatus: 422, // this backend answers 422, never 400
//   validationEnvelope: "fastapi", // …and 422 bodies are FastAPI-shaped
//   concealment: "404", // unknown ids and outsiders both get 404
//   // pydantic v2 names the rule; asserting it is what proves the constraint
//   validationErrorTypes: { minLength: "string_too_short", required: "missing" },
//   operations: {
//     // this one really does 400, Crust-shaped — per-operation beats global
//     "POST /api/reports": { validationStatus: 400, validationEnvelope: "crust" },
//   },
// };

interface Ctx {
  buildingId: string;
  memberToken: string;
  outsiderToken: string;
  /** An item that EXISTS, for `resolveKnownPath` — see its comment. */
  thingId: string;
}

// ONE scenario shared by every generated fixture. Module-scope promise
// cache — safe under --threads, built lazily on first use.
let scenario: Promise<Ctx> | null = null;

export function shared(): Promise<Ctx> {
  scenario ??= (async () => {
    // Replace with your API's real signup/login + scope-creation flow.
    // "member" must clear both the auth and scope gates; "outsider" is
    // authenticated but has NO membership in the shared scope.
    const memberToken = await login("member@gen.test");
    const buildingId = await createBuilding(memberToken);
    const thingId = await createThing(memberToken, buildingId);
    const outsiderToken = await login("outsider@gen.test");
    return { buildingId, memberToken, outsiderToken, thingId };
  })();
  return scenario;
}

/**
 * Request headers for a caller in `role`. Generated code only calls this
 * with "member" / "outsider" — unauthenticated cases use JSON_HEADERS
 * directly.
 */
export function headersFor(ctx: Ctx, role: "none" | "member" | "outsider") {
  if (role === "none") return JSON_HEADERS;
  const token = role === "member" ? ctx.memberToken : ctx.outsiderToken;
  return { ...JSON_HEADERS, authorization: `Bearer ${token}` };
}

/**
 * Turn a raw path template into an absolute request URL: substitute the
 * scope param from ctx, fill every other `{param}` with a random uuid
 * (unknown ids are exactly the 404 bait), prefix the API base.
 */
export function resolvePath(ctx: Ctx, template: string): string {
  const path = template
    .replace("{buildingId}", ctx.buildingId)
    .replace(/\{\w+\}/g, () => crypto.randomUUID());
  return `${BASE}${path}`;
}

/**
 * Optional, and the only way to get a validation matrix on an ITEM path.
 *
 * `resolvePath` fills `{thingId}` with a random uuid, which names no resource — so a
 * `PUT /things/{thingId}` case that sends an invalid body reaches an unknown resource, and a
 * server that resolves the resource before reading the body answers 404. crust sees that and
 * skips those cases with a notice rather than emitting a test a correct implementation fails.
 * Export this to get them back: same job as `resolvePath`, but every non-scope `{param}` is
 * filled with an id that EXISTS — one `shared()` created.
 */
export function resolveKnownPath(ctx: Ctx, template: string): string {
  const path = template
    .replace("{buildingId}", ctx.buildingId)
    .replace(/\{\w+\}/g, () => ctx.thingId);
  return `${BASE}${path}`;
}

// ---- app-specific helpers (replace these with your API's flow) ----------

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "gen-fixtures" }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function createBuilding(token: string): Promise<string> {
  const res = await fetch(`${BASE}/api/buildings`, {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "gen-fixtures scope" }),
  });
  if (!res.ok) throw new Error(`createBuilding failed: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * One item that exists for the whole run, so `resolveKnownPath` can point an
 * item-path validation case at a resource the server will actually resolve.
 */
async function createThing(token: string, buildingId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/buildings/${buildingId}/things`, {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "gen-fixtures thing" }),
  });
  if (!res.ok) throw new Error(`createThing failed: ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}
