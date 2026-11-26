// Regression contract for the generator's soundness audit.
//
// Every case here reproduces a fixture that crust used to EMIT and that a correct
// implementation fails — or an assertion that used to pass on the wrong defect. The
// audit's point was that reading the mock validator's permissive "no violations" as
// "this request is valid" lets a negative case assert a rejection the schema does not
// demand, so each test pairs the counterexample with a CONTROL: a healthy schema whose
// cases must survive. A fix that just makes everything fail passes half of this file.
//
// Provenance of each counterexample is in the case comment. Do not delete one because it
// is inconvenient: delete it only by proving the mutation it names is genuinely invalid.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures, validValue } from "../src/genFixtures/generate";
import { deepEqual, prove, provenInvalid, provenValid } from "../src/genFixtures/proof";
import { validateSchema } from "../src/mockServer/validateRequest";
import { required } from "./support/required";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-soundness-"));
});
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

/** The setup module text, with the optional exports a test needs. */
function setupSource(extra = ""): string {
  return (
    "export const scopeParam = null;\nexport const scopeRoots = [];\n" +
    "export async function shared() { return {}; }\n" +
    "export function headersFor() { return { 'content-type': 'application/json' }; }\n" +
    "export const JSON_HEADERS = { 'content-type': 'application/json' };\n" +
    "export function resolvePath(_c, t) { return 'http://127.0.0.1:1' + t; }\n" +
    extra
  );
}

/** Generate `schema` as the POST /things body and read everything back. */
async function emit(
  name: string,
  schema: Record<string, unknown>,
  opts: { setupExtra?: string; path?: string; method?: string; responses?: unknown } = {},
) {
  const path = opts.path ?? "/things";
  const method = opts.method ?? "post";
  const specPath = join(dir, `${name}.json`);
  await writeFile(
    specPath,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: name, version: "1" },
      paths: {
        [path]: {
          [method]: {
            requestBody: { required: true, content: { "application/json": { schema } } },
            responses: opts.responses ?? {
              "200": { description: "ok" },
              "400": { description: "bad" },
            },
          },
        },
      },
    }),
  );
  const setupPath = join(dir, `${name}.setup.ts`);
  await writeFile(setupPath, setupSource(opts.setupExtra));
  const notes: string[] = [];
  const result = await generateFixtures({
    swagger: specPath,
    out: join(dir, `out-${name}`),
    setup: setupPath,
    log: (line) => notes.push(line),
  });
  const text = (
    await Promise.all(
      result.files.map((f) =>
        Bun.file(f)
          .text()
          .catch(() => ""),
      ),
    )
  ).join("\n");
  const manifest = JSON.parse(await Bun.file(required(result.manifestPath)).text()) as {
    cases: {
      case: string;
      prerequisites: string[];
      validationOracle?: { attribution?: string; constraint?: string; errorType?: string };
    }[];
    unsupported: { operation: string; assumption: string }[];
  };
  return { text, notes, result, manifest, names: manifest.cases.map((c) => c.case) };
}

const body = (
  properties: Record<string, unknown>,
  requiredFields: string[] = Object.keys(properties),
  extra: Record<string, unknown> = {},
) => ({ type: "object", required: requiredFields, properties, ...extra });

