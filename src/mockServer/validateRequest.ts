// Hand-rolled OpenAPI request/response validator (subset — no npm deps).
//
// Governing rule: a schema the walker can't judge validates successfully —
// the validator never invents a violation. Unknown keywords, unknown formats,
// uncompilable patterns, unresolvable/remote $refs, and $ref cycles all pass.
//
// Deliberately unsupported (always pass): not, patternProperties,
// uniqueItems, multipleOf, discriminator, dependentSchemas, propertyNames,
// contains, prefixItems, readOnly/writeOnly directionality.
// additionalProperties is unsupported by default; under opts.strict a
// LITERAL `additionalProperties: false` at a plain object node is enforced
// (see the guards at the enforcement site — composed nodes stay exempt so
// strict mode still never invents a violation).
import type { OpenApiSpec, ParameterObject, RequestBodyObject, ResponseObject } from "./loadSpec";
import { resolveRef } from "./mockResponse";
import type { Route } from "./router";

export interface SchemaViolation {
  /** JSON pointer into the value ("/items/0/name"); param name for path/query. */
  pointer: string;
  rule: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

export interface Violation extends SchemaViolation {
  ts: string;
  direction: "request" | "response";
  location: "body" | "path" | "query" | "status" | "content-type";
  method: string;
  /** Actual request pathname. */
  path: string;
  /** Matched route template ("" for undocumented-operation). */
  template: string;
  /** Upstream status (response direction). */
  status?: number;
}

const MAX_RECEIVED = 200;

function truncate(value: unknown): unknown {
  if (value === undefined) return "undefined";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_RECEIVED ? `${text.slice(0, MAX_RECEIVED)}…` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORMAT_REGEXES: Record<string, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:\S*$/,
};

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword — can't judge, pass
  }
}

