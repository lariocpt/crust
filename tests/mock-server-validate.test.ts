import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { startServer } from "../src/mockServer/server";
import { type Violation, validateSchema } from "../src/mockServer/validateRequest";

const SCHEMA_SPEC: OpenApiSpec = {
  openapi: "3.1.0",
  paths: {},
  components: {
    schemas: {
      Node: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          child: { $ref: "#/components/schemas/Node" },
        },
      },
    },
  },
};

describe("validateSchema", () => {
  const cases: Array<{ name: string; value: unknown; schema: unknown; rules: string[] }> = [
    { name: "type pass", value: "x", schema: { type: "string" }, rules: [] },
    { name: "type fail", value: 5, schema: { type: "string" }, rules: ["type"] },
    {
      name: "required missing",
      value: {},
      schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      rules: ["required"],
    },
    { name: "enum pass", value: "b", schema: { enum: ["a", "b"] }, rules: [] },
    { name: "enum fail", value: "z", schema: { enum: ["a", "b"] }, rules: ["enum"] },
    {
      name: "enum object equality via stringify",
      value: { a: 1 },
      schema: { enum: [{ a: 1 }] },
      rules: [],
    },
    {
      name: "format uuid fail",
      value: "nope",
      schema: { type: "string", format: "uuid" },
      rules: ["format"],
    },
    {
      name: "format email fail",
      value: "not-an-email",
      schema: { type: "string", format: "email" },
      rules: ["format"],
    },
    {
      name: "format date-time pass",
      value: "2024-01-01T12:30:00Z",
      schema: { type: "string", format: "date-time" },
      rules: [],
    },
    {
      name: "unknown format passes",
      value: "whatever",
      schema: { type: "string", format: "kebab-case" },
      rules: [],
    },
    {
      name: "pattern fail",
      value: "abc",
      schema: { type: "string", pattern: "^\\d+$" },
      rules: ["pattern"],
    },
    {
      name: "uncompilable pattern passes",
      value: "abc",
      schema: { type: "string", pattern: "(" },
      rules: [],
    },
    {
      name: "minLength",
      value: "a",
      schema: { type: "string", minLength: 2 },
      rules: ["minLength"],
    },
    {
      name: "maxLength",
      value: "abcd",
      schema: { type: "string", maxLength: 3 },
      rules: ["maxLength"],
    },
    { name: "minimum", value: 1, schema: { type: "integer", minimum: 2 }, rules: ["minimum"] },
    { name: "maximum", value: 9, schema: { type: "number", maximum: 5 }, rules: ["maximum"] },
    {
      name: "exclusiveMinimum 3.1 numeric form",
      value: 2,
      schema: { type: "integer", exclusiveMinimum: 2 },
      rules: ["minimum"],
    },
    { name: "minItems", value: [], schema: { type: "array", minItems: 1 }, rules: ["minItems"] },
    {
      name: "3.1 type array with null passes",
      value: null,
      schema: { type: ["string", "null"] },
      rules: [],
    },
    {
      name: "3.0 nullable passes null",
      value: null,
      schema: { type: "string", nullable: true },
      rules: [],
    },
    {
      name: "anyOf null branch passes",
      value: null,
      schema: { anyOf: [{ type: "string" }, { type: "null" }] },
      rules: [],
    },
    {
      name: "anyOf all branches fail -> single anyOf violation",
      value: 5,
      schema: { anyOf: [{ type: "string" }, { type: "boolean" }] },
      rules: ["anyOf"],
    },
    {
      name: "allOf concatenates branch violations",
      value: 5,
      schema: {
        allOf: [
          { type: "integer", minimum: 10 },
          { type: "integer", maximum: 3 },
        ],
      },
      rules: ["maximum", "minimum"],
    },
    { name: "integer rejects float", value: 1.5, schema: { type: "integer" }, rules: ["type"] },
    { name: "number accepts integer", value: 5, schema: { type: "number" }, rules: [] },
    {
      name: "cyclic $ref passes on re-entry",
      value: { name: "a", child: { name: "b", child: 42 } },
      schema: { $ref: "#/components/schemas/Node" },
      rules: [],
    },
    {
      name: "unresolvable $ref passes",
      value: 12345,
      schema: { $ref: "#/components/schemas/Missing" },
      rules: [],
    },
    {
      name: "additionalProperties:false extra key PASSES (v1 stance)",
      value: { a: 1, extra: "ignored" },
      schema: {
        type: "object",
        properties: { a: { type: "integer" } },
        additionalProperties: false,
      },
      rules: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const violations = validateSchema(c.value, c.schema, SCHEMA_SPEC);
      expect(violations.map((v) => v.rule).sort()).toEqual([...c.rules].sort());
    });
  }

  test("nested violations carry JSON pointers", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    const violations = validateSchema({ items: [{ name: 5 }] }, schema, SCHEMA_SPEC);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.pointer).toBe("/items/0/name");
    expect(violations[0]!.rule).toBe("type");
  });

  test("required violation points at the missing property", () => {
    const violations = validateSchema(
      { child: { name: "x" } },
      { $ref: "#/components/schemas/Node" },
      SCHEMA_SPEC,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.pointer).toBe("/name");
    expect(violations[0]!.rule).toBe("required");
  });
});

