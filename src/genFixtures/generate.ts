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
 *   - 400 boundary violations for ALL body properties (required and
 *     optional): too short/long (minLength/maxLength), below/above
 *     (minimum/maximum), pattern violation, plus one op-level
 *     unexpected-extra-property case when additionalProperties is false
 *
 * Output: one `<tag>.gen.crust.ts` per OpenAPI tag in --out (the directory is
 * deleted and recreated on every run), runnable by the test-fixture runner.
 * Unless --no-flows, qualifying collection paths (POST + item path) also get
 * a generated CRUD flow suite: --out/flows/flows.gen.pipes + its sibling
 * flows.gen.setup.ts, runnable by test-pipes with zero extra flags.
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
 *   - `flowOverrides?: Record<template, { body?: object; skip?: boolean }>`
 *     — optional per-collection flow tuning: `body` merges over the derived
 *     schema-valid create body (business date rules etc.); `skip` drops the
 *     flow (e.g. a required FK no static value can satisfy). Read at
 *     generation time.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadSpec, type OpenApiSpec } from "../mockServer/loadSpec";
import { resolveRef } from "../mockServer/mockResponse";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  oneOf?: Schema[];
  default?: unknown;
};

interface ResponseMedia {
  schema?: Schema;
  example?: unknown;
}

interface Operation {
  tags?: string[];
  summary?: string;
  requestBody?: {
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, ResponseMedia> } | undefined
  >;
}

export interface GenerateOpts {
  swagger: string;
  out: string;
  setup: string;
  /** Emit CRUD flow .pipes files (default true; the CLI's --no-flows sets false). */
  flows?: boolean;
  /** Notice sink for skipped flows (default: process.stdout). */
  log?: (line: string) => void;
}

export interface GenerateResult {
  outDir: string;
  files: string[];
  totalCases: number;
  flowFile: string | null;
  flowCount: number;
}

// Optional per-collection-template flow tuning from the setup module: some
// creates need values a spec can't express — business date rules, foreign
// keys to live rows. `body` merges over the derived schema-valid base;
// `skip` drops the flow (e.g. a required FK no static value can satisfy).
export interface FlowOverride {
  body?: Record<string, unknown>;
  skip?: boolean;
}

