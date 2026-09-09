import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec, type OpenApiSpec } from "../src/mockServer/loadSpec";
import { pickResponse, synthesizeBody } from "../src/mockServer/mockResponse";
import {
  buildRoutes,
  countColonParamPaths,
  countRegexLiteralPatterns,
  countWebhookOperations,
  matchRoute,
} from "../src/mockServer/router";
import { startServer } from "../src/mockServer/server";
import { validateSchema } from "../src/mockServer/validateRequest";

const minimalSpec = {
  openapi: "3.0.0",
  info: { title: "Pets", version: "1" },
  paths: {
    "/pets": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      post: {
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
                example: { id: 42, name: "Rex" },
              },
            },
          },
        },
      },
    },
    "/pets/{id}": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
      delete: {
        responses: { "204": { description: "deleted" } },
      },
    },
    "/pets/mine": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { mine: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          tag: { type: "string", enum: ["dog", "cat"] },
        },
      },
    },
  },
} as const;

describe("loadSpec", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "crust-mock-")));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads JSON from a local file", async () => {
    const path = `${dir}/spec.json`;
    await Bun.write(path, JSON.stringify(minimalSpec));
    const { spec, origin } = await loadSpec(path);
    expect(origin).toBe(path);
    expect(spec.paths).toBeTruthy();
    expect(Object.keys(spec.paths!).length).toBeGreaterThan(0);
  });

  test("loads YAML from a local file", async () => {
    const yaml = [
      "openapi: 3.0.0",
      "info:",
      "  title: Y",
      "  version: '1'",
      "paths:",
      "  /ping:",
      "    get:",
      "      responses:",
      "        '200':",
      "          description: ok",
      "",
    ].join("\n");
    const path = `${dir}/spec.yaml`;
    await Bun.write(path, yaml);
    const { spec } = await loadSpec(path);
    expect(spec.paths?.["/ping"]?.get).toBeTruthy();
  });

  test("loads from a URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(minimalSpec), {
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      const { spec } = await loadSpec(`http://localhost:${server.port}/spec.json`);
      expect(spec.paths!["/pets"]).toBeTruthy();
    } finally {
      server.stop();
    }
  });

  test("rejects when paths missing", async () => {
    const path = `${dir}/bad.json`;
    await Bun.write(path, JSON.stringify({ openapi: "3.0.0" }));
    await expect(loadSpec(path)).rejects.toThrow(/no 'paths'/);
  });

  test("rejects when file not found", async () => {
    await expect(loadSpec(`${dir}/nope.json`)).rejects.toThrow(/not found/);
  });

  // 3.1 made `paths` optional: a document describing only webhooks (or only reusable components)
  // is conformant and simply has nothing to serve. The control above still stands — a document
  // with none of the three is a spec we genuinely cannot use.
  test("accepts a 3.1 webhooks-only document with no paths", async () => {
    const path = `${dir}/hooks.json`;
    await Bun.write(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "h", version: "1" },
        webhooks: { newThing: { post: { responses: { "200": { description: "ok" } } } } },
      }),
    );
    const { spec } = await loadSpec(path);
    expect(spec.paths).toEqual({});
    expect(buildRoutes(spec)).toEqual([]);
    expect(countWebhookOperations(spec)).toBe(1);
  });

  test("accepts a components-only document with no paths", async () => {
    const path = `${dir}/components.json`;
    await Bun.write(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "c", version: "1" },
        components: { schemas: { Widget: { type: "object" } } },
      }),
    );
    const { spec } = await loadSpec(path);
    expect(spec.paths).toEqual({});
  });
});

describe("router", () => {
  test("compiles paths and orders literals before params", () => {
    const routes = buildRoutes(minimalSpec as unknown as OpenApiSpec);
    const templates = routes.map((r) => `${r.method} ${r.template}`);
    expect(templates).toContain("GET /pets");
    expect(templates).toContain("POST /pets");
    expect(templates).toContain("GET /pets/{id}");
    expect(templates).toContain("DELETE /pets/{id}");
    expect(templates).toContain("GET /pets/mine");
    const mineIdx = templates.indexOf("GET /pets/mine");
    const idIdx = templates.indexOf("GET /pets/{id}");
    expect(mineIdx).toBeLessThan(idIdx);
  });

  test("matches literal segment before param", () => {
    const routes = buildRoutes(minimalSpec as unknown as OpenApiSpec);
    const lookup = matchRoute(routes, "GET", "/pets/mine");
    expect(lookup.matched?.template).toBe("/pets/mine");
  });

  test("matches param route when no literal hits", () => {
    const routes = buildRoutes(minimalSpec as unknown as OpenApiSpec);
    const lookup = matchRoute(routes, "GET", "/pets/42");
    expect(lookup.matched?.template).toBe("/pets/{id}");
  });

  test("returns pathExists=true on method mismatch", () => {
    const routes = buildRoutes(minimalSpec as unknown as OpenApiSpec);
    const lookup = matchRoute(routes, "PUT", "/pets");
    expect(lookup.matched).toBeNull();
    expect(lookup.pathExists).toBe(true);
  });

  test("returns pathExists=false on unknown path", () => {
    const routes = buildRoutes(minimalSpec as unknown as OpenApiSpec);
    const lookup = matchRoute(routes, "GET", "/unknown");
    expect(lookup.matched).toBeNull();
    expect(lookup.pathExists).toBe(false);
  });
});

describe("response synthesis", () => {
  const spec = minimalSpec as unknown as OpenApiSpec;

  test("picks 200 by preference", () => {
    const op = spec.paths!["/pets"]!.get!;
    const picked = pickResponse(op);
    expect(picked.status).toBe(200);
    expect(picked.media).toBeTruthy();
  });

  test("uses provided example when present", () => {
    const op = spec.paths!["/pets"]!.post!;
    const picked = pickResponse(op);
    const body = synthesizeBody(picked.media, spec);
    expect(body).toEqual({ id: 42, name: "Rex" });
  });

  test("walks schema $ref and applies defaults + enum first", () => {
    const op = spec.paths!["/pets/{id}"]!.get!;
    const picked = pickResponse(op);
    const body = synthesizeBody(picked.media, spec) as Record<string, unknown>;
    expect(body.id).toBe(0);
    expect(body.name).toBe("string");
    expect(body.tag).toBe("dog");
  });

  test("synthesises arrays of $ref items", () => {
    const op = spec.paths!["/pets"]!.get!;
    const picked = pickResponse(op);
    const body = synthesizeBody(picked.media, spec) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect((body[0] as Record<string, unknown>).name).toBe("string");
  });

  test("cycle guard terminates on re-entry with the empty shape of the declared type", () => {
    const cyclic: OpenApiSpec = {
      openapi: "3.0.0",
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Node" } },
          },
        },
      },
    };
    const body = synthesizeBody(
      cyclic.paths!["/x"]!.get!.responses!["200"]!.content!["application/json"]!,
      cyclic,
    ) as Record<string, unknown>;
    // This assertion used to read `toBeNull()`. Terminating the recursion is still the point, but
    // `null` in a slot the spec declares `type: object` is a body crust's OWN validator rejects —
    // 15 such violations across 300 real-world specs, every one self-inflicted. `{}` stops the
    // recursion just as firmly and is a body that validates.
    expect(body.child).toEqual({});
  });

  test("204 path has no body to synthesise", () => {
    const op = spec.paths!["/pets/{id}"]!.delete!;
    const picked = pickResponse(op);
    expect(picked.status).toBe(204);
    expect(picked.media).toBeNull();
  });

  test("string formats produce sensible defaults", () => {
    const local: OpenApiSpec = {
      openapi: "3.0.0",
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        email: { type: "string", format: "email" },
                        when: { type: "string", format: "date-time" },
                        id: { type: "string", format: "uuid" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const body = synthesizeBody(
      local.paths!["/x"]!.get!.responses!["200"]!.content!["application/json"]!,
      local,
    ) as Record<string, string>;
    expect(body.email).toBe("user@example.com");
    expect(body.when).toBe("1970-01-01T00:00:00.000Z");
    expect(body.id).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("startServer end-to-end", () => {
  test("serves synthesised JSON, 405, 404, and 204 correctly", async () => {
    const logs: string[] = [];
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: minimalSpec as unknown as OpenApiSpec,
      log: (line) => logs.push(line),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const get = await fetch(`${base}/pets`);
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain("application/json");
      const arr = await get.json();
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toHaveLength(1);

      const post = await fetch(`${base}/pets`, { method: "POST" });
      expect(post.status).toBe(201);
      expect(await post.json()).toEqual({ id: 42, name: "Rex" });

      const getOne = await fetch(`${base}/pets/123`);
      expect(getOne.status).toBe(200);
      const one = (await getOne.json()) as { id: number };
      expect(one.id).toBe(0);

      const literal = await fetch(`${base}/pets/mine`);
      expect(literal.status).toBe(200);
      expect(((await literal.json()) as { mine: boolean }).mine).toBe(false);

      const del = await fetch(`${base}/pets/9`, { method: "DELETE" });
      expect(del.status).toBe(204);

      const wrongMethod = await fetch(`${base}/pets`, { method: "PUT" });
      expect(wrongMethod.status).toBe(405);

      const unknown = await fetch(`${base}/nope`);
      expect(unknown.status).toBe(404);

      expect(logs.length).toBeGreaterThanOrEqual(7);
      expect(logs[0]).toMatch(/^GET\s+\/pets\s+200/);
    } finally {
      await server.stop();
    }
  });
});

describe("cli runCli", () => {
  test("exits 2 when --swagger is missing", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    const code = await runCli([]);
    expect(code).toBe(2);
  });

  test("exits 2 on unknown flag", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    const code = await runCli(["--banana"]);
    expect(code).toBe(2);
  });

  test("exits 1 when spec cannot be loaded", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    const code = await runCli(["--swagger", "/definitely/not/here.json"]);
    expect(code).toBe(1);
  });
});

