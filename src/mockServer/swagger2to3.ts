// Swagger 2.0 → OpenAPI 3.x normaliser for the mock server.
//
// The router/mockResponse pipeline understands the OpenAPI 3.x shape:
//   paths[p][m].responses[code].content["application/json"].{schema|example|examples}
//   schema $refs into #/components/schemas/*
// Swagger 2.0 instead puts the response body schema directly on the response
// (responses[code].schema), media examples under responses[code].examples
// (keyed by content type), schema definitions under top-level `definitions`,
// and $refs into #/definitions/*. This module rewrites a parsed 2.0 document
// into the 3.x shape in place, so the rest of the mock server is unchanged.
import type { OpenApiSpec } from "./loadSpec";

/** True when the parsed document is a Swagger/OpenAPI 2.0 spec. */
export function isSwagger2(spec: OpenApiSpec): boolean {
  return typeof spec.swagger === "string" && spec.swagger.trim().startsWith("2");
}

/** Choose a media type from a 2.0 `produces`/`consumes` list (prefer JSON). */
function pickMediaType(produces: unknown): string {
  if (Array.isArray(produces) && produces.length > 0) {
    const json = produces.find((p) => typeof p === "string" && p.includes("json"));
    return (json as string) ?? (produces[0] as string);
  }
  return "application/json";
}

/** Rewrite every `$ref: "#/definitions/X"` to `"#/components/schemas/X"` in place. */
function rewriteRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const v of node) rewriteRefs(v);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")) {
        obj[k] = v.replace("#/definitions/", "#/components/schemas/");
      } else {
        rewriteRefs(v);
      }
    }
  }
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

/**
 * A 2.0 parameter object, possibly a `$ref` into the document's top-level
 * `parameters` (which step 1 does NOT move — see F51), resolving to a body parameter.
 */
function resolveParam(node: unknown, spec: OpenApiSpec): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/parameters/")) {
    const defs = (spec as Record<string, unknown>).parameters as
      | Record<string, unknown>
      | undefined;
    const target = defs?.[obj.$ref.slice("#/parameters/".length)];
    return target && typeof target === "object" ? (target as Record<string, unknown>) : null;
  }
  return obj;
}

function isBodyParam(node: unknown, spec: OpenApiSpec): boolean {
  return resolveParam(node, spec)?.in === "body";
}

/**
 * Swagger 2.0 has no `requestBody`: the body of an operation is a parameter with
 * `in: body`. Until now the conversion dropped it, so both halves of crust were
 * blind to it at once — measured on the prior tree: `mock-server --validate`
 * answered **201** to `{"size":"nope"}` against a schema that requires `name`, and to
 * `"a string"`, and to `{}`, while gen-fixtures emitted **0 cases** for the spec with
 * only its generic hint to say why. That is 1,528 specs and 10,870 operations of the
 * APIs-guru corpus — a third of it, every one a Swagger 2.0 document: 10,083 declare
 * the parameter on the operation, 775 reach it through `$ref: #/parameters/…`, and 12
 * declare it once on the path item.
 *
 * Move the body parameter into the 3.x shape instead, once, here, so the mock
 * validates it and gen-fixtures writes its 400 matrix from the same schema. 2.0
 * body parameters carry `schema:` exactly as 3.x does, so this is a move, not a
 * translation; the `$ref`s inside are rewritten by the step below like any other.
 *
 * `in: formData` is deliberately NOT converted: it becomes a form body, and crust
 * does not validate non-JSON request bodies at all (docs/USAGE.md "Non-JSON request
 * bodies"), so a conversion would advertise a body nothing reads.
 *
 * Nor is a body moved onto `GET` or `HEAD`, though 9 corpus specs declare one (16 GET
 * operations, 12 of them required, in azure botservice/mariadb/mysql, hetras, n-auth,
 * ticketmaster, illumidesk). A generated fixture fetches, and `fetch` refuses a body
 * on those two methods outright, so the case would error rather than fail; and a
 * REQUIRED body there is worse — the mock would answer every GET `422 request body is
 * required but absent`, rejecting a request no client can lawfully satisfy. Leaving
 * the parameter where it was keeps those operations exactly as they are today.
 */
