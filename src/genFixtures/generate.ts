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
 * The last write of a successful generation is --out/gen-manifest.json: a
 * deterministic, timestamp-free record of every generated case with its
 * expectation PROVENANCE (the spec node that documents the status, or a
 * crust convention), plus every skip and unsupported operation. It records
 * generation only — nothing in it was executed or verified. See
 * GenManifest below.
 *
 * The emitted TypeScript takes the style of the project it lands in: the
 * nearest biome.json (walked up from --out, then from cwd) decides — indent
 * (a tab style emits tabs, a space style its width), lineWidth wrapping,
 * javascript.formatter.quoteStyle, and the natural order biome sorts
 * imported names with — biome 2.x's organizeImports assist is ON by
 * default, so only a config that switches it "off" (or disables the whole
 * assist) keeps the legacy code-point sort. No biome.json on either walk
 * keeps the historical 2-space form, byte for byte. The config walk lives in
 * indent.ts, the biome-faithful emit primitives (quotes, wrapping, natural
 * sort) in layout.ts.
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
 *   - `expectations?: { validationStatus?: number; concealment?: "404" | "403";
 *     validationEnvelope?: "crust" | "fastapi";
 *     operations?: Record<"METHOD /path", { validationStatus?: number;
 *     errorStatus?: number; validationEnvelope?: "crust" | "fastapi" }> }`
 *     — reviewed expectation overrides for backends whose contract disagrees
 *     with the 400 convention. `validationStatus` sets the validation-matrix
 *     status (global, or per operation via `operations`); `concealment`
 *     (global) / `errorStatus` (per operation) set the status of the
 *     unknown-id / outsider case family when the spec documents neither;
 *     `validationEnvelope` (global, or per operation — per operation beats
 *     global) sets the response ENVELOPE the validation-matrix data
 *     predicate asserts: `"crust"` (the default when omitted — the canonical
 *     `{ error, code: "validation", fieldErrors }` body, emitted byte for
 *     byte as before) or `"fastapi"` (a `detail` array containing an error
 *     whose `loc` equals the case's own body location, e.g. `["body",
 *     "email"]`, with nonempty string `msg` and `type`). The envelope is
 *     chosen by configuration ONLY — never inferred from a status, so a
 *     contract that answers 422 keeps the crust predicate unless told
 *     otherwise. A documented status ALWAYS wins over a configured one —
 *     configuration fills gaps, it never contradicts the contract — and
 *     configured statuses carry `configured:<module>` provenance in the
 *     manifest; the envelope carries its own provenance in the manifest's
 *     `validationOracle.source` (`"default"` for the omitted convention,
 *     `configured:<module>` for an explicit choice). Validated hard at
 *     generation time: unknown keys, statuses outside 400–599, envelope
 *     values other than `"crust"`/`"fastapi"`, or unknown operation keys
 *     refuse the generation (exit 2) rather than being ignored.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { loadSpec, type OpenApiSpec } from "../mockServer/loadSpec";
import { resolveRef, withRefSiblings } from "../mockServer/mockResponse";
import {
  formatDefault,
  inferType,
  matchesPattern,
  normaliseType,
  sampleFromPattern,
} from "../mockServer/schemaTypes";
import { validateSchema } from "../mockServer/validateRequest";
import { DEFAULT_INDENT_UNIT, type EmitStyle, reindentTwoSpace, resolveEmitStyle } from "./indent";
import {
  fits,
  formatCall,
  formatImport,
  formatJsonProperty,
  formatManifestJson,
  pad,
  quoteStringLiteral,
  sortSpecifiers,
} from "./layout";

type Schema = {
  /** 3.0 writes a string; 3.1 may write a union array (`["string","null"]`). Read via primaryType. */
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean | number;
  exclusiveMaximum?: boolean | number;
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
  /** Flow candidates that were derived and dropped (each one logged with its reason). */
  flowSkipped: number;
  /**
   * Operations whose body cases were ALL dropped because the base body cannot be made valid. A suite
   * that lost 142 cases across 41 operations is a different fact from one that lost one case, and
   * per-operation notices get filtered by harnesses — this number is the aggregate that survives.
   */
  withNoCases: number;
  /** Path of the gen-manifest.json written into --out (see GenManifest). */
  manifestPath: string;
}

// Optional per-collection-template flow tuning from the setup module: some
// creates need values a spec can't express — business date rules, foreign
// keys to live rows. `body` merges over the derived schema-valid base;
// `skip` drops the flow (e.g. a required FK no static value can satisfy).
export interface FlowOverride {
  body?: Record<string, unknown>;
  skip?: boolean;
}

// F6: reviewed expectation configuration, read from the same setup module as
// flowOverrides. A contract that answers 422 (or conceals authorization with
// 404/403) otherwise gets no matrix or no case family at all, and the honest
// alternative to hand-editing generated files is configuration a human
// reviewed. Precedence is fixed: a DOCUMENTED status always wins; per-operation
// beats global; configuration only fills where the contract is silent.
export interface ExpectationOverride {
  /** Validation-matrix status for this operation (instead of the global one). */
  validationStatus?: number;
  /** Unknown-id / outsider case status for this operation (instead of the global concealment). */
  errorStatus?: number;
  /** Validation-response envelope for this operation (instead of the global one). */
  validationEnvelope?: "crust" | "fastapi";
}

export interface ExpectationsConfig {
  /** Global validation-matrix status (e.g. 422 for a contract that never says 400). */
  validationStatus?: number;
  /** Authorization concealment for the unknown-id / outsider family. */
  concealment?: "404" | "403";
  /**
   * Global validation-response envelope. Omitted = the crust convention
   * (unchanged output); `"fastapi"` switches the validation-matrix data
   * predicate to the FastAPI detail array. Never inferred from a status.
   */
  validationEnvelope?: "crust" | "fastapi";
  /** Per-operation overrides keyed exactly `"METHOD /path"` — the manifest's operation key style. */
  operations?: Record<string, ExpectationOverride>;
}

// The validated form: statuses are integers, concealment is normalised to a
// number, and `module` is the --setup specifier as given — the target of the
// `configured:<module>` provenance, identified the same way the manifest
// identifies the spec (by the path it was passed, never by its values).
interface ExpectationOverrides {
  module: string;
  validationStatus?: number;
  concealment?: number;
  validationEnvelope?: "crust" | "fastapi";
  operations: Record<string, ExpectationOverride>;
}

/**
 * Setup-module configuration crust refuses to generate with. A bad expectation
 * config is a caller error exactly like a bad flag, so the CLI maps it to the
 * same exit 2 — and it throws BEFORE any output is written, so a refused
 * generation never touches the --out dir.
 */
export class ConfigError extends Error {}

// Statuses crust will configure: client-error responses only. 2xx/3xx would
// make a negative case assert success; 5xx is not an expectation a fixture
// can hold a server to.
function checkConfigStatus(what: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 400 || value >= 600) {
    throw new ConfigError(
      `${what} must be an integer between 400 and 599 (got ${JSON.stringify(value)}) — ` +
        "only client-error statuses can be configured",
    );
  }
  return value;
}

// The two envelopes a validation response can be asserted in. Validated at
// the same point as every other expectation field — before any output is
// written — and refused when anything else is written: the envelope is a
// deliberate choice, never a guess from a status code.
function checkConfigEnvelope(what: string, value: unknown): "crust" | "fastapi" {
  if (value !== "crust" && value !== "fastapi") {
    throw new ConfigError(
      `${what} must be "crust" or "fastapi" (got ${JSON.stringify(value)}) — ` +
        "the envelope is chosen by configuration, never inferred from a status",
    );
  }
  return value;
}

function checkConfigOverrideKeys(what: string, value: unknown, allowed: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${what} must be an object (got ${JSON.stringify(value)})`);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${what}: unknown key "${key}" — allowed keys are ${allowed.map((k) => `"${k}"`).join(", ")}`,
      );
    }
  }
}

function validateExpectations(
  raw: unknown,
  specOperations: Set<string>,
  module: string,
): ExpectationOverrides | null {
  if (raw === undefined || raw === null) return null;
  checkConfigOverrideKeys("expectations", raw, [
    "validationStatus",
    "concealment",
    "validationEnvelope",
    "operations",
  ]);
  const src = raw as ExpectationsConfig;
  const out: ExpectationOverrides = { module, operations: {} };
  if (src.validationStatus !== undefined) {
    out.validationStatus = checkConfigStatus("expectations.validationStatus", src.validationStatus);
  }
  if (src.concealment !== undefined) {
    // Accept the string spellings the config contract documents and the bare
    // numbers a user may write without quotes; anything else is refused.
    const c: unknown = src.concealment;
    const norm = c === 404 || c === "404" ? 404 : c === 403 || c === "403" ? 403 : undefined;
    if (norm === undefined) {
      throw new ConfigError(
        `expectations.concealment must be "404" or "403" (got ${JSON.stringify(src.concealment)})`,
      );
    }
    out.concealment = norm;
  }
  if (src.validationEnvelope !== undefined) {
    out.validationEnvelope = checkConfigEnvelope(
      "expectations.validationEnvelope",
      src.validationEnvelope,
    );
  }
  if (src.operations !== undefined) {
    if (
      typeof src.operations !== "object" ||
      src.operations === null ||
      Array.isArray(src.operations)
    ) {
      throw new ConfigError(
        `expectations.operations must be an object keyed "METHOD /path" (got ${JSON.stringify(src.operations)})`,
      );
    }
    for (const [key, value] of Object.entries(src.operations)) {
      if (!specOperations.has(key)) {
        throw new ConfigError(
          `expectations.operations: unknown operation "${key}" — the spec has no such ` +
            'operation. Keys are "METHOD /path" exactly as the spec writes them, ' +
            'method uppercase (e.g. "POST /api/things") — a typo here would silently ' +
            "configure nothing, so it is an error, not a warning",
        );
      }
      checkConfigOverrideKeys(`expectations.operations["${key}"]`, value, [
        "validationStatus",
        "errorStatus",
        "validationEnvelope",
      ]);
      const o: ExpectationOverride = {};
      if (value.validationStatus !== undefined) {
        o.validationStatus = checkConfigStatus(
          `expectations.operations["${key}"].validationStatus`,
          value.validationStatus,
        );
      }
      if (value.errorStatus !== undefined) {
        o.errorStatus = checkConfigStatus(
          `expectations.operations["${key}"].errorStatus`,
          value.errorStatus,
        );
      }
      if (value.validationEnvelope !== undefined) {
        o.validationEnvelope = checkConfigEnvelope(
          `expectations.operations["${key}"].validationEnvelope`,
          value.validationEnvelope,
        );
      }
      out.operations[key] = o;
    }
  }
  return out;
}

// The methods gen-fixtures derives cases for — one list so the operation keys
// the `expectations` config validates against and the keys the derivation walk
// visits can never drift apart (a drift here would refuse valid configs).
const GEN_METHODS = ["get", "post", "patch", "put", "delete"];

function specOperationKeys(spec: { paths?: Record<string, unknown> }): Set<string> {
  const keys = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method] of Object.entries(methods as Record<string, unknown>)) {
      if (!GEN_METHODS.includes(method)) continue;
      keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}

interface ScopeConfig {
  scopeParam: string | null;
  scopeRoots: string[];
  flowOverrides: Record<string, FlowOverride>;
  /** Validated `expectations` export of the setup module; null when absent. */
  expectations: ExpectationOverrides | null;
}

// ---------------------------------------------------------------------------
// Valid-value synthesis from a JSON schema (for building a base-valid body
// that single-field perturbations are applied to).
// ---------------------------------------------------------------------------

/**
 * A node and its `allOf` branches as one schema.
 *
 * `allOf` is an INTERSECTION, so every branch's constraint holds at once and the merge must reflect
 * that: `properties` and `required` are unioned, not overwritten, and where two bounds disagree the
 * STRICTER one governs — `minLength: 3` beside a branch's `minLength: 40` means 40, because a value
 * of 3 characters does not satisfy both. Overwriting instead lost whichever branch came first, which
 * is how merging naively broke object composition that already worked.
 */
function intersectAllOf(s: Schema): Schema {
  const out: Schema = { ...s };
  out.allOf = undefined;
  out.properties = { ...(s.properties ?? {}) };
  out.required = [...(s.required ?? [])];
  const stricter = (
    key: "minLength" | "minimum" | "minItems" | "maxLength" | "maximum" | "maxItems",
    branch: Schema,
    pick: (a: number, b: number) => number,
  ): void => {
    const bv = branch[key];
    if (typeof bv !== "number") return;
    const ov = out[key];
    out[key] = typeof ov === "number" ? pick(ov, bv) : bv;
  };
  for (const raw of s.allOf ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const branch = Array.isArray(raw.allOf) ? intersectAllOf(raw) : raw;
    Object.assign(out.properties, branch.properties ?? {});
    if (Array.isArray(branch.required)) out.required.push(...branch.required);
    for (const key of ["type", "format", "pattern", "enum", "items"] as const) {
      if (out[key] === undefined && branch[key] !== undefined)
        (out as Record<string, unknown>)[key] = branch[key];
    }
    stricter("minLength", branch, Math.max);
    stricter("minimum", branch, Math.max);
    stricter("minItems", branch, Math.max);
    stricter("maxLength", branch, Math.min);
    stricter("maximum", branch, Math.min);
    stricter("maxItems", branch, Math.min);
  }
  if (Object.keys(out.properties).length === 0) out.properties = undefined;
  if (out.required.length === 0) out.required = undefined;
  return out;
}

/** Whether merging the refinements changed any constraint this function actually reads. */
function sameConstraints(a: Schema, b: Schema): boolean {
  const keys = [
    "type",
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "enum",
    "items",
    "properties",
    "required",
  ] as const;
  return keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** An object's `required` list and `properties`, merged across its `allOf` chain. */
function composedObject(
  s: Schema | undefined,
  depth = 0,
): { required: string[]; properties: Record<string, Schema> } {
  const out = { required: [] as string[], properties: {} as Record<string, Schema> };
  if (!s || typeof s !== "object" || depth > 10) return out;
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const sub = composedObject(branch, depth + 1);
      out.required.push(...sub.required);
      Object.assign(out.properties, sub.properties);
    }
  }
  if (s.properties) Object.assign(out.properties, s.properties);
  if (Array.isArray(s.required))
    out.required.push(...s.required.filter((r) => typeof r === "string"));
  // A node may declare `type: "object"` and leave its properties to a UNION branch. The explicit
  // type sends generation straight to the object case, which composes through `allOf` only, so the
  // branches were never read and the body came back `{}` — whatsapp writes every media field this
  // way (`audio`, `image`, `video`, `document`), mailscript writes it on array items. The same node
  // WITHOUT a type worked, which is what kept it hidden.
  //
  // The FIRST branch is taken, the convention the combinator path and the mock both already use: a
  // union offers alternatives, not an intersection, so merging them all would invent a shape no
  // branch describes.
  //
  // The mirror shape was still broken: the node owns `properties` and each branch only says WHICH
  // of them is mandatory — urlbox's `RenderRequest` is `oneOf: [{required:[url]},
  // {required:[html]}]` over a shared `properties` block, which is how a two-form POST gets
  // written. Reading a branch only when the node owned nothing at all left this one composing to
  // `{}`: the body satisfied no branch, the validator said `anyOf`, and every negative case of the
  // operation was dropped behind a notice naming crust.
  //
  // So read a branch when the view cannot satisfy one. A branch that declares no `required` is
  // satisfied by any object — that is what keeps the whatsapp shape on the first branch instead of
  // chasing it — and a branch already satisfied by the node's own `required` is NOT read: adding
  // the OTHER alternative would make a `oneOf` match two branches and fail the very thing being
  // composed for. When nothing satisfies the union the FIRST branch is the one, same convention as
  // above; on the rare union where that branch's own requirements also satisfy a later one, the
  // base body crust builds is invalid, F33's check says so, and the notice names it.
  const branches = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
  if (branches && branches.length > 0) {
    const satisfiedBy = (b: Schema): boolean =>
      !Array.isArray(b.required) || b.required.every((r) => out.required.includes(r));
    if (Object.keys(out.properties).length === 0 || !branches.some(satisfiedBy)) {
      const sub = composedObject(branches[0], depth + 1);
      Object.assign(out.properties, sub.properties);
      out.required.push(...sub.required);
    }
  }
  // A name required both here and by a branch arrives twice. Harmless for a body (assignment is
  // idempotent), not harmless for a CASE LIST: deriveCases would emit the same case name twice.
  out.required = [...new Set(out.required)];
  return out;
}

