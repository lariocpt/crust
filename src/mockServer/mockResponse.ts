import type { MediaTypeObject, OpenApiSpec, OperationObject, ResponseObject } from "./loadSpec";
import { normaliseType, sampleFromPattern } from "./schemaTypes";

export interface PickedResponse {
  status: number;
  media: MediaTypeObject | null;
  /**
   * The content type the media was chosen FROM. pickMedia has always fallen back to the first
   * documented type when there is no application/json, but callers had no way to learn which —
   * so the response went out as application/json regardless, and crust's own --proxy validator
   * rejected it ("content-type 'application/json' is not documented for status 200") on any spec
   * documenting text/html or application/javascript.
   */
  mediaType: string | null;
}

/**
 * `spec` is optional only for backward compatibility; pass it whenever you have one, or a
 * response written as `{ $ref: "#/components/responses/Foo" }` cannot be resolved and the
 * operation silently mocks a null body.
 */
export function pickResponse(op: OperationObject, spec?: OpenApiSpec): PickedResponse {
  const responses = op.responses ?? {};
  const keys = Object.keys(responses);
  const order: string[] = ["200", "201"];
  for (const k of keys) {
    if (/^2\d\d$/.test(k) && !order.includes(k)) order.push(k);
  }
  order.push("default");
  for (const k of keys) if (!order.includes(k)) order.push(k);

  for (const k of order) {
    const r = responses[k];
    if (!r) continue;
    return { status: parseStatus(k), ...pickMedia(r, spec) };
  }
  return { status: 200, media: null, mediaType: null };
}

function parseStatus(key: string): number {
  if (key === "default") return 200;
  const n = parseInt(key, 10);
  return Number.isFinite(n) ? n : 200;
}

function pickMedia(
  res: ResponseObject,
  spec?: OpenApiSpec,
): { media: MediaTypeObject | null; mediaType: string | null } {
  // A RESPONSE may itself be a $ref into components.responses — distinct from a $ref'd schema,
  // and the common style in hand-written specs (95 of ton-console's 99 operations). Reading
  // `.content` off the unresolved node yields undefined, so the operation answered 200 with a
  // null body while its spec documented a required object.
  let node = res as ResponseObject & { $ref?: unknown };
  const seen = new Set<string>();
  while (typeof node.$ref === "string" && spec) {
    if (seen.has(node.$ref)) return { media: null, mediaType: null }; // cyclic — no hang
    seen.add(node.$ref);
    const target = resolveRef(node.$ref, spec);
    if (!target || typeof target !== "object") return { media: null, mediaType: null };
    node = target as ResponseObject & { $ref?: unknown };
  }
  const content = node.content;
  if (!content) return { media: null, mediaType: null };
  if (content["application/json"]) {
    return { media: content["application/json"]!, mediaType: "application/json" };
  }
  for (const [type, v] of Object.entries(content)) if (v) return { media: v, mediaType: type };
  return { media: null, mediaType: null };
}

export function synthesizeBody(media: MediaTypeObject | null, spec: OpenApiSpec): unknown {
  if (!media) return null;
  if ("example" in media && media.example !== undefined) return media.example;
  if (media.examples) {
    for (const ex of Object.values(media.examples)) {
      if (ex && "value" in ex) return ex.value;
    }
  }
  if (media.schema !== undefined) return generateFromSchema(media.schema, spec, new Set());
  return null;
}

