import { describe, expect, test } from "bun:test";
import type { OpenApiSpec } from "./loadSpec";
import { pickResponse, synthesizeBody } from "./mockResponse";
import { buildRoutes, matchRoute } from "./router";
import { isSwagger2, swagger2to3 } from "./swagger2to3";

function sampleV2(): OpenApiSpec {
  return {
    swagger: "2.0",
    produces: ["application/json"],
    paths: {
      "/component": {
        post: {
          responses: {
            "200": { description: "ok", schema: { $ref: "#/definitions/ComponentResponse" } },
          },
        },
      },
    },
    definitions: {
      ComponentResponse: {
        type: "object",
        properties: {
          correlationId: { type: "string", example: "abc-123" },
          status: { type: "string", example: "Success" },
          outputs: { type: "array", items: { $ref: "#/definitions/ApiOutput" } },
        },
      },
      ApiOutput: {
        type: "object",
        properties: { status: { type: "string", example: "Success" } },
      },
    },
  } as OpenApiSpec;
}

describe("swagger2to3", () => {
  test("detects Swagger 2.0", () => {
    expect(isSwagger2(sampleV2())).toBe(true);
    expect(isSwagger2({ openapi: "3.0.3", paths: {} } as OpenApiSpec)).toBe(false);
  });

  test("normalises definitions, response schema, and $refs", () => {
    const spec = swagger2to3(sampleV2());
    // definitions moved to components.schemas
    expect((spec as Record<string, unknown>).definitions).toBeUndefined();
    expect(spec.components?.schemas?.ComponentResponse).toBeDefined();
    // response.schema wrapped into content["application/json"]
    const op = spec.paths!["/component"]!.post!;
    const media = op.responses!["200"]!.content!["application/json"]!;
    expect(media.schema).toBeDefined();
    // $ref rewritten to #/components/schemas/*
    expect((media.schema as { $ref: string }).$ref).toBe("#/components/schemas/ComponentResponse");
    expect(spec.openapi).toBe("3.0.0");
  });

  test("mock pipeline generates a body from the converted spec", () => {
    const spec = swagger2to3(sampleV2());
    const routes = buildRoutes(spec);
    const { matched } = matchRoute(routes, "POST", "/component");
    expect(matched).not.toBeNull();
    const { status, media } = pickResponse(matched!.operation);
    expect(status).toBe(200);
    const body = synthesizeBody(media, spec) as Record<string, unknown>;
    // refs resolve through components.schemas; schema-level examples win.
    expect(body.correlationId).toBe("abc-123");
    expect(body.status).toBe("Success");
    expect(Array.isArray(body.outputs)).toBe(true);
    expect((body.outputs as Array<Record<string, unknown>>)[0]!.status).toBe("Success");
  });
});

// Swagger 2.0 has no requestBody — an operation's body is a parameter with `in: body`.
// Dropping that parameter left 1,443 specs / 10,083 operations of the APIs-guru corpus with
// no body at all for either half of crust: `--validate` answered the documented status to a
// body violating a required field, and gen-fixtures wrote 0 cases. See F47.
function bodyV2(over?: Record<string, unknown>): OpenApiSpec {
  return {
    swagger: "2.0",
    consumes: ["application/json"],
    paths: {
      "/widgets": {
        post: {
          parameters: [
            { name: "dry", in: "query", type: "boolean" },
            { name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Widget" } },
          ],
          responses: { "201": { description: "created" }, "400": { description: "bad" } },
        },
      },
      ...(over as object),
    },
    definitions: {
      Widget: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, size: { type: "integer" } },
      },
    },
    parameters: {
      SharedBody: {
        name: "body",
        in: "body",
        required: true,
        schema: { $ref: "#/definitions/Widget" },
      },
    },
  } as unknown as OpenApiSpec;
}