describe("a mutation that does not violate the schema is never emitted", () => {
  // Each of these five shipped as `-> 400` against a server that correctly answers 200.
  // They share one root cause: the mutation was built by convention ("inject the enum
  // sentinel", "subtract one from the minimum") and never checked against the schema.
  const cases: [string, Record<string, unknown>, string][] = [
    [
      "enum containing the sentinel crust injects",
      body({ color: { type: "string", enum: ["red", "__not_a_real_enum_value__"] } }, ["color"]),
      "invalid enum for 'color'",
    ],
    [
      "pattern that matches the pattern sentinel",
      body({ note: { type: "string", pattern: "^.*$" } }, ["note"]),
      "wrong type for 'note'",
    ],
    [
      "minimum where minimum - 1 rounds back to the minimum",
      body({ n: { type: "number", minimum: 1e20 } }, ["n"]),
      "below minimum 'n'",
    ],
    [
      "enum branch beside an unrestricted string alternative",
      body({ m: { anyOf: [{ enum: ["a", "b"] }, { type: "string" }] } }, ["m"]),
      "invalid enum for 'm'",
    ],
    [
      "an 'unexpected property' whose name the schema declares",
      body({ a: { type: "string" }, crustUnexpectedProp: { type: "string" } }, ["a"], {
        additionalProperties: false,
      }),
      "unexpected extra property",
    ],
  ];

  for (const [label, schema, missing] of cases) {
    test(label, async () => {
      const r = await emit(`false-${label.slice(0, 8).replace(/\W/g, "")}`, schema);
      expect(r.names.some((n) => n.includes(missing))).toBe(false);
      // Disclosed, not silently missing: a smaller matrix the reader cannot account for
      // is the failure mode this project ranks worst.
      expect(r.notes.join("\n")).toContain("does not violate the schema");
      expect(r.manifest.unsupported.map((a) => a.assumption).join(" ")).toContain(missing);
    });
  }

  test("control: a healthy schema keeps its whole matrix", async () => {
    const r = await emit(
      "healthy",
      body(
        {
          name: { type: "string", minLength: 3, enum: ["abc", "def"] },
          age: { type: "integer", minimum: 1 },
        },
        ["name"],
        { additionalProperties: false },
      ),
    );
    for (const want of [
      "missing required 'name'",
      "wrong type for 'name'",
      "invalid enum for 'name'",
      "too short 'name'",
      "below minimum 'age'",
      "unexpected extra property",
    ]) {
      expect(r.names.some((n) => n.includes(want))).toBe(true);
    }
    expect(r.notes.join("\n")).not.toContain("does not violate the schema");
  });

  test("control: a genuinely invalid enum value is still emitted", async () => {
    const r = await emit("real-enum", body({ c: { type: "string", enum: ["red"] } }, ["c"]));
    expect(r.names.some((n) => n.includes("invalid enum for 'c'"))).toBe(true);
  });
});

describe("a spec that admits no value is named as the spec's own contradiction", () => {
  test("an unsatisfiable numeric or length window is blamed on the spec, not on crust", async () => {
    // `specDeadEnd` used to know only the enum spelling of "no value satisfies this field". An
    // empty numeric window is the same fault, and without the reading crust's own clamped value
    // took the blame — while the cases themselves passed on the base body's defect.
    const num = await emit(
      "dead-num",
      body({ n: { type: "integer", minimum: 1.5, maximum: 1.9 } }),
    );
    expect(num.notes.join("\n")).toContain("the SPEC contradicts itself");
    expect(num.notes.join("\n")).toContain("admit no integer");
    expect(num.text).not.toContain("below minimum");

    const len = await emit("dead-len", body({ s: { type: "string", minLength: 5, maxLength: 2 } }));
    expect(len.notes.join("\n")).toContain("minLength 5 exceeds maxLength 2");

    // Control: a wide window is nobody's contradiction, and its cases are the point of the matrix.
    const fine = await emit("live-num", body({ n: { type: "integer", minimum: 1, maximum: 9 } }));
    expect(fine.notes.join("\n")).not.toContain("contradicts itself");
    expect(fine.text).toContain("below minimum 'n'");
    expect(fine.text).toContain("above maximum 'n'");
  });

  test("a case that removes the unsatisfiable field survives", async () => {
    // With the field absent the contradiction is absent, so this case's only defect is the one
    // it asserts. Dropping it would lose real coverage for a fault the case cannot inherit.
    const r = await emit(
      "dead-missing",
      body({ n: { type: "integer", minimum: 1.5, maximum: 1.9 }, m: { type: "string" } }, [
        "n",
        "m",
      ]),
    );
    expect(r.names.some((n) => n.includes("missing required 'n'"))).toBe(true);
    expect(r.names.some((n) => n.includes("wrong type for 'n'"))).toBe(false);
  });

  test("uniqueItems demanding more distinct items than items can supply is the spec's", async () => {
    // `minItems: 2` over `items: { enum: ["only"] }` asks for two distinct values from a one-value
    // set. No array satisfies it, yet crust's sampled array took the blame: the notice read
    // "crust's own value for 'tags' (minItems) does not satisfy the schema" and sent the reader to
    // the wrong repo's issue tracker. The distinct-value count is an UPPER bound — a member the
    // proof cannot judge stays counted — so the verdict is never a guess.
    const tags = { type: "array", uniqueItems: true, minItems: 2, items: { enum: ["only"] } };
    const r = await emit("dead-uniq", body({ tags }));
    const joined = r.notes.join("\n");
    expect(joined).toContain("the SPEC contradicts itself");
    expect(joined).toContain("admit at most 1");
    expect(joined).not.toContain("crust's own value");
    // The case that removes the field is untouched by the contradiction.
    expect(r.names.some((n) => n.includes("missing required 'tags'"))).toBe(true);

    // Controls: the same keywords are ordinary when they can be satisfied.
    const ok = await emit(
      "live-uniq",
      body({
        tags: { type: "array", uniqueItems: true, minItems: 2, items: { enum: ["a", "b"] } },
      }),
    );
    expect(ok.notes.join("\n")).not.toContain("contradicts itself");
    const noMin = await emit(
      "live-uniq2",
      body({ tags: { type: "array", uniqueItems: true, items: { enum: ["a"] } } }),
    );
    expect(noMin.notes.join("\n")).not.toContain("contradicts itself");
    const len = await emit(
      "dead-items",
      body({ tags: { type: "array", minItems: 3, maxItems: 1, items: { type: "string" } } }),
    );
    expect(len.notes.join("\n")).toContain("minItems 3 exceeds maxItems 1");
  });
});