function enumMatches(value: unknown, member: unknown): boolean {
  if (member === value) return true;
  try {
    return JSON.stringify(member) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export interface ValidateOpts {
  /** Enforce a literal `additionalProperties: false` at plain object nodes. */
  strict?: boolean;
  /**
   * Internal: set while recursing into an allOf branch at the SAME instance
   * position — sibling branches may legitimately contribute the "extra"
   * properties (the OpenAPI allOf-merge idiom), so enforcement there would
   * invent violations. Reset once the instance position deepens.
   */
  suppressAP?: boolean;
}

export function validateSchema(
  value: unknown,
  schema: unknown,
  spec: OpenApiSpec,
  pointer = "",
  visited: ReadonlySet<string> = new Set<string>(),
  opts: ValidateOpts = {},
): SchemaViolation[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;

  // The `visited` guard only tracks $ref indirection at the SAME instance
  // position ($ref → $ref → … without consuming any value): that is the only
  // place a cycle can loop forever. Descending into the instance (items /
  // properties) always makes progress, so those branches get a fresh set —
  // otherwise a legitimately-repeated $ref at a deeper position would be
  // skipped and its violations silently passed.
  if (typeof s.$ref === "string") {
    const refName = s.$ref;
    if (visited.has(refName)) return []; // same-position cycle — pass
    const resolved = resolveRef(refName, spec);
    if (!resolved) return []; // remote/unresolvable — pass
    const next = new Set(visited);
    next.add(refName);
    return validateSchema(value, resolved, spec, pointer, next, opts);
  }

  const out: SchemaViolation[] = [];

  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      // Same instance position: a branch's additionalProperties:false must
      // not reject properties its sibling branches contribute.
      for (const v of validateSchema(value, branch, spec, pointer, visited, {
        ...opts,
        suppressAP: true,
      }))
        out.push(v);
    }
  }

  const combinator = Array.isArray(s.anyOf) ? "anyOf" : Array.isArray(s.oneOf) ? "oneOf" : null;
  if (combinator) {
    const branches = s[combinator] as unknown[];
    if (branches.length > 0) {
      // Pass when ANY branch passes (oneOf's exactly-one is deliberately not
      // enforced). On total failure, one violation carries the closest branch.
      let best: SchemaViolation[] | null = null;
      let passed = false;
      for (const branch of branches) {
        // Each anyOf/oneOf branch is a self-contained alternative shape —
        // strict enforcement applies inside; a strict-failing branch merely
        // fails branch selection.
        const errs = validateSchema(value, branch, spec, pointer, visited, opts);
        if (errs.length === 0) {
          passed = true;
          break;
        }
        if (!best || errs.length < best.length) best = errs;
      }
      if (!passed && best) {
        out.push({
          pointer,
          rule: "anyOf",
          message: `matches no ${combinator} branch; closest branch failed: ${best
            .map((e) => `${e.pointer || "(root)"}: ${e.message}`)
            .join("; ")}`,
          expected: best,
          received: truncate(value),
        });
      }
    }
  }

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    if (!s.enum.some((member) => enumMatches(value, member))) {
      out.push({
        pointer,
        rule: "enum",
        message: `value not in enum`,
        expected: s.enum,
        received: truncate(value),
      });
    }
  }

  // type — string form, 3.1 array form, plus 3.0 `nullable`.
  const rawType = s.type;
  const types = Array.isArray(rawType)
    ? rawType.filter((t): t is string => typeof t === "string")
    : typeof rawType === "string"
      ? [rawType]
      : [];
  if (s.nullable === true && !types.includes("null") && types.length > 0) types.push("null");
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    out.push({
      pointer,
      rule: "type",
      message: `expected ${types.join(" | ")}, got ${typeOfValue(value)}`,
      expected: Array.isArray(rawType) ? rawType : (rawType ?? types[0]),
      received: truncate(value),
    });
    return out; // per-type keywords are meaningless once the type is wrong
  }

  if (typeof value === "string") {
    if (typeof s.format === "string") {
      const re = FORMAT_REGEXES[s.format]; // unknown format — pass
      if (re && !re.test(value)) {
        out.push({
          pointer,
          rule: "format",
          message: `does not match format '${s.format}'`,
          expected: s.format,
          received: truncate(value),
        });
      }
    }
    if (typeof s.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(s.pattern);
      } catch {
        // uncompilable pattern — pass
      }
      if (re && !re.test(value)) {
        out.push({
          pointer,
          rule: "pattern",
          message: `does not match pattern`,
          expected: s.pattern,
          received: truncate(value),
        });
      }
    }
    if (typeof s.minLength === "number" && value.length < s.minLength) {
      out.push({
        pointer,
        rule: "minLength",
        message: `length ${value.length} < minLength ${s.minLength}`,
        expected: s.minLength,
        received: truncate(value),
      });
    }
    if (typeof s.maxLength === "number" && value.length > s.maxLength) {
      out.push({
        pointer,
        rule: "maxLength",
        message: `length ${value.length} > maxLength ${s.maxLength}`,
        expected: s.maxLength,
        received: truncate(value),
      });
    }
  }

  if (typeof value === "number") {
    // exclusiveMinimum/Maximum: 3.0 boolean form modifies minimum/maximum;
    // 3.1 numeric form is a bound of its own.
    let min = typeof s.minimum === "number" ? s.minimum : null;
    let minExclusive = false;
    if (typeof s.exclusiveMinimum === "number") {
      min = s.exclusiveMinimum;
      minExclusive = true;
    } else if (s.exclusiveMinimum === true && min !== null) {
      minExclusive = true;
    }
    if (min !== null && (minExclusive ? value <= min : value < min)) {
      out.push({
        pointer,
        rule: "minimum",
        message: `${value} ${minExclusive ? "<=" : "<"} minimum ${min}`,
        expected: min,
        received: value,
      });
    }
    let max = typeof s.maximum === "number" ? s.maximum : null;
    let maxExclusive = false;
    if (typeof s.exclusiveMaximum === "number") {
      max = s.exclusiveMaximum;
      maxExclusive = true;
    } else if (s.exclusiveMaximum === true && max !== null) {
      maxExclusive = true;
    }
    if (max !== null && (maxExclusive ? value >= max : value > max)) {
      out.push({
        pointer,
        rule: "maximum",
        message: `${value} ${maxExclusive ? ">=" : ">"} maximum ${max}`,
        expected: max,
        received: value,
      });
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      out.push({
        pointer,
        rule: "minItems",
        message: `${value.length} item(s) < minItems ${s.minItems}`,
        expected: s.minItems,
        received: value.length,
      });
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      out.push({
        pointer,
        rule: "maxItems",
        message: `${value.length} item(s) > maxItems ${s.maxItems}`,
        expected: s.maxItems,
        received: value.length,
      });
    }
    if (s.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        // Fresh guard set: the instance pointer deepens, so recursion is
        // finite — and allOf suppression resets with it.
        for (const v of validateSchema(
          value[i],
          s.items,
          spec,
          `${pointer}/${i}`,
          new Set<string>(),
          {
            strict: opts.strict,
          },
        ))
          out.push(v);
      }
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in value)) {
          out.push({
            pointer: `${pointer}/${key}`,
            rule: "required",
            message: `missing required property '${key}'`,
            expected: key,
          });
        }
      }
    }
    if (isPlainObject(s.properties)) {
      for (const [key, propSchema] of Object.entries(s.properties)) {
        if (key in value) {
          // Fresh guard set: the instance pointer deepens, so recursion is
          // finite — and allOf suppression resets with it.
          out.push(
            ...validateSchema(
              value[key],
              propSchema,
              spec,
              `${pointer}/${key}`,
              new Set<string>(),
              {
                strict: opts.strict,
              },
            ),
          );
        }
      }
    }
    // additionalProperties is not enforced by default (a literal false
    // included). Under strict it is enforced ONLY at a node the walker can
    // fully judge: literal false, no combinator siblings that could
    // contribute properties, no patternProperties covering unknown keys, and
    // not inside an allOf branch at this instance position. Everything the
    // guards exclude keeps the never-invent-a-violation rule even in strict.
    if (
      opts.strict === true &&
      opts.suppressAP !== true &&
      s.additionalProperties === false &&
      !Array.isArray(s.allOf) &&
      !Array.isArray(s.anyOf) &&
      !Array.isArray(s.oneOf) &&
      !isPlainObject(s.patternProperties)
    ) {
      const declared = isPlainObject(s.properties) ? Object.keys(s.properties).sort() : [];
      for (const key of Object.keys(value)) {
        if (!declared.includes(key)) {
          out.push({
            pointer: `${pointer}/${key}`,
            rule: "additionalProperties",
            message: `unexpected property '${key}'`,
            expected: declared,
            received: truncate(value[key]),
          });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export interface RequestInput {
  method: string;
  pathname: string;
  params: Record<string, string>;
  searchParams: URLSearchParams;
  contentType: string | null;
  bodyPresent: boolean;
  body: unknown;
  jsonError?: string;
}

export function isJsonContentType(contentType: string | null): boolean {
  const base = baseContentType(contentType);
  if (!base) return false;
  return base === "application/json" || base === "text/json" || base.endsWith("+json");
}

function baseContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return base.length > 0 ? base : null;
}

function resolveMaybeRef(node: unknown, spec: OpenApiSpec): unknown {
  let cur = node;
  const seen = new Set<string>();
  while (
    isPlainObject(cur) &&
    typeof cur.$ref === "string" &&
    !seen.has(cur.$ref) // cycle — give back the node, callers can't judge it
  ) {
    seen.add(cur.$ref);
    const resolved = resolveRef(cur.$ref, spec);
    if (!resolved) return null; // unresolvable — callers must pass
    cur = resolved;
  }
  return cur;
}

/** First declared non-null type of a (possibly $ref'd) schema, or null. */
function declaredType(schema: unknown, spec: OpenApiSpec): string | null {
  const resolved = resolveMaybeRef(schema, spec);
  if (!isPlainObject(resolved)) return null;
  const t = resolved.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const first = t.find((x) => typeof x === "string" && x !== "null");
    return typeof first === "string" ? first : null;
  }
  return null;
}

interface Coerced {
  value: unknown;
  error?: { expected: string };
}

/** Path/query params arrive as strings — coerce by declared schema type. */
function coerceByType(raw: string, type: string | null): Coerced {
  switch (type) {
    case "integer":
      return /^-?\d+$/.test(raw)
        ? { value: Number(raw) }
        : { value: raw, error: { expected: "integer" } };
    case "number": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n)
        ? { value: n }
        : { value: raw, error: { expected: "number" } };
    }
    case "boolean":
      if (raw === "true") return { value: true };
      if (raw === "false") return { value: false };
      return { value: raw, error: { expected: "boolean" } };
    default:
      return { value: raw };
  }
}