describe("stateful mode", () => {
  const SPEC = {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        get: {
          responses: {
            "200": {
              description: "list",
              content: {
                "application/json": { example: { items: [{ id: "seed", name: "Example" }] } },
              },
            },
          },
        },
        post: {
          responses: {
            "201": {
              description: "created",
              content: { "application/json": { example: { id: "seed", name: "Example" } } },
            },
          },
        },
      },
      "/things/{thingId}": {
        get: { responses: { "200": { description: "one" } } },
        patch: { responses: { "200": { description: "patched" } } },
        delete: { responses: { "204": { description: "gone" } } },
      },
      "/untouched": {
        get: {
          responses: {
            "200": {
              description: "static",
              content: { "application/json": { example: { fixed: true } } },
            },
          },
        },
      },
    },
  };

  test("POST -> GET -> PATCH -> DELETE round-trip", async () => {
    const { startServer } = await import("../src/mockServer/server");
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: SPEC as never,
      stateful: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const created = await fetch(`${base}/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Crusty" }),
      });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { id: string; name: string };
      expect(item.name).toBe("Crusty");
      expect(item.id).toBeTruthy();

      // the memory backend wraps the SAME Map exposed as server.state
      expect(server.state.get("/things")?.size).toBe(1);
      expect(await server.backend.get("/things", item.id)).toMatchObject({ name: "Crusty" });

      const got = await fetch(`${base}/things/${item.id}`);
      expect(got.status).toBe(200);
      expect(((await got.json()) as { name: string }).name).toBe("Crusty");

      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ id: string }>;
      };
      expect(list.items.some((i) => i.id === item.id)).toBe(true);

      const patched = await fetch(`${base}/things/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(((await patched.json()) as { name: string }).name).toBe("Renamed");

      const del = await fetch(`${base}/things/${item.id}`, { method: "DELETE" });
      expect(del.status).toBe(204);
      expect((await fetch(`${base}/things/${item.id}`)).status).toBe(404);

      // untouched collection still serves the example
      const untouched = (await (await fetch(`${base}/untouched`)).json()) as {
        fixed: boolean;
      };
      expect(untouched.fixed).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("non-stateful mode ignores writes (regression)", async () => {
    const { startServer } = await import("../src/mockServer/server");
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: SPEC as never,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await fetch(`${base}/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ghost" }),
      });
      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ name: string }>;
      };
      // still the spec example, not the posted item
      expect(list.items[0]!.name).toBe("Example");
      expect(server.state.size).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

describe("failure injection (/__crust/override)", () => {
  test("arm, match, consume: times:1 answers once then the mock returns", async () => {
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: minimalSpec as unknown as OpenApiSpec,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const armed = await fetch(`${base}/__crust/override`, {
        method: "PUT",
        body: JSON.stringify({
          method: "GET",
          path: "/pets",
          status: 503,
          body: { error: "simulated outage" },
          times: 1,
        }),
      });
      expect(armed.status).toBe(201);

      const first = await fetch(`${base}/pets`);
      expect(first.status).toBe(503);
      expect(((await first.json()) as { error: string }).error).toBe("simulated outage");

      const second = await fetch(`${base}/pets`);
      expect(second.status).toBe(200); // consumed — the mock is back
    } finally {
      await server.stop();
    }
  });

  test("bodyContains scopes an override to the fixture that armed it", async () => {
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: minimalSpec as unknown as OpenApiSpec,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await fetch(`${base}/__crust/override`, {
        method: "PUT",
        body: JSON.stringify({
          method: "POST",
          path: "/pets",
          status: 429,
          times: 1,
          match: { bodyContains: "uuid-mine" },
        }),
      });
      const other = await fetch(`${base}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "uuid-theirs" }),
      });
      expect(other.status).toBe(201); // sibling fixture untouched
      const mine = await fetch(`${base}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "uuid-mine" }),
      });
      expect(mine.status).toBe(429);
      const after = await fetch(`${base}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "uuid-mine" }),
      });
      expect(after.status).toBe(201); // consumed
    } finally {
      await server.stop();
    }
  });

  test("an armed override wins over --validate; GET lists; DELETE clears; bad payloads 400", async () => {
    const strictSpec = {
      openapi: "3.1.0",
      paths: {
        "/w": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    } as unknown as OpenApiSpec;
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: strictSpec,
      validate: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await fetch(`${base}/__crust/override`, {
        method: "PUT",
        body: JSON.stringify({ method: "POST", path: "/w", status: 429 }),
      });
      const listed = (await (await fetch(`${base}/__crust/override`)).json()) as {
        count: number;
      };
      expect(listed.count).toBe(1);

      // Invalid body — but the simulated upstream answers 429 regardless.
      const invalid = await fetch(`${base}/w`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrong: true }),
      });
      expect(invalid.status).toBe(429);

      expect((await fetch(`${base}/__crust/override`, { method: "DELETE" })).status).toBe(204);
      const nowValidated = await fetch(`${base}/w`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrong: true }),
      });
      expect(nowValidated.status).toBe(422); // validation is back in charge

      const bad = await fetch(`${base}/__crust/override`, {
        method: "PUT",
        body: JSON.stringify({ method: "POST", path: "no-slash", status: 201 }),
      });
      expect(bad.status).toBe(400);
      const notJson = await fetch(`${base}/__crust/override`, { method: "PUT", body: "nope" });
      expect(notJson.status).toBe(400);
    } finally {
      await server.stop();
    }
  });
});

