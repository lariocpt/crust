import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envNameFor, generateFixtures, idPathFor } from "../src/genFixtures/generate";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { startServer } from "../src/mockServer/server";
import { runPipes } from "../src/testPipes/runner";

let dir: string;

const SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: {
    "/api/login": {
      post: {
        tags: ["auth"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "ok" },
          "400": { description: "Validation failed" },
          "401": { description: "Bad credentials" },
        },
      },
    },
    "/api/things/{thingId}/widgets": {
      post: {
        tags: ["widgets"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "kind", "pin"],
                additionalProperties: false,
                properties: {
                  name: { type: "string", minLength: 2 },
                  kind: { type: "string", enum: ["round", "square"] },
                  code: { type: "string", pattern: "^\\d{6}$" },
                  pin: { type: "string", pattern: "^\\d{4}$" },
                  label: { type: "string", minLength: 3, maxLength: 30 },
                  bigText: { type: "string", maxLength: 10000 },
                  count: { type: "integer", minimum: 1, maximum: 100 },
                  weight: { type: "number", maximum: Number.MAX_SAFE_INTEGER },
                  note: { anyOf: [{ type: "string", maxLength: 5 }, { type: "null" }] },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "created" },
          "400": { description: "Validation failed" },
          "401": { description: "Not authenticated" },
          "403": { description: "Not a member" },
        },
      },
    },
    "/api/invites/{token}": {
      get: {
        tags: ["invites"],
        responses: {
          "200": { description: "ok" },
          "404": { description: "Unknown token" },
        },
      },
    },
    // CRUD flow pair: POST 201 example with TOP-LEVEL id + item path.
    "/api/things": {
      post: {
        tags: ["things"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", minLength: 2 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { example: { id: "seed-thing", name: "Seed" } } },
          },
        },
      },
    },
    "/api/things/{thingId}": {
      get: {
        tags: ["things"],
        responses: { "200": { description: "ok" }, "404": { description: "gone" } },
      },
      patch: {
        tags: ["things"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string", minLength: 2 } },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
      delete: {
        tags: ["things"],
        responses: { "204": { description: "deleted" } },
      },
    },
    // Second flow (sorts BEFORE /api/things); id nested in the 201 example.
    "/api/animals": {
      post: {
        tags: ["animals"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["species"],
                properties: { species: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { example: { animal: { id: "a-0" }, status: "ok" } } },
          },
        },
      },
    },
    "/api/animals/{animalId}": {
      get: { tags: ["animals"], responses: { "200": { description: "ok" } } },
    },
    // Nested collection (userId is not the scope param) -> skipped with notice.
    "/api/users/{userId}/posts": {
      post: {
        tags: ["posts"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["title"],
                properties: { title: { type: "string" } },
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/api/users/{userId}/posts/{postId}": {
      get: { tags: ["posts"], responses: { "200": { description: "ok" } } },
    },
    // POST 2xx example has no id anywhere -> skipped with notice.
    "/api/blobs": {
      post: {
        tags: ["blobs"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: { data: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { example: { status: "ok" } } },
          },
        },
      },
    },
    "/api/blobs/{blobId}": {
      get: { tags: ["blobs"], responses: { "200": { description: "ok" } } },
    },
  },
};