function generateFromSchema(schema: unknown, spec: OpenApiSpec, visited: Set<string>): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === "string") {
    const refName = s.$ref;
    if (visited.has(refName)) return null;
    const resolved = resolveRef(refName, spec);
    if (!resolved) return null;
    const next = new Set(visited);
    next.add(refName);
    return generateFromSchema(resolved, spec, next);
  }

  if ("example" in s && s.example !== undefined) return s.example;
  // 3.1 replaced the singular `example` with an `examples` ARRAY on the schema itself (distinct
  // from the media-type `examples` map handled in synthesizeBody).
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  // JSON Schema `const` pins the only legal value; synthesising anything else is a body our own
  // validator rejects.
  if ("const" in s && s.const !== undefined) return s.const;

  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  if (Array.isArray(s.allOf)) {
    // allOf means "this, refined", and the thing being refined is not always an object: AWS's
    // specs wrap every enum as `allOf: [{$ref: '.../Status'}]`. Merging with Object.assign alone
    // DISCARDED a scalar branch and returned {} — an empty object where an enum string belongs,
    // which crust's own validator then rejected (4,538 times across 300 real-world specs).
    // So: merge the object branches when there are any, and otherwise fall back to the first
    // branch that produced a value at all. Objects still win a mixed allOf, because merging is
    // the meaningful reading there and a stray scalar branch must not displace it.
    const merged: Record<string, unknown> = {};
    let sawObject = false;
    let scalar: unknown;
    for (const branch of s.allOf) {
      const value = generateFromSchema(branch, spec, visited);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(merged, value);
        sawObject = true;
      } else if (scalar === undefined && value !== undefined && value !== null) {
        scalar = value;
      }
    }
    if (sawObject) return merged;
    return scalar !== undefined ? scalar : merged;
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    return generateFromSchema(s.oneOf[0], spec, visited);
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    return generateFromSchema(s.anyOf[0], spec, visited);
  }

  // OpenAPI 3.1 allows `type: ["string","null"]` — the form that replaced 3.0's `nullable: true`.
  // Reading it as a bare string made every union fall through to `default: return null`, which for
  // a union without "null" is a body validateRequest.ts itself rejects. Prefer the first
  // non-"null" member so a nullable field still gets representative data; a schema whose only type
  // is "null" still yields null.
  const type = pickType(s.type);
  switch (type) {
    case "string":
      return stringDefault(s);
    case "integer":
    case "number":
      return numberDefault(s, type === "integer");
    case "boolean":
      return false;
    case "array": {
      const item = generateFromSchema(s.items, spec, visited);
      return [item];
    }
    case "object":
    case undefined: {
      const props = s.properties as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object") return type === "object" ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        out[k] = generateFromSchema(v, spec, visited);
      }
      return out;
    }
    case "null":
      return null;
    default:
      return null;
  }
}

/**
 * A number inside the schema's own bounds. 0 is the friendly default, but a schema saying
 * `minimum: 1` (every paginated `page`/`size` field) made 0 a body our own validator rejects.
 * Handles both `exclusiveMinimum` spellings: 3.1's numeric bound and 3.0's boolean modifier on
 * `minimum`. Integers step by 1, plain numbers by 1 as well — the value only has to be legal,
 * not interesting.
 */
function numberDefault(s: Record<string, unknown>, isInt = true): number {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let lo = num(s.minimum);
  let hi = num(s.maximum);
  const exMin = num(s.exclusiveMinimum);
  const exMax = num(s.exclusiveMaximum);
  if (exMin !== null) lo = exMin + (isInt ? 1 : Number.EPSILON);
  else if (s.exclusiveMinimum === true && lo !== null) lo += isInt ? 1 : Number.EPSILON;
  if (exMax !== null) hi = exMax - (isInt ? 1 : Number.EPSILON);
  else if (s.exclusiveMaximum === true && hi !== null) hi -= isInt ? 1 : Number.EPSILON;
  if (lo !== null && lo > 0) return lo;
  if (hi !== null && hi < 0) return hi;
  return 0;
}

/** `normaliseType`'s single-value counterpart: the type to synthesise a value for. */
function pickType(raw: unknown): string | undefined {
  const types = normaliseType(raw);
  if (types.length === 0) return undefined;
  return types.find((t) => t !== "null") ?? "null";
}

/**
 * A string that satisfies the schema's own constraints.
 *
 * Was: the literal "string" for anything without a known format. Swept across 300 real-world
 * specs that produced 1,444 violations crust's own validator raised against crust's own mock —
 * "string" is 6 characters, so it breaks every maxLength below 6, every minLength above it, and
 * every pattern. genFixtures' validValue had always honoured these; the mock had not.
 *
 * Order matters: `format` wins (an email must look like an email), then `pattern`, then the
 * length bounds clamp whatever came out. A pattern crust cannot sample falls back to the padded
 * default rather than to something that merely looks plausible.
 */
function stringDefault(s: Record<string, unknown>): string {
  const format = s.format as string | undefined;
  const min = typeof s.minLength === "number" ? s.minLength : null;
  const max = typeof s.maxLength === "number" ? s.maxLength : null;

  let value = formatDefault(format);
  if (value === null) {
    const pattern = typeof s.pattern === "string" ? s.pattern : null;
    value = pattern ? sampleFromPattern(pattern) : "string";
  } else if (min === null && max === null) {
    return value; // a formatted value with no length bounds: leave it exactly as it was
  }

  if (max !== null && value.length > max) value = value.slice(0, Math.max(0, max));
  if (min !== null && value.length < min) value = value.padEnd(min, "x");
  return value;
}

function formatDefault(format: string | undefined): string | null {
  switch (format) {
    case "email":
      return "user@example.com";
    case "date-time":
      return "1970-01-01T00:00:00.000Z";
    case "date":
      return "1970-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
    case "byte":
      return "";
    default:
      return null;
  }
}

export function resolveRef(ref: string, spec: OpenApiSpec): unknown {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[
      decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"))
    ];
  }
  return cur ?? null;
}