export function validValue(s: Schema | undefined, key = ""): unknown {
  if (!s) return "x";
  // The member must satisfy the schema's OWN declared type. Real specs write
  // `{type: "string", enum: [true, false]}`, and returning enum[0] blindly emitted a boolean into a
  // string field — the same fault the mock had until it learned to read the rest of the enum. Where
  // no member fits, the first stands: the schema is unsatisfiable and inventing a value outside the
  // enum would be worse than reporting the contradiction it already has.
  if (s.enum?.length) {
    const declared = normaliseType(s.type);
    if (declared.length === 0) return s.enum[0];
    const fits = (v: unknown): boolean => {
      const actual = v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as string);
      if (declared.includes(actual)) return true;
      return actual === "number" && (declared.includes("integer") || declared.includes("number"));
    };
    const match = s.enum.find(fits);
    return match !== undefined ? match : s.enum[0];
  }
  // Only fall into combinators when the node has no type of its own —
  // zod emits e.g. { type: "string", allOf: [pattern, pattern] } where the
  // branches are refinements, not alternatives.
  // A node may carry its TYPE and leave the constraints to `allOf` refinements — the shape this
  // function's own comment describes and then never read, because a node with a type of its own
  // skips the combinator path entirely. Merge the branches' keywords under the node's own, which
  // stay authoritative: they are the more specific statement about this use.
  if (Array.isArray(s.allOf) && s.allOf.length > 0) {
    const combined = intersectAllOf(s);
    // Only when the merge actually says something new, so the combinator paths below still see
    // their allOf untouched in the cases they handle.
    if (primaryType(combined) !== undefined && !sameConstraints(combined, s)) {
      return validValue(combined, key);
    }
  }

  const t = primaryType(s);
  if (!t) {
    // An `allOf` that composes into an OBJECT is one, whether or not the node says `type`. Taking
    // just the first branch dropped every field the other branches contribute — Asana composes its
    // resources three levels deep this way, and the base body came back `{}`.
    if (s.allOf?.length) {
      const composed = composedObject(s);
      if (composed.required.length > 0 || Object.keys(composed.properties).length > 0) {
        const out: Record<string, unknown> = {};
        for (const k of composed.required) out[k] = validValue(composed.properties[k], k);
        return out;
      }
    }
    if (s.anyOf?.length) return validValue(s.anyOf[0], key);
    if (s.oneOf?.length) return validValue(s.oneOf[0], key);
    if (s.allOf?.length) return validValue(s.allOf[0], key);
  }
  switch (t) {
    case "string": {
      // The key heuristics guess from a NAME; a `pattern` is what the schema actually says, so it
      // wins. A field called `job_id` carrying `^job-[0-9]{3}$` was getting the uuid regardless —
      // 47 rows where a guess beat a statement.
      // A guess from the field NAME yields to anything the schema actually states — a `pattern`
      // (PR #44) and equally a length bound. `client_id: {type: "string", maxLength: 20}` never
      // mentions uuid, and the 36-character one does not fit: 32 rows where a name beat a number.
      // An EXPLICIT `format` is different — then the schema asked for the value itself, and a
      // maxLength too small for it is the spec contradicting itself, which crust leaves visible.
      const fits = (v: string): boolean =>
        (typeof s.maxLength !== "number" || v.length <= s.maxLength) &&
        (typeof s.minLength !== "number" || v.length >= s.minLength);
      // A guess from the NAME applies only where the schema states nothing of its own — not beside a
      // `pattern` (PR #44), not beside a length bound (PR #47), and not beside a `format`. A field
      // called `first_email_date` declaring `format: date-time` was getting the email constant.
      const named = !s.pattern && !s.format;
      if (s.format === "email" && !s.pattern) return "gen@crust.fixture";
      if (named && /email/i.test(key) && fits("gen@crust.fixture")) return "gen@crust.fixture";
      // Fixed, not random: emitted files must be byte-stable so a checked-in
      // matrix can be CI-diffed against a regeneration.
      if (s.format === "uuid" && !s.pattern) return "00000000-0000-4000-8000-00000000c0de";
      if (named && /(^|_)id$/.test(key) && fits("00000000-0000-4000-8000-00000000c0de"))
        return "00000000-0000-4000-8000-00000000c0de";
      if (s.format === "date" && !s.pattern) return "2026-08-12";
      if (s.format === "date-time" && !s.pattern) return "2026-08-12T10:00:00.000Z";
      // Anything else the mock knows how to satisfy — `uri`/`url` above all, which is 972 of the
      // 1,090 format failures across the corpus. The four constants above keep their own values so
      // existing generated matrices do not churn; this only covers formats that had NO value at all.
      if (s.format && !s.pattern) {
        const known = formatDefault(s.format);
        if (known !== null) return known;
      }
      // Both declared: the PATTERN is the narrower statement, and the mock already resolves it that
      // way. `format: email` beside a pattern whose TLD is 2-5 letters rejects "gen@crust.fixture",
      // which has seven — the constant is a fine email and the wrong one for this field.
      if (s.format && s.pattern) {
        const known = formatDefault(s.format);
        if (known !== null && matchesPattern(s.pattern, known)) return known;
      }
      const min = s.minLength ?? 1;
      const max = typeof s.maxLength === "number" ? s.maxLength : null;
      if (s.pattern) {
        // Ask the sampler for the length, rather than padding afterwards and unmaking the match it
        // verified — the same rule the mock follows.
        const sampled = sampleFromPattern(s.pattern, min);
        if (max === null || sampled.length <= max || matchesPattern(s.pattern, sampled))
          return sampled;
        return sampled.slice(0, max);
      }
      // The default is ELEVEN characters, so any smaller maxLength was violated by it. Trim first,
      // then pad, so a `{minLength: 2, maxLength: 5}` field lands inside both.
      let value = "gen-value-x";
      if (max !== null && value.length > max) value = value.slice(0, Math.max(0, max));
      if (value.length < min) value = value.padEnd(min, "x");
      return value;
    }
    case "integer":
    case "number": {
      // Both spellings: 3.0 writes `exclusiveMinimum: true` as a MODIFIER on `minimum`, 3.1 writes a
      // number of its own. Clamping to `maximum` when it is exclusive yields exactly the value the
      // schema excludes — `{maximum: 1, exclusiveMaximum: true}` was answered with 1.
      const step = primaryType(s) === "integer" ? 1 : Number.EPSILON * 8;
      let min = typeof s.minimum === "number" ? s.minimum : null;
      let max = typeof s.maximum === "number" ? s.maximum : null;
      if (s.exclusiveMinimum === true && min !== null) min += step;
      else if (typeof s.exclusiveMinimum === "number") min = s.exclusiveMinimum + step;
      if (s.exclusiveMaximum === true && max !== null) max -= step;
      else if (typeof s.exclusiveMaximum === "number") max = s.exclusiveMaximum - step;
      // 1 stays the friendly default, but a `{maximum: 0}` field was violated by it.
      let n = min !== null ? Math.max(min, 1) : 1;
      if (max !== null && n > max) n = max;
      if (min !== null && n < min) n = min;
      return n;
    }
    case "boolean":
      return true;
    case "array": {
      // Two elements is the useful default — enough to exercise a list — but `maxItems: 1` and
      // `minItems: 3` are as binding here as a length bound on a string.
      const min = typeof s.minItems === "number" ? s.minItems : null;
      const max = typeof s.maxItems === "number" ? s.maxItems : null;
      let count = 2;
      if (min !== null && min > count) count = min;
      if (max !== null && max < count) count = max;
      if (count > 100) count = 100;
      return Array.from({ length: Math.max(0, count) }, () => validValue(s.items, key));
    }
    case "object": {
      // THROUGH allOf. Real specs compose an object from branches and put `required` on the node,
      // or on a branch, or both — reading the node alone returned `{}` for the whole body, missing
      // every field the composition demands. The mock reads composed shapes for the same reason.
      const out: Record<string, unknown> = {};
      const { required: req, properties: props } = composedObject(s);
      for (const k of req) out[k] = validValue(props[k], k);
      return out;
    }
    default:
      return "x";
  }
}