describe("the proof layer answers three questions, not two", () => {
  // `validateSchema` collapses "cannot tell" into "valid". That collapse is what let the
  // counterexamples above ship, so the distinction is the contract being protected here.
  const schema = {
    type: "object",
    properties: { x: { type: "string", format: "ipv4" } },
  } as const;

  test("proven-invalid, proven-valid and cannot-tell are distinct", () => {
    expect(
      provenInvalid({ x: "nope" }, { type: "object", properties: { x: { enum: ["a"] } } }),
    ).toBe(true);
    expect(provenValid({ x: "a" }, { type: "object", properties: { x: { enum: ["a"] } } })).toBe(
      true,
    );
    // An unknown format is not a pass: the mock validator never judges it, and neither
    // does the proof, so nothing may claim this body is valid.
    const p = prove({ x: "zzz" }, schema);
    expect(p.violations).toEqual([]);
    expect(p.incomplete).toBe(true);
    expect(provenValid({ x: "zzz" }, schema)).toBe(false);
    expect(provenInvalid({ x: "zzz" }, schema)).toBe(false);
  });

  test("it judges the keywords the mock validator deliberately skips", () => {
    const bad: [string, unknown, unknown][] = [
      ["multipleOf", { n: 1 }, { type: "object", properties: { n: { multipleOf: 3 } } }],
      [
        "uniqueItems",
        { t: ["a", "a"] },
        { type: "object", properties: { t: { uniqueItems: true } } },
      ],
      ["const", { k: "cat" }, { type: "object", properties: { k: { const: "dog" } } }],
      [
        "oneOf exactly-one",
        { x: 1 },
        { type: "object", properties: { x: { oneOf: [{ type: "integer" }, { type: "number" }] } } },
      ],
      ["not", { x: 5 }, { type: "object", properties: { x: { not: { type: "integer" } } } }],
    ];
    for (const [label, value, s] of bad) {
      // The permissive validator sees nothing — that is the whole reason proof.ts exists.
      expect(validateSchema(value, s, {} as never, "")).toEqual([]);
      expect(provenInvalid(value, s), label).toBe(true);
    }
  });

  test("a subschema the mock validator never visits is still judged", () => {
    // The proof's `walk` owns the keywords the mock skips, but descending into such a subschema
    // with `walk` alone skipped every keyword the mock DOES own: a value violating `type` inside
    // `patternProperties`, `prefixItems` or `additionalProperties: {schema}` produced no violation
    // and no incompleteness, so `provenValid` claimed a proof for a body any server rejects.
    const cases: [string, unknown, unknown][] = [
      [
        "patternProperties",
        { x: { ab: "s" } },
        { type: "object", properties: { x: { patternProperties: { "^a": { type: "integer" } } } } },
      ],
      [
        "prefixItems",
        { v: ["a"] },
        {
          type: "object",
          properties: { v: { type: "array", prefixItems: [{ type: "integer" }] } },
        },
      ],
      [
        "additionalProperties as a schema",
        { x: { ab: 5 } },
        { type: "object", properties: { x: { additionalProperties: { type: "string" } } } },
      ],
    ];
    for (const [label, value, s] of cases) {
      expect(validateSchema(value, s, {} as never, ""), label).toEqual([]);
      expect(provenInvalid(value, s), label).toBe(true);
      expect(provenValid(value, s), label).toBe(false);
    }
  });

  test("tuple `items` is not judged, and says so instead of inventing a violation", () => {
    // `items` as an ARRAY is a list of per-position schemas (draft-07 / 3.0's tuple form), not a
    // schema for every element. Judging an element against the array itself reports a violation no
    // server agrees with, and crust's own sampler fills a list from `items` as a single schema, so
    // the honest answer is "cannot tell" — which keeps the case rather than dropping it on a
    // contradiction crust invented.
    const tuple = { type: "array", items: [{ type: "string" }, { type: "integer" }] };
    const p = prove(["a", 1], tuple);
    expect(p.violations).toEqual([]);
    expect(p.incomplete).toBe(true);
    expect(provenValid(["a", 1], tuple)).toBe(false);
    // Incompleteness never vetoes a real violation: a string is not an array under any reading.
    expect(provenInvalid("a", tuple)).toBe(true);
  });

  test("deepEqual distinguishes structure, not identity", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1] }, { a: [2] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe("validValue builds a body the schema actually admits", () => {
  const ok = (schema: Record<string, unknown>) =>
    validateSchema(validValue(schema as never), schema, {} as never, "");

  test("integer bounds are closed to the type's granularity", () => {
    // `{integer, minimum: 1.5}` admits 2, and the sampler answered 1.5 — the value the
    // schema forbids, in the base body every negative case is built from.
    expect(validValue({ type: "integer", minimum: 1.5, maximum: 3 })).toBe(2);
    expect(validValue({ type: "integer", exclusiveMinimum: 1.5 })).toBe(2);
    expect(ok({ type: "integer", minimum: 1.5, maximum: 3 })).toEqual([]);
  });

  test("multipleOf is honoured", () => {
    // Ignored outright before: `{integer, multipleOf: 3}` got 1, and nothing downstream
    // complained because the mock validator does not judge that keyword either.
    expect(validValue({ type: "integer", multipleOf: 3 })).toBe(3);
    expect(validValue({ type: "integer", multipleOf: 3, minimum: 1 })).toBe(3);
    expect(ok({ type: "number", multipleOf: 0.2, minimum: 1 })).toEqual([]);
  });

  test("const is read as a one-member enum", () => {
    expect(validValue({ type: "string", const: "dog" })).toBe("dog");
    expect(ok({ type: "string", const: "dog" })).toEqual([]);
  });

  test("uniqueItems gets distinct members", () => {
    const v = validValue({
      type: "array",
      uniqueItems: true,
      minItems: 3,
      items: { type: "string" },
    });
    expect(new Set(v as string[]).size).toBe(3);
    expect(ok({ type: "array", uniqueItems: true, items: { type: "string" } })).toEqual([]);
  });

  test("an unsatisfiable window is left visibly unsound, not plausibly wrong", () => {
    // `{integer, minimum: 1.5, maximum: 1.9}` admits no integer. Inventing one would hide
    // the contradiction; the clamped bound makes the manifest name it.
    expect(ok({ type: "integer", minimum: 1.5, maximum: 1.9 })).not.toEqual([]);
  });
});

describe("configured statuses are 4xx unless 5xx is policy", () => {
  const specPath = join(dir, "status.spec.json");
  const setupFor = (name: string, expectations: string) => {
    const p = join(dir, `${name}.setup.ts`);
    return writeFile(p, setupSource(`export const expectations = ${expectations};\n`)).then(
      () => p,
    );
  };

  async function generate(setupPath: string) {
    const notes: string[] = [];
    const result = await generateFixtures({
      swagger: specPath,
      out: join(dir, `out-status-${setupPath.split("/").pop()}`),
      setup: setupPath,
      log: (line) => notes.push(line),
    });
    return { notes, result };
  }

  beforeAll(async () => {
    // No documented 400, so a configured status is the only thing that builds a matrix.
    await writeFile(
      specPath,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "s", version: "1" },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: body({ n: { type: "integer" } }, ["n"]),
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    );
  });

  test("422 is fine, 500 is refused", async () => {
    await expect(
      generate(await setupFor("ok422", "{ validationStatus: 422 }")),
    ).resolves.toBeTruthy();
    let message = "";
    try {
      await generate(await setupFor("no500", "{ validationStatus: 500 }"));
    } catch (e) {
      message = (e as Error).message;
    }
    // The old message claimed "only client-error statuses" while accepting 500.
    expect(message).toContain("between 400 and 499");
    expect(message).toContain("serverErrorStatus");
  });

  test("the opt-in allows 5xx and says so out loud", async () => {
    const { notes, result } = await generate(
      await setupFor("yes500", "{ validationStatus: 500, serverErrorStatus: true }"),
    );
    expect(result.totalCases).toBeGreaterThan(0);
    expect(notes.join("\n")).toContain("serverErrorStatus is set");
    const text = await Bun.file(required(result.files[0])).text();
    expect(text).toContain("status: 500");
  });

  test("the opt-in is a boolean", async () => {
    let message = "";
    try {
      await generate(
        await setupFor("bad5xx", '{ validationStatus: 500, serverErrorStatus: "yes" }'),
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("serverErrorStatus must be a boolean");
  });
});

describe("constraint-level attribution is earned, not guessed", () => {
  const setupExtra =
    "export const expectations = { validationEnvelope: 'fastapi', validationErrorTypes: " +
    "{ minLength: 'string_too_short' } };\n";

  test("a mapped constraint asserts the code; an unmapped one stays field-level", async () => {
    const r = await emit(
      "attr",
      body({ name: { type: "string", minLength: 3 }, note: { type: "string", pattern: "^a+$" } }, [
        "name",
      ]),
      { setupExtra },
    );
    const short = r.manifest.cases.find((c) => c.case.includes("too short"));
    expect(short?.validationOracle?.attribution).toBe("constraint");
    expect(short?.validationOracle?.errorType).toBe("string_too_short");
    // `pattern` was not configured, so this case honestly claims less.
    const pattern = r.manifest.cases.find((c) => c.case.includes("pattern violation"));
    expect(pattern?.validationOracle?.attribution).toBe("field");
    expect(pattern?.validationOracle?.errorType).toBeUndefined();
    // The emitted matcher carries the code, so an unrelated error cannot satisfy it.
    expect(r.text).toContain('e.type === "string_too_short"');
  });

  test("an unknown constraint name is refused, not inert", async () => {
    let message = "";
    try {
      await emit("attr-bad", body({ name: { type: "string", minLength: 3 } }, ["name"]), {
        setupExtra: "export const expectations = { validationErrorTypes: { minLenght: 'x' } };\n",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unknown constraint "minLenght"');
  });
});

describe("a CRUD flow proves identity, change and persistence", () => {
  const flowSetup =
    "export const JSON_HEADERS = { 'content-type': 'application/json' };\n" +
    "export const scopeParam = null;\nexport const scopeRoots = [];\n" +
    "let c = null;\nexport function shared() { c ??= Promise.resolve({}); return c; }\n" +
    "export function headersFor() { return JSON_HEADERS; }\n" +
    "export function resolvePath(_c, t) { return 'http://127.0.0.1:1' + t; }\n";

  /** A collection with an item op set, and a create body crust cannot fill. */
  async function flow(
    name: string,
    itemOps: Record<string, unknown>,
    createSchema: Record<string, unknown>,
    setupExtra = "",
  ) {
    const specPath = join(dir, `${name}.spec.json`);
    await writeFile(
      specPath,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: name, version: "1" },
        paths: {
          "/gadgets": {
            post: {
              tags: ["gadgets"],
              requestBody: { content: { "application/json": { schema: createSchema } } },
              responses: {
                "201": {
                  description: "ok",
                  content: { "application/json": { example: { id: "x" } } },
                },
              },
            },
          },
          "/gadgets/{gadget}": itemOps,
        },
      }),
    );
    const setupPath = join(dir, `${name}.setup.ts`);
    await writeFile(setupPath, `${flowSetup}${setupExtra}`);
    const notes: string[] = [];
    const result = await generateFixtures({
      swagger: specPath,
      out: join(dir, `out-flow-${name}`),
      setup: setupPath,
      log: (l) => notes.push(l),
    });
    const flowText = result.flowFile ? await Bun.file(result.flowFile).text() : "";
    return { notes, result, flowText };
  }

  const gadget = body({ name: { type: "string", minLength: 2 }, age: { type: "integer" } }, [
    "name",
    "age",
  ]);

  test("the read asserts identity at the captured path, not a substring", async () => {
    // `JSON.stringify(j).includes(id)` passed for the WRONG resource — `{"id":"wrong",
    // "note":"<id>"}` satisfied it, and with the env var unset the `?? " "` fallback
    // passed any body containing a space.
    const r = await flow(
      "flow-id",
      { get: { responses: { "200": { description: "ok" } } } },
      gadget,
    );
    expect(r.flowText).toContain('String(j.id ?? "") === process.env.GEN_ID_GADGETS');
    expect(r.flowText).not.toContain("JSON.stringify(j).includes");
  });

  test("a PATCH carries the schema's required set", async () => {
    // One property regardless of `required` is a body the op's OWN request schema rejects,
    // so the step 400s against a correct server for a reason no spec states.
    const r = await flow(
      "flow-patch",
      {
        patch: {
          requestBody: { content: { "application/json": { schema: gadget } } },
          responses: { "200": { description: "ok" } },
        },
      },
      gadget,
    );
    expect(r.flowText).toContain('"name":');
    expect(r.flowText).toContain('"age":');
  });

  test("the update changes something, and the change is read back", async () => {
    const r = await flow(
      "flow-change",
      {
        get: { responses: { "200": { description: "ok" } } },
        patch: {
          requestBody: { content: { "application/json": { schema: gadget } } },
          responses: { "200": { description: "ok" } },
        },
      },
      gadget,
    );
    // Same deterministic value as the create body would prove only that the endpoint
    // accepts a body.
    const post = required(r.flowText.split("\n").find((l) => l.includes("POST")));
    const patch = required(r.flowText.split("\n").find((l) => l.includes("PATCH")));
    expect(patch.slice(0, patch.indexOf("|"))).not.toEqual(post.slice(0, post.indexOf("|")));
    expect(r.flowText).toContain("read-after-update");
  });

  test("an override body does not certify an unsound create body", async () => {
    // The merge is a shallow spread: `body: {}` contributes nothing, so the unsound
    // schema-derived body used to ship with the notice that would have named it
    // silenced by the same override. An override may FIX a body, not certify one.
    const unreadable = { type: "string", pattern: "^(?!a)a" };
    const r = await flow(
      "flow-override",
      { get: { responses: { "200": { description: "ok" } } } },
      body({ code: unreadable }, ["code"]),
      'export const flowOverrides = { "/gadgets": { body: {} } };\n',
    );
    expect(r.result.flowCount).toBe(0);
    expect(r.notes.join("\n")).toContain("create step would 400");
  });
});

describe("an item-path matrix needs a resource that exists", () => {
  const itemSchema = body({ name: { type: "string", minLength: 3 } }, ["name"]);
  // The unknown-id bait is derived only where the contract documents 404.
  const responses = {
    "200": { description: "ok" },
    "400": { description: "bad" },
    "404": { description: "gone" },
  };

  test("without resolveKnownPath the cases are skipped and named", async () => {
    const r = await emit("item-no", itemSchema, {
      path: "/items/{itemId}",
      method: "put",
      responses,
    });
    expect(r.names.some((n) => n.includes("too short"))).toBe(false);
    expect(r.notes.join("\n")).toContain("resolveKnownPath");
    // The 404 bait survives: it is the family a random id CAN test.
    expect(r.names.some((n) => n.includes("unknown itemId"))).toBe(true);
  });

  test("with resolveKnownPath they are emitted through it", async () => {
    const r = await emit("item-yes", itemSchema, {
      path: "/items/{itemId}",
      method: "put",
      responses,
      setupExtra:
        "export function resolveKnownPath(_c, t) { return 'http://127.0.0.1:1' + t.replace(/\\{\\w+\\}/, 'known'); }\n",
    });
    const short = r.names.find((n) => n.includes("too short"));
    expect(short).toBeDefined();
    expect(r.text).toContain('resolveKnownPath(ctx, "/items/{itemId}")');
    // The unknown-id bait still goes through resolvePath: it WANTS a missing resource.
    expect(r.text).toContain('resolvePath(ctx, "/items/{itemId}")');
    const c = required(r.manifest.cases.find((x) => x.case === short));
    expect(c.prerequisites).toContain("known-resource:itemId");
  });

  test("resolveKnownPath must be a function", async () => {
    let message = "";
    try {
      await emit("item-bad", itemSchema, {
        path: "/items/{id}",
        method: "put",
        setupExtra: "export const resolveKnownPath = 42;\n",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("resolveKnownPath must be a function");
  });
});
