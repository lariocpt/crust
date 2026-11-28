import type { OpenApiSpec, ParameterObject } from "../mockServer/loadSpec";
import { resolveRef } from "../mockServer/mockResponse";
import { validateSchema } from "../mockServer/validateRequest";
import { validBaselineFormat } from "./baselineFormats";
import type { EmitStyle } from "./indent";
import { formatCall, pad, quoteStringLiteral } from "./layout";

type Obj = Record<string, unknown>;
type HeaderRequirement = { name: string; prefix?: string };
export type QueryEntry = {
  name: string;
  value?: unknown;
  runtime: boolean;
  array: boolean;
  explode: boolean;
};
export interface RequestPlan {
  explicitSecurity: boolean;
  authenticated: boolean;
  alternatives: HeaderRequirement[][];
  query: QueryEntry[];
  problems: string[];
}
export interface ParameterSetup {
  parameterValues?: Record<string, Record<string, unknown>>;
  resolveParameter?: unknown;
  /**
   * Optional. Fills a path template with the id of a resource that EXISTS — the
   * validation matrix needs one, because a random id reaches an unknown resource
   * that a correct server answers 404 before it ever validates the body.
   */
  resolveKnownPath?: unknown;
}

function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wellFormedUnicode(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

function serializableScalar(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Math.abs(value) < 1e21);
  }
  if (typeof value === "string") return wellFormedUnicode(value);
  return typeof value === "boolean";
}

const BASELINE_ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "externalDocs",
  "xml",
  "$comment",
]);
const BASELINE_ASSERTIONS = new Set([
  "$ref",
  "type",
  "nullable",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "items",
  "allOf",
  "anyOf",
]);
const BASELINE_FORMATS = new Set(["uuid", "email", "date", "date-time", "uri"]);
const annotation = (key: string) => BASELINE_ANNOTATIONS.has(key) || key.startsWith("x-");

/**
 * validateSchema deliberately passes constraints it cannot judge. Such a pass
 * is not evidence that a static prerequisite is valid. Keep this gate local to
 * generation; never change the mock validator's permissive contract.
 */
function supportedBaselineSchema(
  schema: unknown,
  spec: OpenApiSpec,
  seen: ReadonlySet<unknown> = new Set(),
  depth = 0,
): boolean {
  if (!object(schema) || seen.has(schema) || depth > 32) return false;
  const keys = Object.keys(schema);
  // Empty branches can also be unresolved/cyclic refs cut by derefSchemas.
  if (!keys.some((key) => BASELINE_ASSERTIONS.has(key))) return false;
  if (keys.some((key) => !annotation(key) && !BASELINE_ASSERTIONS.has(key))) return false;
  const next = new Set(seen);
  next.add(schema);
  const covered = (node: unknown) => supportedBaselineSchema(node, spec, next, depth + 1);
  if (Object.hasOwn(schema, "$ref")) {
    if (typeof schema.$ref !== "string" || keys.some((k) => k !== "$ref" && !annotation(k))) {
      return false; // The shared validator ignores assertion siblings of a ref.
    }
    try {
      return covered(resolveRef(schema.$ref, spec));
    } catch {
      return false;
    }
  }
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" ||
      !["string", "number", "integer", "boolean", "array", "null"].includes(schema.type))
  ) {
    return false;
  }
  if (schema.nullable !== undefined && typeof schema.nullable !== "boolean") return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return false;
  }
  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) return false;
  }
  for (const [exclusive, ordinary] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    const bound = schema[exclusive];
    if (bound === undefined) continue;
    if (typeof bound === "boolean") {
      if (bound && schema[ordinary] === undefined) return false;
    } else if (!Number.isFinite(bound) || schema[ordinary] !== undefined) {
      return false; // Numeric exclusive bounds otherwise hide ordinary bounds.
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const bound = schema[key];
    if (
      bound !== undefined &&
      (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0)
    ) {
      return false;
    }
  }
  if (
    schema.format !== undefined &&
    (typeof schema.format !== "string" || !BASELINE_FORMATS.has(schema.format))
  ) {
    return false;
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") return false;
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      try {
        new RegExp(schema.pattern);
      } catch {
        return false;
      }
    }
  }
  for (const key of ["allOf", "anyOf"]) {
    const branches = schema[key];
    if (
      branches !== undefined &&
      (!Array.isArray(branches) || branches.length === 0 || !branches.every(covered))
    ) {
      return false;
    }
  }
  return schema.items === undefined || covered(schema.items);
}