function baseBody(schema: Schema): Record<string, unknown> {
  // Composed, not `schema.required` / `schema.properties`. A property can be declared by one
  // `allOf` branch and required by another — Microsoft Graph, 1Password Connect and bitbucket
  // write bodies this way — and the naive read then finds a required name with no schema beside
  // it. `validValue(undefined)` answers `"x"`, which fails the validator for a field the base body
  // never chose, and F33's drop rule correctly takes the operation's cases with it. Measured: 755
  // of 41,574 corpus operations, 65 specs. This has to be the SAME view `validValue`'s object case
  // uses and the one deriveCases lists fields from, or the base body and the cases built on it
  // disagree about what the body is.
  const { required, properties } = composedObject(schema);
  const body: Record<string, unknown> = {};
  for (const k of required) {
    body[k] = validValue(properties[k], k);
  }
  return body;
}

/**
 * Which top-level body fields the generated base body does NOT satisfy, by crust's own validator.
 *
 * The sampler declines a pattern it cannot build and returns its placeholder, which is knowingly
 * wrong for the MOCK and quietly wrong for a GENERATOR: the placeholder lands in the base body, so
 * every case built on that body is invalid in a field it does not mention. The API then 400s for
 * the placeholder, and a case asserting `fieldErrors has 'name'` either fails against a correct
 * implementation or passes for a reason that has nothing to do with its own name. `wrongTypeFor`
 * already refuses to emit a case for a value the API should accept; this is the same rule one level
 * up, on the body the cases share.
 *
 * Pointers come back as `/field` for both a constraint violation and a missing required property,
 * so an empty string here means a violation of the object itself (minProperties, dependentRequired)
 * — which blocks every case, since no case is about it.
 */
