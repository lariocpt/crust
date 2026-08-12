import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec, type OpenApiSpec } from "../src/mockServer/loadSpec";
import { pickResponse, synthesizeBody } from "../src/mockServer/mockResponse";
import { buildRoutes, matchRoute } from "../src/mockServer/router";
import { startServer } from "../src/mockServer/server";

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

  test("cycle guard returns null on re-entry", () => {
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
    expect(body.child).toBeNull();
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
    const server = startServer({
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
      const one = await getOne.json();
      expect(one.id).toBe(0);

      const literal = await fetch(`${base}/pets/mine`);
      expect(literal.status).toBe(200);
      expect((await literal.json()).mine).toBe(false);

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
