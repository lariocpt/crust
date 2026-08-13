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

interface Ctx {
  buildingId: string;
  memberToken: string;
  outsiderToken: string;
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
    const outsiderToken = await login("outsider@gen.test");
    return { buildingId, memberToken, outsiderToken };
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