// OpenAPI 3.1 lets `type` be an array (`["string","null"]`), the form that replaced 3.0's
// `nullable: true`. validateRequest.ts has always understood it; mockResponse.ts read `type` as a
// bare string, so an array matched no case in its switch and fell through to `default: return
// null` — every 3.1 union field was synthesised as null. For a union that does not include "null"
// that is a body crust's OWN validator rejects, which is the one thing a mock must never produce.
describe("openapi 3.1 union types", () => {
  const specOf = (schema: unknown) =>
    ({
      openapi: "3.1.0",
      info: { title: "u", version: "1" },
      paths: {
        "/u": {
          get: {
            responses: {
              "200": { description: "ok", content: { "application/json": { schema } } },
            },
          },
        },
      },
    }) as unknown as OpenApiSpec;

  test("a non-nullable union synthesises a value its own validator accepts", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: ["string", "integer"] } },
    };
    const spec = specOf(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, unknown>;
    // the bug: id was null, and "expected string | integer, got null" is a violation crust
    // reports against a body crust itself produced.
    expect(body.id).not.toBeNull();
    expect(validateSchema(body, schema, spec, "")).toEqual([]);
  });

  test("a nullable union prefers the real type over null", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: ["string", "null"] } },
    };
    const spec = specOf(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, unknown>;
    expect(typeof body.name).toBe("string");
    expect(validateSchema(body, schema, spec, "")).toEqual([]);
  });

  test("3.0 nullable and plain string forms are unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        legacy: { type: "string", nullable: true },
        plain: { type: "string" },
      },
    };
    const spec = specOf(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, unknown>;
    expect(typeof body.legacy).toBe("string");
    expect(typeof body.plain).toBe("string");
  });

  test("const and 3.1 examples are honoured over a synthesised default", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { const: "widget" },
        tag: { type: "string", examples: ["from-examples"] },
      },
    };
    const body = synthesizeBody({ schema } as never, specOf(schema)) as Record<string, unknown>;
    expect(body.kind).toBe("widget");
    expect(body.tag).toBe("from-examples");
  });
});

// A 3.1 document may describe only `webhooks` — callbacks the API SENDS — with no `paths` at all.
// Those are not endpoints to mock, so 0 routes is the right answer; serving nothing while printing
// a bare "0 route(s)" is not, because the operator cannot tell a webhooks-only spec from a spec
// crust failed to understand.
describe("openapi 3.1 webhooks-only documents", () => {
  test("countWebhooks reports the operations that are deliberately not routed", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "h", version: "1" },
      webhooks: {
        newThing: { post: { responses: { "200": { description: "ok" } } } },
        goneThing: { delete: { responses: { "204": { description: "gone" } } } },
      },
    } as unknown as OpenApiSpec;
    expect(countWebhookOperations(spec)).toBe(2);
    expect(buildRoutes(spec)).toEqual([]);
  });

  test("a spec with neither paths nor webhooks reports no webhooks", () => {
    const spec = { openapi: "3.1.0", info: { title: "e", version: "1" } } as unknown as OpenApiSpec;
    expect(countWebhookOperations(spec)).toBe(0);
  });
});

// A response object may itself be a $ref into components.responses — extremely common in
// hand-written specs (95 of tonkeeper/ton-console's 99 operations). pickMedia read `res.content`
// directly, which is undefined on a $ref node, so the mock answered 200 with a `null` body for
// every one of them while the spec documented a required object.
describe("$ref'd response objects", () => {
  const refSpec = {
    openapi: "3.1.0",
    info: { title: "r", version: "1" },
    paths: { "/keys": { get: { responses: { "200": { $ref: "#/components/responses/Keys" } } } } },
    components: {
      responses: {
        Keys: {
          description: "the keys",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["keys"],
                properties: { keys: { type: "array", items: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  } as unknown as OpenApiSpec;

  test("the documented body is synthesised, not null", () => {
    const route = buildRoutes(refSpec)[0]!;
    const picked = pickResponse(route.operation, refSpec);
    expect(picked.media).not.toBeNull();
    const body = synthesizeBody(picked.media, refSpec) as Record<string, unknown>;
    expect(body).not.toBeNull();
    expect(Array.isArray(body.keys)).toBe(true);
  });

  test("and it self-conforms: the validator accepts what the mock produced", () => {
    const route = buildRoutes(refSpec)[0]!;
    const picked = pickResponse(route.operation, refSpec);
    const schema = (picked.media as { schema?: unknown })?.schema;
    const body = synthesizeBody(picked.media, refSpec);
    expect(validateSchema(body, schema, refSpec, "")).toEqual([]);
  });

  test("an inline response object still works (control)", () => {
    const inline = {
      openapi: "3.0.0",
      info: { title: "i", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    } as unknown as OpenApiSpec;
    const route = buildRoutes(inline)[0]!;
    expect(pickResponse(route.operation, inline).media).not.toBeNull();
  });
});

// The synthesiser answered 0 for every integer/number regardless of `minimum`, so a schema saying
// `{type:"integer", minimum:1}` got a body its own validator rejects ("0 < minimum 1"). 16 of
// openconcho's 41 checkable operations failed this way — page/size pagination fields. genFixtures'
// validValue already honoured minimum; the mock did not.
describe("numeric bounds in synthesised bodies", () => {
  const wrap = (schema: unknown) =>
    ({ openapi: "3.1.0", info: { title: "n", version: "1" }, paths: {} }) as unknown as OpenApiSpec;

  test("minimum is honoured", () => {
    const schema = { type: "object", properties: { page: { type: "integer", minimum: 1 } } };
    const spec = wrap(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, number>;
    expect(body.page).toBeGreaterThanOrEqual(1);
    expect(validateSchema(body, schema, spec, "")).toEqual([]);
  });

  test("exclusiveMinimum (3.1 numeric form) is honoured", () => {
    const schema = { type: "object", properties: { n: { type: "integer", exclusiveMinimum: 5 } } };
    const spec = wrap(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, number>;
    expect(body.n).toBeGreaterThan(5);
    expect(validateSchema(body, schema, spec, "")).toEqual([]);
  });

  test("a negative maximum is honoured (0 is too big)", () => {
    const schema = { type: "object", properties: { t: { type: "integer", maximum: -3 } } };
    const spec = wrap(schema);
    const body = synthesizeBody({ schema } as never, spec) as Record<string, number>;
    expect(body.t).toBeLessThanOrEqual(-3);
    expect(validateSchema(body, schema, spec, "")).toEqual([]);
  });

  test("an unconstrained number is still 0 (control)", () => {
    const schema = { type: "object", properties: { x: { type: "integer" } } };
    const body = synthesizeBody({ schema } as never, wrap(schema)) as Record<string, number>;
    expect(body.x).toBe(0);
  });
});

// OpenAPI templates path parameters as `{id}`. Express, Zuplo and several codegen tools write
// `:id`, and a spec that does is non-conformant — but crust matched those segments LITERALLY and
// said nothing, so the mock served `GET /v1/characters/:characterId` as a literal path no client
// will ever request, and the operator got a route count that looked healthy. 7 of the 17 usable
// specs in the react corpus are written this way (21 paths), so it is a real-world shape, not a
// curiosity. crust still will not guess — rewriting someone's spec is worse — but it must say so.
describe("Express-style :param paths", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "c", version: "1" },
    paths: {
      "/v1/characters": { get: { responses: { "200": { description: "ok" } } } },
      "/v1/characters/:characterId": { get: { responses: { "200": { description: "ok" } } } },
      "/v1/locations/:locationId": { get: { responses: { "200": { description: "ok" } } } },
      "/v1/proper/{properId}": { get: { responses: { "200": { description: "ok" } } } },
    },
  } as unknown as OpenApiSpec;

  test("counts the paths that look mis-templated", () => {
    expect(countColonParamPaths(spec)).toBe(2);
  });

  test("a spec using only OpenAPI templating counts zero (control)", () => {
    const ok = {
      openapi: "3.1.0",
      info: { title: "k", version: "1" },
      paths: { "/a/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    } as unknown as OpenApiSpec;
    expect(countColonParamPaths(ok)).toBe(0);
  });

  test("the colon segment is still routed literally — crust does not rewrite the spec", () => {
    const routes = buildRoutes(spec);
    const colon = routes.find((r) => r.template === "/v1/characters/:characterId");
    expect(colon).toBeDefined();
    // literal, so a real id must NOT match it
    expect(matchRoute(routes, "GET", "/v1/characters/42").matched).toBeNull();
    expect(matchRoute(routes, "GET", "/v1/characters/:characterId").matched).toBeDefined();
    // and the properly-templated sibling still works
    expect(matchRoute(routes, "GET", "/v1/proper/42").matched).toBeDefined();
  });
});

// pickMedia already falls back to the first documented content type when there is no
// application/json — but the response was built with a hardcoded `content-type: application/json`
// regardless, so a spec documenting text/html got a JSON content-type over an HTML-ish body.
// crust's own --proxy validator rejects that ("content-type 'application/json' is not documented
// for status 200"), which makes it a crust bug by construction. self-conformance never saw it:
// it validates the BODY against the schema and never looks at the header.
describe("response content-type follows the spec", () => {
  const specOf = (mediaType: string) =>
    ({
      openapi: "3.1.0",
      info: { title: "ct", version: "1" },
      paths: {
        "/thing": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { [mediaType]: { schema: { type: "string" }, example: "hi" } },
              },
            },
          },
        },
      },
    }) as unknown as OpenApiSpec;

  test("a text/html response is served as text/html", async () => {
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: specOf("text/html"),
      log: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/thing`);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      await server.stop();
    }
  });

  test("application/javascript is served as itself", async () => {
    const spec = specOf("application/javascript");
    const server = await startServer({ port: 0, hostname: "127.0.0.1", spec, log: () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/thing`);
      expect(res.headers.get("content-type")).toContain("application/javascript");
    } finally {
      await server.stop();
    }
  });

  test("json stays json, and an undocumented content stays json (controls)", async () => {
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: specOf("application/json"),
      log: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/thing`);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await server.stop();
    }
    const bare = {
      openapi: "3.1.0",
      info: { title: "b", version: "1" },
      paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
    } as unknown as OpenApiSpec;
    const s2 = await startServer({ port: 0, hostname: "127.0.0.1", spec: bare, log: () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${s2.port}/x`);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await s2.stop();
    }
  });
});