function unsoundFields(body: Record<string, unknown>, schema: unknown): Map<string, string> {
  const bad = new Map<string, string>();
  for (const v of validateSchema(body, schema, {} as OpenApiSpec, "")) {
    const field = v.pointer.replace(/^\//, "").split("/")[0];
    if (!bad.has(field)) bad.set(field, v.rule);
  }
  return bad;
}

/**
 * Why NO value satisfies this node, or null when it is merely hard for crust. The one shape that is
 * certain is an `enum` whose members all fail the node's own constraints: the enum allows only its
 * members, so if each is rejected nothing is allowed. The validator decides, so `nullable` and 3.1
 * type arrays are already accounted for. Real corpus shapes: `type: integer` + `format: int32` with
 * `enum: ["0 (StandardHDD)", …]` (visualstudio's `VMDiskType`, the enum written as YAML strings) and
 * `type: string` with `enum: [true, false]` (apptigent). Both mean the SPEC has no legal value — and
 * a notice blaming crust's value sends the reader to fix the wrong repo.
 */
function enumDeadEnd(node: Schema): string | null {
  const en = node.enum as unknown[] | undefined;
  if (!Array.isArray(en) || en.length === 0) return null;
  const verdicts = en.map((m) => validateSchema(m, node, {} as OpenApiSpec, ""));
  if (verdicts.some((v) => v.length === 0)) return null;
  const shown =
    en
      .slice(0, 3)
      .map((m) => JSON.stringify(m))
      .join(", ") + (en.length > 3 ? ", …" : "");
  const rules = [...new Set(verdicts.flat().map((v) => v.rule))].sort().join("/");
  return `enum [${shown}] fails ${rules}`;
}

/** Does this node admit `null` by its own declaration (either spec version)? */
function admitsNull(node: Schema): boolean {
  if ((node as { nullable?: unknown }).nullable === true) return true;
  const t = node.type as unknown;
  return Array.isArray(t) && t.includes("null");
}

/**
 * Walk to the point inside a schema where nothing can satisfy it, following only keywords that MUST
 * hold — a `required` property, `items` when `minItems` demands one, every `allOf` branch — so a
 * contradiction in something optional is not reported as one. A union is dead only when EVERY branch
 * is dead. Returns a pointer-style path (`/vmSpecs/diskType`) and the reason, or null meaning crust
 * could have filled it and did not. Depth-bounded: specs are user input.
 */
function specDeadEnd(node: unknown, path = "", depth = 0): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 8) return null;
  const n = node as Schema;
  const dead = enumDeadEnd(n);
  if (dead) return path ? `${path}: ${dead}` : dead;
  if (admitsNull(n)) return null;
  const union =
    (Array.isArray(n.anyOf) ? n.anyOf : null) ?? (Array.isArray(n.oneOf) ? n.oneOf : null);
  if (union) {
    return union.length > 0 && union.every((b) => specDeadEnd(b, path, depth + 1) !== null)
      ? `every branch of its ${Array.isArray(n.anyOf) ? "anyOf" : "oneOf"} is unsatisfiable`
      : null;
  }
  if (Array.isArray(n.allOf)) {
    for (const b of n.allOf) {
      const r = specDeadEnd(b, path, depth + 1);
      if (r) return r;
    }
  }
  const props = n.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const name of Array.isArray(n.required) ? (n.required as string[]) : []) {
      const r = specDeadEnd(props[name], `${path}/${name}`, depth + 1);
      if (r) return r;
    }
  }
  if (typeof n.minItems === "number" && n.minItems > 0) {
    const r = specDeadEnd(n.items, `${path}/0`, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * Split the fields an unsound body breaks into the spec's own contradiction and crust's value, so
 * each half is named by whoever is responsible. `field === ""` means the body itself: the walk starts
 * there too, and a hit along required paths proves the whole body unsatisfiable.
 */
function blameFields(
  bodySchema: Schema,
  bad: [string, string][],
): { spec: [string, string][]; crust: [string, string][] } {
  const props = composedObject(bodySchema).properties as Record<string, unknown> | undefined;
  const spec: [string, string][] = [];
  const crust: [string, string][] = [];
  for (const entry of bad) {
    const why = specDeadEnd(entry[0] === "" ? bodySchema : props?.[entry[0]]);
    (why ? spec : crust).push(why ? [entry[0], why] : entry);
  }
  return { spec, crust };
}

/**
 * One drop notice, blaming the right repo. A spec that allows no value is stated as the spec's
 * contradiction (and does not repeat crust's rule for the same field); crust's own value keeps the
 * old wording, since that is the half the reader can file against crust.
 */
function blameClause(
  spec: [string, string][],
  crust: [string, string][],
  consequence: string,
): string {
  const parts: string[] = [];
  if (spec.length > 0) {
    parts.push(
      `the SPEC contradicts itself: ${spec
        .map(([field, why]) => (field ? `'${field}' — ${why}` : why))
        .join("; ")}`,
    );
  }
  if (crust.length > 0) {
    const named = crust
      .map(([field, rule]) => (field ? `'${field}' (${rule})` : `the body (${rule})`))
      .join(", ");
    parts.push(`crust's own value for ${named} does not satisfy the schema`);
  }
  if (parts.length === 0) return `crust's own value does not satisfy the schema, ${consequence}`;
  return `${parts.join("; ")}, ${consequence}`;
}

// Minimal sampler for simple digit/dash regexes (^\d{6}$, ^\d{4,16}$,
// ^\d{4}-\d{2}-\d{2}$). Anything fancier falls back to a generic string —
// a failing case will point at the gap.

/**
 * The type to reason about for a schema node: the first non-"null" member of 3.1's array form,
 * or the plain 3.0 string. Shared reading via normaliseType so the generator, the mock and the
 * validator cannot drift apart on what a schema means.
 */
function primaryType(s: Schema | undefined): string | undefined {
  const types = normaliseType((s as { type?: unknown } | undefined)?.type);
  // `type` is optional in JSON Schema, and `{properties: {...}}` with none is extremely common.
  // Without inference, wrongTypeFor fell to its 12345 default there — a value the validator ACCEPTS,
  // since `properties` alone does not constrain a non-object — and the generated case asserted a 400
  // for a request that should return 200. Shared with the mock: one implementation, not two.
  if (types.length === 0) return inferType((s ?? {}) as Record<string, unknown>);
  return types.find((x) => x !== "null") ?? "null";
}

export function wrongTypeFor(s: Schema | undefined): unknown {
  // 3.1 may write `type: ["string","null"]`; judge on the non-null member so a nullable field
  // still gets a genuinely wrong value (null would be LEGAL there and would assert nothing).
  const t = primaryType(s);
  // Coercing fields (dates, digit patterns) happily swallow numbers, so the
  // wrong-typed value for constrained strings must be an unparseable STRING.
  if (t === "string" && (s?.format === "date" || s?.format === "date-time" || s?.pattern)) {
    return "!!not-a-valid-value!!";
  }
  switch (t) {
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

export interface GenCase {
  name: string;
  auth: "none" | "outsider" | "member";
  method: string;
  path: string; // with {params} placeholders — resolved by the setup module
  body?: Record<string, unknown>;
  expectStatus: number;
  /**
   * Where the expected status came from, recorded in gen-manifest.json (never
   * emitted into the fixture files). `contract:<spec pointer>` when the spec
   * documents that response for this operation — set at the gate that decides
   * the case exists, never re-derived in a second pass. `convention:<name>`
   * when crust assumed the status without documentation; no fixture case does
   * that today (every family is gated on a documented response or a reviewed
   * setup-module override). `configured:<module>` when the status came from
   * the setup module's `expectations` block because the spec was silent.
   */
  expectationSource: string;
  expectValidationField?: string;
  /** Assert only status + code === "validation" (no fieldErrors matcher). */
  expectValidationCode?: boolean;
  /**
   * The response envelope this case's data predicate asserts, resolved per
   * operation at derivation (per-op config beats global; omitted = the crust
   * convention). Set on every validation-matrix case. Never inferred from a
   * status: a contract that answers 422 stays crust unless configured.
   */
  validationEnvelope?: "crust" | "fastapi";
  /**
   * Where the envelope choice came from: `"default"` (the crust convention —
   * the envelope was not configured anywhere) or `configured:<setup-module
   * specifier>`. Recorded in the manifest's validationOracle, never emitted
   * into the fixture files.
   */
  validationEnvelopeSource?: string;
  /**
   * The exact body location the validation error must name — carried from
   * derivation's own knowledge of the perturbation, never parsed from the
   * case name. Drives the fastapi predicate and the manifest's
   * validationOracle.target.
   */
  validationTarget?: {
    /** The full location: `["body", <field>]` for a top-level body property. */
    loc: string[];
    /** The mutation family that produced the case. */
    kind: "missing-required" | "wrong-type" | "enum" | "bound" | "pattern" | "unexpected-property";
    /** The mutated body property ("crustUnexpectedProp" for the extra-property case). */
    field: string;
  };
  /** documented response schema for expectStatus (inline post-deref) */
  responseSchema?: unknown;
}

/**
 * An operation whose body cases were dropped because the base body is not schema-valid. Reported to
 * the caller so a shrunken suite is DISCLOSED rather than silently shipped — the same accounting a
 * skipped flow gets. Dropping is the honest half: the alternative is a case that 400s for the wrong
 * reason and passes.
 */
interface UnsoundOp {
  template: string;
  /** Field ("" = the object itself) and the schema rule crust's own value breaks. */
  fields: [string, string][];
  /**
   * The half of `fields` the SPEC cannot satisfy at all, with the contradiction. Not a subset by
   * happenstance: a field is here when NO value would have passed, so crust's value is not the defect.
   */
  specFaults: [string, string][];
  /** The complement: fields where crust's own value is what breaks the schema. */
  crustFaults: [string, string][];
  /** Cases that survived for this operation. Zero means it has no negative cases left at all. */
  kept: number;
  dropped: number;
}

/**
 * An operation that documents a request body on a method which cannot carry one (GET, HEAD).
 * Reported so the missing 400 matrix is DISCLOSED rather than silently absent: crust cannot
 * generate those cases, because no client can send the request they describe.
 */
interface BodylessOp {
  template: string;
  /** Cases that still exist for this operation. Zero means it has no negative cases at all. */
  kept: number;
}

/**
 * An operation with a JSON request body whose spec documents no 400 and whose
 * setup module configures no validation status. The validation matrix is
 * gated on the documented status (crust never assumes 400) or a reviewed
 * configured one, so the matrix is absent — recorded in the manifest's
 * `unsupported` so the silence is reviewable rather than invisible.
 */
interface NoMatrixOp {
  template: string;
}

/**
 * The operation's request body, when the method can actually carry one.
 *
 * A body on GET or HEAD is a body nobody can send: fetch refuses to build the request at all
 * (`fetch() request with GET/HEAD/OPTIONS method cannot have body.`), and Bun discards one that
 * a raw client sends anyway — measured through Bun.serve, a GET with `content-length: 13`
 * arrives and `arrayBuffer()` reads 0 bytes. Reading such a body would make crust generate a
 * case that errors before it connects, so the body is treated as absent for those methods and
 * the operation is disclosed by name instead.
 */
function canCarryBody(
  body: Operation["requestBody"],
  method: string,
): Operation["requestBody"] | undefined {
  const m = method.toLowerCase();
  if (m === "get" || m === "head") return undefined;
  return body ?? undefined;
}

function isScopeGated(path: string, firstParam: string | null, scope: ScopeConfig): boolean {
  if (firstParam === null || scope.scopeParam === null) return false;
  if (firstParam === scope.scopeParam) return true;
  // scopeRoots: the first param right after a scoped collection root is the
  // scope id regardless of its name (e.g. /api/buildings/{id}).
  return scope.scopeRoots.some((root) => path.startsWith(`${root.replace(/\/+$/, "")}/{`));
}

function deriveCases(
  path: string,
  method: string,
  op: Operation,
  scope: ScopeConfig,
  unsound: UnsoundOp[],
  bodyless: BodylessOp[],
  noMatrix: NoMatrixOp[],
): GenCase[] {
  const cases: GenCase[] = [];
  const responses = op.responses ?? {};
  const has = (code: number) => String(code) in responses;
  // Provenance pointer for this operation's documented responses — the
  // gen-manifest's `contract:` target. The path template and method are the
  // spec's own keys, so a reviewer can open the spec at exactly this node.
  const responsePointer = (code: number) =>
    `contract:paths.${path}.${method.toLowerCase()}.responses.${code}`;
  // F6: the setup module's reviewed overrides for THIS operation (per-op beats
  // global). They only ever FILL gaps — every family below still asks the spec
  // first, and a documented status wins with `contract:` provenance even when
  // a different status is configured.
  const opKey = `${method.toUpperCase()} ${path}`;
  const exp = scope.expectations;
  const opOverride = exp?.operations[opKey];
  const configuredValidation = opOverride?.validationStatus ?? exp?.validationStatus;
  const configuredError = opOverride?.errorStatus ?? exp?.concealment;
  const configuredSource = exp ? `configured:${exp.module}` : "";
  // The envelope names the response SHAPE a validation case asserts (the
  // crust canonical body vs a FastAPI detail array) — a matcher choice,
  // orthogonal to the status provenance above. Configuration only: per-op
  // beats global, omitted is the crust convention, and a status code never
  // selects it.
  const validationEnvelope = opOverride?.validationEnvelope ?? exp?.validationEnvelope ?? "crust";
  const validationEnvelopeSource =
    opOverride?.validationEnvelope !== undefined || exp?.validationEnvelope !== undefined
      ? configuredSource
      : "default";
  // Every perturbation the validation matrix can build today is one top-level
  // body property, so every locatable target is a `["body", <field>]` location
  // built here from the derivation's own knowledge of what was perturbed —
  // never re-parsed from the case name.
  const validationCaseFields = (
    field: string,
    kind: NonNullable<GenCase["validationTarget"]>["kind"],
  ): Pick<GenCase, "validationEnvelope" | "validationEnvelopeSource" | "validationTarget"> => ({
    validationEnvelope,
    validationEnvelopeSource,
    validationTarget: { loc: ["body", field], kind, field },
  });
  // Provenance for a family status: `contract:` whenever the spec documents
  // that exact status (even one the configuration also asked for), `configured:`
  // only when the spec is silent on it.
  const familySource = (status: number) =>
    has(status) ? responsePointer(status) : configuredSource;
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
  // test. Except on GET/HEAD, where no client can send one at all — see
  // `canCarryBody`. The 400 matrix below is derived from the same view, so the
  // rule is decided once, here.
  const sendableBody = canCarryBody(op.requestBody, method);
  const bodySchema = sendableBody?.content?.["application/json"]?.schema;
  const authzBody = sendableBody ? (bodySchema ? baseBody(bodySchema) : {}) : undefined;
  const bodylessOp = sendableBody === undefined && op.requestBody !== undefined;

  if (requiresAuth) {
    cases.push({
      name: `${method.toUpperCase()} ${path} without credentials -> 401`,
      auth: "none",
      method,
      path,
      body: authzBody,
      expectStatus: 401,
      expectationSource: responsePointer(401),
    });
  }

  if (scoped) {
    // Outsider family: a documented 403 wins outright; otherwise a configured
    // concealment status fills the gap (an API that answers 404 to outsiders
    // to hide existence still needs the case — the contract being silent is
    // not the same as the behavior not existing).
    const status = has(403) ? 403 : configuredError;
    if (status !== undefined) {
      cases.push({
        name: `${method.toUpperCase()} ${path} as non-member -> ${status}`,
        auth: "outsider",
        method,
        path,
        body: authzBody,
        expectStatus: status,
        expectationSource: familySource(status),
      });
    }
  }

  if (!scoped && otherParams.length > 0) {
    // Unknown-id family: same rule — documented 404 wins; a configured
    // concealment status (e.g. an API that answers 403 before revealing
    // existence) generates the case where the spec documents neither.
    const status = has(404) ? 404 : configuredError;
    if (status !== undefined) {
      cases.push({
        name: `${method.toUpperCase()} ${path} with unknown ${otherParams[0]} -> ${status}`,
        auth: requiresAuth ? "member" : "none",
        method,
        path,
        body: authzBody,
        expectStatus: status,
        expectationSource: familySource(status),
      });
    }
  }

  // Validation matrix — needs a caller who clears the auth/role gates, so
  // auth-gated ops run as "member" (the setup module's headersFor("member")
  // must resolve to a caller inside the shared scope). The gate is
  // "documented 400 OR configured validation status": a contract that answers
  // 422 gets the same matrix at 422, and a documented 400 stays 400 no matter
  // what is configured (contract beats config).
  const matrixStatus = has(400) ? 400 : configuredValidation;
  if (bodySchema && matrixStatus !== undefined) {
    const validAuth = requiresAuth ? "member" : "none";
    const matrixSource = has(400) ? responsePointer(400) : configuredSource;
    // Same composed view as baseBody, on purpose: the field list drives `missing required '<field>'`
    // cases, so a name the spec requires through an `allOf` branch would otherwise get no case at
    // all — and a property declared only in a branch would get a `wrong type` case built from
    // `undefined`.
    const { required, properties: props } = composedObject(bodySchema);
    const base = baseBody(bodySchema);

    for (const field of required) {
      const { [field]: _omitted, ...withoutField } = base;
      cases.push({
        name: `${method.toUpperCase()} ${path} missing required '${field}' -> ${matrixStatus}`,
        auth: validAuth,
        method,
        path,
        body: withoutField,
        expectStatus: matrixStatus,
        expectationSource: matrixSource,
        expectValidationField: field,
        ...validationCaseFields(field, "missing-required"),
      });
      // Only when the value is ACTUALLY rejected. A field whose schema constrains nothing —
      // `{properties: {...}}` with no `type`, a description-only node — has no wrong value, and the
      // case would assert `-> 400` for a request a correct API answers 200. That is a false test: it
      // fails against a correct implementation, and 6,101 were derivable from the corpus. crust owns
      // the validator, so it is asked rather than guessed at.
      const wrongValue = wrongTypeFor(props[field]);
      // The spec is already fully inlined by derefSchemas at entry, so there is nothing left for the
      // validator to resolve and an empty document is the honest argument.
      if (validateSchema(wrongValue, props[field], {} as OpenApiSpec, "").length > 0) {
        cases.push({
          name: `${method.toUpperCase()} ${path} wrong type for '${field}' -> ${matrixStatus}`,
          auth: validAuth,
          method,
          path,
          body: { ...base, [field]: wrongValue },
          expectStatus: matrixStatus,
          expectationSource: matrixSource,
          expectValidationField: field,
          ...validationCaseFields(field, "wrong-type"),
        });
      }
    }
    for (const [field, rawFs] of Object.entries(props)) {
      // effectiveSchema here is purely additive: it only unwraps nullable
      // combinator wrappers (which previously derived NO enum case at all).
      const fs = effectiveSchema(rawFs);
      if (fs?.enum?.length) {
        cases.push({
          name: `${method.toUpperCase()} ${path} invalid enum for '${field}' -> ${matrixStatus}`,
          auth: validAuth,
          method,
          path,
          body: { ...base, [field]: "__not_a_real_enum_value__" },
          expectStatus: matrixStatus,
          expectationSource: matrixSource,
          expectValidationField: field,
          ...validationCaseFields(field, "enum"),
        });
      }
    }

    // Boundary-violation matrix — ALL properties (required and optional), one
    // perturbation per case, fixed per-field order so regeneration is a
    // purely additive, byte-stable diff.
    for (const [field, rawFs] of Object.entries(props)) {
      const fs = effectiveSchema(rawFs);
      if (!fs) continue;
      const push = (suffix: string, wrongValue: unknown, kind: "bound" | "pattern") =>
        cases.push({
          name: `${method.toUpperCase()} ${path} ${suffix} '${field}' -> ${matrixStatus}`,
          auth: validAuth,
          method,
          path,
          body: { ...base, [field]: wrongValue },
          expectStatus: matrixStatus,
          expectationSource: matrixSource,
          expectValidationField: field,
          ...validationCaseFields(field, kind),
        });
      const ft = primaryType(fs);
      const isString = ft === "string";
      const isNumeric = ft === "integer" || ft === "number";
      if (isString && typeof fs.minLength === "number" && fs.minLength >= 1) {
        push("too short", "x".repeat(fs.minLength - 1), "bound");
      }
      // maxLength > 4096 is skipped on purpose: a 100KB literal in a
      // checked-in generated file is unreviewable.
      if (isString && typeof fs.maxLength === "number" && fs.maxLength <= 4096) {
        push("too long", "x".repeat(fs.maxLength + 1), "bound");
      }
      if (isNumeric && typeof fs.minimum === "number") {
        push("below minimum", fs.minimum - 1, "bound");
      }
      // Real specs use MAX_SAFE_INTEGER as an "unbounded" sentinel — +1 would
      // not even round-trip through JSON faithfully, so skip those.
      if (
        isNumeric &&
        typeof fs.maximum === "number" &&
        fs.maximum + 1 <= Number.MAX_SAFE_INTEGER
      ) {
        push("above maximum", fs.maximum + 1, "bound");
      }
      if (fs.pattern) {
        // For required constrained-string fields the wrong-type case already
        // sends wrongTypeFor's string sentinel — a pattern violation in
        // disguise. Dedupe to avoid an identical-in-substance case.
        const covered = required.includes(field) && wrongTypeFor(rawFs) === "!!not-a-valid-value!!";
        if (!covered) push("pattern violation", "!!pattern-violation!!", "pattern");
      }
    }

    // Op-level: one unexpected-extra-property case. Unknown-key naming in
    // fieldErrors varies by server, so this asserts status + code only.
    if (bodySchema.additionalProperties === false) {
      cases.push({
        name: `${method.toUpperCase()} ${path} unexpected extra property -> ${matrixStatus}`,
        auth: validAuth,
        method,
        path,
        body: { ...base, crustUnexpectedProp: "gen-extra" },
        expectStatus: matrixStatus,
        expectationSource: matrixSource,
        expectValidationCode: true,
        // The extra property is crust's own injection, so the fastapi envelope
        // can attribute the error to it with certainty.
        ...validationCaseFields("crustUnexpectedProp", "unexpected-property"),
      });
    }

    // Attribution. Each case above names ONE field and expects the 400 to name that field back,
    // which only holds if the rest of the body is valid. It is not when a required field's pattern
    // could not be built: the placeholder invalidates a field the case never mentions, so the case
    // passes on the wrong defect or fails against a correct API. Drop those, keep the ones about
    // the very field that is invalid (whose body's only defect IS what they assert), and report it.
    const baseBad = unsoundFields(base, bodySchema);
    if (baseBad.size > 0) {
      const kept = cases.filter((c) => {
        // Authz and unknown-param cases carry a body but assert the GATE, which answers before the
        // body is read — an unsound body cannot make those wrong.
        if (c.expectValidationField === undefined && c.expectValidationCode !== true) return true;
        const f = c.expectValidationField;
        return f !== undefined && baseBad.size === 1 && baseBad.has(f);
      });
      const dropped = cases.length - kept.length;
      if (dropped > 0) {
        cases.length = 0;
        cases.push(...kept);
        const blame = blameFields(bodySchema, [...baseBad]);
        unsound.push({
          template: `${method.toUpperCase()} ${path}`,
          fields: [...baseBad],
          specFaults: blame.spec,
          crustFaults: blame.crust,
          kept: kept.length,
          dropped,
        });
      }
    }
  } else if (bodySchema) {
    // A JSON body whose op documents no 400 AND carries no configured
    // validation status: the matrix is absent because crust never assumes the
    // status where both the contract and the reviewed configuration are
    // silent. Disclosed in the manifest rather than silently missing. (A
    // configured status takes the branch above, so it never lands here.)
    noMatrix.push({ template: `${method.toUpperCase()} ${path}` });
  }

  // Attach the documented response schema (if any) for each case's expected
  // status — the emitter turns it into the runner's reserved `schema` key.
  for (const c of cases) {
    const media = responses[String(c.expectStatus)]?.content?.["application/json"];
    if (media?.schema !== undefined) c.responseSchema = media.schema;
  }

  // Disclosed, not silently absent: the operation asked for a body crust cannot send.
  if (bodylessOp)
    bodyless.push({ template: `${method.toUpperCase()} ${path}`, kept: cases.length });

  return cases;
}

/**
 * A fastapi case whose body location cannot be attributed cannot be asserted
 * honestly: the only predicate left to write would be a permissive one ("a
 * nonempty detail at all"), and that passes the wrong field, a query or path
 * location, and a generic status-only body. Dropping the case and recording
 * it in the manifest's `unsupported` is the honest half — the matcher is
 * never weakened to make the case exist. Derivation always carries a target
 * today, so this guards the invariant for a mutation a future derivation
 * might add rather than a live path.
 */
export function dropUnattributable(cases: GenCase[]): {
  kept: GenCase[];
  dropped: { operation: string; assumption: string }[];
} {
  const kept: GenCase[] = [];
  const dropped: { operation: string; assumption: string }[] = [];
  for (const c of cases) {
    const isValidationCase =
      c.expectValidationField !== undefined || c.expectValidationCode === true;
    if (
      c.validationEnvelope === "fastapi" &&
      isValidationCase &&
      c.validationTarget === undefined
    ) {
      dropped.push({
        operation: `${c.method.toUpperCase()} ${c.path}`,
        assumption:
          `the fastapi envelope is configured, but no body location could be ` +
          `attributed to the case "${c.name}" — the case is dropped rather ` +
          "than matched permissively",
      });
      continue;
    }
    kept.push(c);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// gen-manifest.json — the generation record
//
// Generation is not execution: a generated case is a candidate expectation,
// and the reviewer needs to see WHERE each expectation came from (the spec
// node that documents it, or a crust convention) and WHAT was skipped, in the
// artifact itself rather than only in a stdout scrollback. The manifest is
// written as the LAST write of a successful generation, so a crashed run
// never leaves a manifest claiming files that do not exist. It is
// deterministic — same spec bytes + same crust version → byte-identical file:
// no timestamps, the spec is identified by a content hash instead. Prereq-
// isites are NAMES (auth, scope:member, resource:<param>) — never a value
// from the setup module, a header, or a credential.
// ---------------------------------------------------------------------------

export interface GenManifestCase {
  /** `METHOD /path/template` — the operation the case belongs to. */
  operation: string;
  /** The case name exactly as generated into the fixture file. */
  case: string;
  /** What the case mutates (or "baseline" when nothing is mutated). */
  mutation: string;
  expectStatus: number;
  /** `contract:<spec pointer>` | `convention:<name>` | `configured:<setup-module specifier>` — the STATUS provenance. */
  expectationSource: string;
  /**
   * Validation-matrix cases only: the response envelope the case's data
   * predicate asserts, where that choice came from (`"default"` = the crust
   * convention with no envelope configured; `configured:<module>` = an
   * explicit setup-module choice), and the exact location the validation
   * error must name. Deterministic — derived from spec + config, no
   * timestamps.
   */
  validationOracle?: {
    envelope: "crust" | "fastapi";
    source: string;
    target: { loc: string[]; kind: string };
  };
  prerequisites: string[];
}

export interface GenManifestSkip {
  operation: string;
  /** The same reason string stdout shows for this skip. */
  reason: string;
}

export interface GenManifestUnsupported {
  operation: string;
  /** What crust could not derive for this operation, and why. */
  assumption: string;
}

export interface GenManifest {
  crustGenManifest: 1;
  crustVersion: string;
  spec: { path: string; sha256: string };
  note: string;
  cases: GenManifestCase[];
  skipped: GenManifestSkip[];
  unsupported: GenManifestUnsupported[];
}

// The mutation phrases deriveCases writes into case names. A case name is
// `METHOD /path <mutation> -> NNN`; the manifest records the mutation without
// the operation prefix or the status suffix, so a reviewer reads what was
// perturbed, not the whole title again.
const MUTATION_MARKERS = [
  "without credentials",
  "as non-member",
  "with unknown",
  "missing required",
  "wrong type for",
  "invalid enum for",
  "too short",
  "too long",
  "below minimum",
  "above maximum",
  "pattern violation",
  "unexpected extra property",
] as const;

function mutationOf(name: string): string {
  const arrow = name.lastIndexOf(" ->");
  const body = arrow === -1 ? name : name.slice(0, arrow);
  let best = -1;
  for (const marker of MUTATION_MARKERS) {
    const i = body.indexOf(marker);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best === -1 ? "baseline" : body.slice(best);
}

// Names only — the setup module's values (tokens, ids, base URLs) never
// enter the manifest. `resource:<param>` names the path placeholder the case
// needs filled; `scope:member`/`scope:outsider` name the membership the
// caller role presumes.
function prerequisitesOf(c: GenCase): string[] {
  const pre: string[] = [];
  if (c.auth === "member") pre.push("auth", "scope:member");
  else if (c.auth === "outsider") pre.push("auth", "scope:outsider");
  for (const m of c.path.matchAll(/\{(\w+)\}/g)) {
    const name = `resource:${m[1]}`;
    if (!pre.includes(name)) pre.push(name);
  }
  return pre;
}

// The spec's own bytes, hashed — the deterministic stand-in for a timestamp.
// A path spec hashes the file exactly as given; anything loadSpec can fetch
// but readFile cannot (a URL) hashes the parsed document instead, which is
// the same content by another route.
async function specContentHash(specPath: string, rawSpec: unknown): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(specPath))
      .digest("hex");
  } catch {
    return createHash("sha256").update(JSON.stringify(rawSpec)).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * The fastapi envelope's data predicate, in canonical 2-space (reindented
 * with the rest of the file). It asserts exactly one thing: some `detail`
 * error names the case's own body location — same length, same segments —
 * with a nonempty string `msg` and a nonempty string `type`. Message text is
 * never matched; no other location shape (another field, a query or path
 * location, extra segments) passes; and the element checks run on `unknown`
 * values, so a malformed element or a non-object body fails the case instead
 * of throwing or coercing into a pass.
 */
function fastapiPredicateLines(
  target: NonNullable<GenCase["validationTarget"]>,
  style: EmitStyle,
): string[] {
  const loc = target.loc;
  const locChecks = loc.map((seg, i) => `e.loc[${i}] === ${quoteStringLiteral(seg, style)}`);
  const chain =
    `Array.isArray(e.loc) && e.loc.length === ${loc.length} && ${locChecks.join(" && ")} && ` +
    'typeof e.msg === "string" && e.msg.length > 0 && typeof e.type === "string" && e.type.length > 0';
  const lines: string[] = [
    `${pad(3)}data: (d: { detail?: unknown }) =>`,
    `${pad(4)}Array.isArray(d.detail) &&`,
    `${pad(4)}d.detail.some((e) => {`,
    `${pad(5)}if (e === null || typeof e !== "object") return false;`,
  ];
  // A block-body arrow can never sit on one line, so the outer chain breaks
  // at every width; only the inner `return (...)` can join when the receiver's
  // lineWidth is large enough for the whole chain.
  if (fits(style, 5, `return (${chain});`)) {
    lines.push(`${pad(5)}return (${chain});`);
  } else {
    lines.push(
      `${pad(5)}return (`,
      `${pad(6)}Array.isArray(e.loc) &&`,
      `${pad(6)}e.loc.length === ${loc.length} &&`,
      // Every check is followed by another operand (another location check
      // or the msg check), so EVERY line keeps a trailing `&&` — including
      // the last location check.
      ...locChecks.map((c) => `${pad(6)}${c} &&`),
      `${pad(6)}typeof e.msg === "string" &&`,
      `${pad(6)}e.msg.length > 0 &&`,
      `${pad(6)}typeof e.type === "string" &&`,
      `${pad(6)}e.type.length > 0`,
      `${pad(5)});`,
    );
  }
  lines.push(`${pad(4)}}),`);
  return lines;
}

// The fastapi branch of the validation data predicate. A fastapi case whose
// target is missing is an internal invariant violation — dropUnattributable
// runs before emission and is the sanctioned path for unattributable cases —
// so the only remaining way to reach here is a programming error, and its
// failure mode is refused loud rather than shipped as a weakened matcher.
function fastapiDataLines(c: GenCase, style: EmitStyle): string[] {
  if (c.validationTarget === undefined) {
    throw new Error(
      `gen-fixtures: internal error — fastapi case "${c.name}" has no attributed ` +
        "validation target; refusing to emit a weakened matcher",
    );
  }
  return fastapiPredicateLines(c.validationTarget, style);
}

function emitFixture(c: GenCase, used: Set<string>, style: EmitStyle): string {
  const lines: string[] = [
    "  {",
    `    name: ${quoteStringLiteral(c.name, style)},`,
    "    setup: shared,",
    "    input: (ctx: Ctx) => ({",
  ];
  lines.push(
    pad(3) +
      formatCall(style, 3, "url: ", "resolvePath", ["ctx", quoteStringLiteral(c.path, style)], ","),
  );
  lines.push(`${pad(3)}method: ${quoteStringLiteral(c.method.toUpperCase(), style)},`);
  if (c.auth === "none") {
    used.add("JSON_HEADERS");
    lines.push("      headers: JSON_HEADERS,");
  } else {
    used.add("headersFor");
    lines.push(
      pad(3) +
        formatCall(
          style,
          3,
          "headers: ",
          "headersFor",
          ["ctx", quoteStringLiteral(c.auth, style)],
          ",",
        ),
    );
  }
  if (c.body !== undefined) {
    // A string literal is never wrappable, and `body` is below biome's
    // break-after-colon key width — the line overflows and biome lets it.
    lines.push(`${pad(3)}body: ${quoteStringLiteral(JSON.stringify(c.body), style)},`);
  }
  lines.push("    }),", "    output: {", `      status: ${c.expectStatus},`);
  if (c.expectValidationField) {
    if (c.validationEnvelope === "fastapi") {
      lines.push(...fastapiDataLines(c, style));
    } else {
      // The crust envelope — byte for byte the historical shape.
      const fieldLit = quoteStringLiteral(c.expectValidationField, style);
      const header = `data: (d: { code?: string; fieldErrors?: Record<string, unknown> }) =>`;
      const chain = `d.code === "validation" && d.fieldErrors !== undefined && ${fieldLit} in d.fieldErrors`;
      if (!style.legacy && fits(style, 3, `${header} ${chain},`)) {
        lines.push(pad(3) + `${header} ${chain},`);
      } else {
        // Below the arrow (biome joins the one-liner only when it fits; the
        // legacy template always broke here — keep that shape byte for byte).
        // When even the header line does not fit, biome breaks the type
        // literal's members one per line, closing `}) =>` at the property's
        // own level.
        lines.push(
          style.legacy || fits(style, 3, header)
            ? pad(3) + header
            : `${pad(3)}data: (d: {\n${pad(4)}code?: string;\n${pad(4)}fieldErrors?: Record<string, unknown>;\n${pad(3)}}) =>`,
        );
        if (style.legacy || fits(style, 4, `${chain},`)) {
          lines.push(`${pad(4)}${chain},`);
        } else {
          // The chain does not fit on one line below the arrow: biome puts one
          // operand per line, `&&` trailing.
          lines.push(
            `${pad(4)}d.code === "validation" &&`,
            `${pad(4)}d.fieldErrors !== undefined &&`,
            `${pad(4)}${fieldLit} in d.fieldErrors,`,
          );
        }
      }
    }
  } else if (c.expectValidationCode) {
    if (c.validationEnvelope === "fastapi") {
      lines.push(...fastapiDataLines(c, style));
    } else {
      lines.push('      data: (d: { code?: string }) => d.code === "validation",');
    }
  }
  if (c.responseSchema !== undefined) {
    lines.push(
      style.legacy
        ? `${pad(3)}schema: ${JSON.stringify(c.responseSchema)},`
        : pad(3) + formatJsonProperty(style, "schema", c.responseSchema, 3),
    );
  }
  lines.push("    },", "  },");
  return lines.join("\n");
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

    // The create step posts a schema-valid body and asserts a 2xx. A body crust cannot fill — a
    // required field whose pattern it cannot build — 400s against a correct implementation on the
    // FIRST step, so the flow would fail for a reason nobody wrote. Unless the setup module supplies
    // the body (the documented escape for exactly this), skip the flow and say why.
    if (!override?.body) {
      const bad = [...unsoundFields(baseBody(bodySchema), bodySchema)].filter(
        ([field]) => field !== "",
      );
      if (bad.length > 0) {
        const blame = blameFields(bodySchema, bad);
        skipped.push({
          template,
          reason: blameClause(blame.spec, blame.crust, "so the create step would 400"),
        });
        continue;
      }
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
      // Composed (an update schema can declare its properties only inside an `allOf` branch), while
      // keeping the original rule: an update schema with nothing of its own still borrows the POST's.
      const composedUpdate = updateSchema ? composedObject(updateSchema) : null;
      const props =
        composedUpdate && Object.keys(composedUpdate.properties).length > 0
          ? composedUpdate.properties
          : composedObject(bodySchema).properties;
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

function emitFlowsSetup(flows: FlowPlan[], specifier: string, style: EmitStyle): string {
  const urlLines = flows
    .map(
      (f) =>
        pad(1) +
        formatCall(
          style,
          1,
          `process.env.GEN_URL_${f.envName} = `,
          "resolvePath",
          ["ctx", quoteStringLiteral(f.template, style)],
          ";",
        ),
    )
    .join("\n");
  const noAuthThrow = formatCall(
    style,
    2,
    "throw ",
    "new Error",
    [quoteStringLiteral("gen flows: headersFor(ctx, 'member') returned no auth header", style)],
    ";",
  );
  // The overlong tail after `.join(", ")` is template-literal text biome
  // cannot move; when the line does not fit, the only thing biome breaks is
  // the join call's own argument.
  const joinTail =
    "}) — generated flows can send only one; reduce headersFor to a single auth header`";
  const joinCall = formatCall(style, 4, "", ".join", [quoteStringLiteral(", ", style)], joinTail);
  const bigThrow = formatCall(
    style,
    2,
    "throw ",
    "new Error",
    [
      "`gen flows: headersFor(ctx, 'member') returned ${auth.length} auth headers (${auth\n" +
        `${pad(4)}.map(([k]) => k)\n${pad(4)}${joinCall}`,
    ],
    ";",
  );
  return `// GENERATED by crust gen-fixtures — DO NOT EDIT.
${formatImport(style, sortSpecifiers(["headersFor", "resolvePath", "shared"], style), specifier)}

export default async function setup(): Promise<void> {
  const ctx = await shared();
  const headers = headersFor(ctx, ${quoteStringLiteral("member", style)});
  ${formatCall(
    style,
    1,
    "const auth = ",
    "Object.entries(headers).filter",
    [`([k]) => k.toLowerCase() !== ${quoteStringLiteral("content-type", style)}`],
    ";",
  )}
  if (auth.length === 0) {
    ${noAuthThrow}
  }
  if (auth.length > 1) {
    // Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently
    // dropping the rest would make every generated request fail mysteriously.
    ${bigThrow}
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
interface DerefContext {
  /** Resolved form of each ref, reused wherever that ref appears. */
  cache: Map<string, unknown>;
  /** How many times a cycle has been cut, used to decide what may be cached. */
  cuts: number;
  /** Nodes left to build before inlining stops. */
  budget: number;
  /** Whether the budget has already been reported. */
  warned: boolean;
}

/**
 * How many nodes the inlined spec may contain.
 *
 * Sharing resolved refs takes azure's network-applicationGateway from 17.4s and 2.2 GB to 12.5s and
 * 1.2 GB, and that is still unusable: the cache serves 85% of 4.7 MILLION lookups for one file, and
 * the 15% it must refuse — resolutions that cut a cycle, and so depend on the path that reached them
 * — each rebuild a deep tree. No amount of sharing fixes a walk that large.
 *
 * So it is bounded. Past the budget a `$ref` inlines as `{}`, exactly as a cyclic one does, and
 * gen-fixtures says so. This module already accepts that trade for cycles — "missing coverage beats
 * wrong output" — and a spec that cannot be inlined in 200,000 nodes is the same situation: fewer
 * generated cases, none of them wrong.
 */
const DEREF_NODE_BUDGET = 200_000;

export function derefSchemas(
  node: unknown,
  spec: OpenApiSpec,
  stack: string[] = [],
  ctx: DerefContext = { cache: new Map(), cuts: 0, budget: DEREF_NODE_BUDGET, warned: false },
): unknown {
  if (Array.isArray(node)) return node.map((n) => derefSchemas(n, spec, stack, ctx));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string") {
    if (stack.includes(ref)) {
      ctx.cuts++;
      return {};
    }
    const target = resolveRef(ref, spec);
    if (!target || typeof target !== "object") return {};
    if (ctx.budget <= 0) {
      if (!ctx.warned) {
        ctx.warned = true;
        process.stderr.write(
          `gen-fixtures: spec too large to inline fully; \`$ref\`s past ${DEREF_NODE_BUDGET} nodes ` +
            "are cut, so fewer cases are generated — none of them wrong\n",
        );
      }
      return {};
    }
    ctx.budget--;

    // Resolve each ref ONCE and share the result. Inlining a fresh deep copy at every occurrence
    // makes the output grow with the number of PATHS through the schema graph rather than its size:
    // azure's network-applicationGateway is a DAG of a few schemas referenced from many places, and
    // a few-MB spec became a 2.03 GB structure — 8 seconds on the versions that survived, and out of
    // memory on five of the nine. `gen-fixtures` there did not run slowly, it did not run.
    //
    // A resolution that CUT a cycle is not shareable: what it produced depends on which refs were
    // already open on the path that reached it. `cuts` is how that is detected.
    let resolved = ctx.cache.get(ref) as Record<string, unknown> | undefined;
    if (resolved === undefined) {
      const before = ctx.cuts;
      resolved = derefSchemas(target, spec, [...stack, ref], ctx) as Record<string, unknown>;
      if (ctx.cuts === before) ctx.cache.set(ref, resolved);
    }

    // Siblings are applied by the SAME rule the mock's synthesiser uses, and that is the whole fix:
    // this line used to lay EVERY sibling over the resolved target, so britbox's
    // `{$ref: ItvDeleteAccountRequest, type: string}` became a string carrying `required` and
    // `properties` — a node nothing can satisfy. `baseBody` built the string, crust's own validator
    // (`validateRequest.ts`, whose `$ref` rule resolves the ref and validates the resolved node
    // alone) rejected it, and all four of that spec's JSON-body operations were dropped behind a
    // notice blaming crust's value. See `withRefSiblings` for why a structural sibling is noise and
    // a narrowing one is intent, and why dialect is not part of it.
    return withRefSiblings(obj, resolved);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = derefSchemas(v, spec, stack, ctx);
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
    // Validated here, before the --out dir is touched: a bad expectations
    // block refuses the generation (the CLI maps ConfigError to exit 2) and
    // never writes a partial tree. Operation keys are checked against the
    // spec's own operations so a typo'd key is loud, not inert.
    expectations: validateExpectations(
      (setupMod as { expectations?: unknown }).expectations,
      specOperationKeys(spec),
      opts.setup,
    ),
  };

  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const unsound: UnsoundOp[] = [];
  const bodyless: BodylessOp[] = [];
  const noMatrix: NoMatrixOp[] = [];
  const byTag = new Map<string, GenCase[]>();
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods as Record<string, Operation>)) {
      if (!GEN_METHODS.includes(method)) continue;
      const tag = op.tags?.[0] ?? "untagged";
      const arr = byTag.get(tag) ?? [];
      arr.push(...deriveCases(path, method, op, scope, unsound, bodyless, noMatrix));
      byTag.set(tag, arr);
    }
  }

  // A fastapi case whose location cannot be attributed is dropped and
  // disclosed (manifest `unsupported`) rather than matched permissively.
  // Derivation always carries a target today, so this guards the invariant
  // for mutations a future derivation might add — nothing below may ever see
  // a fastapi validation case without a target.
  const unattributable: { operation: string; assumption: string }[] = [];
  for (const [tag, cases] of byTag) {
    const { kept, dropped } = dropUnattributable(cases);
    if (dropped.length > 0) {
      log(
        `gen-fixtures: ${dropped.length} case(s) skipped — the configured fastapi envelope ` +
          "cannot be asserted for a case without an attributed body location, and the matcher " +
          "would be weakened rather than the case dropped",
      );
      unattributable.push(...dropped);
      byTag.set(tag, kept);
    }
  }

  // Cases dropped for an unfillable body are disclosed here, not left as a silently smaller suite —
  // and each field is blamed on whoever is responsible. Where the spec allows no value at all the
  // notice says the SPEC contradicts itself, because "crust's own value" points a reader at the
  // wrong repo's issue tracker.
  let withNoCases = 0;
  for (const u of unsound) {
    log(
      `gen-fixtures: ${u.dropped} case(s) skipped for ${u.template} — ${blameClause(u.specFaults, u.crustFaults, "so a 400 from that body would name the wrong field")}`,
    );
    if (u.kept === 0) withNoCases++;
  }

  // The other way an operation can be left with no negative cases: it documents a body on a
  // method no client can send one with, so its 400 matrix cannot be built at all. Same
  // accounting as an unsound body — name the operations, and count the ones left empty. A
  // silently smaller suite is the failure mode this project ranks worst.
  if (bodyless.length > 0) {
    const none = bodyless.filter((b) => b.kept === 0).length;
    log(
      `gen-fixtures: ${bodyless.length} operation(s) document a request body on GET or HEAD — crust sends no body with those methods (fetch refuses the request), so their 400 matrix is not generated${none > 0 ? `; ${none} of them now have no negative cases at all` : ""}`,
    );
    withNoCases += none;
  }

  // The emitted files must carry the style the receiving project's formatter
  // would apply, or its pre-commit hook rewrites the whole matrix on every
  // regeneration. No biome.json on either walk keeps the historical 2-space
  // form byte for byte. The notice names the indent — the dimension a reader
  // sees first — so a config resolving to the historical unit stays silent
  // even when its other dimensions (wrapping, quotes, import order) no
  // longer match the pre-style-aware form.
  const style = resolveEmitStyle(outDir, log);
  if (style.biomeJson !== null && style.unit !== DEFAULT_INDENT_UNIT) {
    log(
      `gen-fixtures: emitting with ${style.unit === "\t" ? "tab" : `${style.unit.length}-space`} indent ` +
        `(biome.json at ${style.biomeJson})`,
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const specifier = setupSpecifier(opts.setup, outDir);
  const files: string[] = [];
  const manifestCases: GenManifestCase[] = [];
  let totalCases = 0;
  for (const [tag, cases] of [...byTag.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (cases.length === 0) continue;
    totalCases += cases.length;
    for (const c of cases) {
      // Validation-matrix cases only: the oracle is deterministic metadata —
      // envelope, where it came from, and the exact location asserted. The
      // conditional spread keeps the key order fixed (expectationSource,
      // validationOracle, prerequisites) so regeneration of the same input
      // is byte-identical.
      manifestCases.push({
        operation: `${c.method.toUpperCase()} ${c.path}`,
        case: c.name,
        mutation: mutationOf(c.name),
        expectStatus: c.expectStatus,
        expectationSource: c.expectationSource,
        ...(c.validationTarget !== undefined
          ? {
              validationOracle: {
                envelope: c.validationEnvelope ?? "crust",
                source: c.validationEnvelopeSource ?? "default",
                target: { loc: c.validationTarget.loc, kind: c.validationTarget.kind },
              },
            }
          : {}),
        prerequisites: prerequisitesOf(c),
      });
    }
    const used = new Set<string>(["resolvePath", "shared"]);
    const fixtures = cases.map((c) => emitFixture(c, used, style)).join("\n");
    const file = reindentTwoSpace(
      `// GENERATED by crust gen-fixtures — DO NOT EDIT.
// Regenerate: gen-fixtures --swagger <spec> --out <dir> --setup <module>
${formatImport(style, sortSpecifiers(used, style), specifier)}

type Ctx = Awaited<ReturnType<typeof shared>>;

export default [
${fixtures}
];
`,
      style.unit,
    );
    const outFile = resolve(outDir, `${tag.replace(/[^\w.-]+/g, "-")}.gen.crust.ts`);
    await writeFile(outFile, file);
    files.push(outFile);
  }

  // CRUD flows — a .pipes file + auto-detected sibling setup, run by
  // test-pipes with zero extra flags.
  let flowFile: string | null = null;
  let flowCount = 0;
  let flowSkipped = 0;
  const flowSkips: SkippedFlow[] = [];
  if (opts.flows !== false) {
    const { flows, skipped } = deriveFlows(
      (spec.paths ?? {}) as Record<string, Record<string, Operation>>,
      scope,
    );
    for (const s of skipped) {
      log(`gen-fixtures: skipping flow for ${s.template} — ${s.reason}`);
    }
    flowSkipped = skipped.length;
    flowSkips.push(...skipped);
    if (flows.length > 0) {
      const flowsDir = resolve(outDir, "flows");
      await mkdir(flowsDir, { recursive: true });
      flowFile = resolve(flowsDir, "flows.gen.pipes");
      await writeFile(flowFile, emitFlowsPipes(flows));
      await writeFile(
        resolve(flowsDir, "flows.gen.setup.ts"),
        reindentTwoSpace(
          emitFlowsSetup(flows, setupSpecifier(opts.setup, flowsDir), style),
          style.unit,
        ),
      );
      flowCount = flows.length;
    }
  }

  // The manifest is the LAST write of a successful generation: a run that
  // crashed mid-emit leaves no manifest behind, so a gen-manifest.json in an
  // out dir always describes a complete generation. It records generation
  // only — nothing in it was executed. Skips mirror the stdout notices
  // (dropped-case blame per operation, then each skipped flow with its
  // reason verbatim); unsupported names what crust could not derive.
  const manifest: GenManifest = {
    crustGenManifest: 1,
    crustVersion: pkg.version,
    spec: { path: opts.swagger, sha256: await specContentHash(opts.swagger, rawSpec) },
    note: "Records generation only. Nothing here was executed or verified.",
    cases: manifestCases,
    skipped: [
      ...unsound.map((u) => ({
        operation: u.template,
        reason: `${u.dropped} case(s) skipped — ${blameClause(u.specFaults, u.crustFaults, "so a 400 from that body would name the wrong field")}`,
      })),
      ...flowSkips.map((s) => ({ operation: s.template, reason: s.reason })),
    ],
    unsupported: [
      ...bodyless.map((b) => ({
        operation: b.template,
        assumption:
          "the spec documents a JSON request body on a method no client can send one with " +
          "(GET/HEAD — fetch refuses the request), so the 400 matrix could not be derived",
      })),
      ...noMatrix.map((n) => ({
        operation: n.template,
        assumption:
          "the spec documents no 400 for this operation, so no validation matrix was " +
          "derived — crust does not assume 400 where the contract is silent",
      })),
      ...unattributable,
    ],
  };
  const manifestPath = resolve(outDir, "gen-manifest.json");
  // The manifest is JSON: biome's JSON layout — expand policy, indent, width
  // (top level → json.formatter) — decides its shape, so a consumer's
  // `biome format --write` is a no-op on it. The legacy 0.3.2 contract (no
  // biome.json in reach) stays plain JSON.stringify output.
  const manifestText = style.legacy
    ? JSON.stringify(manifest, null, 2)
    : formatManifestJson(style, manifest);
  await writeFile(manifestPath, `${manifestText}\n`);

  return { outDir, files, totalCases, flowFile, flowCount, flowSkipped, withNoCases, manifestPath };
}