const SETUP = `
export const JSON_HEADERS = { "content-type": "application/json" };
export const scopeParam = "thingId";
let cached = null;
export function shared() {
  cached ??= Promise.resolve({ thingId: "11111111-1111-4111-8111-111111111111" });
  return cached;
}
export function headersFor(ctx, role) {
  return { ...JSON_HEADERS, "x-role": role };
}
export function resolvePath(ctx, template) {
  const path = template
    .replace("{thingId}", ctx.thingId)
    .replace(/\\{\\w+\\}/g, "00000000-0000-4000-8000-000000000000");
  return "http://localhost:9" + path;
}
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-genfx-"));
  await writeFile(join(dir, "spec.json"), JSON.stringify(SPEC));
  await writeFile(join(dir, "setup.ts"), SETUP);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("gen-fixtures", () => {
  test("derives the expected case matrix per tag", async () => {
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    expect(result.files.length).toBe(3);

    const widgets = await Bun.file(result.files.find((f) => f.includes("widgets"))!).text();
    // auth-gated -> 401 case; scope-gated -> 403 case
    expect(widgets).toContain("without credentials -> 401");
    expect(widgets).toContain("as non-member -> 403");
    // per required field: missing + wrong type; enum violation for kind
    expect(widgets).toContain("missing required 'name' -> 400");
    expect(widgets).toContain("wrong type for 'name' -> 400");
    expect(widgets).toContain("invalid enum for 'kind' -> 400");

    const auth = await Bun.file(result.files.find((f) => f.includes("auth"))!).text();
    // login's 401 is "Bad credentials", NOT the middleware 401 — no case
    expect(auth).not.toContain("without credentials -> 401");
    expect(auth).toContain("missing required 'email' -> 400");

    const invites = await Bun.file(result.files.find((f) => f.includes("invites"))!).text();
    expect(invites).toContain("with unknown token -> 404");
  });

  test("generated file imports cleanly and produces well-formed inputs", async () => {
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out2"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const widgetsFile = result.files.find((f) => f.includes("widgets"))!;
    const mod = (await import(widgetsFile)) as {
      default: Array<{
        name: string;
        setup: () => Promise<unknown>;
        input: (ctx: unknown) => {
          url: string;
          method: string;
          headers: Record<string, string>;
          body?: string;
        };
        output: { status: number };
      }>;
    };
    expect(Array.isArray(mod.default)).toBe(true);
    expect(mod.default.length).toBeGreaterThanOrEqual(7);

    const ctx = await mod.default[0]!.setup();
    for (const fx of mod.default) {
      const input = fx.input(ctx);
      expect(input.url).toStartWith("http://localhost:9/api/");
      expect(input.url).toContain("11111111-1111-4111-8111-111111111111");
      expect(typeof fx.output.status).toBe("number");
      if (input.body !== undefined) {
        // bodies are pre-stringified JSON
        expect(() => JSON.parse(input.body!)).not.toThrow();
      }
    }

    // pattern sampling: the base body for widgets satisfies ^\d{6}$ when the
    // optional code field is perturbed... at minimum wrong-type cases for
    // pattern fields must use an unparseable STRING, not a number
    const wrongCode = mod.default.find((f) => f.name.includes("wrong type for 'code'"));
    if (wrongCode) {
      const body = JSON.parse(wrongCode.input(ctx).body!) as { code: unknown };
      expect(typeof body.code).toBe("string");
    }
  });

  test("boundary-violation matrix: all properties, gated + deduped, additive", async () => {
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out3"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const widgetsFile = result.files.find((f) => f.includes("widgets"))!;
    const widgets = await Bun.file(widgetsFile).text();

    // existing case names are still present — regeneration is additive
    for (const name of [
      "without credentials -> 401",
      "as non-member -> 403",
      "missing required 'name' -> 400",
      "wrong type for 'name' -> 400",
      "invalid enum for 'kind' -> 400",
    ]) {
      expect(widgets).toContain(name);
    }

    // new boundary cases — required AND optional fields
    expect(widgets).toContain("too short 'name' -> 400");
    expect(widgets).toContain("too short 'label' -> 400");
    expect(widgets).toContain("too long 'label' -> 400");
    expect(widgets).toContain("below minimum 'count' -> 400");
    expect(widgets).toContain("above maximum 'count' -> 400");
    // nullable anyOf wrapper is unwrapped (zod-style)
    expect(widgets).toContain("too long 'note' -> 400");
    // maxLength > 4096 skipped — keeps checked-in files reviewable
    expect(widgets).not.toContain("too long 'bigText'");
    // MAX_SAFE_INTEGER is an "unbounded" sentinel — no above-maximum case
    expect(widgets).not.toContain("above maximum 'weight'");
    // optional pattern field gets a case; required pattern field is already
    // covered by wrong-type's string sentinel -> deduped
    expect(widgets).toContain("pattern violation 'code' -> 400");
    expect(widgets).not.toContain("pattern violation 'pin'");
    expect(widgets).toContain("wrong type for 'pin' -> 400");
    // op-level extra property asserts status + code ONLY
    expect(widgets).toContain("unexpected extra property -> 400");
    expect(widgets).toContain('data: (d: { code?: string }) => d.code === "validation",');

    // perturbed values are what the matrix promises
    const mod = (await import(widgetsFile)) as {
      default: Array<{
        name: string;
        setup: () => Promise<unknown>;
        input: (ctx: unknown) => { body?: string };
      }>;
    };
    const ctx = await mod.default[0]!.setup();
    const bodyOf = (suffix: string): Record<string, unknown> => {
      const fx = mod.default.find((f) => f.name.includes(suffix));
      expect(fx).toBeDefined();
      return JSON.parse(fx!.input(ctx).body!) as Record<string, unknown>;
    };
    expect(bodyOf("too short 'name'").name).toBe("x");
    expect((bodyOf("too long 'label'").label as string).length).toBe(31);
    expect(bodyOf("below minimum 'count'").count).toBe(0);
    expect(bodyOf("above maximum 'count'").count).toBe(101);
    expect(bodyOf("too long 'note'").note).toBe("xxxxxx");
    expect(bodyOf("pattern violation 'code'").code).toBe("!!pattern-violation!!");
    expect(bodyOf("unexpected extra property").crustUnexpectedProp).toBe("gen-extra");

    const auth = await Bun.file(result.files.find((f) => f.includes("auth"))!).text();
    expect(auth).toContain("too short 'password' -> 400");
  });

  test("flow helpers: envNameFor and idPathFor", () => {
    expect(envNameFor("/api/things")).toBe("API_THINGS");
    expect(envNameFor("/api/things/{thingId}/sub-items")).toBe("API_THINGS_SUB_ITEMS");

    const op = (media: Record<string, unknown>) => ({
      responses: { "201": { description: "c", content: { "application/json": media } } },
    });
    expect(idPathFor(op({ example: { id: "x" } }))).toEqual(["id"]);
    expect(idPathFor(op({ example: { data: { id: "x" }, meta: {} } }))).toEqual(["data", "id"]);
    expect(
      idPathFor(op({ schema: { type: "object", properties: { id: { type: "string" } } } })),
    ).toEqual(["id"]);
    expect(
      idPathFor(
        op({
          schema: {
            type: "object",
            properties: {
              thing: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        }),
      ),
    ).toEqual(["thing", "id"]);
    expect(idPathFor(op({ example: { status: "ok" } }))).toBeNull();
    expect(idPathFor({ responses: { "204": { description: "n" } } })).toBeNull();
  });

  test("emits CRUD flows: capture lines, tombstone 404, sorted order, notices", async () => {
    const notices: string[] = [];
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out4"),
      setup: join(dir, "setup.ts"),
      log: (l) => notices.push(l),
    });
    expect(result.flowCount).toBe(2);
    expect(result.flowFile).toBe(join(dir, "out4", "flows", "flows.gen.pipes"));
    const pipes = await Bun.file(result.flowFile!).text();

    // create: base body -> status assert -> json -> capture (derived id path)
    expect(pipes).toContain(
      '{"name":"gen-value-x"} | POST $GEN_URL_API_THINGS -H "$GEN_AUTH_HEADER" | assert (r => r.status === 201) | (r => r.json()) | capture GEN_ID_API_THINGS (b => b.id)',
    );
    expect(pipes).toContain("capture GEN_ID_API_ANIMALS (b => b.animal.id)");
    // read: id must round-trip
    expect(pipes).toContain(
      'GET $GEN_URL_API_THINGS/$GEN_ID_API_THINGS -H "$GEN_AUTH_HEADER" | assert (r => r.status === 200) | (r => r.json()) | assert (j => JSON.stringify(j).includes(process.env.GEN_ID_API_THINGS ?? " "))',
    );
    // update prefers PATCH with a single-field body; {} is the DELETE trigger
    expect(pipes).toContain(
      '{"name":"gen-value-x"} | PATCH $GEN_URL_API_THINGS/$GEN_ID_API_THINGS -H "$GEN_AUTH_HEADER" | expect 200',
    );
    expect(pipes).toContain(
      '{} | DELETE $GEN_URL_API_THINGS/$GEN_ID_API_THINGS -H "$GEN_AUTH_HEADER" | expect 204',
    );
    // tombstone read-after-delete (GET documents 404)
    expect(pipes).toContain(
      'GET $GEN_URL_API_THINGS/$GEN_ID_API_THINGS -H "$GEN_AUTH_HEADER" | expect 404',
    );
    // animals has no DELETE -> no delete line and no tombstone
    expect(pipes).not.toContain("DELETE $GEN_URL_API_ANIMALS");
    expect(pipes).not.toContain('$GEN_ID_API_ANIMALS -H "$GEN_AUTH_HEADER" | expect 404');
    // flows sorted by template for byte-stable output
    expect(pipes.indexOf("# flow: /api/animals")).toBeGreaterThan(-1);
    expect(pipes.indexOf("# flow: /api/animals")).toBeLessThan(
      pipes.indexOf("# flow: /api/things"),
    );
    // SQL assertions are out of scope, and the header says so
    expect(pipes).toContain("SQL assertions are not derivable");

    // skipped-template notices
    const joined = notices.join("\n");
    expect(joined).toContain("/api/users/{userId}/posts");
    expect(joined).toContain("/api/blobs");
    expect(joined).not.toContain("skipping flow for /api/things");
  });

  test("flows.gen.setup.ts seeds GEN_AUTH_HEADER + GEN_URL_* via the setup contract", async () => {
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out5"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const setupFile = join(dir, "out5", "flows", "flows.gen.setup.ts");
    const text = await Bun.file(setupFile).text();
    expect(text).toContain('import { headersFor, resolvePath, shared } from "../../setup.ts";');

    const mod = (await import(setupFile)) as { default: () => Promise<void> };
    try {
      await mod.default();
      expect(process.env.GEN_AUTH_HEADER).toBe("x-role: member");
      expect(process.env.GEN_URL_API_THINGS).toBe("http://localhost:9/api/things");
      expect(process.env.GEN_URL_API_ANIMALS).toBe("http://localhost:9/api/animals");
    } finally {
      delete process.env.GEN_AUTH_HEADER;
      delete process.env.GEN_URL_API_THINGS;
      delete process.env.GEN_URL_API_ANIMALS;
    }
    void result;
  });

  test("generated flow round-trips create->read->update->delete->404 on the stateful mock", async () => {
    // Top-level id in the 201 example ON PURPOSE: the stateful mock stores
    // ids top-level, so a wrapped-response spec would mis-capture against
    // the MOCK (fine against real servers — documented mock limitation).
    const CRUD_SPEC = {
      openapi: "3.0.0",
      info: { title: "crud", version: "1" },
      paths: {
        "/api/things": {
          post: {
            tags: ["things"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string", minLength: 2 } },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "created",
                content: { "application/json": { example: { id: "seed-thing", name: "Seed" } } },
              },
            },
          },
        },
        "/api/things/{thingId}": {
          get: {
            tags: ["things"],
            responses: { "200": { description: "ok" }, "404": { description: "gone" } },
          },
          patch: {
            tags: ["things"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string", minLength: 2 } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
          delete: { tags: ["things"], responses: { "204": { description: "deleted" } } },
        },
      },
    };
    const CRUD_SETUP = `