interface ViolationContext {
  direction: "request" | "response";
  method: string;
  path: string;
  template: string;
  status?: number;
}

function toViolation(
  sv: SchemaViolation,
  location: Violation["location"],
  ctx: ViolationContext,
): Violation {
  return {
    ...sv,
    ts: new Date().toISOString(),
    direction: ctx.direction,
    location,
    method: ctx.method,
    path: ctx.path,
    template: ctx.template,
    ...(ctx.status !== undefined ? { status: ctx.status } : {}),
  };
}

export function validateRequest(
  input: RequestInput,
  route: Route,
  spec: OpenApiSpec,
  opts: ValidateOpts = {},
): Violation[] {
  const ctx: ViolationContext = {
    direction: "request",
    method: input.method.toUpperCase(),
    path: input.pathname,
    template: route.template,
  };
  const out: Violation[] = [];

  for (const paramRaw of route.parameters) {
    const param = resolveMaybeRef(paramRaw, spec) as ParameterObject | null;
    if (!param || typeof param.name !== "string") continue;
    if (param.in === "path") {
      const raw = input.params[param.name];
      if (raw === undefined) continue;
      for (const v of validateParamValue(raw, param, spec, "path", ctx, opts)) out.push(v);
    } else if (param.in === "query") {
      const values = input.searchParams.getAll(param.name);
      if (values.length === 0) {
        if (param.required === true) {
          out.push(
            toViolation(
              {
                pointer: param.name,
                rule: "required",
                message: `missing required query parameter '${param.name}'`,
                expected: param.name,
              },
              "query",
              ctx,
            ),
          );
        }
        continue;
      }
      for (const v of validateQueryValues(values, param, spec, ctx, opts)) out.push(v);
    }
    // header/cookie parameters are not validated
  }

  const rb = resolveMaybeRef(route.operation.requestBody, spec) as RequestBodyObject | null;
  if (rb && isPlainObject(rb)) {
    if (rb.required === true && !input.bodyPresent) {
      out.push(
        toViolation(
          {
            pointer: "",
            rule: "required-body",
            message: "request body is required but absent",
            expected: Object.keys(rb.content ?? {}),
          },
          "body",
          ctx,
        ),
      );
    } else if (input.bodyPresent) {
      const content = rb.content ?? {};
      const base = baseContentType(input.contentType) ?? "application/json";
      const mediaKey = Object.keys(content).find((k) => baseContentType(k) === base);
      const media = mediaKey ? content[mediaKey] : undefined;
      if (media && isJsonContentType(mediaKey ?? null)) {
        if (input.jsonError) {
          out.push(
            toViolation(
              {
                pointer: "",
                rule: "json-parse",
                message: `request body is not valid JSON: ${input.jsonError}`,
                received: undefined,
              },
              "body",
              ctx,
            ),
          );
        } else if (input.body !== undefined && media.schema !== undefined) {
          for (const sv of validateSchema(input.body, media.schema, spec, "", new Set(), opts)) {
            out.push(toViolation(sv, "body", ctx));
          }
        }
      }
      // non-JSON content types (multipart, form, …) — pass
    }
  }

  return out;
}

