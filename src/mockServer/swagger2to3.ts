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

/** Choose the response media type from a 2.0 `produces` list (prefer JSON). */
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

  // 2. wrap each response's `schema`/`examples` into `content[mediaType]`
  const specProduces = (spec as Record<string, unknown>).produces;
  const paths = spec.paths ?? {};
  for (const pathItem of Object.values(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, opUnknown] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = opUnknown as Record<string, unknown> | undefined;
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

  // 3. rewrite all #/definitions/* refs (incl. inside the moved schemas)
  rewriteRefs(spec);

  // 4. mark as 3.x
  spec.openapi = "3.0.0";
  delete (spec as Record<string, unknown>).swagger;
  return spec;
}
