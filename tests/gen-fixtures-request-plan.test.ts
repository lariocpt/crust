import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "../src/genFixtures/generate";
import { styleForBiomeConfig } from "../src/genFixtures/indent";
import {
  emitRequestHelpers,
  mergeParameters,
  planRequest,
  validateParameterSetup,
} from "../src/genFixtures/requestPlan";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { buildRoutes } from "../src/mockServer/router";
import { validateRequest } from "../src/mockServer/validateRequest";
import { required } from "./support/required";

const securitySchemes = {
  bearer: { type: "http", scheme: "bearer" },
  key: { type: "apiKey", in: "header", name: "X-Key" },
  cookie: { type: "apiKey", in: "cookie", name: "session" },
};
const secured = {
  openapi: "3.0.0",
  security: [{ bearer: [] }],
  components: { securitySchemes },
} as OpenApiSpec;
const query = (name: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  required: true,
  schema,
});

const FORMAT_CASES = [
  {
    format: "date",
    valid: ["2024-02-29", "2000-02-29", "2026-04-30", "0001-01-01"],
    invalid: [
      "2026-99-99",
      "2026-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-00-10",
      "2026-01-00",
      "0000-01-01",
      "2026-01-01\n",
      "2026-1-01",
    ],
  },
  {
    format: "date-time",
    valid: [
      "2026-01-01T12:00:00Z",
      "2024-02-29t23:59:59.123z",
      "2000-02-29T00:00:00+05:30",
      "2026-01-01T23:59:59-23:59",
      "2026-01-01T00:00:00-00:00",
    ],
    invalid: [
      "2026-01-01T12:00:00",
      "2026-01-01 12:00:00Z",
      "2026-01-01T12:00:00+0530",
      "2026-01-01T24:00:00Z",
      "2026-01-01T12:60:00Z",
      "2026-01-01T12:00:60Z",
      "2026-01-01T12:00:00+24:00",
      "2026-01-01T12:00:00+00:60",
      "2026-02-29T12:00:00Z",
      "2026-01-01T12:00:00Z\n",
    ],
  },
  {
    format: "uuid",
    valid: [
      "123e4567-e89b-12d3-a456-426614174000",
      "550E8400-E29B-41D4-A716-446655440000",
      "00000000-0000-0000-0000-000000000000",
    ],
    invalid: [
      "550e8400-e29b-41d4-0716-446655440000",
      "550e8400-e29b-01d4-a716-446655440000",
      "550e8400-e29b-81d4-a716-446655440000",
      "{550e8400-e29b-41d4-a716-446655440000}",
      "550e8400-e29b-41d4-a716-446655440000\n",
    ],
  },
  {
    format: "email",
    valid: ["a.b+tag@example.invalid", "user_name@example-domain.invalid", "a!b@example.invalid"],
    invalid: [
      "a..b@example.invalid",
      ".a@example.invalid",
      "a.@example.invalid",
      "a@-example.invalid",
      "a@example-.invalid",
      "a@example..invalid",
      '"a b"@example.invalid',
      "é@example.invalid",
      "a@[127.0.0.1]",
      "a@localhost",
      "a@example.invalid\n",
      `${"a".repeat(65)}@example.invalid`,
      `a@${"b".repeat(64)}.invalid`,
    ],
  },
  {
    format: "uri",
    valid: [
      "https://example.invalid/a%20b?q=x%26y#section",
      "http://127.0.0.1:8080/",
      "HTTPS://Example.Invalid/path",
      "https://example.invalid/%F0%9F%98%80",
    ],
    invalid: [
      "https://example.invalid/%zz",
      "https://example.invalid/%",
      "https://example.invalid/a b",
      "https://example.invalid/a\n",
      "https://example.invalid\\path",
      "https://example.invalid/#a#b",
      "https://example.invalid/{id}",
      "https://user@example.invalid/",
      "https://[::1]/",
      "urn:example:animal",
      "https://127.1/",
      "https://example.invalid:65536/",
      "https://-example.invalid/",
      "https://example.invalid/😀",
    ],
  },
];