interface ScopeConfig {
  scopeParam: string | null;
  scopeRoots: string[];
  flowOverrides: Record<string, FlowOverride>;
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
      // Fixed, not random: emitted files must be byte-stable so a checked-in
      // matrix can be CI-diffed against a regeneration.
      if (s.format === "uuid" || /(^|_)id$/.test(key))
        return "00000000-0000-4000-8000-00000000c0de";
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

// zod emits nullable fields as `anyOf: [X, { type: "null" }]` — a property
// node with no own type (and no own enum) but combinator branches unwraps to
// the first non-null branch, so constraint inspection sees the real schema.
// Without this the boundary matrix would miss every nullable field.
export function effectiveSchema(s: Schema | undefined): Schema | undefined {
  if (!s || s.type || s.enum) return s;
  const branches = s.anyOf ?? s.oneOf;
  if (!branches?.length) return s;
  return branches.find((b) => b.type !== "null") ?? s;
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
  /** Assert only status + code === "validation" (no fieldErrors matcher). */
  expectValidationCode?: boolean;
  /** documented response schema for expectStatus (inline post-deref) */
  responseSchema?: unknown;
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
    for (const [field, rawFs] of Object.entries(props)) {
      // effectiveSchema here is purely additive: it only unwraps nullable
      // combinator wrappers (which previously derived NO enum case at all).
      const fs = effectiveSchema(rawFs);
      if (fs?.enum?.length) {
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

    // Boundary-violation matrix — ALL properties (required and optional), one
    // perturbation per case, fixed per-field order so regeneration is a
    // purely additive, byte-stable diff.
    for (const [field, rawFs] of Object.entries(props)) {
      const fs = effectiveSchema(rawFs);
      if (!fs) continue;
      const push = (suffix: string, wrongValue: unknown) =>
        cases.push({
          name: `${method.toUpperCase()} ${path} ${suffix} '${field}' -> 400`,
          auth: validAuth,
          method,
          path,
          body: { ...base, [field]: wrongValue },
          expectStatus: 400,
          expectValidationField: field,
        });
      const isString = fs.type === "string";
      const isNumeric = fs.type === "integer" || fs.type === "number";
      if (isString && typeof fs.minLength === "number" && fs.minLength >= 1) {
        push("too short", "x".repeat(fs.minLength - 1));
      }
      // maxLength > 4096 is skipped on purpose: a 100KB literal in a
      // checked-in generated file is unreviewable.
      if (isString && typeof fs.maxLength === "number" && fs.maxLength <= 4096) {
        push("too long", "x".repeat(fs.maxLength + 1));
      }
      if (isNumeric && typeof fs.minimum === "number") {
        push("below minimum", fs.minimum - 1);
      }
      // Real specs use MAX_SAFE_INTEGER as an "unbounded" sentinel — +1 would
      // not even round-trip through JSON faithfully, so skip those.
      if (
        isNumeric &&
        typeof fs.maximum === "number" &&
        fs.maximum + 1 <= Number.MAX_SAFE_INTEGER
      ) {
        push("above maximum", fs.maximum + 1);
      }
      if (fs.pattern) {
        // For required constrained-string fields the wrong-type case already
        // sends wrongTypeFor's string sentinel — a pattern violation in
        // disguise. Dedupe to avoid an identical-in-substance case.
        const covered = required.includes(field) && wrongTypeFor(rawFs) === "!!not-a-valid-value!!";
        if (!covered) push("pattern violation", "!!pattern-violation!!");
      }
    }

    // Op-level: one unexpected-extra-property case. Unknown-key naming in
    // fieldErrors varies by server, so this asserts status + code only.
    if (bodySchema.additionalProperties === false) {
      cases.push({
        name: `${method.toUpperCase()} ${path} unexpected extra property -> 400`,
        auth: validAuth,
        method,
        path,
        body: { ...base, crustUnexpectedProp: "gen-extra" },
        expectStatus: 400,
        expectValidationCode: true,
      });
    }
  }

  // Attach the documented response schema (if any) for each case's expected
  // status — the emitter turns it into the runner's reserved `schema` key.
  for (const c of cases) {
    const media = responses[String(c.expectStatus)]?.content?.["application/json"];
    if (media?.schema !== undefined) c.responseSchema = media.schema;
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
    : c.expectValidationCode
      ? `\n      data: (d: { code?: string }) => d.code === "validation",`
      : "";
  // `schema` is the runner's reserved response-conformance key — emitted only
  // when the spec documents a schema for the expected status (post-deref, so
  // it's inline JSON; example-only specs emit nothing here).
  const schemaLine =
    c.responseSchema === undefined ? "" : `\n      schema: ${JSON.stringify(c.responseSchema)},`;
  return `  {
    name: ${JSON.stringify(c.name)},
    setup: shared,
    input: (ctx: Ctx) => ({
      url: resolvePath(ctx, ${JSON.stringify(c.path)}),
      method: ${JSON.stringify(c.method.toUpperCase())},
      headers: ${headersExpr},${bodyLine}
    }),
    output: {
      status: ${c.expectStatus},${dataMatcher}${schemaLine}
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

// ---------------------------------------------------------------------------
// CRUD flows — emitted as a .pipes file (test-pipes runs it; the sibling
// flows.gen.setup.ts is auto-detected and seeds $GEN_AUTH_HEADER/$GEN_URL_*).
// ---------------------------------------------------------------------------

/** Lowest documented 2xx status of an op, or null when it documents none. */
function lowest2xx(op: Operation): number | null {
  const codes = Object.keys(op.responses ?? {})
    .filter((k) => /^2\d\d$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
  return codes[0] ?? null;
}

/**
 * `/api/things/{thingId}` -> `API_THINGS`: drop {params}, non-alphanumeric
 * runs -> one `_`, trim, uppercase. Residual collisions get `_2`, `_3`, …
 * suffixes (assigned over templates in sorted order, so names are stable).
 */
export function envNameFor(template: string): string {
  return template
    .replace(/\{[^}]*\}/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Where the created id lives in the POST's 2xx response body. Prefers the
 * 2xx media `example`, else `schema.properties`. Top-level `id` -> ["id"];
 * else the FIRST object-valued property containing an `id` (JSON key order —
 * deterministic) -> [prop, "id"]. Depth cap 2. Null -> flow is skipped.
 */
export function idPathFor(op: Operation): string[] | null {
  const code = lowest2xx(op);
  if (code === null) return null;
  const media = op.responses?.[String(code)]?.content?.["application/json"];
  if (!media) return null;
  if (isPlainRecord(media.example)) {
    if ("id" in media.example) return ["id"];
    for (const [k, v] of Object.entries(media.example)) {
      if (isPlainRecord(v) && "id" in v) return [k, "id"];
    }
    return null;
  }
  const props = media.schema?.properties;
  if (!props) return null;
  if ("id" in props) return ["id"];
  for (const [k, v] of Object.entries(props)) {
    const eff = effectiveSchema(v);
    if (eff?.properties && "id" in eff.properties) return [k, "id"];
  }
  return null;
}

interface ItemOps {
  get?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
}

interface FlowPlan {
  template: string; // collection path template
  post: Operation;
  itemOps: ItemOps;
  idPath: string[];
  envName: string;
  bodyOverride?: Record<string, unknown>;
}

interface SkippedFlow {
  template: string;
  reason: string;
}

function deriveFlows(
  paths: Record<string, Record<string, Operation>>,
  scope: ScopeConfig,
): { flows: FlowPlan[]; skipped: SkippedFlow[] } {
  const flows: FlowPlan[] = [];
  const skipped: SkippedFlow[] = [];
  const templates = Object.keys(paths);

  for (const template of templates) {
    const post = paths[template]?.post;
    const bodySchema = post?.requestBody?.content?.["application/json"]?.schema;
    if (!post || !bodySchema || lowest2xx(post) === null) continue;
    const override = scope.flowOverrides[template];
    if (override?.skip) {
      skipped.push({ template, reason: "flowOverrides.skip in the setup module" });
      continue;
    }

    // Item template: `<template>/{param}` with at least one of GET/PUT/PATCH/
    // DELETE. First match in JSON key order — deterministic.
    let itemOps: ItemOps | null = null;
    for (const k of templates) {
      if (!k.startsWith(template) || !/^\/\{[^/}]+\}$/.test(k.slice(template.length))) continue;
      const m = paths[k]!;
      const ops: ItemOps = { get: m.get, put: m.put, patch: m.patch, delete: m.delete };
      if (ops.get || ops.put || ops.patch || ops.delete) {
        itemOps = ops;
        break;
      }
    }
    if (!itemOps) continue;

    // Only the scope param may appear in the collection template — a nested
    // collection's parent id is not derivable from the spec alone.
    const params = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    const scoped = params.length > 0 && isScopeGated(template, params[0]!, scope);
    const extraParams = scoped ? params.slice(1) : params;
    if (extraParams.length > 0) {
      skipped.push({ template, reason: `nested path params {${extraParams.join("}, {")}}` });
      continue;
    }

    const idPath = idPathFor(post);
    if (!idPath) {
      skipped.push({ template, reason: "no id derivable from the POST 2xx response" });
      continue;
    }

    flows.push({ template, post, itemOps, idPath, envName: "", bodyOverride: override?.body });
  }

  flows.sort((a, b) => (a.template < b.template ? -1 : 1));
  const used = new Map<string, number>();
  for (const f of flows) {
    const base = envNameFor(f.template) || "ROOT";
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    f.envName = n === 1 ? base : `${base}_${n}`;
  }
  return { flows, skipped };
}

// `b`, ["billing", "id"] -> `b.billing.id` (bracket form for non-identifier keys).
function accessExpr(root: string, path: string[]): string {
  let out = root;
  for (const key of path) {
    out += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return out;
}

function emitFlow(f: FlowPlan): string {
  const T = f.envName;
  const url = `$GEN_URL_${T}`;
  const itemUrl = `$GEN_URL_${T}/$GEN_ID_${T}`;
  const H = `-H "$GEN_AUTH_HEADER"`;
  const bodySchema = f.post.requestBody!.content!["application/json"]!.schema!;
  const base = { ...baseBody(bodySchema), ...f.bodyOverride };
  const lines: string[] = [];
  const steps: string[] = ["create"];

  const postStatus = lowest2xx(f.post)!;
  lines.push(
    `${JSON.stringify(base)} | POST ${url} ${H} | assert (r => r.status === ${postStatus}) | (r => r.json()) | capture GEN_ID_${T} (b => ${accessExpr("b", f.idPath)})`,
  );

  if (f.itemOps.get) {
    steps.push("read");
    const s = lowest2xx(f.itemOps.get) ?? 200;
    lines.push(
      `GET ${itemUrl} ${H} | assert (r => r.status === ${s}) | (r => r.json()) | assert (j => JSON.stringify(j).includes(process.env.GEN_ID_${T} ?? " "))`,
    );
  }

  const update = f.itemOps.patch ?? f.itemOps.put;
  if (update) {
    steps.push("update");
    const verb = f.itemOps.patch ? "PATCH" : "PUT";
    const s = lowest2xx(update) ?? 200;
    const updateSchema = update.requestBody?.content?.["application/json"]?.schema;
    let body: Record<string, unknown>;
    if (verb === "PATCH") {
      // PATCH is a partial update — a single perturbed field is the point.
      // First schema property with a valid value (the update op's own schema
      // when it has one, else the POST's).
      const props = updateSchema?.properties ?? bodySchema.properties ?? {};
      const firstKey = Object.keys(props)[0];
      body = firstKey ? { [firstKey]: validValue(props[firstKey], firstKey) } : {};
    } else {
      // PUT is full-replace: a single-field body 400s on any op with other
      // required fields — send a full schema-valid body from the update op's
      // own request schema (falling back to the POST's).
      body = baseBody(updateSchema ?? bodySchema);
    }
    lines.push(`${JSON.stringify(body)} | ${verb} ${itemUrl} ${H} | expect ${s}`);
  }

  if (f.itemOps.delete) {
    steps.push("delete");
    const s = lowest2xx(f.itemOps.delete) ?? 204;
    // {} is the upstream trigger item, not a meaningful body.
    lines.push(`{} | DELETE ${itemUrl} ${H} | expect ${s}`);
  }

  // Tombstone read: only meaningful after a DELETE, and only when the GET
  // actually documents 404.
  if (f.itemOps.delete && f.itemOps.get && "404" in (f.itemOps.get.responses ?? {})) {
    steps.push("read-after-delete");
    lines.push(`GET ${itemUrl} ${H} | expect 404`);
  }

  return `# flow: ${f.template}  (${steps.join(" -> ")})\n${lines.join("\n")}\n`;
}

function emitFlowsPipes(flows: FlowPlan[]): string {
  return `# GENERATED by crust gen-fixtures — DO NOT EDIT.
# CRUD flows derived from the OpenAPI spec; run with test-pipes (the sibling
# flows.gen.setup.ts is auto-detected and seeds $GEN_AUTH_HEADER/$GEN_URL_*;
# capture stages write $GEN_ID_* at run time).
# NOTE: SQL assertions are not derivable from a spec, so none are emitted —
# add DB-level checks in a hand-written .pipes file if you need them.

${flows.map(emitFlow).join("\n")}`;
}

function emitFlowsSetup(flows: FlowPlan[], specifier: string): string {
  const urlLines = flows
    .map(
      (f) =>
        `  process.env.GEN_URL_${f.envName} = resolvePath(ctx, ${JSON.stringify(f.template)});`,
    )
    .join("\n");
  return `// GENERATED by crust gen-fixtures — DO NOT EDIT.
import { headersFor, resolvePath, shared } from ${JSON.stringify(specifier)};

export default async function setup(): Promise<void> {
  const ctx = await shared();
  const headers = headersFor(ctx, "member");
  const auth = Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type");
  if (auth.length === 0) {
    throw new Error("gen flows: headersFor(ctx, 'member') returned no auth header");
  }
  if (auth.length > 1) {
    // Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently
    // dropping the rest would make every generated request fail mysteriously.
    throw new Error(
      \`gen flows: headersFor(ctx, 'member') returned \${auth.length} auth headers (\${auth
        .map(([k]) => k)
        .join(", ")}) — generated flows can send only one; reduce headersFor to a single auth header\`,
    );
  }
  process.env.GEN_AUTH_HEADER = \`\${auth[0]![0]}: \${auth[0]![1]}\`;
${urlLines}
}
`;
}

// Deep-inline every $ref before derivation: most real-world specs put their
// request/response schemas behind components refs, and every consumer below
// (baseBody, boundary matrix, idPathFor) reads properties structurally. A
// cyclic ref is cut to {} — a cyclic request body can't be instantiated as a
// finite valid example anyway, and missing coverage beats wrong output.
// OpenAPI 3.1 $ref siblings are merged over the resolved target.
export function derefSchemas(node: unknown, spec: OpenApiSpec, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => derefSchemas(n, spec, stack));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) return {};
    const target = resolveRef(ref, spec);
    if (!target || typeof target !== "object") return {};
    const { $ref: _drop, ...siblings } = obj;
    const resolved = derefSchemas(target, spec, [...stack, ref]) as Record<string, unknown>;
    return { ...resolved, ...(derefSchemas(siblings, spec, stack) as Record<string, unknown>) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = derefSchemas(v, spec, stack);
  return out;
}

export async function generateFixtures(opts: GenerateOpts): Promise<GenerateResult> {
  const { spec: rawSpec } = await loadSpec(opts.swagger);
  const spec = derefSchemas(rawSpec, rawSpec as OpenApiSpec) as typeof rawSpec;
  const outDir = resolve(opts.out);

  // The setup module is imported at generation time only to read the scope
  // configuration — this is why the contract requires shared() to be lazy.
  const setupMod = (await import(isPathLike(opts.setup) ? resolve(opts.setup) : opts.setup)) as {
    scopeParam?: string | null;
    scopeRoots?: string[];
  };
  if (!("scopeParam" in setupMod)) {
    throw new Error(
      `gen-fixtures: setup module ${opts.setup} must export scopeParam. It names ` +
        "the path param that marks a resource as belonging to a scope, and " +
        "decides whether 403 cases are generated at all — so it is deliberate, " +
        "not defaulted. If this API has no scoped resources, export it as null: " +
        "`export const scopeParam = null;`",
    );
  }
  const scope: ScopeConfig = {
    scopeParam: setupMod.scopeParam ?? null,
    scopeRoots: setupMod.scopeRoots ?? [],
    flowOverrides:
      (setupMod as { flowOverrides?: Record<string, FlowOverride> }).flowOverrides ?? {},
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

  // CRUD flows — a .pipes file + auto-detected sibling setup, run by
  // test-pipes with zero extra flags.
  let flowFile: string | null = null;
  let flowCount = 0;
  if (opts.flows !== false) {
    const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
    const { flows, skipped } = deriveFlows(
      (spec.paths ?? {}) as Record<string, Record<string, Operation>>,
      scope,
    );
    for (const s of skipped) {
      log(`gen-fixtures: skipping flow for ${s.template} — ${s.reason}`);
    }
    if (flows.length > 0) {
      const flowsDir = resolve(outDir, "flows");
      await mkdir(flowsDir, { recursive: true });
      flowFile = resolve(flowsDir, "flows.gen.pipes");
      await writeFile(flowFile, emitFlowsPipes(flows));
      await writeFile(
        resolve(flowsDir, "flows.gen.setup.ts"),
        emitFlowsSetup(flows, setupSpecifier(opts.setup, flowsDir)),
      );
      flowCount = flows.length;
    }
  }

  return { outDir, files, totalCases, flowFile, flowCount };
}