function validateParamValue(
  raw: string,
  param: ParameterObject,
  spec: OpenApiSpec,
  location: "path" | "query",
  ctx: ViolationContext,
  opts: ValidateOpts = {},
): Violation[] {
  const name = param.name!;
  const coerced = coerceByType(raw, declaredType(param.schema, spec));
  if (coerced.error) {
    return [
      toViolation(
        {
          pointer: name,
          rule: "type",
          message: `expected ${coerced.error.expected}, got '${raw}'`,
          expected: coerced.error.expected,
          received: truncate(raw),
        },
        location,
        ctx,
      ),
    ];
  }
  return validateSchema(coerced.value, param.schema, spec, name, new Set(), opts).map((sv) =>
    toViolation(sv, location, ctx),
  );
}

function validateQueryValues(
  values: string[],
  param: ParameterObject,
  spec: OpenApiSpec,
  ctx: ViolationContext,
  opts: ValidateOpts = {},
): Violation[] {
  const name = param.name!;
  const type = declaredType(param.schema, spec);
  if (type === "array") {
    // Serialization: explode:true (the form-style default) means repeated keys
    // (?tag=a&tag=b); explode:false with style form means one comma-joined
    // value (?tag=a,b). Anything else (spaceDelimited, pipeDelimited, …, or a
    // non-exploded param sent with repeated keys) isn't modeled — pass rather
    // than invent a violation.
    let items = values;
    if (param.explode === false) {
      const style = typeof param.style === "string" ? param.style : "form";
      if (style !== "form" || values.length !== 1) return [];
      items = values[0]!.split(",");
    }
    // exploded repeated keys (or the comma-split above) → array; coerce each
    // item by the items schema type
    const schema = resolveMaybeRef(param.schema, spec);
    const itemsSchema = isPlainObject(schema) ? schema.items : undefined;
    const itemType = declaredType(itemsSchema, spec);
    const out: Violation[] = [];
    const coercedItems: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const c = coerceByType(items[i]!, itemType);
      if (c.error) {
        out.push(
          toViolation(
            {
              pointer: `${name}/${i}`,
              rule: "type",
              message: `expected ${c.error.expected}, got '${items[i]}'`,
              expected: c.error.expected,
              received: truncate(items[i]),
            },
            "query",
            ctx,
          ),
        );
      }
      coercedItems.push(c.value);
    }
    if (out.length === 0) {
      out.push(
        ...validateSchema(coercedItems, param.schema, spec, name, new Set(), opts).map((sv) =>
          toViolation(sv, "query", ctx),
        ),
      );
    }
    return out;
  }
  return validateParamValue(values[0]!, param, spec, "query", ctx, opts);
}