describe("request planning", () => {
  test("inherits security, honors explicit public and anonymous alternatives", () => {
    expect(planRequest(secured, {}, [], "GET /", {}).authenticated).toBe(true);
    for (const security of [[], [{}], [{ bearer: [] }, {}]]) {
      const plan = planRequest(secured, { security }, [], "GET /", {});
      expect(plan.authenticated).toBe(false);
      expect(plan.alternatives).toEqual([]);
      expect(plan.problems).toEqual([]);
    }
  });

  test("supports header AND/OR requirements and refuses unsupported alternatives", () => {
    const plan = planRequest(
      secured,
      { security: [{ cookie: [] }, { bearer: [], key: [] }] },
      [],
      "GET /",
      {},
    );
    expect(plan.alternatives).toEqual([
      [{ name: "authorization", prefix: "bearer " }, { name: "x-key" }],
    ]);
    expect(plan.problems).toEqual([]);
    for (const security of [[{ cookie: [] }], [{ missing: [] }], [{ bearer: ["read"] }]]) {
      expect(planRequest(secured, { security }, [], "GET /", {}).problems.length).toBe(1);
    }
  });

  test("merges parameters by name and location, preserving deterministic order", () => {
    const base = query("kind", { type: "string", enum: ["old"] });
    const replacement = query("kind", { type: "string", enum: ["new"] });
    expect(mergeParameters([base, { name: "kind", in: "path" }], [replacement])).toEqual([
      replacement,
      { name: "kind", in: "path" },
    ]);
  });

  test("operation security replaces root requirements and null is rejected", () => {
    const plan = planRequest(secured, { security: [{ key: [] }] }, [], "GET /", {});
    expect(plan.alternatives).toEqual([[{ name: "x-key" }]]);
    expect(plan.problems).toEqual([]);
    expect(planRequest(secured, { security: null }, [], "GET /", {}).problems).toEqual([
      "malformed security requirements",
    ]);
  });

  test("does not guess business strings; uses reviewed or documented baselines", () => {
    expect(planRequest({}, {}, [query("kind")], "GET /", {}).problems.length).toBe(1);
    const plan = planRequest(
      {},
      {},
      [query("kind", { type: "string", enum: ["Requirement"] })],
      "GET /",
      {},
    );
    expect(plan.query[0]?.value).toBe("Requirement");
    expect(plan.problems).toEqual([]);
    expect(
      planRequest({}, {}, [query("kind")], "GET /", {
        parameterValues: { "GET /": { kind: "reviewed" } },
      }).query[0]?.value,
    ).toBe("reviewed");
  });

  test("validates setup keys and schema baselines without leaking values", () => {
    expect(() =>
      validateParameterSetup({ parameterValues: { typo: {} } }, new Set(["GET /"])),
    ).toThrow();
    expect(() => validateParameterSetup({ resolveParameter: true }, new Set())).toThrow();
    expect(() =>
      planRequest({}, {}, [query("kind")], "GET /", {
        parameterValues: { "GET /": { typo: "private-value" } },
      }),
    ).toThrow();
    const plan = planRequest({}, {}, [query("count", { type: "integer", minimum: 1 })], "GET /", {
      parameterValues: { "GET /": { count: -1 } },
    });
    expect(plan.problems.length).toBe(1);
    expect(JSON.stringify(plan.problems)).not.toContain("-1");
  });

  test("discloses unsupported serialization and required header/cookie inputs", () => {
    for (const p of [
      { ...query("kind"), style: "deepObject" },
      query("kind", { type: "object" }),
      { ...query("kind"), allowReserved: true },
      { name: "session", in: "cookie", required: true },
    ]) {
      expect(planRequest({}, {}, [p], "GET /", {}).problems.length).toBeGreaterThan(0);
    }
  });

  test("static baselines fail closed on unsupported or unjudgeable constraints", () => {
    const schemas = [
      { type: "integer", default: 3, multipleOf: 2 },
      { type: "integer", default: 5, oneOf: [{ minimum: 0 }, { maximum: 10 }] },
      { type: "integer", default: 5, allOf: [{ not: { enum: [5] } }] },
      { type: "integer", default: 5, anyOf: [{ minimum: 0 }, { const: 6 }] },
      { type: "integer", default: 5, futureConstraint: true },
      { type: "integer", default: 5, minimum: 10, exclusiveMinimum: 0 },
      { type: "integer", default: 5, allOf: [{}] },
      { type: "string", default: "private-value", pattern: "[" },
      { type: "string", default: "private-value", format: "unknown" },
      { type: "string", default: "private-value", minLength: "20" },
      { type: "array", default: [1, 1], items: { type: "integer" }, uniqueItems: true },
      { type: "array", default: [3], items: { type: "integer", multipleOf: 2 } },
    ];
    for (const schema of schemas) {
      // A resolver must not silently replace an invalid documented baseline.
      const plan = planRequest({}, {}, [query("kind", schema)], "GET /", {
        resolveParameter: () => {
          throw new Error("must stay lazy");
        },
      });
      expect(plan.query).toEqual([]);
      expect(plan.problems).toEqual(["unsupported static query schema constraints: kind"]);
      expect(JSON.stringify(plan.problems)).not.toContain("private-value");
    }
  });

  test("checks every referenced branch and rejects unresolved/cyclic refs", () => {
    const spec = {
      components: {
        schemas: {
          Unsupported: { type: "integer", multipleOf: 2 },
          Loop: { $ref: "#/components/schemas/Loop" },
        },
      },
    };
    for (const ref of [
      "#/components/schemas/Unsupported",
      "#/components/schemas/Loop",
      "#/components/schemas/Missing",
      "https://example.invalid/schema",
    ]) {
      const schema = { type: "integer", default: 3, allOf: [{ $ref: ref }] };
      const plan = planRequest(spec, {}, [query("kind", schema)], "GET /", {});
      expect(plan.query).toEqual([]);
      expect(plan.problems).toHaveLength(1);
    }
  });

  test("supports fully covered composition, annotations, and lazy schema ownership", () => {
    const schema = {
      type: "integer",
      default: 5,
      description: "reviewed",
      "x-owner": "offline",
      allOf: [{ minimum: 1 }],
      anyOf: [{ enum: [5] }, { minimum: 10 }],
    };
    const plan = planRequest({}, {}, [query("kind", schema)], "GET /", {});
    expect(plan.problems).toEqual([]);
    expect(plan.query[0]?.value).toBe(5);
    const lazy = planRequest({}, {}, [query("kind", { type: "integer", multipleOf: 2 })], "GET /", {
      resolveParameter: () => 4,
    });
    expect(lazy.problems).toEqual([]);
    expect(lazy.query[0]?.runtime).toBe(true);
  });

  test("length bounds count code points and keep anyOf alternatives independent", () => {
    const cases = [
      { value: "😀", constraints: { minLength: 2 }, valid: false },
      { value: "😀", constraints: { minLength: 1, maxLength: 1 }, valid: true },
      { value: "😀😀", constraints: { minLength: 2, maxLength: 2 }, valid: true },
      { value: "é", constraints: { maxLength: 1 }, valid: false },
      { value: "é", constraints: { minLength: 2, maxLength: 2 }, valid: true },
      { value: "😀", constraints: { allOf: [{ minLength: 1 }, { maxLength: 1 }] }, valid: true },
      { value: "😀", constraints: { allOf: [{ minLength: 2 }, { maxLength: 2 }] }, valid: false },
      {
        value: "😀",
        constraints: {
          anyOf: [
            { minLength: 2, enum: ["😀"] },
            { maxLength: 1, enum: ["other"] },
          ],
        },
        valid: false,
      },
      {
        value: "😀",
        constraints: {
          anyOf: [
            { maxLength: 1, enum: ["😀"] },
            { minLength: 3, pattern: "^x" },
          ],
        },
        valid: true,
      },
    ];
    for (const { value, constraints, valid } of cases) {
      for (const array of [false, true]) {
        const item = { type: "string", ...constraints };
        const spec = { components: { schemas: { Text: item } } };
        const referenced = { type: "string", allOf: [{ $ref: "#/components/schemas/Text" }] };
        const schema = array
          ? { type: "array", items: referenced, default: [value] }
          : { ...referenced, default: value };
        const plan = planRequest(spec, {}, [query("kind", schema)], "GET /", {});
        expect(plan.problems.length).toBe(valid ? 0 : 1);
        expect(plan.query.length).toBe(valid ? 1 : 0);
      }
    }
  });

  test("static format proofs validate references and items, not merely regex shape", () => {
    for (const { format, valid, invalid } of FORMAT_CASES) {
      const spec = { components: { schemas: { Text: { type: "string", format } } } };
      for (const value of [...valid, ...invalid]) {
        for (const array of [false, true]) {
          const item = { type: "string", allOf: [{ $ref: "#/components/schemas/Text" }] };
          const schema = array
            ? { type: "array", items: item, default: [value] }
            : { ...item, default: value };
          const plan = planRequest(spec, {}, [query("kind", schema)], "GET /", {});
          expect({ format, value, accepted: plan.problems.length === 0 }).toEqual({
            format,
            value,
            accepted: valid.includes(value),
          });
          expect(plan.query.length).toBe(valid.includes(value) ? 1 : 0);
          expect(JSON.stringify(plan.problems)).not.toContain(value);
        }
      }
    }
    const schema = {
      type: "string",
      default: "2026-99-99",
      anyOf: [{ format: "date" }, { enum: ["different"], minLength: 1 }],
    };
    expect(planRequest({}, {}, [query("kind", schema)], "GET /", {}).problems).toHaveLength(1);
    const control = { ...schema, anyOf: [{ format: "date" }, { enum: ["2026-99-99"] }] };
    expect(planRequest({}, {}, [query("kind", control)], "GET /", {}).problems).toEqual([]);
    const lazy = planRequest({}, {}, [query("kind", { type: "string", format: "date" })], "GET /", {
      resolveParameter: () => "owned-by-resolver",
    });
    expect(lazy.problems).toEqual([]);
    expect(lazy.query[0]?.runtime).toBe(true);
  });

  test("static baselines enforce referenced constraints in the actual spec", () => {
    const spec = {
      components: { schemas: { Allowed: { type: "string", enum: ["allowed"] } } },
    };
    const parameter = query("kind", {
      type: "string",
      allOf: [{ $ref: "#/components/schemas/Allowed" }],
    });
    for (const value of ["allowed", "invalid"]) {
      const plan = planRequest(spec, {}, [parameter], "GET /", {
        parameterValues: { "GET /": { kind: value } },
      });
      expect(plan.problems.length).toBe(value === "allowed" ? 0 : 1);
      expect(plan.query.length).toBe(value === "allowed" ? 1 : 0);
    }
  });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function generate(
  paths: Record<string, unknown>,
  setupExtra = "",
  root: Record<string, unknown> = {},
  flows = false,
  style?: Record<string, unknown>,
) {
  const dir = await mkdtemp(join(tmpdir(), "crust-request-plan-"));
  dirs.push(dir);
  const specPath = join(dir, "spec.json");
  const setupPath = join(dir, "setup.ts");
  const out = join(dir, "generated");
  if (style) await writeFile(join(dir, "biome.json"), JSON.stringify(style));
  await writeFile(specPath, JSON.stringify({ openapi: "3.0.0", paths, ...root }));
  await writeFile(
    setupPath,
    `
export const scopeParam = null;
export const JSON_HEADERS = {};
export const shared = async () => ({});
export const headersFor = () => ({ Authorization: "Bearer offline", "X-Key": "offline" });
export const resolvePath = (_ctx: unknown, path: string) =>
  "https://example.invalid" + path.replace("{id}", "missing") + "?existing=keep";
${setupExtra}
`,
  );
  const result = await generateFixtures({
    swagger: specPath,
    setup: setupPath,
    out,
    flows,
    log: () => {},
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const file = result.files[0];
  return { result, manifest, file, specPath, setupPath, out };
}

test("security selects credentials without inventing a 401; query is inherited", async () => {
  const g = await generate(
    {
      "/nodes/{id}": {
        parameters: [query("node_type")],
        get: { responses: { "404": { description: "missing" } } },
      },
    },
    `export const parameterValues = { "GET /nodes/{id}": { node_type: "Requirement" } };`,
    { security: [{ bearer: [] }], components: { securitySchemes } },
  );
  expect(g.manifest.cases).toHaveLength(1);
  expect(g.manifest.cases[0].expectStatus).toBe(404);
  expect(g.manifest.cases[0].prerequisites).toContain("auth");
  expect(g.manifest.cases[0].prerequisites).toContain("query:node_type");
  const fixtures = (await import(g.file)).default;
  const input = await fixtures[0].input({});
  expect(input.headers.Authorization).toBe("Bearer offline");
  expect(new URL(input.url).searchParams.get("node_type")).toBe("Requirement");
  expect(new URL(input.url).searchParams.get("existing")).toBe("keep");
  const first = await readFile(g.file, "utf8");
  const regen = await generateFixtures({
    swagger: g.specPath,
    setup: g.setupPath,
    out: g.out,
    flows: false,
    log: () => {},
  });
  expect(await readFile(regen.files[0], "utf8")).toBe(first);
});

test("explicit public login does not inherit the legacy 401 description heuristic", async () => {
  const g = await generate(
    {
      "/login": {
        post: {
          security: [],
          responses: { "401": { description: "Not authenticated" } },
        },
      },
    },
    "",
    { security: [{ bearer: [] }], components: { securitySchemes } },
  );
  expect(g.manifest.cases).toEqual([]);
});

test("lazy resolver stays uncalled during generation and serializes repeated/encoded values", async () => {
  const g = await generate(
    {
      "/nodes/{id}": {
        get: {
          parameters: [
            query("node_type"),
            query("tags", { type: "array", items: { type: "string" } }),
            { ...query("joined", { type: "array", items: { type: "string" } }), explode: false },
          ],
          responses: { "404": { description: "missing" } },
        },
      },
    },
    `
export let calls = 0;
export const resolveParameter = () => { calls++; return "A&B /?"; };
export const parameterValues = { "GET /nodes/{id}": { tags: ["a&b", "c"], joined: ["a", "b"] } };
`,
  );
  const setup = await import(g.setupPath);
  expect(setup.calls).toBe(0);
  const fixtures = (await import(g.file)).default;
  const input = await fixtures[0].input({});
  const url = new URL(input.url);
  expect(setup.calls).toBe(1);
  expect(url.searchParams.get("node_type")).toBe("A&B /?");
  expect(url.searchParams.getAll("tags")).toEqual(["a&b", "c"]);
  expect(url.searchParams.get("joined")).toBe("a,b");
  expect(JSON.stringify(g.manifest)).not.toContain("A&B");
});

test("missing baselines are disclosed instead of emitted", async () => {
  const g = await generate({
    "/nodes/{id}": {
      get: {
        parameters: [query("node_type")],
        responses: { "404": { description: "missing" } },
      },
    },
  });
  expect(g.result.totalCases).toBe(0);
  expect(g.result.withNoCases).toBe(1);
  expect(g.manifest.unsupported[0].assumption).toContain("required query baseline");
});

test("unsupported static constraints are disclosed, including dereferenced cut branches", async () => {
  for (const schema of [
    { type: "integer", default: 3, multipleOf: 2 },
    { type: "integer", default: 5, oneOf: [{ minimum: 0 }, { maximum: 10 }] },
    { type: "integer", default: 3, allOf: [{ $ref: "#/components/schemas/Missing" }] },
    { type: "integer", default: 3, allOf: [{ $ref: "#/components/schemas/Unsupported" }] },
  ]) {
    const g = await generate(
      {
        "/nodes/{id}": {
          get: {
            parameters: [query("kind", schema)],
            responses: { "404": { description: "missing" } },
          },
        },
      },
      "",
      { components: { schemas: { Unsupported: { multipleOf: 2 } } } },
    );
    expect(g.result.totalCases).toBe(0);
    expect(g.result.withNoCases).toBe(1);
    expect(g.manifest.unsupported[0].assumption).toContain("unsupported static query schema");
  }
});

test("original query schemas prevent ref-sibling assertions from disappearing", async () => {
  const root = {
    components: {
      schemas: { Count: { type: "integer", default: 3 } },
      parameters: { Count: query("kind", { $ref: "#/components/schemas/Count" }) },
    },
  };
  for (const assertion of [
    { multipleOf: 2 },
    { oneOf: [{ minimum: 0 }, { maximum: 10 }] },
    { not: { enum: [3] } },
  ]) {
    const g = await generate(
      {
        "/nodes/{id}": {
          get: {
            parameters: [query("kind", { $ref: "#/components/schemas/Count", ...assertion })],
            responses: { "404": { description: "missing" } },
          },
        },
      },
      "",
      root,
    );
    expect(g.result.totalCases).toBe(0);
    expect(g.manifest.unsupported[0].assumption).toContain("unsupported static query schema");
  }
  const control = await generate(
    {
      "/nodes/{id}": {
        parameters: [{ $ref: "#/components/parameters/Count" }],
        get: { responses: { "404": { description: "missing" } } },
      },
    },
    "",
    root,
  );
  expect(control.result.totalCases).toBe(1);
  const fixtures = (await import(control.file)).default;
  expect(new URL((await fixtures[0].input({})).url).searchParams.get("kind")).toBe("3");
});

test("generated baselines enforce referenced code-point bounds on strings and array items", async () => {
  for (const array of [false, true]) {
    for (const minLength of [1, 2]) {
      const item = { type: "string", minLength, maxLength: 1 };
      const referenced = { $ref: "#/components/schemas/Text" };
      const schema = array
        ? { type: "array", items: referenced, default: ["😀"] }
        : { type: "string", allOf: [referenced], default: "😀" };
      const g = await generate(
        {
          "/nodes/{id}": {
            get: {
              parameters: [query("kind", schema)],
              responses: { "404": { description: "missing" } },
            },
          },
        },
        "",
        { components: { schemas: { Text: item } } },
      );
      expect(g.result.totalCases).toBe(minLength === 1 ? 1 : 0);
      if (minLength === 1) {
        const fixtures = (await import(g.file)).default;
        const url = new URL((await fixtures[0].input({})).url);
        const decoded = array ? url.searchParams.getAll("kind") : url.searchParams.get("kind");
        expect(decoded).toEqual(array ? ["😀"] : "😀");
      } else {
        expect(g.manifest.unsupported[0].assumption).toContain("schema/serialization");
        expect(JSON.stringify(g.manifest)).not.toContain("😀");
      }
    }
  }
});

test("generation omits unproven formats and emits valid referenced scalar and array baselines", async () => {
  for (const { format, valid, invalid } of FORMAT_CASES) {
    for (const array of [false, true]) {
      for (const accepted of [false, true]) {
        const value = (accepted ? valid : invalid)[0];
        const item = { type: "string", allOf: [{ $ref: "#/components/schemas/Formatted" }] };
        const schema = array
          ? { type: "array", items: item, default: [value] }
          : { ...item, default: value };
        const g = await generate(
          {
            "/nodes/{id}": {
              get: {
                parameters: [query("kind", schema)],
                responses: { "404": { description: "missing" } },
              },
            },
          },
          "",
          { components: { schemas: { Formatted: { type: "string", format } } } },
        );
        expect(g.result.totalCases).toBe(accepted ? 1 : 0);
        if (accepted) {
          const fixtures = (await import(g.file)).default;
          const url = new URL((await fixtures[0].input({})).url);
          expect(array ? url.searchParams.getAll("kind") : url.searchParams.get("kind")).toEqual(
            array ? [value] : value,
          );
        } else {
          expect(g.manifest.unsupported[0].assumption).toContain("schema/serialization");
          expect(JSON.stringify(g.manifest)).not.toContain(value);
        }
      }
    }
  }
});

test("runtime missing query value rejects input construction", async () => {
  const g = await generate(
    {
      "/nodes/{id}": {
        get: {
          parameters: [query("node_type")],
          responses: { "404": { description: "missing" } },
        },
      },
    },
    "export const resolveParameter = () => undefined;",
  );
  const fixtures = (await import(g.file)).default;
  await expect(fixtures[0].input({})).rejects.toThrow("unresolved or unsupported query baseline");
});

describe("query serialization boundaries", () => {
  const arraySchema = { type: "array", items: { type: "string" } };
  const parameter = (schema: Record<string, unknown>, explode = true) => ({
    ...query("kind", schema),
    explode,
  });
  const pathsFor = (p: ReturnType<typeof parameter>) => ({
    "/nodes/{id}": {
      get: { parameters: [p], responses: { "404": { description: "missing" } } },
    },
  });
  const checkWire = (url: URL, paths: Record<string, unknown>) => {
    const spec = { paths } as OpenApiSpec;
    const route = buildRoutes(spec)[0];
    expect(
      validateRequest(
        {
          method: "GET",
          pathname: url.pathname,
          params: {},
          searchParams: url.searchParams,
          contentType: null,
          bodyPresent: false,
          body: undefined,
        },
        route,
        spec,
      ),
    ).toEqual([]);
  };

  test("malformed Unicode scalars and array items fail statically and lazily", async () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdfff);
    for (const text of [high, low, `private-${high}-text`, `😀${low}`, `${high}😀`]) {
      for (const mode of ["scalar", "exploded", "joined"]) {
        const array = mode !== "scalar";
        const item = { type: "string", enum: [text] };
        const schema = array ? { type: "array", items: item } : item;
        const value = array ? [text] : text;
        const p = parameter({ ...schema, default: value }, mode !== "joined");
        const omitted = await generate(pathsFor(p));
        expect(omitted.result.totalCases).toBe(0);
        expect(omitted.manifest.unsupported[0].assumption).toContain("schema/serialization");
        expect(JSON.stringify(omitted.manifest)).not.toContain("private-");
        const lazySchema = array
          ? { type: "array", items: { type: "string" } }
          : { type: "string" };
        const g = await generate(
          pathsFor(parameter(lazySchema, mode !== "joined")),
          `export const resolveParameter = () => ${JSON.stringify(value)};`,
        );
        const fixtures = (await import(g.file)).default;
        await expect(fixtures[0].input({})).rejects.toThrow(
          "gen-fixtures: unresolved or unsupported query baseline",
        );
      }
    }
  });

  test("valid surrogate pairs and BMP values round-trip without replacement", async () => {
    for (const text of ["😀", "A😀漢字é", "�", "é"]) {
      for (const mode of ["scalar", "exploded", "joined"]) {
        for (const runtime of [false, true]) {
          const array = mode !== "scalar";
          const item = { type: "string", ...(runtime ? {} : { enum: [text] }) };
          const schema = array ? { type: "array", items: item } : item;
          const value = array ? [text, text] : text;
          const g = await generate(
            pathsFor(
              parameter(runtime ? schema : { ...schema, default: value }, mode !== "joined"),
            ),
            runtime ? `export const resolveParameter = () => ${JSON.stringify(value)};` : "",
          );
          const fixtures = (await import(g.file)).default;
          const url = new URL((await fixtures[0].input({})).url);
          const decoded = !array
            ? url.searchParams.get("kind")
            : mode === "exploded"
              ? url.searchParams.getAll("kind")
              : required(url.searchParams.get("kind")).split(",");
          expect(decoded).toEqual(value);
          expect(url.searchParams.get("existing")).toBe("keep");
        }
      }
    }
  });

  test("malformed query names are rejected by planning and the emitted URL guard", async () => {
    const source = emitRequestHelpers(
      {
        ...styleForBiomeConfig({}),
        legacy: false,
        biomeJson: null,
      },
      true,
      false,
    );
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const genUrl = new Function(`${js}\nreturn genUrl;`)();
    for (const name of [String.fromCharCode(0xd800), `private-${String.fromCharCode(0xdfff)}`]) {
      for (const runtime of [false, true]) {
        const p = {
          ...parameter(
            runtime
              ? { type: "string" }
              : {
                  type: "string",
                  default: "valid",
                },
          ),
          name,
        };
        const g = await generate(
          pathsFor(p),
          runtime ? 'export const resolveParameter = () => "valid";' : "",
        );
        expect(g.result.totalCases).toBe(0);
        expect(g.manifest.unsupported[0].assumption).toContain("malformed Unicode");
        expect(JSON.stringify(g.manifest)).not.toContain("private-");
      }
      let calls = 0;
      await expect(
        genUrl(
          "https://example.invalid",
          {},
          "GET /",
          [
            {
              name,
              runtime: true,
              array: false,
              explode: true,
            },
          ],
          () => {
            calls++;
            return "valid";
          },
        ),
      ).rejects.toThrow("unsupported query baseline");
      expect(calls).toBe(0);
    }
    const name = "tag😀漢";
    const g = await generate(
      pathsFor({
        ...parameter({ type: "string", default: "😀" }),
        name,
      }),
    );
    const fixtures = (await import(g.file)).default;
    expect(new URL((await fixtures[0].input({})).url).searchParams.get(name)).toBe("😀");
  });

  test("both colliding comma arrays are rejected and disclosed before emission", async () => {
    for (const value of [
      ["a,b", "c"],
      ["a", "b,c"],
    ]) {
      const g = await generate(pathsFor(parameter({ ...arraySchema, default: value }, false)));
      expect(g.result.totalCases).toBe(0);
      expect(g.manifest.unsupported[0].assumption).toContain("comma-bearing elements");
      expect(JSON.stringify(g.manifest)).not.toContain(JSON.stringify(value));
    }
  });

  test("lazy comma elements reject only non-exploded arrays", async () => {
    for (const value of [
      ["a,b", "c"],
      ["a", "b,c"],
    ]) {
      for (const explode of [false, true]) {
        const paths = pathsFor(parameter(arraySchema, explode));
        const g = await generate(
          paths,
          `
export const resolveParameter = () => ${JSON.stringify(value)};
`,
        );
        const fixtures = (await import(g.file)).default;
        if (!explode) {
          await expect(fixtures[0].input({})).rejects.toThrow("unsupported query baseline");
        } else {
          const url = new URL((await fixtures[0].input({})).url);
          expect(url.searchParams.getAll("kind")).toEqual(value);
          checkWire(url, paths);
        }
      }
    }
  });

  test("static exploded arrays preserve commas as element data", async () => {
    const value = ["a,b", "c"];
    const paths = pathsFor(parameter({ ...arraySchema, default: value }));
    const g = await generate(paths);
    const fixtures = (await import(g.file)).default;
    const url = new URL((await fixtures[0].input({})).url);
    expect(url.searchParams.getAll("kind")).toEqual(value);
    checkWire(url, paths);
  });

  test("exponent-form integral scalars and array items reject statically and lazily", async () => {
    for (const value of [1e21, -1e21, Number.MAX_VALUE]) {
      for (const array of [false, true]) {
        const schema = array ? { type: "array", items: { type: "integer" } } : { type: "integer" };
        const baseline = array ? [value] : value;
        const staticPaths = pathsFor(parameter({ ...schema, default: baseline }));
        const omitted = await generate(staticPaths);
        expect(omitted.result.totalCases).toBe(0);
        expect(omitted.manifest.unsupported[0].assumption).toContain("schema/serialization");

        const g = await generate(
          pathsFor(parameter(schema)),
          `
export const resolveParameter = () => ${JSON.stringify(baseline)};
`,
        );
        const fixtures = (await import(g.file)).default;
        await expect(fixtures[0].input({})).rejects.toThrow("unsupported query baseline");
      }
    }
  });

  test("supported integer and fractional values round-trip through request validation", async () => {
    for (const value of [0, -42, 1e20, -1e20, 1.25, 1e-7]) {
      for (const array of [false, true]) {
        for (const runtime of [false, true]) {
          const type = Number.isInteger(value) ? "integer" : "number";
          const schema = array ? { type: "array", items: { type } } : { type };
          const baseline = array ? [value, value] : value;
          const paths = pathsFor(
            parameter(runtime ? schema : { ...schema, default: baseline }, false),
          );
          const g = await generate(
            paths,
            runtime
              ? `
export const resolveParameter = () => ${JSON.stringify(baseline)};
`
              : "",
          );
          const fixtures = (await import(g.file)).default;
          const url = new URL((await fixtures[0].input({})).url);
          const wire = required(url.searchParams.get("kind"));
          const decoded = array ? wire.split(",").map(Number) : Number(wire);
          expect(decoded).toEqual(baseline);
          if (type === "integer") expect(wire).not.toMatch(/[eE]/);
          checkWire(url, paths);
        }
      }
    }
  });
});

test("required query is retained in auth and body-validation cases", async () => {
  const g = await generate(
    {
      "/nodes": {
        post: {
          parameters: [query("kind", { type: "string", enum: ["node"] })],
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
            "400": { description: "validation" },
            "401": { description: "unauthorized" },
          },
        },
      },
    },
    "",
    { security: [{ bearer: [] }], components: { securitySchemes } },
  );
  const fixtures = (await import(g.file)).default;
  expect(fixtures.length).toBeGreaterThan(1);
  for (const fixture of fixtures) {
    const input = await fixture.input({});
    expect(new URL(input.url).searchParams.get("kind")).toBe("node");
    if (fixture.name.includes("without credentials")) expect(input.headers).toEqual({});
    else expect(input.headers.Authorization).toBe("Bearer offline");
  }
});

test("runtime header guard refuses incomplete AND requirements without exposing headers", async () => {
  const g = await generate(
    { "/nodes/{id}": { get: { responses: { "404": { description: "missing" } } } } },
    "",
    { security: [{ bearer: [], key: [] }], components: { securitySchemes } },
  );
  const source = await readFile(g.file, "utf8");
  expect(source).toContain("genHeaders(headersFor");
  const setup = await readFile(g.setupPath, "utf8");
  // Use a distinct setup path to avoid Bun's module import cache.
  const badSetup = join(g.out, "bad-setup.ts");
  await writeFile(badSetup, setup.replace('"X-Key": "offline"', '"Other": "private"'));
  const badFile = join(g.out, "bad.crust.ts");
  await writeFile(badFile, source.replace("../setup", "./bad-setup"));
  const fixtures = (await import(badFile)).default;
  expect(() => fixtures[0].input({})).toThrow("setup headers");
});

test("query/security operations do not leak into unsupported pipes flows", async () => {
  const post = {
    requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    responses: { "201": { content: { "application/json": { example: { id: "x" } } } } },
  };
  const g = await generate(
    {
      "/nodes": { parameters: [query("kind", { type: "string", enum: ["x"] })], post },
      "/nodes/{id}": { get: { responses: { "404": { description: "missing" } } } },
    },
    "",
    {},
    true,
  );
  expect(g.result.flowCount).toBe(0);
  expect(
    g.manifest.unsupported.some((u: { assumption: string }) => u.assumption.includes("CRUD")),
  ).toBe(true);
});

test("a blocked flow step omits the whole flow, including read, update, and cleanup", async () => {
  const post = {
    requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    responses: { "201": { content: { "application/json": { example: { id: "x" } } } } },
  };
  for (const method of ["delete", "get", "patch", "put"]) {
    for (const constraint of [
      { parameters: [query("kind", { type: "string", enum: ["x"] })] },
      { security: [{ bearer: [] }] },
      { parameters: [query("unresolved")] },
    ]) {
      const g = await generate(
        {
          "/nodes": { post },
          "/nodes/{id}": {
            get: { responses: { "200": {} } },
            delete: { responses: { "204": {} } },
            ...(method === "patch" ? { put: { responses: { "200": {} } } } : {}),
            [method]: { ...constraint, responses: { "200": {}, "204": {} } },
          },
        },
        "",
        { components: { securitySchemes } },
        true,
      );
      expect(g.result.flowCount).toBe(0);
      expect(g.result.flowFile).toBeNull();
      expect(g.result.flowSkipped).toBe(1);
      expect(g.manifest.skipped).toContainEqual({
        operation: "/nodes",
        reason: `request plans unsupported for flow step(s): ${method.toUpperCase()} /nodes/{id}`,
      });
    }
  }
  const control = await generate(
    {
      "/nodes": { post },
      "/nodes/{id}": {
        get: { responses: { "200": {} } },
        delete: { responses: { "204": {} } },
      },
    },
    "",
    {},
    true,
  );
  expect(control.result.flowCount).toBe(1);
  expect(control.result.flowSkipped).toBe(0);
  expect(await readFile(required(control.result.flowFile), "utf8")).toContain("DELETE");
});

const STYLES = [
  { unit: "  ", width: 100, quote: "double" },
  { unit: "    ", width: 60, quote: "single" },
  { unit: "\t", width: 80, quote: "single" },
  { unit: "  ", width: 120, quote: "double" },
] as const;

async function styledGeneration(style: (typeof STYLES)[number]) {
  return generate(
    {
      "/nodes/{id}": {
        get: {
          parameters: [
            query("kind"),
            query("labels", {
              type: "array",
              items: { type: "string" },
              default: ["a'b", 'two"quotes'],
            }),
          ],
          responses: { "404": { description: "missing" } },
        },
      },
    },
    'export const resolveParameter = () => "runtime";',
    { security: [{ bearer: [], key: [] }, { key: [] }], components: { securitySchemes } },
    false,
    {
      formatter: {
        indentStyle: style.unit === "\t" ? "tab" : "space",
        indentWidth: style.unit === "\t" ? 2 : style.unit.length,
        lineWidth: style.width,
      },
      javascript: { formatter: { quoteStyle: style.quote } },
    },
  );
}

describe("request-plan emission style", () => {
  for (const style of STYLES) {
    test(`${style.unit === "\t" ? "tabs" : `${style.unit.length} spaces`}, width ${style.width}, ${style.quote} quotes`, async () => {
      const g = await styledGeneration(style);
      const source = await readFile(g.file, "utf8");
      const quote = style.quote === "single" ? "'" : '"';
      expect(source).toContain(`name: ${quote}kind${quote}`);
      expect(source).toContain(`prefix: ${quote}bearer ${quote}`);
      expect(source).toContain(`typeof v === ${quote}number${quote}`);
      expect(source.includes(`${style.unit.repeat(3)}url: await genUrl(\n`)).toBe(
        style.width < 120,
      );
      expect(source).not.toContain('[{"name":');
      expect(source.match(/const requests =/g)).toHaveLength(1);
      expect(source.match(/name: ['"]kind['"]/g)).toHaveLength(1);
      for (const line of source.split("\n")) {
        const leading = line.match(/^[\t ]*/)?.[0] ?? "";
        if (leading) {
          expect(leading).toBe(style.unit.repeat(leading.length / style.unit.length));
        }
        // Long comments, case names and atomic string literals cannot wrap.
        if (line.trimStart().startsWith("//") || line.includes("name: ") || /^\s*['"]/.test(line)) {
          continue;
        }
        expect(line.replaceAll("\t", "  ").length).toBeLessThanOrEqual(style.width);
      }
      const fixtures = (await import(g.file)).default;
      const input = await fixtures[0].input({});
      expect(new URL(input.url).searchParams.get("kind")).toBe("runtime");
      expect(new URL(input.url).searchParams.getAll("labels")).toEqual(["a'b", 'two"quotes']);
      expect(input.headers.Authorization).toBe("Bearer offline");
      const regenerated = await generateFixtures({
        swagger: g.specPath,
        setup: g.setupPath,
        out: g.out,
        flows: false,
        log: () => {},
      });
      expect(await readFile(regenerated.files[0], "utf8")).toBe(source);
    });
  }

  test("omits helpers and metadata that a file does not use", async () => {
    for (const mode of ["public", "query", "headers", "unauthenticated"]) {
      const g = await generate(
        {
          "/nodes/{id}": {
            get: {
              security: mode === "public" || mode === "query" ? [] : [{ bearer: [] }],
              ...(mode === "query"
                ? { parameters: [query("kind", { type: "string", enum: ["node"] })] }
                : {}),
              responses:
                mode === "unauthenticated"
                  ? { "401": { description: "unauthorized" } }
                  : { "404": { description: "missing" } },
            },
          },
        },
        "",
        { components: { securitySchemes } },
      );
      const source = await readFile(g.file, "utf8");
      expect(source.includes("function genUrl(")).toBe(mode === "query");
      expect(source.includes("function genHeaders(")).toBe(mode === "headers");
      expect(source.includes("const requests =")).toBe(mode === "query" || mode === "headers");
    }
  });

  const biome = join(import.meta.dir, "..", "node_modules", "@biomejs", "biome", "bin", "biome");
  test.skipIf(!existsSync(biome))(
    "generated request plans are Biome-format-idempotent",
    async () => {
      for (const style of STYLES) {
        const g = await styledGeneration(style);
        const before = await readFile(g.file, "utf8");
        const proc = Bun.spawn([process.execPath, biome, "format", "--write", g.file], {
          cwd: join(g.out, ".."),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect({ code: await proc.exited, output: out + err }).toMatchObject({ code: 0 });
        expect(await readFile(g.file, "utf8")).toBe(before);
      }
    },
  );
});