const VALIDATE_SPEC = {
  openapi: "3.0.0",
  info: { title: "widgets", version: "1" },
  paths: {
    "/widgets": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "kind"],
                properties: {
                  name: { type: "string", minLength: 2 },
                  kind: { type: "string", enum: ["basic", "fancy"] },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { example: { id: 9, name: "W" } } },
          },
        },
      },
    },
    "/widgets/{widgetId}": {
      // path-item-level parameters must merge into the route
      parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
      get: {
        parameters: [{ name: "verbose", in: "query", required: true, schema: { type: "boolean" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { example: { id: 1 } } },
          },
        },
      },
    },
  },
} as unknown as OpenApiSpec;

describe("--validate mock mode e2e", () => {
  test("invalid body -> 422 with violations; valid body -> mock response", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: VALIDATE_SPEC,
      validate: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const bad = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", kind: "weird" }),
      });
      expect(bad.status).toBe(422);
      expect(bad.headers.get("x-crust-validation")).toBe("request");
      const body = (await bad.json()) as {
        error: string;
        violations: Array<{ pointer: string; rule: string; location: string }>;
      };
      expect(body.error).toBe("request validation failed");
      const byPointer = Object.fromEntries(body.violations.map((v) => [v.pointer, v.rule]));
      expect(byPointer["/name"]).toBe("minLength");
      expect(byPointer["/kind"]).toBe("enum");
      expect(body.violations.every((v) => v.location === "body")).toBe(true);

      const absent = await fetch(`${base}/widgets`, { method: "POST" });
      expect(absent.status).toBe(422);
      const absentBody = (await absent.json()) as { violations: Array<{ rule: string }> };
      expect(absentBody.violations.map((v) => v.rule)).toContain("required-body");

      const garbage = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      });
      expect(garbage.status).toBe(422);
      const garbageBody = (await garbage.json()) as { violations: Array<{ rule: string }> };
      expect(garbageBody.violations.map((v) => v.rule)).toContain("json-parse");

      const good = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Widgy", kind: "basic" }),
      });
      expect(good.status).toBe(201);
      expect(await good.json()).toEqual({ id: 9, name: "W" });
    } finally {
      await server.stop();
    }
  });

  test("path (path-item-level) and query params are coerced and validated", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: VALIDATE_SPEC,
      validate: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const badPath = await fetch(`${base}/widgets/abc?verbose=true`);
      expect(badPath.status).toBe(422);
      const badPathBody = (await badPath.json()) as {
        violations: Array<{ pointer: string; rule: string; location: string }>;
      };
      expect(badPathBody.violations).toEqual([
        expect.objectContaining({ pointer: "widgetId", rule: "type", location: "path" }),
      ]);

      const missingQuery = await fetch(`${base}/widgets/3`);
      expect(missingQuery.status).toBe(422);
      const missingBody = (await missingQuery.json()) as {
        violations: Array<{ pointer: string; rule: string; location: string }>;
      };
      expect(missingBody.violations).toEqual([
        expect.objectContaining({ pointer: "verbose", rule: "required", location: "query" }),
      ]);

      const badQuery = await fetch(`${base}/widgets/3?verbose=yes`);
      expect(badQuery.status).toBe(422);

      const ok = await fetch(`${base}/widgets/3?verbose=true`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: 1 });
    } finally {
      await server.stop();
    }
  });

  test("stateful + validate: an invalid POST returns 422 and creates NOTHING", async () => {
    const server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: VALIDATE_SPEC,
      validate: true,
      stateful: true,
      log: () => {},
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const bad = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "no-kind-given" }),
      });
      expect(bad.status).toBe(422);
      expect(server.state.size).toBe(0);

      const good = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Widgy", kind: "fancy" }),
      });
      expect(good.status).toBe(201);
      expect(server.state.size).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

const PROXY_SPEC = {
  openapi: "3.0.0",
  info: { title: "upstream", version: "1" },
  paths: {
    "/ok": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "name"],
                  properties: { id: { type: "integer" }, name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/weird-status": {
      get: { responses: { "200": { description: "only 200 documented" } } },
    },
    "/bad-body": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "integer" } } },
              },
            },
          },
        },
      },
    },
  },
} as unknown as OpenApiSpec;