function moveBodyParams(
  method: string,
  op: Record<string, unknown>,
  pathParams: unknown[],
  specConsumes: unknown,
  spec: OpenApiSpec,
): void {
  // A document that mixes both dialects already says what it means — do not overwrite it.
  if (op.requestBody) return;
  // See above: no client sends that body. The same rule is applied to a native 3.x
  // requestBody in validateRequest (never required) and generate (never sent), so this
  // guard is the third layer, keeping the converted document honest.
  if (method === "get" || method === "head") return;
  const params = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
  // Operation-level parameters override path-level ones by (name, in), and only ONE
  // body parameter is legal per operation, so the first at op level wins.
  const at = params.findIndex((p) => isBodyParam(p, spec));
  const chosen = at >= 0 ? params[at] : pathParams.find((p) => isBodyParam(p, spec));
  if (chosen === undefined) return;
  const bodyParam = resolveParam(chosen, spec);
  const schema = bodyParam?.schema;
  if (!schema || typeof schema !== "object") return; // `in: body` with no schema declares nothing
  // Only an operation-level parameter is removed: the mock ignores a leftover `in: body`,
  // but a path-level one is shared by every operation under the path and is not ours to edit.
  if (at >= 0) op.parameters = params.filter((_p, i) => i !== at);
  op.requestBody = {
    required: bodyParam?.required === true,
    content: { [pickMediaType(op.consumes ?? specConsumes)]: { schema } },
  };
}

/**
 * Convert a parsed Swagger 2.0 document to the OpenAPI 3.x shape the mock server
 * consumes. Mutates and returns the same object. Safe to call only on 2.0 specs
 * (guard with `isSwagger2`).
 */
export function swagger2to3(spec: OpenApiSpec): OpenApiSpec {
  // 1. definitions -> components.schemas
  const definitions = (spec as Record<string, unknown>).definitions as
    | Record<string, unknown>
    | undefined;
  const components = (spec.components ?? {}) as { schemas?: Record<string, unknown> };
  if (definitions && typeof definitions === "object") {
    components.schemas = { ...(components.schemas ?? {}), ...definitions };
  }
  spec.components = components;
  delete (spec as Record<string, unknown>).definitions;

  // 2. wrap each response's `schema`/`examples` into `content[mediaType]`, and move each
  //    `in: body` parameter into `requestBody` (both live on the same walk, and the body
  //    has to move even for an operation that declares no responses at all)
  const specProduces = (spec as Record<string, unknown>).produces;
  const specConsumes = (spec as Record<string, unknown>).consumes;
  const paths = spec.paths ?? {};
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParams = Array.isArray((pathItem as Record<string, unknown>).parameters)
      ? ((pathItem as Record<string, unknown>).parameters as unknown[])
      : [];
    for (const [method, opUnknown] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = opUnknown as Record<string, unknown> | undefined;
      if (op && typeof op === "object")
        moveBodyParams(method.toLowerCase(), op, pathParams, specConsumes, spec);
      const responses = op?.responses as Record<string, Record<string, unknown>> | undefined;
      if (!responses || typeof responses !== "object") continue;
      const media = pickMediaType((op as Record<string, unknown>)?.produces ?? specProduces);
      for (const res of Object.values(responses)) {
        if (!res || typeof res !== "object" || res.content) continue;
        const mt: Record<string, unknown> = {};
        if ("schema" in res && res.schema !== undefined) mt.schema = res.schema;
        if (res.examples && typeof res.examples === "object") {
          const ex = res.examples as Record<string, unknown>;
          const val = ex[media] ?? Object.values(ex)[0];
          if (val !== undefined) mt.example = val;
        }
        if (Object.keys(mt).length > 0) res.content = { [media]: mt };
      }
    }
  }

  // 3. rewrite all #/definitions/* refs (incl. inside the moved schemas, the moved
  //    response schemas and any requestBody built above)
  rewriteRefs(spec);

  // 4. mark as 3.x
  spec.openapi = "3.0.0";
  delete (spec as Record<string, unknown>).swagger;
  return spec;
}