/** Called only after coverage is proven; keep branch selection local as well. */
function validBaseline(value: unknown, schema: unknown, spec: OpenApiSpec, depth = 0): boolean {
  if (!object(schema) || depth > 32) return false;
  const { $ref, allOf, anyOf, items, minLength, maxLength, format, ...assertions } = schema;
  const valid = (node: unknown, item = value) => validBaseline(item, node, spec, depth + 1);
  if (typeof $ref === "string") {
    try {
      return valid(resolveRef($ref, spec));
    } catch {
      return false;
    }
  }
  if (Array.isArray(allOf) && !allOf.every((node) => valid(node))) return false;
  if (Array.isArray(anyOf) && !anyOf.some((node) => valid(node))) return false;
  // Do not let UTF-16 length checks or the shared walker's branch selection
  // override the generator's code-point semantics.
  if (validateSchema(value, assertions, spec, "").length > 0) return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof minLength === "number" && length < minLength) return false;
    if (typeof maxLength === "number" && length > maxLength) return false;
    if (typeof format === "string" && !validBaselineFormat(value, format)) return false;
  }
  if (Array.isArray(value) && items !== undefined) {
    if (!value.every((item) => valid(items, item))) return false;
  }
  return true;
}

/** Resolve parameter containers only; leave schema assertions intact for coverage. */
function originalQuerySchemas(spec: OpenApiSpec, key: string): Map<string, unknown> | null {
  const resolveObject = (input: unknown): Obj | null => {
    let node = input;
    const seen = new Set<unknown>();
    while (object(node) && typeof node.$ref === "string") {
      if (seen.has(node) || seen.size >= 32) return null;
      seen.add(node);
      try {
        node = resolveRef(node.$ref, spec);
      } catch {
        return null;
      }
    }
    return object(node) ? node : null;
  };
  const space = key.indexOf(" ");
  const path = resolveObject(spec.paths?.[key.slice(space + 1)]);
  const op = path && resolveObject(path[key.slice(0, space).toLowerCase()]);
  if (!path || !op) return null;
  const schemas = new Map<string, unknown>();
  for (const list of [path.parameters, op.parameters]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      const p = resolveObject(entry);
      if (!p || typeof p.name !== "string" || typeof p.in !== "string") return null;
      if (p.in === "query") schemas.set(p.name, p.schema);
    }
  }
  return schemas;
}

/** Path-item defaults are overridden only by an operation's matching (name, in). */
export function mergeParameters(path: unknown, operation: unknown): ParameterObject[] {
  const merged = new Map<string, ParameterObject>();
  for (const list of [path, operation]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error("gen-fixtures: parameters must be arrays");
    for (const p of list) {
      if (!object(p) || typeof p.name !== "string" || typeof p.in !== "string") {
        throw new Error("gen-fixtures: unresolved or malformed parameter");
      }
      merged.set(`${p.in}\0${p.name}`, p);
    }
  }
  return [...merged.values()];
}

/** Validate configuration before touching the destructive output directory. */
export function validateParameterSetup(setup: ParameterSetup, keys: Set<string>): void {
  if (setup.resolveParameter !== undefined && typeof setup.resolveParameter !== "function") {
    throw new Error("gen-fixtures: resolveParameter must be a lazy function");
  }
  // Same rule as `resolveParameter`: it is emitted as a call into the setup module, so a
  // non-function here would produce a fixture file that fails at RUN time on a type error
  // instead of refusing the generation now.
  if (setup.resolveKnownPath !== undefined && typeof setup.resolveKnownPath !== "function") {
    throw new Error("gen-fixtures: resolveKnownPath must be a function (ctx, template) => url");
  }
  if (setup.parameterValues === undefined) return;
  if (!object(setup.parameterValues)) {
    throw new Error("gen-fixtures: parameterValues must be an operation map");
  }
  for (const [key, values] of Object.entries(setup.parameterValues)) {
    if (!keys.has(key) || !object(values)) {
      throw new Error("gen-fixtures: parameterValues has an unknown operation or invalid map");
    }
  }
}