export const JSON_HEADERS = { "content-type": "application/json" };
export const scopeParam = null;
let cached = null;
export function shared() {
  cached ??= Promise.resolve({ base: process.env.CRUST_GENFX_BASE });
  return cached;
}
export function headersFor(ctx, role) {
  return { ...JSON_HEADERS, authorization: "Bearer gen-" + role };
}
export function resolvePath(ctx, template) {
  return ctx.base + template;
}
`;
    await writeFile(join(dir, "crud-spec.json"), JSON.stringify(CRUD_SPEC));
    await writeFile(join(dir, "crud-setup.ts"), CRUD_SETUP);
    const srv = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: CRUD_SPEC as OpenApiSpec,
      stateful: true,
      log: () => {},
    });
    process.env.CRUST_GENFX_BASE = `http://127.0.0.1:${srv.port}`;
    try {
      const result = await generateFixtures({
        swagger: join(dir, "crud-spec.json"),
        out: join(dir, "out6"),
        setup: join(dir, "crud-setup.ts"),
        log: () => {},
      });
      expect(result.flowCount).toBe(1);
      const report = await runPipes({ target: result.flowFile! });
      expect(report.results.filter((r) => r.status === "fail")).toEqual([]);
      expect(report.totals).toEqual({ pass: 5, fail: 0, files: 1 });
    } finally {
      await srv.stop();
      delete process.env.CRUST_GENFX_BASE;
    }
  });

  test("flows setup: MULTIPLE auth headers throw at runtime naming them (never silently drop)", async () => {
    const MULTI_SETUP = `
export const JSON_HEADERS = { "content-type": "application/json" };
export const scopeParam = null;
let cached = null;
export function shared() {
  cached ??= Promise.resolve({});
  return cached;
}
export function headersFor(ctx, role) {
  return { ...JSON_HEADERS, cookie: "session=abc", "x-csrf-token": "tok-" + role };
}
export function resolvePath(ctx, template) {
  return "http://localhost:9" + template;
}
`;
    await writeFile(join(dir, "multi-setup.ts"), MULTI_SETUP);
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out9"),
      setup: join(dir, "multi-setup.ts"),
      log: () => {},
    });
    expect(result.flowCount).toBeGreaterThan(0);
    const prev = process.env.GEN_AUTH_HEADER;
    delete process.env.GEN_AUTH_HEADER;
    try {
      const mod = (await import(join(dir, "out9", "flows", "flows.gen.setup.ts"))) as {
        default: () => Promise<void>;
      };
      // Two non-content-type headers: picking ONE silently would generate
      // flows that fail mysteriously — the setup must throw, naming both.
      await expect(mod.default()).rejects.toThrow(/2 auth headers/);
      await expect(mod.default()).rejects.toThrow(/cookie/);
      await expect(mod.default()).rejects.toThrow(/x-csrf-token/);
      expect(process.env.GEN_AUTH_HEADER).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.GEN_AUTH_HEADER = prev;
    }
  });

  test("PUT-only update sends a full schema-valid body from the PUT's own schema", async () => {
    const PUT_SPEC = {
      openapi: "3.0.0",
      info: { title: "put", version: "1" },
      paths: {
        "/api/gadgets": {
          post: {
            tags: ["gadgets"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string", minLength: 2 } },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "created",
                content: { "application/json": { example: { id: "g-0", name: "Seed" } } },
              },
            },
          },
        },
        "/api/gadgets/{gadgetId}": {
          get: { tags: ["gadgets"], responses: { "200": { description: "ok" } } },
          // PUT only — no PATCH. Full-replace semantics: TWO required fields,
          // so the old single-field body would 400 on any correct server.
          put: {
            tags: ["gadgets"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name", "color"],
                    properties: {
                      name: { type: "string", minLength: 2 },
                      color: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    await writeFile(join(dir, "put-spec.json"), JSON.stringify(PUT_SPEC));
    const result = await generateFixtures({
      swagger: join(dir, "put-spec.json"),
      out: join(dir, "out10"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    expect(result.flowCount).toBe(1);
    const pipes = await Bun.file(result.flowFile!).text();
    // PUT carries the FULL schema-valid body from the PUT op's own schema
    // (both required fields), not the POST's one-field base body.
    expect(pipes).toContain(
      '{"name":"gen-value-x","color":"gen-value-x"} | PUT $GEN_URL_API_GADGETS/$GEN_ID_API_GADGETS -H "$GEN_AUTH_HEADER" | expect 200',
    );
    // The create step still uses the POST schema (name only).
    expect(pipes).toContain('{"name":"gen-value-x"} | POST $GEN_URL_API_GADGETS');
  });

  test("--no-flows suppresses the flows dir", async () => {
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out7"),
      setup: join(dir, "setup.ts"),
      flows: false,
      log: () => {},
    });
    expect(result.flowFile).toBeNull();
    expect(result.flowCount).toBe(0);
    expect(existsSync(join(dir, "out7", "flows"))).toBe(false);
  });

  test("CLI --no-flows maps through to generation", async () => {
    const { runCli } = await import("../src/genFixtures/cli");
    const code = await runCli([
      "--swagger",
      join(dir, "spec.json"),
      "--out",
      join(dir, "out8"),
      "--setup",
      join(dir, "setup.ts"),
      "--no-flows",
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "out8", "flows"))).toBe(false);
  });
});

describe("$ref dereferencing", () => {
  test("a requestBody behind $ref still yields the full 400 + boundary matrix and a flow", async () => {
    const refSpec = {
      openapi: "3.1.0",
      info: { title: "r", version: "1" },
      components: {
        schemas: {
          Gizmo: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", minLength: 2, maxLength: 10 },
              kind: { $ref: "#/components/schemas/Kind" },
            },
          },
          Kind: { type: "string", enum: ["a", "b"] },
          GizmoOut: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
        },
      },
      paths: {
        "/api/gizmos": {
          post: {
            tags: ["gizmos"],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Gizmo" } } },
            },
            responses: {
              "201": {
                description: "created",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/GizmoOut" } },
                },
              },
              "400": { description: "bad" },
            },
          },
        },
        "/api/gizmos/{gizmoId}": {
          get: {
            tags: ["gizmos"],
            responses: { "200": { description: "ok" }, "404": { description: "nope" } },
          },
          delete: {
            tags: ["gizmos"],
            responses: { "204": { description: "gone" } },
          },
        },
      },
    };
    await writeFile(join(dir, "ref-spec.json"), JSON.stringify(refSpec));
    const result = await generateFixtures({
      swagger: join(dir, "ref-spec.json"),
      out: join(dir, "ref-out"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(result.files.find((f) => f.includes("gizmos"))!).text();
    expect(text).toContain("missing required 'name' -> 400");
    expect(text).toContain("too short 'name' -> 400");
    expect(text).toContain("too long 'name' -> 400");
    expect(text).toContain("invalid enum for 'kind' -> 400");
    // Flow derivation works through the $ref'd 201 response schema.
    expect(result.flowCount).toBe(1);
    const flow = await Bun.file(result.flowFile!).text();
    expect(flow).toContain("capture GEN_ID_API_GIZMOS");
  });

  test("a cyclic $ref is cut, not an infinite loop", async () => {
    const cyclic = {
      openapi: "3.1.0",
      info: { title: "c", version: "1" },
      components: {
        schemas: {
          Node: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              next: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
      paths: {
        "/api/nodes": {
          post: {
            tags: ["nodes"],
            requestBody: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
            },
            responses: { "201": { description: "ok" }, "400": { description: "bad" } },
          },
        },
      },
    };
    await writeFile(join(dir, "cyclic-spec.json"), JSON.stringify(cyclic));
    const result = await generateFixtures({
      swagger: join(dir, "cyclic-spec.json"),
      out: join(dir, "cyclic-out"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(result.files.find((f) => f.includes("nodes"))!).text();
    expect(text).toContain("missing required 'name' -> 400");
  });
});

describe("flowOverrides", () => {
  test("skip drops a flow; body merges over the derived base", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "o", version: "1" },
      paths: {
        "/api/levies": {
          post: {
            tags: ["levies"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title", "issueDate"],
                    properties: {
                      title: { type: "string" },
                      issueDate: { type: "string", format: "date" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "ok",
                content: { "application/json": { example: { id: "x" } } },
              },
            },
          },
        },
        "/api/levies/{levyId}": {
          get: { tags: ["levies"], responses: { "200": { description: "ok" } } },
        },
        "/api/tasks": {
          post: {
            tags: ["tasks"],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title"],
                    properties: { title: { type: "string" } },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "ok",
                content: { "application/json": { example: { id: "x" } } },
              },
            },
          },
        },
        "/api/tasks/{taskId}": {
          get: { tags: ["tasks"], responses: { "200": { description: "ok" } } },
        },
      },
    };
    await writeFile(join(dir, "ov-spec.json"), JSON.stringify(spec));
    await writeFile(
      join(dir, "ov-setup.ts"),
      `${SETUP}\nexport const flowOverrides = { "/api/tasks": { skip: true }, "/api/levies": { body: { issueDate: "2026-01-01" } } };\n`,
    );
    const logs: string[] = [];
    const result = await generateFixtures({
      swagger: join(dir, "ov-spec.json"),
      out: join(dir, "ov-out"),
      setup: join(dir, "ov-setup.ts"),
      log: (l: string) => logs.push(l),
    });
    expect(result.flowCount).toBe(1);
    const flow = await Bun.file(result.flowFile!).text();
    expect(flow).toContain('"issueDate":"2026-01-01"');
    expect(flow).not.toContain("GEN_ID_API_TASKS");
    expect(logs.join("\n")).toContain("flowOverrides.skip");
  });
});

describe("response-schema emission", () => {
  test("cases whose expected status documents a schema carry output.schema", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "s", version: "1" },
      paths: {
        "/api/wombats": {
          post: {
            tags: ["wombats"],
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
            responses: {
              "201": { description: "ok" },
              "400": {
                description: "bad",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["code"],
                      properties: { code: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    await writeFile(join(dir, "schema-spec.json"), JSON.stringify(spec));
    const result = await generateFixtures({
      swagger: join(dir, "schema-spec.json"),
      out: join(dir, "schema-out"),
      setup: join(dir, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(result.files.find((f) => f.includes("wombats"))!).text();
    // The 400 matrix cases carry the documented 400 response schema…
    expect(text).toContain('schema: {"type":"object","required":["code"]');
    // …and it appears only on cases expecting 400 (the spec documents no other schemas).
    const perCase = text.split("name:").slice(1);
    for (const c of perCase) {
      if (c.includes("schema:")) expect(c).toContain("status: 400");
    }
  });
});