// Same family as the numeric-bounds fix, found at scale: swept across 300 real-world specs from
// APIs-guru/openapi-directory, `stringDefault` returned the literal "string" regardless of the
// schema's own maxLength, minLength or pattern — 1,444 violations that crust's OWN validator
// rejects. genFixtures' validValue had always honoured these; the mock had not. The asymmetry is
// the tell: two crust tools reading one schema and disagreeing about what satisfies it.
describe("string bounds in synthesised bodies", () => {
  const wrap = {
    openapi: "3.1.0",
    info: { title: "s", version: "1" },
    paths: {},
  } as unknown as OpenApiSpec;
  const synth = (schema: unknown) =>
    synthesizeBody({ schema } as never, wrap) as Record<string, unknown>;

  test("maxLength is not exceeded", () => {
    const schema = { type: "object", properties: { code: { type: "string", maxLength: 3 } } };
    const body = synth(schema);
    expect(String(body.code).length).toBeLessThanOrEqual(3);
    expect(validateSchema(body, schema, wrap, "")).toEqual([]);
  });

  test("minLength is met", () => {
    const schema = { type: "object", properties: { tok: { type: "string", minLength: 12 } } };
    const body = synth(schema);
    expect(String(body.tok).length).toBeGreaterThanOrEqual(12);
    expect(validateSchema(body, schema, wrap, "")).toEqual([]);
  });

  test("a pattern is satisfied where it CAN be sampled", () => {
    const schema = { type: "object", properties: { n: { type: "string", pattern: "^\\d{3}$" } } };
    const body = synth(schema);
    expect(String(body.n)).toMatch(/^\d{3}$/);
    expect(validateSchema(body, schema, wrap, "")).toEqual([]);
  });

  // The honest limit, asserted so nobody later mistakes it for a bug or "fixes" it by inventing a
  // value that merely looks right. Character classes ARE sampled now (2026-09-09); what remains
  // beyond a structural sampler is back-references and lookaround. There the mock is knowingly
  // wrong for that field — better than confidently wrong, and the violation stays visible under
  // --validate rather than hidden behind a plausible-looking value.
  test("a pattern beyond structural sampling falls back rather than guessing", () => {
    const schema = { type: "object", properties: { n: { type: "string", pattern: "^(a)\\1$" } } };
    expect(String(synth(schema).n)).toBe("gen-value-x");
  });

  test("both bounds together are satisfiable", () => {
    const schema = {
      type: "object",
      properties: { s: { type: "string", minLength: 4, maxLength: 6 } },
    };
    const body = synth(schema);
    const len = String(body.s).length;
    expect(len).toBeGreaterThanOrEqual(4);
    expect(len).toBeLessThanOrEqual(6);
  });

  test('an unconstrained string is still "string", and a format still wins (controls)', () => {
    const plain = { type: "object", properties: { a: { type: "string" } } };
    expect(synth(plain).a).toBe("string");
    const fmt = { type: "object", properties: { e: { type: "string", format: "email" } } };
    expect(synth(fmt).e).toBe("user@example.com");
  });
});

// allOf is the OpenAPI idiom for "this, refined" and is not restricted to objects: AWS's specs
// wrap every enum as `allOf: [{$ref: '#/.../Status'}]`. generateFromSchema merged branches with
// Object.assign, which silently DISCARDS a scalar branch, so such a field synthesised `{}` — an
// empty object where an enum string belongs, rejected by crust's own validator. 4,538 occurrences
// across 300 real-world specs, and the tell is that the same schema unwrapped works fine.
describe("allOf around a scalar", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "a", version: "1" },
    components: { schemas: { Status: { type: "string", enum: ["COMPLETED", "FAILED"] } } },
    paths: {},
  } as unknown as OpenApiSpec;
  const synth = (schema: unknown) => synthesizeBody({ schema } as never, spec);

  test("allOf wrapping a $ref'd enum yields the enum value, not {}", () => {
    expect(synth({ allOf: [{ $ref: "#/components/schemas/Status" }] })).toBe("COMPLETED");
  });

  test("allOf wrapping an inline scalar yields the scalar", () => {
    expect(synth({ allOf: [{ type: "string", enum: ["A", "B"] }] })).toBe("A");
    expect(synth({ allOf: [{ type: "integer", minimum: 5 }] })).toBe(5);
  });

  test("allOf over objects still MERGES them (control)", () => {
    const merged = synth({
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "integer" } } },
      ],
    }) as Record<string, unknown>;
    expect(merged).toEqual({ a: "string", b: 0 });
  });

  test("a mixed allOf prefers the object merge (control)", () => {
    // objects present: merging is the meaningful reading; a stray scalar branch must not win
    const merged = synth({
      allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }],
    }) as Record<string, unknown>;
    expect(merged).toEqual({ a: "string" });
  });
});