describe("an `in: body` parameter becomes a requestBody (F47)", () => {
  test("the move: schema, required flag, media type, and the parameter removed", () => {
    const spec = swagger2to3(bodyV2());
    const op = spec.paths!["/widgets"]!.post!;
    const rb = op.requestBody as unknown as Record<string, unknown>;
    expect(rb.required).toBe(true);
    const media = (rb.content as Record<string, Record<string, unknown>>)["application/json"];
    expect((media.schema as { $ref: string }).$ref).toBe("#/components/schemas/Widget");
    // the body parameter is gone from `parameters`, the query parameter is not
    const left = op.parameters as unknown as Array<Record<string, unknown>>;
    expect(left.map((p) => p.in)).toEqual(["query"]);
  });

  test("operation-level `consumes` wins; a non-JSON one is carried, not rewritten to JSON", () => {
    // crust does not validate non-JSON request bodies (docs/USAGE.md), and gen-fixtures
    // reads only application/json — so carrying the declared type honestly is what keeps
    // the two halves in agreement instead of inventing a body neither side reads.
    const spec = swagger2to3(
      bodyV2({
        "/upload": {
          post: {
            consumes: ["application/x-www-form-urlencoded"],
            parameters: [{ name: "body", in: "body", schema: { type: "object" } }],
            responses: { "201": { description: "ok" } },
          },
        },
      }),
    );
    const rb = spec.paths!["/upload"]!.post!.requestBody as Record<string, Record<string, unknown>>;
    expect(Object.keys(rb.content)).toEqual(["application/x-www-form-urlencoded"]);
  });

  test("a body parameter shared through #/parameters is resolved and moved", () => {
    const spec = swagger2to3(
      bodyV2({
        "/shared": {
          post: {
            parameters: [{ $ref: "#/parameters/SharedBody" }],
            responses: { "201": { description: "ok" }, "400": { description: "bad" } },
          },
        },
      }),
    );
    const rb = spec.paths!["/shared"]!.post!.requestBody as Record<string, unknown>;
    expect(rb.required).toBe(true);
    const media = (rb.content as Record<string, Record<string, unknown>>)["application/json"];
    expect((media.schema as { $ref: string }).$ref).toBe("#/components/schemas/Widget");
  });

  test("a path-level body parameter reaches every operation of the path", () => {
    const spec = swagger2to3({
      swagger: "2.0",
      paths: {
        "/things": {
          parameters: [{ name: "body", in: "body", required: true, schema: { type: "object" } }],
          post: { responses: { "201": { description: "ok" } } },
          put: { responses: { "200": { description: "ok" } } },
        },
      },
    } as unknown as OpenApiSpec);
    const item = spec.paths!["/things"]!;
    expect(item.post!.requestBody).toBeDefined();
    expect(item.put!.requestBody).toBeDefined();
    // a shared parameter is not the converter's to delete — every operation still needs it
    expect((item.parameters as unknown as unknown[]).length).toBe(1);
  });

  test("controls: nothing is invented where no body was declared", () => {
    const spec = swagger2to3(
      bodyV2({
        // already declares a body in the 3.x shape — the document's own answer wins
        "/mixed": { post: { requestBody: { content: { "text/plain": {} } }, responses: {} } },
        // `in: formData` — a form body, which crust documents as unvalidated
        "/form": {
          post: {
            parameters: [{ name: "caption", in: "formData", type: "string" }],
            responses: { "201": { description: "ok" } },
          },
        },
        // `in: body` with no schema declares nothing
        "/hollow": {
          post: {
            parameters: [{ name: "body", in: "body" }],
            responses: { "201": { description: "ok" } },
          },
        },
      }),
    );
    const paths = spec.paths!;
    expect((paths["/mixed"]!.post!.requestBody as Record<string, unknown>).content).toEqual({
      "text/plain": {},
    });
    expect(paths["/form"]!.post!.requestBody).toBeUndefined();
    expect(paths["/hollow"]!.post!.requestBody).toBeUndefined();
    // and the query parameter of /widgets did not become a body
    expect(paths["/widgets"]!.post!.requestBody).toBeDefined();
  });
});
