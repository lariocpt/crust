// Strict schema proof for the generator's own soundness decisions.
//
// The mock's validator (`../mockServer/validateRequest`) is deliberately permissive, and right to
// be: a schema it cannot judge validates successfully, because inventing a 422 for a keyword it does
// not implement would break real traffic. Its own header lists the keywords that always pass —
// `not`, `patternProperties`, `uniqueItems`, `multipleOf`, `discriminator`, `dependentSchemas`,
// `propertyNames`, `contains`, `prefixItems` — plus `oneOf`'s exactly-one, and it enforces
// `additionalProperties: false` only under `opts.strict`.
//
// That permissive contract is the WRONG one to read during generation, where "no violations" gets
// interpreted as "this request is valid" to decide whether a negative case is worth emitting. A
// permissive pass read as validity is exactly how a fixture comes to assert `-> 400` for a request
// a conformant server answers 200 — a false test, which is the one thing crust's design forbids.
//
// So this module is the fail-closed half, and it answers with THREE values, not two:
//
//   violations.length > 0   the value is PROVEN to violate the schema
//   clean and !incomplete   the value is PROVEN to satisfy it
//   clean and incomplete    crust cannot tell, and must not claim either
//
// The third answer is the point. `validateSchema` collapses it into the second, and that collapse
// is what let an "invalid enum" case be emitted for an enum that contained the sentinel, a "below
// minimum" case for `minimum: 1e20` where `minimum - 1` rounds back to the minimum, and an
// "unexpected property" case for a property the schema declares.
//
// It reuses `validateSchema` for the keywords that validator judges strictly — a violation it
// reports is always real, it never invents one — but owns traversal so boolean subschemas and
// the prefixItems/items boundary are judged consistently at every position.

import type { OpenApiSpec } from "../mockServer/loadSpec";
import { isMultipleOf } from "../mockServer/schemaNumbers";
import { validateSchema } from "../mockServer/validateRequest";

export interface ProofViolation {
  /** JSON pointer into the value ("/items/0/name"); "" is the value itself. */
  pointer: string;
  rule: string;
}

export interface Proof {
  violations: ProofViolation[];
  /** Something could not be judged, so an empty `violations` proves nothing about validity. */
  incomplete: boolean;
  /** First reason for `incomplete`, for the manifest. */
  note?: string;
}

/** Formats the mock validator matches. Any other `format` is a judgement crust cannot make. */
const KNOWN_FORMATS = new Set(["uuid", "email", "date", "date-time", "uri"]);

/** Keywords this module plus `validateSchema` judge between them. Anything else ⇒ incomplete. */
const JUDGED = new Set([
  "type",
  "nullable",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "items",
  "prefixItems",
  "contains",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "minProperties",
  "maxProperties",
  "format",
]);

/** Pure annotations: carrying no constraint, so they never make a proof incomplete. */
const ANNOTATION = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "xml",
  "externalDocs",
  "contentEncoding",
  "contentMediaType",
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
]);

/** Depth bound: specs are user input, and a recursive `$ref`-free cycle is still possible. */
const MAX_DEPTH = 12;

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality, used to tell whether an update actually changed anything. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function mark(out: Proof, note: string): void {
  out.incomplete = true;
  if (!out.note) out.note = note;
}

function push(out: Proof, pointer: string, rule: string): void {
  out.violations.push({ pointer, rule });
}

/**
 * Does `value` satisfy `schema`, judged on its own so a combinator branch can be counted?
 * `unknown` means the branch carries something crust cannot judge — which must never be read as
 * either a match or a mismatch.
 */
function verdict(value: unknown, schema: unknown, depth: number): "yes" | "no" | "unknown" {
  const inner: Proof = { violations: [], incomplete: false };
  if (schema === false) return "no";
  if (schema === true || schema === undefined) return "yes";
  if (!isObj(schema)) return "unknown";
  walk(inner, value, schema, "", depth + 1);
  if (inner.violations.length > 0) return "no";
  return inner.incomplete ? "unknown" : "yes";
}

