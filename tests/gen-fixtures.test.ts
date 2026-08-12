import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "../src/genFixtures/generate";

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
                required: ["name", "kind"],
                properties: {
                  name: { type: "string", minLength: 2 },
                  kind: { type: "string", enum: ["round", "square"] },
                  code: { type: "string", pattern: "^\\d{6}$" },
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
});