// ---------------------------------------------------------------------------
// Response validation (proxy mode)
// ---------------------------------------------------------------------------

export interface ResponseInput {
  status: number;
  contentType: string | null;
  hasBody: boolean;
  /** JSON-parsed body when the upstream body parsed as JSON; else undefined. */
  body: unknown;
}

export function validateResponse(
  input: ResponseInput,
  route: Route,
  spec: OpenApiSpec,
  opts: ValidateOpts = {},
): Violation[] {
  const ctx: ViolationContext = {
    direction: "response",
    method: route.method,
    path: route.template,
    template: route.template,
    status: input.status,
  };
  const out: Violation[] = [];
  const responses = route.operation.responses ?? {};
  const keys = Object.keys(responses);

  // (a) status documented — exact key, then NXX range key, then default.
  const exact = String(input.status);
  const range = `${Math.floor(input.status / 100)}XX`;
  const matchedKey =
    keys.find((k) => k === exact) ??
    keys.find((k) => k.toUpperCase() === range) ??
    keys.find((k) => k === "default");
  if (!matchedKey) {
    out.push(
      toViolation(
        {
          pointer: "",
          rule: "undocumented-status",
          message: `status ${input.status} is not documented for ${route.method} ${route.template}`,
          expected: [...keys].sort(),
          received: input.status,
        },
        "status",
        ctx,
      ),
    );
    return out; // no documented response to check content-type/body against
  }

  const resObj = resolveMaybeRef(responses[matchedKey], spec) as ResponseObject | null;
  if (!resObj || !isPlainObject(resObj)) return out;
  const content = resObj.content;
  if (!content || Object.keys(content).length === 0) return out;

  const base = baseContentType(input.contentType);
  const docBases = Object.keys(content)
    .map((k) => baseContentType(k))
    .filter((k): k is string => k !== null);

  // (b) content-type documented (skip for 204/304/HEAD/empty body).
  const skipCt =
    input.status === 204 || input.status === 304 || route.method === "HEAD" || !input.hasBody;
  if (!skipCt) {
    const ok =
      base !== null &&
      docBases.some(
        (doc) =>
          doc === base ||
          doc === "*/*" ||
          (doc.endsWith("/*") && base.startsWith(doc.slice(0, -1))),
      );
    if (!ok) {
      out.push(
        toViolation(
          {
            pointer: "",
            rule: "content-type",
            message: `content-type '${base ?? "(none)"}' is not documented for status ${input.status}`,
            expected: [...docBases].sort(),
            received: base ?? null,
          },
          "content-type",
          ctx,
        ),
      );
    }
  }

  // (c) body — only when the matched media documents a schema.
  if (input.body !== undefined) {
    const mediaKey = Object.keys(content).find(
      (k) => baseContentType(k) === (base ?? "application/json"),
    );
    const media = mediaKey ? content[mediaKey] : undefined;
    if (media?.schema !== undefined) {
      for (const sv of validateSchema(input.body, media.schema, spec, "", new Set(), opts)) {
        out.push(toViolation(sv, "body", ctx));
      }
    }
  }

  return out;
}

/** The one non-schema violation: a request that matches no documented route. */
export function undocumentedOperation(method: string, pathname: string): Violation {
  return {
    ts: new Date().toISOString(),
    direction: "request",
    location: "path",
    method: method.toUpperCase(),
    path: pathname,
    template: "",
    pointer: "",
    rule: "undocumented-operation",
    message: `${method.toUpperCase()} ${pathname} matches no documented operation`,
  };
}