/** Judge each node and descend with pointers into the original value. */
function walk(out: Proof, value: unknown, schema: unknown, pointer: string, depth: number): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    push(out, pointer, "false");
    return;
  }
  if (!isObj(schema)) {
    mark(out, "a schema node that is neither an object nor a boolean");
    return;
  }
  if (depth > MAX_DEPTH) {
    mark(out, `schema nesting beyond depth ${MAX_DEPTH}`);
    return;
  }
  if ("$ref" in schema) {
    mark(out, "an un-inlined $ref cannot be judged here");
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!JUDGED.has(key) && !ANNOTATION.has(key)) {
      mark(out, `the keyword '${key}' is not judged by the proof layer`);
    }
  }

  // The mock does not know prefixItems and would apply items to the prefix too. Keep its
  // node-local checks, but let this walk own ALL descent (including properties/combinators),
  // otherwise nested arrays and branch verdicts would still inherit that false rejection.
  const local = {
    ...schema,
    items: undefined,
    properties: undefined,
    allOf: undefined,
    anyOf: undefined,
    oneOf: undefined,
  };
  for (const v of validateSchema(value, local, {} as OpenApiSpec, pointer)) {
    push(out, v.pointer, v.rule);
  }

  if ("const" in schema && !deepEqual(value, schema.const)) push(out, pointer, "const");

  if (typeof schema.format === "string" && !KNOWN_FORMATS.has(schema.format)) {
    mark(out, `the format '${schema.format}' is not judged by the proof layer`);
  }
  if (typeof schema.pattern === "string" && compile(schema.pattern) === null) {
    mark(out, `the pattern '${schema.pattern}' does not compile`);
  }

  if (typeof value === "number" && typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    if (!isMultipleOf(value, schema.multipleOf)) {
      push(out, pointer, "multipleOf");
    }
  }

  if (Array.isArray(value)) {
    if (schema.uniqueItems === true) {
      const seen: unknown[] = [];
      for (const item of value) {
        // JSON object member order is irrelevant; array element order is not.
        if (seen.some((previous) => deepEqual(previous, item))) {
          push(out, pointer, "uniqueItems");
          break;
        }
        seen.push(item);
      }
    }
    if (Array.isArray(schema.items)) {
      // Tuple validation: `items` as an ARRAY is a list of per-position schemas (draft-07 /
      // OpenAPI 3.0's tuple form), not a schema for every element. Validating an element against
      // the array itself would invent a violation — an array is not a schema — and crust's own
      // sampler fills a list from `items` as a single schema, so crust has not judged this node
      // and must not claim it did.
      mark(out, "tuple `items` (a schema array) is not judged by the proof layer");
    } else if ("items" in schema) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let i = start; i < value.length; i++) {
        walk(out, value[i], schema.items, `${pointer}/${i}`, depth + 1);
      }
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((position, i) => {
        if (i < value.length) walk(out, value[i], position, `${pointer}/${i}`, depth + 1);
      });
    }
    if ("contains" in schema) {
      const verdicts = value.map((item) => verdict(item, schema.contains, depth));
      if (!verdicts.includes("yes")) {
        if (verdicts.includes("unknown")) mark(out, "a `contains` candidate could not be judged");
        else push(out, pointer, "contains");
      }
    }
  }

  if (isObj(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      push(out, pointer, "minProperties");
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      push(out, pointer, "maxProperties");
    }
    const props = isObj(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
    for (const k of keys) {
      if (k in props) walk(out, value[k], props[k], `${pointer}/${k}`, depth + 1);
    }

    const patProps = isObj(schema.patternProperties)
      ? (schema.patternProperties as Record<string, unknown>)
      : {};
    const claimed = new Set<string>();
    for (const [pattern, position] of Object.entries(patProps)) {
      const re = compile(pattern);
      if (!re) {
        mark(out, `the patternProperties pattern '${pattern}' does not compile`);
        continue;
      }
      for (const k of keys) {
        if (!re.test(k)) continue;
        claimed.add(k);
        walk(out, value[k], position, `${pointer}/${k}`, depth + 1);
      }
    }

    if ("propertyNames" in schema) {
      for (const k of keys) {
        const v = verdict(k, schema.propertyNames, depth);
        if (v === "no") push(out, pointer, "propertyNames");
        else if (v === "unknown") mark(out, "the `propertyNames` subschema could not be judged");
      }
    }

    if ("additionalProperties" in schema) {
      const ap = schema.additionalProperties;
      const extra = keys.filter((k) => !(k in props) && !claimed.has(k));
      // Composed nodes stay exempt, exactly as the mock's strict mode exempts them: a node that
      // says `additionalProperties: false` while its properties arrive from an `allOf` branch is
      // self-contradictory under JSON Schema (the keyword only sees properties in its OWN schema
      // object, so the branch's field reads as "additional"), and real servers read it the other
      // way. Judging it either way would invent a violation, so it is not judged.
      const composed =
        Array.isArray(schema.allOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf);
      if (ap === false && composed && Object.keys(props).length === 0) {
        mark(
          out,
          "additionalProperties: false beside a composed node whose properties come from a branch",
        );
      } else if (ap === false) {
        for (const k of extra) push(out, `${pointer}/${k}`, "additionalProperties");
      } else if (ap === true || ap === undefined) {
        // anything goes
      } else if (isObj(ap)) {
        for (const k of extra) walk(out, value[k], ap, `${pointer}/${k}`, depth + 1);
      } else {
        mark(out, "additionalProperties is neither a boolean nor a schema");
      }
    }

    if (isObj(schema.dependentRequired)) {
      for (const [k, deps] of Object.entries(schema.dependentRequired)) {
        if (!(k in value) || !Array.isArray(deps)) continue;
        for (const d of deps) {
          if (typeof d === "string" && !(d in value)) push(out, pointer, "dependentRequired");
        }
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) walk(out, value, branch, pointer, depth + 1);
  }
  if (Array.isArray(schema.anyOf)) {
    const verdicts = schema.anyOf.map((b) => verdict(value, b, depth));
    if (!verdicts.includes("yes")) {
      if (verdicts.includes("unknown")) mark(out, "an anyOf branch could not be judged");
      else push(out, pointer, "anyOf");
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const verdicts = schema.oneOf.map((b) => verdict(value, b, depth));
    const matches = verdicts.filter((v) => v === "yes").length;
    // exactly-one, which the mock validator deliberately drops: two branches matching is a
    // violation, and one match beside a branch that could not be judged is not a proof of anything.
    if (matches > 1) push(out, pointer, "oneOf");
    else if (matches === 0 && !verdicts.includes("unknown")) push(out, pointer, "oneOf");
    if (verdicts.includes("unknown")) mark(out, "a oneOf branch could not be judged");
  }
  if ("not" in schema) {
    const v = verdict(value, schema.not, depth);
    if (v === "yes") push(out, pointer, "not");
    else if (v === "unknown") mark(out, "the `not` subschema could not be judged");
  }
}

/**
 * Prove `value` against `schema`. See the header: an empty `violations` list means nothing unless
 * `incomplete` is also false.
 */
export function prove(value: unknown, schema: unknown): Proof {
  const out: Proof = { violations: [], incomplete: false };
  walk(out, value, schema, "", 0);
  const seen = new Set<string>();
  out.violations = out.violations.filter((v) => {
    // NUL is the separator on purpose: a JSON pointer and a keyword name can both contain
    // `:` and `|`, so any printable separator could collide two distinct violations into one
    // key and silently drop one of them. A NUL cannot appear in either.
    const key = `${v.pointer}\u0000${v.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out;
}

/** `true` ONLY when the value is proven to satisfy the schema — never on a permissive pass. */
export function provenValid(value: unknown, schema: unknown): boolean {
  const p = prove(value, schema);
  return p.violations.length === 0 && !p.incomplete;
}

/** `true` when the value is proven to violate it. Distinct from "not proven valid". */
export function provenInvalid(value: unknown, schema: unknown): boolean {
  const p = prove(value, schema);
  return p.violations.length > 0;
}