// The pattern sampler used to understand only \d{n}. Across 300 real-world specs that left 6,385
// pattern violations: character classes, quantifiers and alternations are what specs actually use.
// The safety property matters more than the coverage: whatever it constructs is CHECKED against
// the real regex before being returned, so a wrong guess degrades to the neutral fallback rather
// than to a confidently wrong value. It can never make a field worse than not sampling at all.
describe("pattern sampling", () => {
  const wrap = {
    openapi: "3.1.0",
    info: { title: "p", version: "1" },
    paths: {},
  } as unknown as OpenApiSpec;
  const synth = (pattern: string, extra: Record<string, unknown> = {}) =>
    String(
      (
        synthesizeBody(
          {
            schema: { type: "object", properties: { v: { type: "string", pattern, ...extra } } },
          } as never,
          wrap,
        ) as any
      ).v,
    );

  const matches = (pattern: string, value: string) => {
    try {
      return new RegExp(pattern, "u").test(value);
    } catch {
      return new RegExp(pattern).test(value);
    }
  };

  for (const p of [
    "^[0-9]+$",
    "^[a-z]+$",
    "^[A-Za-z0-9_-]+$",
    "^[0-9]{12}$",
    "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    "^\\d{3}$",
    "^\\w+$",
    "^[a-zA-Z0-9_.-]+$",
  ]) {
    test(`satisfies ${p}`, () => {
      const v = synth(p);
      expect(matches(p, v)).toBe(true);
    });
  }

  test("a pattern it cannot construct still falls back rather than guessing", () => {
    // a back-reference is beyond a structural sampler; the value must not pretend otherwise
    expect(synth("^(a)\\1$")).toBe("gen-value-x");
  });

  test("the sampled value never violates the pattern it was built for", () => {
    // the safety property, stated directly: sample or fall back, never a confident wrong answer
    for (const p of ["^[0-9]{4}$", "^[a-z]{2,6}$", "^x[0-9]+y$"]) {
      const v = synth(p);
      expect(v === "gen-value-x" || matches(p, v)).toBe(true);
    }
  });
});

// Array bounds were ignored: `array` always synthesised exactly one element, so minItems > 1 and
// maxItems 0 both produced a body crust's own validator rejects. Same constraint-blindness family
// as the numeric and string bounds.
describe("array bounds in synthesised bodies", () => {
  const wrap = {
    openapi: "3.1.0",
    info: { title: "a", version: "1" },
    paths: {},
  } as unknown as OpenApiSpec;
  const synth = (schema: unknown) =>
    synthesizeBody({ schema } as never, wrap) as Record<string, unknown>;

  test("minItems is met", () => {
    const schema = {
      type: "object",
      properties: { xs: { type: "array", minItems: 3, items: { type: "string" } } },
    };
    const body = synth(schema);
    expect((body.xs as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(validateSchema(body, schema, wrap, "")).toEqual([]);
  });

  test("maxItems is not exceeded, including zero", () => {
    const schema = {
      type: "object",
      properties: { xs: { type: "array", maxItems: 0, items: { type: "string" } } },
    };
    const body = synth(schema);
    expect(body.xs).toEqual([]);
    expect(validateSchema(body, schema, wrap, "")).toEqual([]);
  });

  test("an unconstrained array is still a single element (control)", () => {
    const schema = {
      type: "object",
      properties: { xs: { type: "array", items: { type: "string" } } },
    };
    expect(synth(schema).xs).toEqual(["string"]);
  });
});

// A formatted value that cannot fit maxLength is a CONTRADICTORY schema — a uuid is 36 characters
// and cannot be 8. Truncating it produced "00000000", which is not a uuid and fails `format`
// instead: one violation traded for another, and the mock's data made less sense. Keeping the
// valid uuid is the better wrong answer, and it is what the docs already claimed happened.
describe("format versus an impossible maxLength", () => {
  const wrap = {
    openapi: "3.1.0",
    info: { title: "f", version: "1" },
    paths: {},
  } as unknown as OpenApiSpec;
  const synth = (schema: unknown) =>
    synthesizeBody({ schema } as never, wrap) as Record<string, unknown>;

  test("a formatted value is kept whole rather than truncated into nonsense", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "string", format: "uuid", maxLength: 8 } },
    };
    expect(synth(schema).id).toBe("00000000-0000-0000-0000-000000000000");
  });

  test("a formatted value IS padded up to minLength (control: padding stays valid-ish)", () => {
    const schema = {
      type: "object",
      properties: { e: { type: "string", format: "email", minLength: 40 } },
    };
    expect(String(synth(schema).e).length).toBeGreaterThanOrEqual(40);
  });
});

describe("length clamping never breaks a verified pattern", () => {
  // sampleFromPattern verifies its construction against the real regex before returning it. That
  // guarantee was then thrown away by the caller: stringDefault padded or truncated the value to
  // fit minLength/maxLength, so a verified "0" became "0xxxxxxxxxxx" and the fallback became "gen".
  // 153 of 668 pattern violations across 300 real-world specs were crust breaking its own value.
  // The pattern is the more specific constraint, so where the two cannot both hold, it wins.
  const body = (schema: Record<string, unknown>): Record<string, unknown> =>
    synthesizeBody(
      { schema: { type: "object", properties: { v: schema }, required: ["v"] } },
      {},
    ) as Record<string, unknown>;

  test("padding to minLength does not invalidate a satisfiable pattern", () => {
    const v = body({ type: "string", pattern: "^[0-9]{3}$", minLength: 12 }).v as string;
    expect(/^[0-9]{3}$/.test(v)).toBe(true);
  });

  test("truncating to maxLength does not invalidate a satisfiable pattern", () => {
    const v = body({ type: "string", pattern: "^[a-z]{8}$", maxLength: 3 }).v as string;
    expect(/^[a-z]{8}$/.test(v)).toBe(true);
  });

  test("an expandable quantifier is grown to meet minLength, satisfying both", () => {
    const v = body({ type: "string", pattern: "^[a-z]+$", minLength: 10 }).v as string;
    expect(/^[a-z]+$/.test(v)).toBe(true);
    expect(v.length).toBeGreaterThanOrEqual(10);
  });

  // Control: with no pattern in play the length bounds are still honoured exactly as before, so the
  // fix above cannot be "stop clamping" wearing a disguise.
  test("without a pattern, minLength and maxLength still apply", () => {
    expect((body({ type: "string", minLength: 9 }).v as string).length).toBeGreaterThanOrEqual(9);
    expect((body({ type: "string", maxLength: 2 }).v as string).length).toBeLessThanOrEqual(2);
  });
});

describe("a construct crust cannot build still respects the declared type", () => {
  // Found by classifying the residue of 300 real-world specs: after spec-supplied examples,
  // self-contradictory schemas and crust's own deliberate pattern fallback were accounted for, 40
  // violations remained and collapsed into these three shapes. All share one mistake — when crust
  // cannot construct a value it fell back to a value of the WRONG TYPE, so its own validator
  // rejected the body. A shape crust cannot fill should still be the right shape.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown> = {},
  ): Record<string, unknown> =>
    synthesizeBody(
      { schema: { type: "object", properties: { v: schema }, required: ["v"] } },
      spec,
    ) as Record<string, unknown>;

  test("a cyclic $ref under type: object yields {} rather than null", () => {
    const spec = {
      components: {
        schemas: {
          Node: { type: "object", properties: { self: { $ref: "#/components/schemas/Node" } } },
        },
      },
    };
    const v = body({ $ref: "#/components/schemas/Node" }, spec).v as Record<string, unknown>;
    expect(v).not.toBeNull();
    expect(typeof v).toBe("object");
    expect(Array.isArray(v)).toBe(false);
  });

  test("an array whose items cannot be built is still an array", () => {
    const spec = {
      components: {
        schemas: {
          Kid: {
            type: "object",
            properties: { kids: { type: "array", items: { $ref: "#/components/schemas/Kid" } } },
          },
        },
      },
    };
    const v = body({ $ref: "#/components/schemas/Kid" }, spec).v as Record<string, unknown>;
    expect(Array.isArray(v.kids)).toBe(true);
  });

  test("a documentation-only allOf branch does not discard a sibling's array", () => {
    // AWS writes every field as `allOf: [{$ref: Real}, {description}]`. The description-only branch
    // synthesises {} and, treated as a contribution, silently outranked a sibling LIST.
    const spec = {
      components: { schemas: { List: { type: "array", items: { type: "string" } } } },
    };
    const v = body(
      { allOf: [{ $ref: "#/components/schemas/List" }, { description: "the list" }] },
      spec,
    ).v;
    expect(Array.isArray(v)).toBe(true);
  });

  test("a cyclic $ref with no declared type is read from its keywords", () => {
    const spec = {
      components: {
        schemas: {
          N: { properties: { kids: { type: "array", items: { $ref: "#/components/schemas/N" } } } },
        },
      },
    };
    const v = body({ $ref: "#/components/schemas/N" }, spec).v as Record<string, unknown>;
    expect(Array.isArray((v.kids as unknown[])?.[0] ?? null)).toBe(false);
    expect((v.kids as unknown[])[0]).not.toBeNull();
  });

  test("\\uXXXX escapes inside a character class are sampled, not abandoned", () => {
    // ^[1-9][0-9]{0,2}$ written the way gamelift's spec writes it.
    const v = body({
      type: "string",
      pattern: "^[\\u0031-\\u0039][\\u0030-\\u0039]{0,2}$",
      minLength: 1,
      maxLength: 3,
    }).v as string;
    expect(/^[\u0031-\u0039][\u0030-\u0039]{0,2}$/.test(v)).toBe(true);
  });
});

