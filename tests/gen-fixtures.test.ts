import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derefSchemas,
  envNameFor,
  generateFixtures,
  idPathFor,
  validValue,
  wrongTypeFor,
} from "../src/genFixtures/generate";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { startServer } from "../src/mockServer/server";
import { validateSchema } from "../src/mockServer/validateRequest";
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
    // Flat 201 example (top-level id) — the wrapped-envelope variant is the
    // next test; the mock now handles both.
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
    const srv = await startServer({
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

  test("wrapped-response spec: the generated flow passes against the envelope-aware stateful mock", async () => {
    // The 201 example wraps the entity — the capture is b.gadget.id. Before
    // envelope-aware CRUD this mis-captured the stale example id against the
    // mock (the documented limitation); it must round-trip now.
    const WRAPPED_CRUD_SPEC = {
      openapi: "3.0.0",
      info: { title: "wrapped-crud", version: "1" },
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
                content: { "application/json": { example: { gadget: { id: "x" } } } },
              },
            },
          },
        },
        "/api/gadgets/{gadgetId}": {
          get: {
            tags: ["gadgets"],
            responses: { "200": { description: "ok" }, "404": { description: "gone" } },
          },
          patch: {
            tags: ["gadgets"],
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
          delete: { tags: ["gadgets"], responses: { "204": { description: "deleted" } } },
        },
      },
    };
    const WRAPPED_SETUP = `
export const JSON_HEADERS = { "content-type": "application/json" };
export const scopeParam = null;
let cached = null;
export function shared() {
  cached ??= Promise.resolve({ base: process.env.CRUST_GENFX_WRAP_BASE });
  return cached;
}
export function headersFor(ctx, role) {
  return { ...JSON_HEADERS, authorization: "Bearer gen-" + role };
}
export function resolvePath(ctx, template) {
  return ctx.base + template;
}
`;
    await writeFile(join(dir, "wrapped-crud-spec.json"), JSON.stringify(WRAPPED_CRUD_SPEC));
    await writeFile(join(dir, "wrapped-crud-setup.ts"), WRAPPED_SETUP);
    const srv = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: WRAPPED_CRUD_SPEC as OpenApiSpec,
      stateful: true,
      log: () => {},
    });
    process.env.CRUST_GENFX_WRAP_BASE = `http://127.0.0.1:${srv.port}`;
    try {
      const result = await generateFixtures({
        swagger: join(dir, "wrapped-crud-spec.json"),
        out: join(dir, "out-wrapped"),
        setup: join(dir, "wrapped-crud-setup.ts"),
        log: () => {},
      });
      expect(result.flowCount).toBe(1);
      const pipes = await Bun.file(result.flowFile!).text();
      expect(pipes).toContain("capture GEN_ID_API_GADGETS (b => b.gadget.id)");
      const report = await runPipes({ target: result.flowFile! });
      expect(report.results.filter((r) => r.status === "fail")).toEqual([]);
      expect(report.totals).toEqual({ pass: 5, fail: 0, files: 1 });
    } finally {
      await srv.stop();
      delete process.env.CRUST_GENFX_WRAP_BASE;
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

  test("a setup module without scopeParam fails loudly", async () => {
    await writeFile(join(dir, "no-scope-setup.ts"), "export const JSON_HEADERS = {};\n");
    await expect(
      generateFixtures({
        swagger: join(dir, "spec.json"),
        out: join(dir, "out9"),
        setup: join(dir, "no-scope-setup.ts"),
        log: () => {},
      }),
    ).rejects.toThrow(/must export scopeParam/);
  });

  test("CLI prints the derivation hint when zero cases generate", async () => {
    const bareSpec = {
      openapi: "3.1.0",
      info: { title: "bare", version: "1" },
      paths: {
        "/ping": {
          get: {
            tags: ["ping"],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    await writeFile(join(dir, "bare-spec.json"), JSON.stringify(bareSpec));
    const { runCli } = await import("../src/genFixtures/cli");
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli([
        "--swagger",
        join(dir, "bare-spec.json"),
        "--out",
        join(dir, "out10"),
        "--setup",
        join(dir, "setup.ts"),
        "--no-flows",
      ]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = realWrite;
    }
    const out = written.join("");
    expect(out).toContain("generated 0 cases");
    expect(out).toContain("DOCUMENTED responses");
    expect(out).toContain("examples/gen-setup.ts");
  });

  test("examples/gen-setup.ts satisfies the setup contract against a real spec", async () => {
    // Staleness guard: the shipped example must keep generating cases —
    // generation only reads scopeParam/scopeRoots, so its lazy fetch
    // helpers never run here.
    const result = await generateFixtures({
      swagger: join(dir, "spec.json"),
      out: join(dir, "out11"),
      setup: `${import.meta.dir}/../examples/gen-setup.ts`,
      flows: false,
      log: () => {},
    });
    expect(result.totalCases).toBeGreaterThan(0);
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

// OpenAPI 3.1 `type: ["string","null"]` reached the boundary matrix as a non-string, so
// `fs.type === "string"` was false and minLength/maxLength cases were never emitted. The
// generator did not fail — it produced nothing for those fields and reported success, which is
// the false pass design rule 1 forbids. wrongTypeFor had the same blind spot via its switch.
describe("openapi 3.1 union types in generated fixtures", () => {
  test("wrongTypeFor picks a genuinely wrong type for a 3.1 union", () => {
    // a union of string|null must be violated by a NUMBER, not by null (null is legal here)
    expect(typeof wrongTypeFor({ type: ["string", "null"] } as never)).toBe("number");
    // numeric union must be violated by a string
    expect(typeof wrongTypeFor({ type: ["integer", "null"] } as never)).toBe("string");
    // 3.0 forms unchanged
    expect(typeof wrongTypeFor({ type: "string" } as never)).toBe("number");
    expect(typeof wrongTypeFor({ type: "integer" } as never)).toBe("string");
  });

  test("length boundary cases are still generated for a 3.1 nullable string", async () => {
    const spec31 = {
      openapi: "3.1.0",
      info: { title: "b", version: "1" },
      paths: {
        "/things": {
          post: {
            tags: ["things"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: ["string", "null"], minLength: 3, maxLength: 8 } },
                  },
                },
              },
            },
            responses: { "201": { description: "created" }, "400": { description: "bad" } },
          },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "crust-gen31-"));
    try {
      await writeFile(join(dir, "spec.json"), JSON.stringify(spec31));
      await writeFile(join(dir, "setup.ts"), SETUP);
      const result = await generateFixtures({
        swagger: join(dir, "spec.json"),
        out: join(dir, "out"),
        setup: join(dir, "setup.ts"),
        flows: false,
        log: () => {},
      });
      const text = await Bun.file(result.files[0]!).text();
      // before the fix these were absent: the boundary matrix skipped the field entirely
      expect(text).toContain("too short");
      expect(text).toContain("too long");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("derefSchemas does not materialise an exponential tree", () => {
  // azure's network-applicationGateway is a DAG: a few schemas, each referenced from many places.
  // Inlining a FRESH deep copy at every occurrence turned a few-MB spec into a 2.03 GB structure —
  // 8 seconds on the versions that survived, and OUT OF MEMORY on five of the nine. `gen-fixtures`
  // against those specs does not run slowly; it does not run.
  //
  // The resolved form of a ref is the same wherever it appears, so it is resolved once and shared.
  test("a DAG of shared refs stays linear", () => {
    const schemas: Record<string, unknown> = {
      Leaf: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    };
    // Each level references the one below eight times. At depth 8 the copying walk is 8^8 nodes.
    for (let i = 1; i <= 8; i++) {
      const props: Record<string, unknown> = {};
      for (let k = 0; k < 8; k++)
        props[`k${k}`] = { $ref: `#/components/schemas/${i === 1 ? "Leaf" : `L${i - 1}`}` };
      schemas[`L${i}`] = { type: "object", properties: props };
    }
    const spec = { components: { schemas } } as never;
    const started = performance.now();
    const out = derefSchemas({ $ref: "#/components/schemas/L8" }, spec) as Record<string, unknown>;
    expect(performance.now() - started).toBeLessThan(2000);
    // Still correct: the leaf is reachable through the whole depth.
    let node: Record<string, unknown> = out;
    for (let i = 0; i < 8; i++)
      node = (node.properties as Record<string, Record<string, unknown>>).k0;
    expect((node.properties as Record<string, unknown>).a).toEqual({ type: "string" });
  });

  // Control: a cyclic ref is still cut to {}, which is the documented behaviour — a cyclic request
  // body cannot be instantiated as a finite valid example.
  test("a cyclic ref is still cut", () => {
    const spec = {
      components: {
        schemas: {
          N: { type: "object", properties: { self: { $ref: "#/components/schemas/N" } } },
        },
      },
    } as never;
    const out = derefSchemas({ $ref: "#/components/schemas/N" }, spec) as Record<string, unknown>;
    expect((out.properties as Record<string, unknown>).self).toEqual({});
  });

  // Control: $ref siblings still merge over the resolved target.
  test("siblings still override the resolved target", () => {
    const spec = {
      components: { schemas: { S: { type: "string", description: "base" } } },
    } as never;
    const out = derefSchemas(
      { $ref: "#/components/schemas/S", description: "mine" },
      spec,
    ) as Record<string, unknown>;
    expect(out.type).toBe("string");
    expect(out.description).toBe("mine");
  });
});

describe("the generator infers a missing type", () => {
  // `{properties: {...}}` with no `type` is extremely common, and `properties` alone does not
  // constrain a non-object — so `wrongTypeFor` returning 12345 there produced a body the validator
  // ACCEPTS, and the generated case asserts `-> 400` for a request that should return 200. That is a
  // false test, which is worse than a bad mock body: it fails against a correct implementation.
  // 6,101 of them across 164,473 request-body field schemas.
  test("an object without `type` gets a genuinely wrong value", () => {
    expect(wrongTypeFor({ properties: { a: { type: "string" } } } as never)).toBe("not-an-object");
  });

  test("an array without `type` gets a genuinely wrong value", () => {
    expect(wrongTypeFor({ items: { type: "string" } } as never)).toBe("not-an-array");
  });

  test("string-only keywords without `type` imply a string", () => {
    expect(wrongTypeFor({ minLength: 3 } as never)).toBe(12345);
    // A pattern makes it a coercion-resistant string, per the existing rule.
    expect(wrongTypeFor({ pattern: "^a+$" } as never)).toBe("!!not-a-valid-value!!");
  });

  // Control: a declared type still wins, and a schema stating nothing keeps the old default.
  test("a declared type wins, and a bare schema is unchanged", () => {
    expect(wrongTypeFor({ type: "string" } as never)).toBe(12345);
    expect(wrongTypeFor({ type: "object", properties: {} } as never)).toBe("not-an-object");
    expect(wrongTypeFor({} as never)).toBe(12345);
  });
});

describe("no wrong-type case is generated that cannot fail", () => {
  // The wrong-type case was emitted unconditionally for every required field. Where the field's
  // schema constrains nothing — `{properties: {...}}` with no `type`, or a description-only node —
  // NO value is wrong, so the generated case asserts `-> 400` for a request a correct API answers
  // 200. That is a false test: it fails against a correct implementation, and 6,101 of them were
  // derivable from the corpus.
  //
  // crust owns the validator, so the case is only emitted when the wrong value is actually rejected.
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-gen-wrong-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a field whose schema constrains nothing gets no wrong-type case", async () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/things": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["loose", "tight"],
                    properties: {
                      // No `type`: `properties` alone does not constrain a non-object.
                      loose: { properties: { a: { type: "string" } } },
                      tight: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" }, "400": { description: "bad" } },
          },
        },
      },
    };
    const specPath = join(dir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec));
    const setupPath = join(dir, "setup.ts");
    await writeFile(
      setupPath,
      "export const scopeParam = null;\nexport async function shared() { return {}; }\n" +
        "export function headersFor() { return { 'content-type': 'application/json' }; }\n" +
        "export function resolvePath(_c, t) { return 'http://127.0.0.1:1' + t; }\n",
    );
    const out = join(dir, "out");
    const result = await generateFixtures({
      swagger: specPath,
      out,
      setup: setupPath,
      log: () => {},
    });
    // Read whatever it wrote rather than guessing the filename.
    const written = (
      await Promise.all(
        result.files.map((f) =>
          Bun.file(f)
            .text()
            .catch(() => ""),
        ),
      )
    ).join("\n");
    expect(written).toContain("wrong type for 'tight'");
    expect(written).not.toContain("wrong type for 'loose'");
  });
});

describe("validValue respects the schema's own bounds", () => {
  // `validValue` builds the VALID base body that every 400-case perturbs. Where it produces an
  // invalid value the case perturbs an already-broken body, so the expected 400 can arrive for the
  // wrong reason — a false pass, which is the one thing crust's design forbids. 4,004 request-body
  // fields across 4,138 specs, the bulk of them length and item bounds the mock has honoured for
  // some time and the generator never did.
  const ok = (schema: Record<string, unknown>) =>
    validateSchema(validValue(schema as never), schema, {} as never, "");

  test("maxLength is honoured — the default is 11 characters", () => {
    expect(ok({ type: "string", maxLength: 4 })).toEqual([]);
    expect(ok({ type: "string", minLength: 2, maxLength: 5 })).toEqual([]);
  });

  test("maxItems is honoured — two elements are emitted by default", () => {
    expect(ok({ type: "array", maxItems: 1, items: { type: "string" } })).toEqual([]);
    expect(ok({ type: "array", minItems: 3, items: { type: "string" } })).toEqual([]);
  });

  test("maximum is honoured — the default is 1", () => {
    expect(ok({ type: "integer", maximum: 0 })).toEqual([]);
    expect(ok({ type: "integer", minimum: 5, maximum: 9 })).toEqual([]);
  });

  // Control: the byte-stable format values are unchanged, since checked-in matrices are CI-diffed
  // against a regeneration and churning them is a cost with no finding behind it.
  test("the fixed format values are unchanged", () => {
    expect(validValue({ type: "string", format: "email" } as never)).toBe("gen@crust.fixture");
    expect(validValue({ type: "string", format: "uuid" } as never)).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
    expect(validValue({ type: "string", format: "date" } as never)).toBe("2026-08-12");
    expect(validValue({ type: "string" } as never)).toBe("gen-value-x");
  });
});

describe("validValue covers uri, and an explicit pattern outranks a key guess", () => {
  // 972 of 1,090 format failures across the corpus were `format: "uri"`, which validValue simply did
  // not handle — it fell to "gen-value-x", which is not a URI. The mock has covered uri for some
  // time; the generator never did.
  //
  // And the key heuristics (`*_id` -> a uuid, `*email*` -> an address) were applied BEFORE the
  // field's own pattern, so a field named `job_id` carrying a pattern that is not a uuid got the
  // uuid anyway: 47 rows where a guess from the NAME beat what the schema actually says.
  const ok = (schema: Record<string, unknown>, key = "") =>
    validateSchema(validValue(schema as never, key), schema, {} as never, "");

  test("uri is honoured", () => {
    expect(ok({ type: "string", format: "uri" })).toEqual([]);
    expect(ok({ type: "string", format: "url" })).toEqual([]);
  });

  test("an explicit pattern beats the key heuristic", () => {
    expect(ok({ type: "string", pattern: "^job-[0-9]{3}$" }, "job_id")).toEqual([]);
    expect(ok({ type: "string", pattern: "^[a-z]{4}$" }, "user_email")).toEqual([]);
  });

  // Control: the byte-stable constants still apply where nothing contradicts them, because
  // checked-in matrices are CI-diffed against a regeneration.
  test("the fixed constants are unchanged where no pattern disagrees", () => {
    expect(validValue({ type: "string" } as never, "job_id")).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
    expect(validValue({ type: "string", format: "email" } as never)).toBe("gen@crust.fixture");
    expect(validValue({ type: "string", format: "date" } as never)).toBe("2026-08-12");
  });
});

describe("validValue reads enums and allOf the way the mock does", () => {
  // Two shapes the mock learned to handle and the generator never did — the same divergence that
  // produced four of the six defects on this axis.
  //
  // `{type: "string", enum: [true, false]}` is a spec contradicting itself, and validValue returned
  // enum[0] before ever looking at the type. And an object composed with `allOf` had its `required`
  // and `properties` read off the NODE only, so the base body came back `{}` — missing every field
  // the composition demands.
  const ok = (schema: Record<string, unknown>, key = "") =>
    validateSchema(validValue(schema as never, key), schema, {} as never, "");

  test("the enum member picked satisfies the declared type", () => {
    expect(ok({ type: "string", enum: [true, false, "yes"] })).toEqual([]);
    expect(ok({ type: "integer", enum: ["none", 3] })).toEqual([]);
  });

  test("required and properties are read through allOf", () => {
    const schema = {
      allOf: [
        { type: "object", required: ["gid"], properties: { gid: { type: "string" } } },
        { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      ],
    };
    expect(ok(schema)).toEqual([]);
    const built = validValue(schema as never) as Record<string, unknown>;
    expect(built.gid).toBeDefined();
    expect(built.name).toBeDefined();
  });

  // Control: where no enum member fits, the first still stands — the schema is unsatisfiable and
  // inventing a value outside the enum would be worse than reporting the contradiction.
  test("an unsatisfiable enum keeps its first member", () => {
    expect(validValue({ type: "integer", enum: ["a", "b"] } as never)).toBe("a");
  });
});

describe("scalar constraints are read through allOf too", () => {
  // The object case learned to compose through `allOf`; the scalar cases did not. Real specs write
  // `{allOf: [{type: "string", minLength: 600, maxLength: 2400, pattern: "..."}, {description: "..."}]}`
  // — the constraints in a branch, a prose note beside it — and validValue read `minLength` off the
  // NODE, found none, and produced a value far too short for the field it was standing in for.
  const ok = (schema: Record<string, unknown>, key = "") =>
    validateSchema(validValue(schema as never, key), schema, {} as never, "");

  // The node carries the TYPE and the branches carry refinements — the shape validValue's own
  // comment describes ("zod emits { type: 'string', allOf: [pattern, pattern] }") and then ignores,
  // because a node with a type of its own never enters the combinator path at all.
  test("length bounds in a refinement branch are honoured", () => {
    expect(ok({ type: "string", allOf: [{ minLength: 24 }] })).toEqual([]);
    expect(
      ok({ type: "string", allOf: [{ minLength: 5, maxLength: 8 }, { description: "x" }] }),
    ).toEqual([]);
  });

  test("numeric bounds in a refinement branch are honoured", () => {
    expect(ok({ type: "integer", allOf: [{ minimum: 50 }] })).toEqual([]);
  });

  test("a format in a refinement branch is honoured", () => {
    expect(ok({ type: "string", allOf: [{ format: "uri" }] })).toEqual([]);
  });

  // Control: the node's own constraints still win where both state one — it is the more specific
  // statement about this use.
  test("the node's own constraint is not overridden by a branch", () => {
    expect(
      validValue({ type: "string", minLength: 3, allOf: [{ minLength: 40 }] } as never),
    ).toHaveLength(40);
  });
});

describe("a field-name guess never breaks a declared bound", () => {
  // All 32 remaining maxLength failures were one shape: a field called `client_id`, `external_id`,
  // `alphanumeric_sender_id` — matching the `*_id` heuristic — whose schema says
  // `{type: "string", maxLength: 20}` and never mentions uuid. The heuristic returned the fixed
  // 36-character uuid and blew the bound.
  //
  // PR #44 already stopped a name guess overriding an explicit `pattern`. A length bound is the same
  // kind of statement: the schema said what fits, and a guess from the NAME does not get to ignore it.
  const ok = (schema: Record<string, unknown>, key = "") =>
    validateSchema(validValue(schema as never, key), schema, {} as never, "");

  test("the uuid guess yields to a maxLength that cannot hold it", () => {
    expect(ok({ type: "string", maxLength: 20 }, "client_id")).toEqual([]);
    expect(ok({ type: "string", maxLength: 34 }, "external_id")).toEqual([]);
  });

  test("the email guess yields too", () => {
    expect(ok({ type: "string", maxLength: 5 }, "user_email")).toEqual([]);
  });

  // Control: an EXPLICIT format still wins, because then the schema itself asked for the uuid and a
  // maxLength that cannot hold one is the spec contradicting itself — crust keeps the valid value
  // and lets --validate report the contradiction, exactly as the mock does.
  test("an explicit format: uuid is kept even against a small maxLength", () => {
    expect(validValue({ type: "string", format: "uuid", maxLength: 8 } as never, "x")).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
  });

  // Control: with room, the guess still applies — this must not become "never guess".
  test("the guess still applies where it fits", () => {
    expect(validValue({ type: "string", maxLength: 40 } as never, "client_id")).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
    expect(validValue({ type: "string" } as never, "client_id")).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
  });
});

describe("the last three divergences from the mock", () => {
  // Each of these the mock handles and the generator did not — the same split that produced most of
  // the defects on this axis.
  const ok = (schema: Record<string, unknown>, key = "") =>
    validateSchema(validValue(schema as never, key), schema, {} as never, "");

  // `exclusiveMaximum: true` is 3.0's BOOLEAN modifier on `maximum`; 3.1 writes a number. Clamping
  // to `maximum` itself yields exactly the excluded value.
  test("exclusive bounds are honoured in both spellings", () => {
    expect(
      ok({
        type: "number",
        minimum: 0,
        maximum: 1,
        exclusiveMinimum: true,
        exclusiveMaximum: true,
      }),
    ).toEqual([]);
    expect(ok({ type: "integer", exclusiveMaximum: 5 })).toEqual([]);
    expect(ok({ type: "integer", exclusiveMinimum: 5 })).toEqual([]);
  });

  // `format: email` beside a pattern whose TLD is 2-5 letters: "gen@crust.fixture" has seven.
  test("a pattern the format constant cannot satisfy is sampled instead", () => {
    expect(
      ok({
        type: "string",
        format: "email",
        pattern: "^([a-zA-Z0-9_.-]+)@([a-zA-Z0-9_.-]+)\\.([a-zA-Z]{2,5})$",
      }),
    ).toEqual([]);
  });

  // A field called `first_email_date` declaring `format: date-time` got the email constant, because
  // the NAME heuristic ran regardless of what the schema said.
  test("an explicit format is not overridden by the field name", () => {
    expect(ok({ type: "string", format: "date-time" }, "first_email_date")).toEqual([]);
    expect(ok({ type: "string", format: "uuid" }, "customer_email")).toEqual([]);
  });

  // Control: the name heuristics still work where the schema states nothing.
  test("the name heuristics still apply to an unconstrained string", () => {
    expect(validValue({ type: "string" } as never, "customer_email")).toBe("gen@crust.fixture");
    expect(validValue({ type: "string" } as never, "order_id")).toBe(
      "00000000-0000-4000-8000-00000000c0de",
    );
  });
});
