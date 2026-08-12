/**
 * gen-fixtures core: derive negative-case HTTP fixtures from an OpenAPI 3.x
 * spec (Swagger 2.0 is converted by loadSpec).
 *
 * For every operation the spec documents, emit fixtures for inputs the server
 * must reject:
 *   - 401 when the op documents a middleware 401 — a 401 response whose
 *     description matches /not authenticated|log in/i (public endpoints like
 *     login document 401 for bad credentials; those get no case)
 *   - 403 for scope-gated ops that document 403 (an authenticated outsider
 *     with no membership in the scope hits the role middleware)
 *   - 404 for non-scope-gated ops with path params that document 404 (an
 *     authorised caller requests a random uuid)
 *   - 400 per request-body field: required field missing, wrong JSON type,
 *     enum violation — asserting the canonical
 *     { error, code: "validation", fieldErrors } body
 *
 * Output: one `<tag>.gen.crust.ts` per OpenAPI tag in --out (the directory is
 * deleted and recreated on every run), runnable by the test-fixture runner.
 *
 * ## The setup-module contract
 *
 * Generated files are app-agnostic: they import ONLY from the --setup module
 * (the import specifier is rewritten relative to --out). That module carries
 * every app-specific detail and must export:
 *
 *   - `shared(): Promise<Ctx>` — promise-cached scenario factory (roles, ids).
 *     It is wired as every fixture's `setup`, so it MUST cache: build the
 *     scenario once on first call and return the same promise afterwards
 *     (safe under --threads). It must also be lazy — no side effects at
 *     module import time, because the generator imports the module at
 *     generation time to read `scopeParam` / `scopeRoots`.
 *   - `headersFor(ctx, role: "none" | "member" | "outsider"):
 *     Record<string, string>` — request headers for a caller in that role.
 *     "member" must clear both the auth and scope gates; "outsider" is
 *     authenticated but has no membership in the shared scope. Generated code
 *     only calls it with "member" / "outsider" — unauthenticated cases use
 *     `JSON_HEADERS` directly.
 *   - `resolvePath(ctx, template: string): string` — takes the raw path
 *     template with `{param}` placeholders, substitutes scope params from
 *     ctx, substitutes any other `{param}` with a random uuid, and prefixes
 *     the API base URL; returns the absolute request URL.
 *   - `scopeParam: string | null` — the template param name that marks a path
 *     as scope-gated (e.g. "buildingId"). An op is scope-gated when its
 *     path's FIRST template param has this name. `null` disables 403
 *     derivation entirely.
 *   - `scopeRoots?: string[]` — optional path prefixes (e.g. "/api/buildings")
 *     whose immediately following first template param is the scope id even
 *     when it has a different name (`/api/buildings/{id}`).
 *   - `JSON_HEADERS: Record<string, string>` — plain unauthenticated JSON
 *     headers, used for role "none".
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadSpec } from "../mockServer/loadSpec";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  anyOf?: Schema[];
  allOf?: Schema[];
  oneOf?: Schema[];
  default?: unknown;
};

interface Operation {
  tags?: string[];
  summary?: string;
  requestBody?: {
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, { description?: string } | undefined>;
}

export interface GenerateOpts {
  swagger: string;
  out: string;
  setup: string;
}

export interface GenerateResult {
  outDir: string;
  files: string[];
  totalCases: number;
}

interface ScopeConfig {
  scopeParam: string | null;
  scopeRoots: string[];
}

// ---------------------------------------------------------------------------
// Valid-value synthesis from a JSON schema (for building a base-valid body
// that single-field perturbations are applied to).
// ---------------------------------------------------------------------------

export function validValue(s: Schema | undefined, key = ""): unknown {
  if (!s) return "x";
  if (s.enum?.length) return s.enum[0];
  // Only fall into combinators when the node has no type of its own —
  // zod emits e.g. { type: "string", allOf: [pattern, pattern] } where the
  // branches are refinements, not alternatives.
  if (!s.type) {
    if (s.anyOf?.length) return validValue(s.anyOf[0], key);
    if (s.oneOf?.length) return validValue(s.oneOf[0], key);
    if (s.allOf?.length) return validValue(s.allOf[0], key);
  }
  switch (s.type) {
    case "string": {
      if (s.format === "email" || /email/i.test(key)) return "gen@crust.fixture";
      if (s.format === "uuid" || /(^|_)id$/.test(key)) return crypto.randomUUID();
      if (s.format === "date") return "2026-08-12";
      if (s.format === "date-time") return "2026-08-12T10:00:00.000Z";
      if (s.pattern) return sampleFromPattern(s.pattern);
      const min = s.minLength ?? 1;
      return "gen-value-x".padEnd(min, "x");
    }
    case "integer":
    case "number": {
      const min = s.minimum;
      if (typeof min === "number") return Math.max(min, 1);
      return 1;
    }
    case "boolean":
      return true;
    case "array":
      return [validValue(s.items, key), validValue(s.items, key)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = validValue(s.properties?.[k], k);
      return out;
    }
    default:
      return "x";
  }
}

function baseBody(schema: Schema): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of schema.required ?? []) {
    body[k] = validValue(schema.properties?.[k], k);
  }
  return body;
}

// Minimal sampler for simple digit/dash regexes (^\d{6}$, ^\d{4,16}$,
// ^\d{4}-\d{2}-\d{2}$). Anything fancier falls back to a generic string —
// a failing case will point at the gap.
export function sampleFromPattern(pattern: string): string {
  let out = pattern.replace(/^\^/, "").replace(/\$$/, "");
  out = out.replace(/\\d\{(\d+),\d+\}/g, (_m, n) => "1".repeat(Number(n)));
  out = out.replace(/\\d\{(\d+)\}/g, (_m, n) => "1".repeat(Number(n)));
  out = out.replace(/\\d/g, "1");
  // If regex syntax survives, we couldn't sample it — return something sane.
  return /[\\[\](){}|?*+]/.test(out) ? "gen-value-x" : out;
}

export function wrongTypeFor(s: Schema | undefined): unknown {
  // Coercing fields (dates, digit patterns) happily swallow numbers, so the
  // wrong-typed value for constrained strings must be an unparseable STRING.
  if (s?.type === "string" && (s.format === "date" || s.format === "date-time" || s.pattern)) {
    return "!!not-a-valid-value!!";
  }
  switch (s?.type) {
    case "string":
      return 12345;
    case "integer":
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-bool";
    case "array":
      return "not-an-array";
    case "object":
      return "not-an-object";
    default:
      return 12345;
  }
}

// ---------------------------------------------------------------------------
// Case derivation
// ---------------------------------------------------------------------------

interface GenCase {
  name: string;
  auth: "none" | "outsider" | "member";
  method: string;
  path: string; // with {params} placeholders — resolved by the setup module
  body?: Record<string, unknown>;
  expectStatus: number;
  expectValidationField?: string;
}

function isScopeGated(path: string, firstParam: string | null, scope: ScopeConfig): boolean {
  if (firstParam === null || scope.scopeParam === null) return false;
  if (firstParam === scope.scopeParam) return true;
  // scopeRoots: the first param right after a scoped collection root is the
  // scope id regardless of its name (e.g. /api/buildings/{id}).
  return scope.scopeRoots.some((root) => path.startsWith(`${root.replace(/\/+$/, "")}/{`));
}

function deriveCases(path: string, method: string, op: Operation, scope: ScopeConfig): GenCase[] {
  const cases: GenCase[] = [];
  const responses = op.responses ?? {};
  const has = (code: number) => String(code) in responses;
  // A documented 401 only implies "requires auth" when it's the middleware's
  // 401 — public endpoints like login document 401 for bad credentials.
  const desc401 = String(responses["401"]?.description ?? "");
  const requiresAuth = has(401) && /not authenticated|log in/i.test(desc401);
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
  const firstParam = params[0] ?? null;
  const scoped = isScopeGated(path, firstParam, scope);
  const otherParams = scoped ? params.filter((p) => p !== firstParam) : params;

  // Authz cases carry a schema-valid body: routes may validate before the
  // authz middleware, so an empty body could 400 ahead of the 401/403 under
  // test.
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  const authzBody = op.requestBody ? (bodySchema ? baseBody(bodySchema) : {}) : undefined;

  if (requiresAuth) {
    cases.push({
      name: `${method.toUpperCase()} ${path} without credentials -> 401`,
      auth: "none",
      method,
      path,
      body: authzBody,
      expectStatus: 401,
    });
  }

  if (scoped && has(403)) {
    cases.push({
      name: `${method.toUpperCase()} ${path} as non-member -> 403`,
      auth: "outsider",
      method,
      path,
      body: authzBody,
      expectStatus: 403,
    });
  }

  if (!scoped && otherParams.length > 0 && has(404)) {
    cases.push({
      name: `${method.toUpperCase()} ${path} with unknown ${otherParams[0]} -> 404`,
      auth: requiresAuth ? "member" : "none",
      method,
      path,
      body: authzBody,
      expectStatus: 404,
    });
  }

  // Validation matrix — needs a caller who clears the auth/role gates, so
  // auth-gated ops run as "member" (the setup module's headersFor("member")
  // must resolve to a caller inside the shared scope).
  if (bodySchema && has(400)) {
    const validAuth = requiresAuth ? "member" : "none";
    const required = bodySchema.required ?? [];
    const props = bodySchema.properties ?? {};
    const base = baseBody(bodySchema);

    for (const field of required) {
      const { [field]: _omitted, ...withoutField } = base;
      cases.push({
        name: `${method.toUpperCase()} ${path} missing required '${field}' -> 400`,
        auth: validAuth,
        method,
        path,
        body: withoutField,
        expectStatus: 400,
        expectValidationField: field,
      });
      cases.push({
        name: `${method.toUpperCase()} ${path} wrong type for '${field}' -> 400`,
        auth: validAuth,
        method,
        path,
        body: { ...base, [field]: wrongTypeFor(props[field]) },
        expectStatus: 400,
        expectValidationField: field,
      });
    }
    for (const [field, fs] of Object.entries(props)) {
      if (fs.enum?.length) {
        cases.push({
          name: `${method.toUpperCase()} ${path} invalid enum for '${field}' -> 400`,
          auth: validAuth,
          method,
          path,
          body: { ...base, [field]: "__not_a_real_enum_value__" },
          expectStatus: 400,
          expectValidationField: field,
        });
      }
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emitFixture(c: GenCase, used: Set<string>): string {
  let headersExpr: string;
  if (c.auth === "none") {
    used.add("JSON_HEADERS");
    headersExpr = "JSON_HEADERS";
  } else {
    used.add("headersFor");
    headersExpr = `headersFor(ctx, ${JSON.stringify(c.auth)})`;
  }
  const bodyLine =
    c.body === undefined ? "" : `\n      body: ${JSON.stringify(JSON.stringify(c.body))},`;
  const dataMatcher = c.expectValidationField
    ? `\n      data: (d: { code?: string; fieldErrors?: Record<string, unknown> }) =>\n        d.code === "validation" && d.fieldErrors !== undefined && ${JSON.stringify(c.expectValidationField)} in d.fieldErrors,`
    : "";
  return `  {
    name: ${JSON.stringify(c.name)},
    setup: shared,
    input: (ctx: Ctx) => ({
      url: resolvePath(ctx, ${JSON.stringify(c.path)}),
      method: ${JSON.stringify(c.method.toUpperCase())},
      headers: ${headersExpr},${bodyLine}
    }),
    output: {
      status: ${c.expectStatus},${dataMatcher}
    },
  },`;
}

/** Rewrite the CLI's --setup value into an import specifier valid from outDir. */
function setupSpecifier(setup: string, outDir: string): string {
  if (!isPathLike(setup)) return setup; // bare package specifier — keep as-is
  let rel = relative(outDir, resolve(setup)).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function isPathLike(setup: string): boolean {
  return setup.startsWith(".") || isAbsolute(setup) || /\.(m?[jt]s|[jt]sx)$/.test(setup);
}

export async function generateFixtures(opts: GenerateOpts): Promise<GenerateResult> {
  const { spec } = await loadSpec(opts.swagger);
  const outDir = resolve(opts.out);

  // The setup module is imported at generation time only to read the scope
  // configuration — this is why the contract requires shared() to be lazy.
  const setupMod = (await import(isPathLike(opts.setup) ? resolve(opts.setup) : opts.setup)) as {
    scopeParam?: string | null;
    scopeRoots?: string[];
  };
  if (!("scopeParam" in setupMod)) {
    throw new Error(
      `gen-fixtures: setup module ${opts.setup} must export scopeParam (string | null)`,
    );
  }
  const scope: ScopeConfig = {
    scopeParam: setupMod.scopeParam ?? null,
    scopeRoots: setupMod.scopeRoots ?? [],
  };

  const byTag = new Map<string, GenCase[]>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as Record<string, Operation>)) {
      if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
      const tag = op.tags?.[0] ?? "untagged";
      const arr = byTag.get(tag) ?? [];
      arr.push(...deriveCases(path, method, op, scope));
      byTag.set(tag, arr);
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const specifier = setupSpecifier(opts.setup, outDir);
  const files: string[] = [];
  let totalCases = 0;
  for (const [tag, cases] of [...byTag.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (cases.length === 0) continue;
    totalCases += cases.length;
    const used = new Set<string>(["resolvePath", "shared"]);
    const fixtures = cases.map((c) => emitFixture(c, used)).join("\n");
    const names = [...used].sort().join(", ");
    const file = `// GENERATED by crust gen-fixtures — DO NOT EDIT.
// Regenerate: gen-fixtures --swagger <spec> --out <dir> --setup <module>
import { ${names} } from ${JSON.stringify(specifier)};

type Ctx = Awaited<ReturnType<typeof shared>>;

export default [
${fixtures}
];
`;
    const outFile = resolve(outDir, `${tag.replace(/[^\w.-]+/g, "-")}.gen.crust.ts`);
    await writeFile(outFile, file);
    files.push(outFile);
  }

  return { outDir, files, totalCases };
}