describe("a required property the schema never describes", () => {
  // Found by the dogfooding residue on ton-console: `Participant` lists `date_create` in `required`
  // and defines no such property. crust omitted it and its own validator then rejected the body —
  // a self-inflicted violation. Since no schema constrains the name, ANY value satisfies it, so
  // emitting one is both legal and strictly better than emitting a body that fails.
  const body = (schema: Record<string, unknown>): Record<string, unknown> =>
    synthesizeBody({ schema }, {}) as Record<string, unknown>;

  test("the key is present, so the body satisfies its own required list", () => {
    const out = body({
      type: "object",
      required: ["id", "date_create"],
      properties: { id: { type: "integer" } },
    });
    expect(Object.hasOwn(out, "date_create")).toBe(true);
  });

  // Control: with additionalProperties: false the schema forbids the very key it requires. Nothing
  // can satisfy it, and inventing the key would break the stricter rule instead. crust leaves it,
  // and the contradiction stays visible as the spec's.
  test("additionalProperties: false makes it unsatisfiable, and crust does not paper over it", () => {
    const out = body({
      type: "object",
      additionalProperties: false,
      required: ["id", "date_create"],
      properties: { id: { type: "integer" } },
    });
    expect(Object.hasOwn(out, "date_create")).toBe(false);
  });
});

describe("a cycle terminator satisfies the schema it stands in for", () => {
  // Terminating a $ref cycle with the empty shape fixed the TYPE violation and left a `required`
  // one: {} is an object, but not one that carries the properties its schema demands. 4,663 such
  // violations across all 4,138 APIs-guru specs, the largest single group. The recursive property
  // is almost always OPTIONAL (a slot may contain a sub-slot), so generating the required
  // properties and stopping there satisfies the schema and still terminates.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): Record<string, unknown> => synthesizeBody({ schema }, spec) as Record<string, unknown>;

  const SPEC = {
    components: {
      schemas: {
        Slot: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            subSlot: { $ref: "#/components/schemas/Slot" },
          },
        },
      },
    },
  };

  test("the terminating level still carries its required properties", () => {
    const out = body({ $ref: "#/components/schemas/Slot" }, SPEC);
    const sub = out.subSlot as Record<string, unknown>;
    expect(sub).toBeDefined();
    expect(sub.name).toBeDefined();
  });

  test("and it still terminates — the nesting is finite", () => {
    const out = body({ $ref: "#/components/schemas/Slot" }, SPEC);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });

  test("a REQUIRED recursive property still bottoms out rather than looping", () => {
    const spec = {
      components: {
        schemas: {
          N: {
            type: "object",
            required: ["kid"],
            properties: { kid: { $ref: "#/components/schemas/N" } },
          },
        },
      },
    };
    const out = body({ $ref: "#/components/schemas/N" }, spec);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });
});

describe("allOf does not swallow its node's own keywords", () => {
  // The largest group in the full 4,138-spec sweep. JSON Schema keywords are INDEPENDENT: a node
  // carrying both `allOf` and its own `properties` must satisfy both, because allOf is an
  // intersection and not a replacement. crust took the allOf path and returned early, so the
  // node's own properties were dropped entirely — appcenter.ms mocks 2 of a schema's 12 fields,
  // and every one of the 10 missing required ones is a violation crust hands itself.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown> = {},
  ): Record<string, unknown> => synthesizeBody({ schema }, spec) as Record<string, unknown>;

  test("sibling properties survive alongside allOf", () => {
    const out = body({
      type: "object",
      allOf: [
        {
          type: "object",
          properties: { fromBranch: { type: "string" } },
          required: ["fromBranch"],
        },
      ],
      properties: { ownProperty: { type: "string" } },
      required: ["ownProperty"],
    });
    expect(out.fromBranch).toBeDefined();
    expect(out.ownProperty).toBeDefined();
  });

  test("it survives nesting, which is how real specs write it", () => {
    // appcenter.ms's exact shape: allOf -> [ { allOf: [inner], properties: outer } ]
    const out = body({
      type: "object",
      allOf: [
        {
          allOf: [
            { type: "object", properties: { state: { type: "string" } }, required: ["state"] },
          ],
          properties: { appVersion: { type: "string" }, count: { type: "integer" } },
          required: ["appVersion", "count"],
        },
      ],
    });
    expect(out.state).toBeDefined();
    expect(out.appVersion).toBeDefined();
    expect(out.count).toBeDefined();
  });

  // Control: an allOf with no sibling properties still behaves exactly as before, so the fix
  // cannot be "always generate the object" wearing a disguise.
  test("an allOf around a scalar is still a scalar", () => {
    const out = body({
      type: "object",
      properties: { status: { allOf: [{ type: "string", enum: ["live", "dead"] }] } },
    });
    expect(out.status).toBe("live");
  });
});

