import type { MediaTypeObject, OpenApiSpec, OperationObject, ResponseObject } from "./loadSpec";
import { matchesPattern, normaliseType, sampleFromPattern } from "./schemaTypes";

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
    const resolved = resolveRef(refName, spec);
    if (visited.has(refName)) {
      // A cycle has to stop somewhere, but stopping with `null` puts a value of the WRONG TYPE in
      // the body, which crust's own validator then rejects — a self-inflicted violation on any spec
      // with a recursive model (AWS amplifyuibuilder, athena). The empty shape of the declared type
      // terminates the recursion just as firmly and is a body the validator accepts.
      //
      // But `{}` is an object that carries none of the properties its schema DEMANDS, which merely
      // traded the `type` violation for a `required` one — 4,663 of them across all 4,138 APIs-guru
      // specs. So the terminating level generates its REQUIRED properties and stops there. The
      // recursive property is nearly always optional (a slot may contain a sub-slot), so omitting
      // optional properties is what makes this both complete and finite. `depth` is what guarantees
      // the finiteness when the recursive property is itself required: one shallow level, then the
      // empty shape.
      // The marker is what makes "one shallow level" true rather than aspirational: a REQUIRED
      // property that closes the loop lands here again, sees it, and stops with the empty shape.
      if (visited.has(`${refName}#shallow`)) return emptyOfDeclaredType(resolved);
      return shallowForCycle(resolved, spec, visited, refName);
    }
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
        // An EMPTY object contributed nothing, and treating it as a contribution let it outrank a
        // sibling that had real content. AWS writes every field as
        // `allOf: [{$ref: RealThing}, {description: "..."}]`, and the description-only branch
        // synthesises `{}`; where RealThing was a LIST, the `{}` won and the array was discarded —
        // 12 self-inflicted "expected array, got object" violations in one spec.
        if (Object.keys(value).length === 0) continue;
        Object.assign(merged, value);
        sawObject = true;
      } else if (scalar === undefined && value !== undefined && value !== null) {
        scalar = value;
      }
    }
    if (sawObject) return merged;
    if (scalar !== undefined) return scalar;
    // Every branch was documentation-only or unbuildable. `{}` is right for an object and wrong for
    // anything else, so let the node's own `type` have the last word before defaulting to it.
    const declared = emptyOfDeclaredType(s);
    return declared !== null ? declared : merged;
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
      // Honour the schema's own bounds. One element was the default and remains it, but minItems
      // and maxItems are as binding here as minLength is on a string — a maxItems of 0 means the
      // empty array, and synthesising one element there is a body our own validator rejects.
      const item = generateFromSchema(s.items, spec, visited);
      const min = typeof s.minItems === "number" ? s.minItems : null;
      const max = typeof s.maxItems === "number" ? s.maxItems : null;
      let count = 1;
      if (min !== null && min > count) count = min;
      if (max !== null && max < count) count = max;
      if (count > 100) count = 100; // a mock body nobody can read helps nobody
      return Array.from({ length: Math.max(0, count) }, () => item);
    }
    case "object":
    case undefined: {
      const props = s.properties as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object") return type === "object" ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        out[k] = generateFromSchema(v, spec, visited);
      }
      // A name in `required` that `properties` never describes. Real specs do this (ton-console's
      // Participant requires `date_create` and defines no such property), and omitting it made the
      // mock fail crust's OWN validator. Nothing constrains the name, so any value satisfies it —
      // `null` is the least assuming one. The exception is `additionalProperties: false`, where the
      // schema forbids the very key it demands: nothing can satisfy that, and inventing the key
      // would break the stricter rule instead, so the spec's contradiction is left visible.
      if (Array.isArray(s.required) && s.additionalProperties !== false) {
        for (const name of s.required) {
          if (typeof name === "string" && !Object.hasOwn(out, name)) out[name] = null;
        }
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
/**
 * The value a `$ref` cycle terminates with: an object carrying the properties its schema requires,
 * and nothing else. Optional properties are dropped — that is what stops the recursion, since the
 * property that closes the loop is almost always optional. A REQUIRED property that closes the loop
 * gets the empty shape, so the nesting is finite either way.
 */
function shallowForCycle(
  resolved: unknown,
  spec: OpenApiSpec,
  visited: Set<string>,
  refName: string,
): unknown {
  const empty = emptyOfDeclaredType(resolved);
  if (!resolved || typeof resolved !== "object") return empty;
  const s = resolved as Record<string, unknown>;
  const props = s.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(s.required) ? s.required : [];
  if (!props || required.length === 0) return empty;

  const marked = new Set(visited);
  marked.add(`${refName}#shallow`);
  const out: Record<string, unknown> = {};
  for (const name of required) {
    if (typeof name !== "string") continue;
    const sub = props[name];
    if (sub === undefined) {
      out[name] = null; // required but never described — the same rule as the object case
      continue;
    }
    // `visited` still holds refName, so a required property that closes the loop lands back in the
    // cycle branch; the marker makes it terminate there with the empty shape instead of recursing.
    out[name] = generateFromSchema(sub, spec, marked);
  }
  return out;
}

/**
 * The empty value of whatever type a schema declares: `{}` for an object, `[]` for an array, and
 * `null` when nothing is declared and no honest guess exists. Used wherever crust gives up on
 * building a value — a `$ref` cycle, an `allOf` with nothing in it — because giving up is not a
 * licence to emit the wrong type. `null` where `type: object` is declared is a violation crust
 * inflicts on itself.
 */
function emptyOfDeclaredType(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  const types = normaliseType(s);
  if (types.includes("object")) return {};
  if (types.includes("array")) return [];
  // `type` is optional in JSON Schema and real specs leave it out constantly. The shape is still
  // legible from the keywords, and guessing from them beats emitting `null` into a typed slot.
  if (s.properties !== undefined || s.additionalProperties !== undefined) return {};
  if (s.items !== undefined) return [];
  return null;
}

function stringDefault(s: Record<string, unknown>): string {
  const format = s.format as string | undefined;
  const min = typeof s.minLength === "number" ? s.minLength : null;
  const max = typeof s.maxLength === "number" ? s.maxLength : null;

  const pattern = typeof s.pattern === "string" ? s.pattern : null;
  let value = formatDefault(format);
  if (value === null) {
    // Hand the sampler the length requirement so it can buy it from an open-ended quantifier,
    // rather than us padding the answer afterwards and breaking the match it just verified.
    value = pattern ? sampleFromPattern(pattern, min ?? 0) : "string";
  } else if (min === null && max === null) {
    return value; // a formatted value with no length bounds: leave it exactly as it was
  }

  // A formatted value that cannot fit maxLength means the SCHEMA contradicts itself: a uuid is 36
  // characters and cannot be 8. Truncating produced "00000000" — not a uuid — which merely traded a
  // maxLength violation for a format one while making the mock data less useful. Keep the valid
  // formatted value; it is the better wrong answer, and the one the docs already described.
  const formatted = formatDefault(format) !== null;
  // A value that already matches its pattern is one crust VERIFIED. Clamping it afterwards silently
  // unmakes that: a checked "0" padded to minLength became "0xxxxxxxxxxx", and the fallback
  // truncated to "gen" — 153 of 668 pattern violations across 300 real specs were crust breaking its
  // own work. Where the length bound and the pattern cannot both hold, the pattern is the narrower
  // statement about the field, so it wins; the length violation is then the SPEC's contradiction to
  // answer for, and --validate still reports it.
  const held = pattern !== null && matchesPattern(pattern, value);
  const clamped = ((v: string): string => {
    if (max !== null && v.length > max && !formatted) v = v.slice(0, Math.max(0, max));
    if (min !== null && v.length < min) v = v.padEnd(min, "x");
    return v;
  })(value);
  if (held && !matchesPattern(pattern, clamped)) return value;
  return clamped;
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
