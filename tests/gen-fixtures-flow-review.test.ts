import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "../src/genFixtures/generate";
import { runPipes } from "../src/testPipes/runner";
import { required } from "./support/required";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-flow-review-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Schema = Record<string, unknown>;
type Mode =
  | "correct"
  | "wrong"
  | "null"
  | "missing"
  | "reordered"
  | "reversed"
  | "nested"
  | "wrong-id";

function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, v]) => [key, reordered(v)]),
    );
  }
  return value;
}

function wrongValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(String);
  if (value !== null && typeof value === "object") return { wrong: true };
  if (typeof value === "string") return { wrong: true };
  return String(value);
}

async function fixture(
  name: string,
  field: Schema,
  options: {
    postWrapped?: boolean;
    getWrapped?: boolean;
    schemaShape?: boolean;
    unknown?: boolean;
  } = {},
) {
  let mode: Mode = "correct";
  let record: Record<string, unknown> = {};
  let updated = false;
  const wrap = (value: unknown, wrapped?: boolean) => (wrapped ? { resource: value } : value);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "POST") {
        record = { ...((await request.json()) as Record<string, unknown>), id: "created-id" };
        updated = false;
        return Response.json(wrap(record, options.postWrapped), { status: 201 });
      }
      if (request.method === "PATCH") {
        Object.assign(record, await request.json());
        updated = true;
        return Response.json(record);
      }
      const result = { ...record };
      if (mode === "wrong-id") result.id = "different-id";
      if (updated) {
        if (mode === "wrong") result.value = wrongValue(result.value);
        if (mode === "null") result.value = null;
        if (mode === "missing") delete result.value;
        if (mode === "reordered") result.value = reordered(result.value);
        if (mode === "reversed") result.value = [...(result.value as unknown[])].reverse();
        if (mode === "nested") {
          result.value = { ...(result.value as object), nested: { nil: "null" } };
        }
      }
      return Response.json(wrap(result, options.getWrapped));
    },
  });
  const object = { type: "object", required: ["value"], properties: { value: field } };
  const response = (wrapped?: boolean) => {
    const resource = {
      type: "object",
      properties: { id: { type: "string" }, value: field },
    };
    return {
      description: "ok",
      content: {
        "application/json": options.schemaShape
          ? { schema: wrapped ? { type: "object", properties: { resource } } : resource }
          : { example: wrap({ id: "example-id", value: "example" }, wrapped) },
      },
    };
  };
  try {
    const specPath = join(dir, `${name}.json`);
    const setupPath = join(dir, `${name}.setup.ts`);
    await writeFile(
      specPath,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: name, version: "1" },
        paths: {
          "/records": {
            post: {
              requestBody: { content: { "application/json": { schema: object } } },
              responses: { "201": response(options.postWrapped) },
            },
          },
          "/records/{id}": {
            get: {
              responses: {
                "200": options.unknown
                  ? { description: "unknown shape" }
                  : response(options.getWrapped),
              },
            },
            patch: {
              requestBody: { content: { "application/json": { schema: object } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    );
    await writeFile(
      setupPath,
      "export const scopeParam = null;\nexport const scopeRoots = [];\n" +
        "export const JSON_HEADERS = { 'content-type': 'application/json' };\n" +
        "export async function shared() { return {}; }\n" +
        "export function headersFor() { return { ...JSON_HEADERS, authorization: 'Bearer review' }; }\n" +
        `export function resolvePath(_c, t) { return ${JSON.stringify(server.url.origin)} + t; }\n`,
    );
    const notes: string[] = [];
    const generated = await generateFixtures({
      swagger: specPath,
      setup: setupPath,
      out: join(dir, `out-${name}`),
      log: (line) => notes.push(line),
    });
    const target = generated.flowFile;
    return {
      generated,
      notes,
      text: target ? await Bun.file(target).text() : "",
      async run(next: Mode) {
        mode = next;
        return runPipes({ target: required(target) });
      },
      stop() {
        server.stop(true);
      },
    };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

describe("review: structural JSON persistence through the real pipeline runner", () => {
  const fields: [string, Schema][] = [
    ["string", { type: "string" }],
    ["number", { type: "number" }],
    ["integer", { type: "integer" }],
    ["boolean", { type: "boolean" }],
    [
      "object",
      {
        type: "object",
        required: ["nested", "empty"],
        properties: {
          nested: {
            type: "object",
            required: ["nil"],
            properties: { nil: { type: "null", const: null } },
          },
          empty: { type: "array", maxItems: 0, items: { type: "string" } },
        },
      },
    ],
    ["array", { type: "array", minItems: 2, items: { type: ["string", "number"] } }],
  ];
  for (const [name, field] of fields) {
    test(`${name}: actual persistence passes; coercion, null and omission fail only read-back`, async () => {
      const f = await fixture(`persistence-${name}`, field);
      try {
        expect(f.generated.flowCount).toBe(1);
        expect(f.text).toContain("return equal(j.value,");
        expect((await f.run("correct")).totals).toMatchObject({ pass: 4, fail: 0 });
        for (const mode of ["wrong", "null", "missing"] as const) {
          const report = await f.run(mode);
          expect(report.results.map((r) => r.status)).toEqual(["pass", "pass", "pass", "fail"]);
        }
        if (name === "object") {
          expect((await f.run("reordered")).totals).toMatchObject({ pass: 4, fail: 0 });
          expect((await f.run("nested")).results.map((r) => r.status)).toEqual([
            "pass",
            "pass",
            "pass",
            "fail",
          ]);
        }
        if (name === "array") {
          expect((await f.run("reversed")).results.map((r) => r.status)).toEqual([
            "pass",
            "pass",
            "pass",
            "fail",
          ]);
        }
      } finally {
        f.stop();
      }
    });
  }

  test("an unsound large multipleOf create is skipped instead of certified", async () => {
    const f = await fixture("large-fraction", {
      type: "number",
      multipleOf: 1,
      enum: [1_000_000_000.25],
    });
    try {
      expect(f.generated.flowCount).toBe(0);
      expect(f.notes.join("\n")).toContain("create step would 400");
    } finally {
      f.stop();
    }
  });
});

describe("review: each GET owns its response paths", () => {
  for (const schemaShape of [false, true]) {
    for (const postWrapped of [false, true]) {
      test(`${schemaShape ? "schema" : "example"}: ${postWrapped ? "wrapped" : "bare"} POST has an independent GET envelope`, async () => {
        const f = await fixture(
          `paths-${schemaShape}-${postWrapped}`,
          { type: "string" },
          {
            schemaShape,
            postWrapped,
            getWrapped: !postWrapped,
          },
        );
        try {
          expect(f.text).toContain(
            `capture GEN_ID_RECORDS (b => b.${postWrapped ? "resource." : ""}id)`,
          );
          expect(f.text).toContain(
            `String(j.${postWrapped ? "" : "resource."}id ?? "") === process.env.GEN_ID_RECORDS`,
          );
          expect(f.text).toContain(`return equal(j.${postWrapped ? "" : "resource."}value,`);
          expect((await f.run("correct")).totals).toMatchObject({ pass: 4, fail: 0 });
          expect((await f.run("wrong")).results.map((r) => r.status)).toEqual([
            "pass",
            "pass",
            "pass",
            "fail",
          ]);
          expect((await f.run("wrong-id")).results.map((r) => r.status)).toEqual([
            "pass",
            "fail",
            "pass",
            "pass",
          ]);
        } finally {
          f.stop();
        }
      });
    }
  }

  test("an undocumented GET is explicitly status-only with no POST-path fallback", async () => {
    const f = await fixture(
      "unknown-get",
      { type: "string" },
      { unknown: true, postWrapped: true },
    );
    try {
      expect(f.text).toContain("read(status-only)");
      expect(f.text).toContain("read-after-update(status-only)");
      expect(f.text).toContain("identity is not asserted");
      expect(f.text).toContain("persistence is not asserted");
      expect(f.text).not.toContain("String(j.");
      expect(f.text).not.toContain("return equal(");
      expect((await f.run("wrong-id")).totals).toMatchObject({ pass: 4, fail: 0 });
    } finally {
      f.stop();
    }
  });
});