describe("a cycle through an allOf-composed schema", () => {
  // 349 of 356 sampled `type` residues were "expected object, got null", and they all sit on a
  // recursive type whose shape lives in an allOf branch — bitbucket's `comment.parent` and
  // `commit.parents` are the canonical case. Reading `type`/`properties` off the node itself finds
  // nothing there, so the cycle terminated with null: the wrong type, in a slot the schema declares.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): Record<string, unknown> => synthesizeBody({ schema }, spec) as Record<string, unknown>;

  const SPEC = {
    components: {
      schemas: {
        Comment: {
          allOf: [
            { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
            { type: "object", properties: { parent: { $ref: "#/components/schemas/Comment" } } },
          ],
        },
      },
    },
  };

  test("the cycle terminates as an object, not as null", () => {
    const out = body({ $ref: "#/components/schemas/Comment" }, SPEC);
    expect(out.parent).not.toBeNull();
    expect(typeof out.parent).toBe("object");
  });

  test("and it still carries what the composed schema requires", () => {
    const out = body({ $ref: "#/components/schemas/Comment" }, SPEC);
    expect((out.parent as Record<string, unknown>).id).toBeDefined();
  });

  test("additionalProperties alone is enough to know it is an object", () => {
    const spec = {
      components: {
        schemas: {
          Bag: {
            additionalProperties: true,
            properties: { inner: { $ref: "#/components/schemas/Bag" } },
          },
        },
      },
    };
    const out = body({ $ref: "#/components/schemas/Bag" }, spec);
    expect(out.inner).not.toBeNull();
  });
});

describe("a shared schema graph does not explode", () => {
  // presalytics.io/ooxml made synthesis issue 176 MILLION generateFromSchema calls for 134
  // responses — 25 million for a single one, 53 seconds for the file. Nothing there is recursive:
  // the schema graph is a DAG, and every path to a shared node regenerated its whole subtree.
  // A user booting mock-server against that spec sees a hang and no explanation.
  test("a DAG of shared $refs generates in linear time, not exponential", () => {
    // Each level references the one below TWICE. At depth 22 the naive walk is 4M+ nodes; with
    // shared subtrees reused it is 22. The assertion is that this returns at all, promptly.
    const schemas: Record<string, unknown> = {
      L0: { type: "object", properties: { v: { type: "string" } } },
    };
    for (let i = 1; i <= 22; i++) {
      schemas[`L${i}`] = {
        type: "object",
        properties: {
          a: { $ref: `#/components/schemas/L${i - 1}` },
          b: { $ref: `#/components/schemas/L${i - 1}` },
        },
      };
    }
    const spec = { components: { schemas } };
    const started = performance.now();
    const out = synthesizeBody({ schema: { $ref: "#/components/schemas/L22" } }, spec) as Record<
      string,
      unknown
    >;
    const elapsed = performance.now() - started;
    expect(out).toBeDefined();
    expect((out.a as Record<string, unknown>).a as Record<string, unknown>).toBeDefined();
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("a mutually recursive schema graph is bounded, not endless", () => {
  // presalytics.io/ooxml: `Slide.Slides.Details` references `Shared.*.Details` which references
  // back. With per-path cycle detection the cost of a complete body grows with the number of PATHS
  // rather than nodes — 52 million expansions for 134 responses, 53 seconds for the file, which
  // from outside is a hang with no explanation. Reuse cannot rescue it: in a mutually recursive
  // graph nearly every subtree genuinely does depend on the path that reached it.
  test("two schemas referencing each other still return promptly", () => {
    const spec = {
      components: {
        schemas: {
          A: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              b1: { $ref: "#/components/schemas/B" },
              b2: { $ref: "#/components/schemas/B" },
            },
          },
          B: {
            type: "object",
            required: ["tag"],
            properties: {
              tag: { type: "string" },
              a1: { $ref: "#/components/schemas/A" },
              a2: { $ref: "#/components/schemas/A" },
            },
          },
        },
      },
    };
    const started = performance.now();
    const out = synthesizeBody({ schema: { $ref: "#/components/schemas/A" } }, spec) as Record<
      string,
      unknown
    >;
    expect(performance.now() - started).toBeLessThan(2000);
    // Bounded, but still the shape the schema promises: truncation terminates the way a cycle does.
    expect(out.id).toBeDefined();
    expect((out.b1 as Record<string, unknown>).tag).toBeDefined();
  });
});

describe("a node's own properties narrow what it inherits through allOf", () => {
  // Azure writes `allOf: [{$ref: CustomAlertRule}]` to inherit `ruleType: {type: string}` and then
  // restates that property with an `enum` to narrow it. Merging generated VALUES cannot resolve
  // that: both precedences were measured on all 4,138 specs and both lose — letting the branch win
  // emits the inherited "string" the enum forbids, letting the node win costs 668 violations
  // elsewhere, because a node's own fragment is often the vaguer one. Keywords settle it.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): Record<string, unknown> => synthesizeBody({ schema }, spec) as Record<string, unknown>;

  const SPEC = {
    components: {
      schemas: {
        Base: {
          type: "object",
          properties: { ruleType: { type: "string" } },
          required: ["ruleType"],
        },
      },
    },
  };

  test("an enum on the node constrains a property the base left open", () => {
    const out = body(
      {
        type: "object",
        allOf: [{ $ref: "#/components/schemas/Base" }],
        properties: { ruleType: { type: "string", enum: ["Allowed", "Denied"] } },
      },
      SPEC,
    );
    expect(out.ruleType).toBe("Allowed");
  });

  test("properties that only the branch declares are still inherited", () => {
    const out = body(
      {
        type: "object",
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { type: "object", properties: { onlyOnBranch: { type: "string" } } },
        ],
        properties: { own: { type: "string" } },
      },
      SPEC,
    );
    expect(out.onlyOnBranch).toBeDefined();
    expect(out.own).toBeDefined();
    expect(out.ruleType).toBeDefined();
  });
});

describe("a discriminated union names the branch it picked", () => {
  // 28 of 61 sampled anyOf/oneOf residues carry a `discriminator`. crust picks the first branch and
  // leaves the discriminator property at its schema default — "string" — so the body it produced
  // matches NO branch of the union it came from, by crust's own validator. The value that selects
  // the chosen branch is not a guess: the mapping states it.
  const body = (
    schema: Record<string, unknown>,
    spec: Record<string, unknown>,
  ): Record<string, unknown> => synthesizeBody({ schema }, spec) as Record<string, unknown>;

  const SPEC = {
    components: {
      schemas: {
        Cat: {
          type: "object",
          properties: { petType: { type: "string" }, meow: { type: "string" } },
          required: ["petType"],
        },
        Dog: {
          type: "object",
          properties: { petType: { type: "string" }, bark: { type: "string" } },
          required: ["petType"],
        },
      },
    },
  };

  test("an explicit mapping supplies the discriminator value", () => {
    const out = body(
      {
        oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
        discriminator: {
          propertyName: "petType",
          mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
        },
      },
      SPEC,
    );
    expect(out.petType).toBe("cat");
  });

  test("with no mapping the schema name is the value, which is the spec's own default rule", () => {
    const out = body(
      {
        oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
        discriminator: { propertyName: "petType" },
      },
      SPEC,
    );
    expect(out.petType).toBe("Cat");
  });

  // Control: a branch that pins the discriminator itself is already correct and must not be
  // overwritten — the spec said what that value is, and it outranks anything inferred.
  test("a branch that pins the discriminator keeps its own value", () => {
    const spec = {
      components: {
        schemas: {
          Fixed: { type: "object", properties: { kind: { type: "string", const: "already-set" } } },
        },
      },
    };
    const out = body(
      {
        oneOf: [{ $ref: "#/components/schemas/Fixed" }],
        discriminator: { propertyName: "kind", mapping: { other: "#/components/schemas/Fixed" } },
      },
      spec,
    );
    expect(out.kind).toBe("already-set");
  });
});

describe("a discriminator declared the inheritance way", () => {
  // What real specs actually do. The specification's own example puts `oneOf` + discriminator on a
  // BASE; apple.com/sirikit-cloud-media — and most of the corpus — does the reverse: the derived
  // schema carries `allOf: [{$ref: Base}]` together with the discriminator whose mapping names the
  // keys that select it. Several keys may select the same schema; any of them is correct, and the
  // plain "string" default is not.
  test("the property takes a mapping key that selects this schema", () => {
    const spec = {
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { method: { type: "string" } },
            required: ["method"],
          },
          Derived: {
            type: "object",
            allOf: [{ $ref: "#/components/schemas/Base" }],
            properties: { detail: { type: "string" } },
            discriminator: {
              propertyName: "method",
              mapping: {
                "Thing.handle": "#/components/schemas/Derived",
                "Thing.confirm": "#/components/schemas/Derived",
              },
            },
          },
        },
      },
    };
    const out = synthesizeBody(
      { schema: { $ref: "#/components/schemas/Derived" } },
      spec,
    ) as Record<string, unknown>;
    expect(["Thing.handle", "Thing.confirm"]).toContain(out.method as string);
  });
});