export function planRequest(
  spec: OpenApiSpec,
  op: Obj,
  parameters: ParameterObject[],
  key: string,
  setup: ParameterSetup,
  originalSpec?: OpenApiSpec,
): RequestPlan {
  const plan: RequestPlan = {
    explicitSecurity: op.security !== undefined || spec.security !== undefined,
    authenticated: false,
    alternatives: [],
    query: [],
    problems: [],
  };
  const security = op.security !== undefined ? op.security : spec.security;
  if (plan.explicitSecurity) {
    if (!Array.isArray(security) || security.some((r) => !object(r))) {
      plan.problems.push("malformed security requirements");
    } else if (security.length > 0 && !security.some((r) => Object.keys(r).length === 0)) {
      plan.authenticated = true;
      const components = spec.components as Obj | undefined;
      const schemes = components?.securitySchemes;
      for (const requirement of security as Obj[]) {
        const headers: HeaderRequirement[] = [];
        let supported = true;
        for (const [name, scopes] of Object.entries(requirement)) {
          const scheme = object(schemes) ? schemes[name] : undefined;
          if (!object(scheme) || !Array.isArray(scopes) || scopes.length !== 0) {
            supported = false;
            break;
          }
          if (scheme.type === "http" && /^(bearer|basic)$/i.test(String(scheme.scheme))) {
            headers.push({ name: "authorization", prefix: `${String(scheme.scheme)} ` });
          } else if (
            scheme.type === "apiKey" &&
            scheme.in === "header" &&
            typeof scheme.name === "string" &&
            scheme.name.length > 0
          ) {
            headers.push({ name: scheme.name.toLowerCase() });
          } else {
            supported = false;
            break;
          }
        }
        // Two schemes demanding incompatible values in the same header cannot be satisfied.
        const names = headers.map((h) => h.name);
        if (supported && new Set(names).size === names.length) plan.alternatives.push(headers);
      }
      if (plan.alternatives.length === 0) {
        plan.problems.push("no supported header-based security alternative (scopes must be empty)");
      }
    }
  }

  const values = setup.parameterValues?.[key] ?? {};
  const originalSchemas = originalSpec ? originalQuerySchemas(originalSpec, key) : undefined;
  const queryNames = new Set(parameters.filter((p) => p.in === "query").map((p) => p.name));
  if (Object.keys(values).some((name) => !queryNames.has(name))) {
    throw new Error("gen-fixtures: parameterValues names an undeclared query parameter");
  }
  for (const p of parameters) {
    if (p.in !== "query") {
      if (p.required && p.in !== "path") {
        plan.problems.push("required non-path/non-query parameters are not supported");
      }
      continue;
    }
    const name = p.name as string;
    const configured = Object.hasOwn(values, name);
    if (!p.required && !configured) continue;
    if (!wellFormedUnicode(name)) {
      plan.problems.push("unsupported query parameter name: malformed Unicode");
      continue;
    }
    const schema = object(p.schema) ? p.schema : {};
    const array = schema.type === "array";
    const scalar = ["string", "number", "integer", "boolean"].includes(String(schema.type));
    if (
      p.content !== undefined ||
      (p.style !== undefined && p.style !== "form") ||
      p.allowReserved === true ||
      (!array && !scalar) ||
      (array &&
        (!object(schema.items) ||
          !["string", "number", "integer", "boolean"].includes(String(schema.items.type))))
    ) {
      plan.problems.push(`unsupported required/configured query serialization: ${name}`);
      continue;
    }
    let value: unknown;
    if (configured) value = values[name];
    else if (Object.hasOwn(schema, "default")) value = schema.default;
    else if (Object.hasOwn(p, "example")) value = p.example;
    else if (Object.hasOwn(schema, "example")) value = schema.example;
    else if (Array.isArray(schema.enum) && schema.enum.length > 0) value = schema.enum[0];

    const runtime = value === undefined && typeof setup.resolveParameter === "function";
    if (value === undefined && !runtime) {
      plan.problems.push(
        `required query baseline needs parameterValues or resolveParameter: ${name}`,
      );
      continue;
    }
    if (!runtime) {
      if (
        !supportedBaselineSchema(schema, spec) ||
        (originalSpec && !supportedBaselineSchema(originalSchemas?.get(name), originalSpec))
      ) {
        plan.problems.push(`unsupported static query schema constraints: ${name}`);
        continue;
      }
      const serializable = array
        ? Array.isArray(value) && value.every(serializableScalar)
        : serializableScalar(value);
      if (
        !serializable ||
        !validBaseline(value, schema, spec) ||
        (originalSpec && !validBaseline(value, originalSchemas?.get(name), originalSpec)) ||
        (Array.isArray(value) && value.length === 0)
      ) {
        plan.problems.push(`query baseline does not satisfy its schema/serialization: ${name}`);
        continue;
      }
      if (
        Array.isArray(value) &&
        p.explode === false &&
        value.some((item) => typeof item === "string" && item.includes(","))
      ) {
        plan.problems.push(`non-exploded query array has comma-bearing elements: ${name}`);
        continue;
      }
    }
    plan.query.push({ name, value, runtime, array, explode: p.explode !== false });
  }
  return plan;
}

