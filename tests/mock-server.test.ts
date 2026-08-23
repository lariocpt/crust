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
