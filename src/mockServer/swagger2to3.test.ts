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