/** No package imports: generated fixtures run independently of the installed generator. */
export function emitRequestHelpers(style: EmitStyle, query: boolean, headers: boolean): string {
  const q = (value: string) => quoteStringLiteral(value, style);
  const call = (level: number, prefix: string, callee: string, args: string[]) =>
    pad(level) + formatCall(style, level, prefix, callee, args, ";");
  const sections: string[] = [];
  if (headers) {
    sections.push(`type GenHeader = {
  name: string;
  prefix?: string;
};

${formatCall(
  style,
  0,
  "function ",
  "genHeaders",
  ["headers: Record<string, string>", "alternatives: GenHeader[][]"],
  ": Record<string, string> {",
)}
  const entries = Object.entries(headers);
  for (const required of alternatives) {
    const valid = required.every((r) => {
${call(3, "const matches = ", "entries.filter", ["([name]) => name.toLowerCase() === r.name"])}
      if (matches.length !== 1) return false;
      const value = matches[0]![1];
      if (typeof value !== ${q("string")}) return false;
      if (value.trim().length === 0) return false;
      if (!r.prefix) return true;
      const actual = value.toLowerCase();
      const prefix = r.prefix.toLowerCase();
      if (!actual.startsWith(prefix)) return false;
      const tail = value.slice(prefix.length);
      return tail.trim().length > 0;
    });
    if (valid) return headers;
  }
${call(1, "throw ", "new Error", [q("gen-fixtures: setup headers do not satisfy selected security")])}
}`);
  }
  if (query) {
    sections.push(`type GenQuery = {
  name: string;
  value?: unknown;
  runtime: boolean;
  array: boolean;
  explode: boolean;
};

${formatCall(
  style,
  0,
  "type GenResolver = ",
  "",
  ["ctx: Ctx", "operation: string", "name: string"],
  " => unknown;",
)}

type GenScalar = string | number | boolean;

function genUnicode(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char.length !== 1) continue;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

function genScalar(v: unknown): v is GenScalar {
  if (typeof v === ${q("number")}) {
    if (!Number.isFinite(v)) return false;
    if (!Number.isInteger(v)) return true;
    return Math.abs(v) < 1e21;
  }
  if (typeof v === ${q("string")}) return genUnicode(v);
  return typeof v === ${q("boolean")};
}

function genQueryError(): never {
${call(1, "throw ", "new Error", [q("gen-fixtures: unresolved or unsupported query baseline")])}
}

async function genUrl(
  base: string,
  ctx: Ctx,
  operation: string,
  parameters: GenQuery[],
  resolver?: GenResolver,
): Promise<string> {
  const url = new URL(base);
  for (const p of parameters) {
    if (!genUnicode(p.name)) genQueryError();
    let value = p.value;
    if (p.runtime) {
${call(3, "value = await ", "resolver?.", ["ctx", "operation", "p.name"])}
    }
    if (p.array) {
      if (!Array.isArray(value)) genQueryError();
      if (value.length === 0) genQueryError();
      if (!value.every(genScalar)) genQueryError();
    } else if (!genScalar(value)) genQueryError();
    url.searchParams.delete(p.name);
    if (Array.isArray(value)) {
      if (p.explode) {
        for (const item of value) {
${call(5, "", "url.searchParams.append", ["p.name", "String(item)"])}
        }
      } else {
        const items = value.map(String);
        for (const item of items) {
          const comma = item.includes(${q(",")});
          if (comma) genQueryError();
        }
        const joined = items.join(${q(",")});
${call(4, "", "url.searchParams.append", ["p.name", "joined"])}
      }
    } else {
${call(3, "", "url.searchParams.append", ["p.name", "String(value)"])}
    }
  }
  return url.toString();
}`);
  }
  return sections.join("\n\n");
}