describe("a required array of a recursive type terminates as empty", () => {
  // bbc.co.uk: `ChildCategory` requires both `category_type` and `child_categories`, and
  // `child_categories` is an array of ChildCategory. The cycle terminator filled the array with one
  // element, and that element — being the terminating level — carried none of ITS required
  // properties. The nesting is finite but every level below the first is invalid.
  //
  // Such a schema is not unsatisfiable: the EMPTY array satisfies `required` and is finite. That is
  // the answer the schema itself offers, and crust was declining to take it.
  test("the recursive array is empty rather than holding an invalid element", () => {
    const spec = {
      components: {
        schemas: {
          Cat: {
            type: "object",
            required: ["name", "kids"],
            properties: {
              name: { type: "string" },
              kids: { type: "array", items: { $ref: "#/components/schemas/Cat" } },
            },
          },
        },
      },
    };
    const out = synthesizeBody({ schema: { $ref: "#/components/schemas/Cat" } }, spec) as Record<
      string,
      unknown
    >;
    expect(out.name).toBeDefined();
    const kids = out.kids as unknown[];
    expect(Array.isArray(kids)).toBe(true);
    // Whatever depth it stops at, no level may be an object missing its own required properties.
    const check = (node: Record<string, unknown>): void => {
      expect(node.name).toBeDefined();
      expect(Array.isArray(node.kids)).toBe(true);
      for (const kid of node.kids as Record<string, unknown>[]) check(kid);
    };
    check(out);
  });

  // Control: minItems still wins where the spec asks for elements, even inside a cycle.
  test("minItems is still honoured on a recursive array", () => {
    const spec = {
      components: {
        schemas: {
          Node: {
            type: "object",
            required: ["kids"],
            properties: {
              kids: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    };
    const out = synthesizeBody({ schema: { $ref: "#/components/schemas/Node" } }, spec) as Record<
      string,
      unknown
    >;
    expect((out.kids as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe("oneOf/anyOf does not swallow its node's own properties", () => {
  // The same mistake as the allOf one, in the other combinator. JSON Schema keywords are
  // independent: a node carrying `oneOf` AND its own `properties` must satisfy both. Real specs use
  // `oneOf` purely to express "one of these REQUIRED sets", with the actual properties declared on
  // the node — influxdata writes exactly that. crust took the branch, found `{required: [...]}` with
  // no type and no properties, and produced `null` for the whole object.
  const body = (schema: Record<string, unknown>, spec: Record<string, unknown> = {}): unknown =>
    synthesizeBody({ schema }, spec);

  test("a oneOf of required-sets keeps the node's properties", () => {
    const out = body({
      type: "object",
      oneOf: [{ required: ["orgID"] }, { required: ["org"] }],
      properties: { orgID: { type: "string" }, bucketID: { type: "string" } },
    }) as Record<string, unknown>;
    expect(out).not.toBeNull();
    expect(out.orgID).toBeDefined();
    expect(out.bucketID).toBeDefined();
  });

  test("the same holds for anyOf", () => {
    const out = body({
      type: "object",
      anyOf: [{ required: ["a"] }],
      properties: { a: { type: "string" } },
    }) as Record<string, unknown>;
    expect(out.a).toBeDefined();
  });

  // Control: a union whose branches carry the real content still uses them, and a union with no
  // sibling properties is untouched.
  test("a union whose branches carry the content is unchanged", () => {
    const out = body({
      oneOf: [{ type: "object", properties: { fromBranch: { type: "string" } } }],
    }) as Record<string, unknown>;
    expect(out.fromBranch).toBeDefined();
  });
});

describe("an optional property crust cannot represent is omitted", () => {
  // telegram.org: Message -> pinned_message -> Chat -> pinned_message -> Message. `Chat` is reached
  // outside the cycle so it generates ALL its properties, including the OPTIONAL `pinned_message`,
  // which re-enters the cycle and came back as `{}` — an object carrying none of Message's required
  // fields. 138 violations in one spec.
  //
  // An optional property may simply be absent, and absent always validates. Emitting a value known
  // to be invalid is strictly worse than emitting nothing, which is the whole of this fix.
  const SPEC = {
    components: {
      schemas: {
        Message: {
          type: "object",
          required: ["message_id", "chat"],
          properties: {
            message_id: { type: "integer" },
            chat: { $ref: "#/components/schemas/Chat" },
            // Optional and self-referential: this is the edge that reaches the marker level.
            pinned_message: { $ref: "#/components/schemas/Message" },
          },
        },
        Chat: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "integer" },
            pinned_message: { $ref: "#/components/schemas/Message" },
          },
        },
      },
    },
  };

  test("no object in the body is missing its own required properties", () => {
    const out = synthesizeBody(
      { schema: { $ref: "#/components/schemas/Message" } },
      SPEC,
    ) as Record<string, unknown>;
    const walkMessage = (m: Record<string, unknown>): void => {
      expect(m.message_id).toBeDefined();
      expect(m.chat).toBeDefined();
      walkChat(m.chat as Record<string, unknown>);
      if (m.pinned_message !== undefined) walkMessage(m.pinned_message as Record<string, unknown>);
    };
    const walkChat = (c: Record<string, unknown>): void => {
      expect(c.id).toBeDefined();
      // Optional: present or absent, but never present-and-invalid.
      if (c.pinned_message !== undefined) walkMessage(c.pinned_message as Record<string, unknown>);
    };
    walkMessage(out);
  });

  // Control: a required property that cannot be represented is still PRESENT, because absent would
  // fail `required` outright — the empty shape remains the least-bad answer there.
  test("a required property that cannot be represented is still present", () => {
    const spec = {
      components: {
        schemas: {
          A: {
            type: "object",
            required: ["b"],
            properties: { b: { $ref: "#/components/schemas/B" } },
          },
          B: {
            type: "object",
            required: ["a"],
            properties: { a: { $ref: "#/components/schemas/A" } },
          },
        },
      },
    };
    const out = synthesizeBody({ schema: { $ref: "#/components/schemas/A" } }, spec) as Record<
      string,
      unknown
    >;
    expect(out.b).toBeDefined();
  });
});

describe("format and pattern on the same string", () => {
  // peertube declares `{format: "uri", pattern: "magnet:\\?xt=urn:..."}`. crust took the format
  // default — "https://example.com" — and never looked at the pattern, so it emitted a value the
  // field's own regex rejects. sinao.app's `nic` and `code_naf` fail the same way, and its unions
  // then fail on top of them.
  //
  // The pattern is the narrower statement: a format names a family of values, a pattern names which
  // of them. So the format default is used only when it actually satisfies the pattern.
  const body = (schema: Record<string, unknown>): Record<string, unknown> =>
    synthesizeBody(
      { schema: { type: "object", properties: { v: schema }, required: ["v"] } },
      {},
    ) as Record<string, unknown>;

  test("a pattern the format default cannot satisfy is sampled instead", () => {
    const v = body({ type: "string", format: "uri", pattern: "^magnet:[a-z0-9]{6}$" }).v as string;
    expect(/^magnet:[a-z0-9]{6}$/.test(v)).toBe(true);
  });

  // Control: where the format default DOES satisfy the pattern, it is kept — it is the more useful
  // value, and there is no conflict to resolve.
  test("a format default that satisfies the pattern is kept", () => {
    const v = body({ type: "string", format: "uri", pattern: "^https://" }).v as string;
    expect(v).toBe("https://example.com");
  });

  // Control: format alone is untouched.
  test("format alone still wins", () => {
    expect(body({ type: "string", format: "uuid" }).v).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("patterns written as JavaScript regex literals", () => {
  // sinao.app writes both of its patterns as `/^[0-9]{5}$/i` — delimiters and flags included — where
  // JSON Schema wants a bare regex. The leading slash is then a literal character, so no value can
  // satisfy the pattern: every response carrying one is unsatisfiable, silently, because the failure
  // looks like ordinary validation noise. crust does not rewrite them (guessing at what a spec meant
  // is how a mock starts lying) — it names them, as it does Express-style `:param` paths.
  test("they are counted so the boot line can report them", () => {
    const spec = {
      components: {
        schemas: {
          A: {
            type: "object",
            properties: {
              nic: { type: "string", pattern: "/^[0-9]{5}$/i" },
              naf: { type: "string", pattern: "/^[0-9]{4}[a-z]$/" },
              fine: { type: "string", pattern: "^[0-9]{5}$" },
            },
          },
        },
      },
    };
    expect(countRegexLiteralPatterns(spec)).toBe(2);
  });

  test("a bare pattern that merely contains slashes is not one", () => {
    const spec = { components: { schemas: { A: { pattern: "^/api/v[0-9]+/things$" } } } };
    expect(countRegexLiteralPatterns(spec)).toBe(0);
  });
});