describe("--proxy validation-proxy e2e", () => {
  let dir: string;
  let reportPath: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof startServer>;
  let base: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "crust-proxy-")));
    reportPath = join(dir, "violations.ndjson");
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/ok") {
          return new Response(JSON.stringify({ id: 1, name: "ok" }), {
            headers: { "content-type": "application/json", "x-upstream": "yes" },
          });
        }
        if (url.pathname === "/weird-status") {
          return new Response("teapot", { status: 599, headers: { "content-type": "text/plain" } });
        }
        if (url.pathname === "/bad-body") {
          return new Response(JSON.stringify({ id: "not-an-int" }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("mystery", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    proxy = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: PROXY_SPEC,
      proxy: `http://127.0.0.1:${upstream.port}`,
      report: reportPath,
      log: () => {},
    });
    base = `http://127.0.0.1:${proxy.port}`;
  });

  afterAll(async () => {
    await proxy.stop();
    upstream.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("conforming request/response passes through untouched, no violations", async () => {
    const res = await fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ id: 1, name: "ok" });
    expect(proxy.violations).toHaveLength(0);
  });

  test("undocumented upstream status is passed through and recorded", async () => {
    const res = await fetch(`${base}/weird-status`);
    expect(res.status).toBe(599);
    expect(await res.text()).toBe("teapot");
    const v = proxy.violations.find((x) => x.rule === "undocumented-status");
    expect(v).toBeDefined();
    expect(v!.direction).toBe("response");
    expect(v!.location).toBe("status");
    expect(v!.status).toBe(599);
    expect(v!.template).toBe("/weird-status");
    expect(v!.expected).toEqual(["200"]);
  });

  test("schema-violating upstream JSON body is passed through and recorded", async () => {
    const res = await fetch(`${base}/bad-body`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "not-an-int" });
    const v = proxy.violations.find((x) => x.rule === "type" && x.direction === "response");
    expect(v).toBeDefined();
    expect(v!.location).toBe("body");
    expect(v!.pointer).toBe("/id");
    expect(v!.path).toBe("/bad-body");
  });

  test("unknown path is forwarded anyway and recorded as undocumented-operation", async () => {
    const res = await fetch(`${base}/mystery-path`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mystery");
    const v = proxy.violations.find((x) => x.rule === "undocumented-operation");
    expect(v).toBeDefined();
    expect(v!.direction).toBe("request");
    expect(v!.template).toBe("");
    expect(v!.path).toBe("/mystery-path");
  });

  test("GET /__crust/violations reports; DELETE clears", async () => {
    const before = (await (await fetch(`${base}/__crust/violations`)).json()) as {
      count: number;
      dropped: number;
      violations: Violation[];
    };
    expect(before.count).toBe(proxy.violations.length);
    expect(before.count).toBeGreaterThanOrEqual(3);
    expect(before.dropped).toBe(0);
    expect(before.violations.map((v) => v.rule)).toContain("undocumented-operation");
    for (const v of before.violations) {
      expect(typeof v.ts).toBe("string");
      expect(["request", "response"]).toContain(v.direction);
    }

    const del = await fetch(`${base}/__crust/violations`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const after = (await (await fetch(`${base}/__crust/violations`)).json()) as { count: number };
    expect(after.count).toBe(0);
    expect(proxy.violations).toHaveLength(0);
  });

  test("--report file holds one NDJSON line per violation, surviving DELETE", async () => {
    const text = await readFile(reportPath, "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const parsed = lines.map((l) => JSON.parse(l) as Violation);
    expect(parsed.map((v) => v.rule)).toContain("undocumented-status");
    expect(parsed.map((v) => v.rule)).toContain("undocumented-operation");
  });

  test("unreachable upstream -> 502, NOT recorded as a violation", async () => {
    const doomed = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = doomed.port;
    doomed.stop();
    const orphan = startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: PROXY_SPEC,
      proxy: `http://127.0.0.1:${deadPort}`,
      log: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${orphan.port}/ok`);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; upstream: string; detail: string };
      expect(body.error).toBe("upstream unreachable");
      expect(body.upstream).toContain(String(deadPort));
      expect(orphan.violations).toHaveLength(0);
    } finally {
      await orphan.stop();
    }
  });
});

describe("cli flag conflicts", () => {
  test("--proxy + --stateful -> exit 2 (before spec load)", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    // A nonexistent spec would exit 1 if loading were attempted; 2 proves the
    // conflict is caught before boot.
    const code = await runCli([
      "--swagger",
      "/definitely/not/here.json",
      "--proxy",
      "http://localhost:1",
      "--stateful",
    ]);
    expect(code).toBe(2);
  });

  test("--report without --proxy -> exit 2", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    const code = await runCli([
      "--swagger",
      "/definitely/not/here.json",
      "--report",
      "/tmp/nope.ndjson",
    ]);
    expect(code).toBe(2);
  });

  test("--proxy-timeout must be a positive integer", async () => {
    const { runCli } = await import("../src/mockServer/cli");
    expect(
      await runCli([
        "--swagger",
        "/definitely/not/here.json",
        "--proxy",
        "http://localhost:1",
        "--proxy-timeout",
        "banana",
      ]),
    ).toBe(2);
    expect(
      await runCli([
        "--swagger",
        "/definitely/not/here.json",
        "--proxy",
        "http://localhost:1",
        "--proxy-timeout=0",
      ]),
    ).toBe(2);
  });
});
