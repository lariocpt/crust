// validationEnvelope — the validation-response envelope as reviewed
// configuration. The 422/400 matrix has always asserted crust's own
// validation shape (code === "validation" + fieldErrors), so a contract that
// answers FastAPI's detail array got no usable cases. This file pins the
// whole feature:
//
//   1. configuration — `validationEnvelope: "crust" | "fastapi"`, global and
//      per-operation; per-op beats global; omitted = the crust convention,
//      byte for byte; any other value refuses the generation BEFORE anything
//      is written (loud message, exit 2 through the CLI, no output dir);
//   2. the envelope is NEVER inferred from a status — a documented or
//      configured 422 keeps the crust predicate unless the envelope is
//      configured too, and the two provenances are independent;
//   3. the emitted fastapi predicate is strict: a `detail` array holding an
//      error whose `loc` exactly equals the case's own body location, with a
//      nonempty string `msg` and `type`. Wrong fields, query/path locations,
//      wrong loc length, malformed entries, empty or non-string msg/type,
//      and generic bodies all FAIL; neither envelope is permissive — a
//      crust-shaped answer fails the fastapi predicate and a fastapi-shaped
//      answer fails the crust one;
//   4. the documented response schema stays attached — predicate and schema
//      are cumulative, and the schema alone catches a response the predicate
//      passes (a missing documented field);
//   5. provenance — the manifest's validationOracle records the envelope,
//      where the choice came from ("default" vs configured:<module>), and
//      the exact target location carried from derivation (never parsed from
//      the case name); non-validation cases carry no oracle at all;
//   6. a fastapi case with no attributable location is dropped and
//      disclosed — never matched permissively;
//   7. end to end against a real FastAPI-shaped server: the fixtures pass a
//      response that carries nothing but detail (+ the documented fields) —
//      no code, no fieldErrors anywhere — and every corruption mode fails at
//      the layer it corrupts;
//   8. determinism and biome-format idempotency of the emitted files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropUnattributable,
  type GenCase,
  type GenerateResult,
  generateFixtures,
} from "../src/genFixtures/generate";
import { runFixtures } from "../src/testFixture/runner";

// Shared tmpdir root; the helper above and every nested describe resolve
// their trees under it, and the outer beforeAll/afterAll owns its lifetime.
let dir: string;

// Three validation answers in one contract: a FastAPI-shaped 422 (with a
// documented detail+traceId schema), the crust-shaped 400 (with a documented
// error+code+fieldErrors schema), and an operation that documents no error
// at all (a "gap" only a configured status can fill).
const SPEC = {
  openapi: "3.0.0",
  info: { title: "envelope", version: "1" },
  paths: {
    "/api/fastapi": {
      post: {
        tags: ["fastapi"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "age", "role"],
                additionalProperties: false,
                properties: {
                  email: { type: "string", format: "email" },
                  age: { type: "integer", minimum: 0, maximum: 120 },
                  role: { type: "string", enum: ["admin", "user"] },
                  code: { type: "string", pattern: "^[A-Z]{3}$" },
                  note: { type: "string", minLength: 2, maxLength: 10 },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "created" },
          "422": {
            description: "validation",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["detail", "traceId"],
                  properties: {
                    detail: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["loc", "msg", "type"],
                        properties: {
                          loc: { type: "array", items: { type: "string" } },
                          msg: { type: "string" },
                          type: { type: "string" },
                        },
                      },
                    },
                    traceId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/legacy": {
      post: {
        tags: ["crust"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                additionalProperties: false,
                properties: { name: { type: "string", minLength: 2 } },
              },
            },
          },
        },
        responses: {
          "200": { description: "ok" },
          "400": {
            description: "validation",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["error", "code"],
                  properties: {
                    error: { type: "string" },
                    code: { type: "string" },
                    fieldErrors: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/gap": {
      post: {
        tags: ["gap"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                additionalProperties: false,
                properties: { token: { type: "string", minLength: 3 } },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

// The plain setup module (no expectations block) the default-behaviour tests
// generate against. The e2e server address comes from an env var so the
// generated setup stays a reviewed constant, not a test-wired address.
const SETUP = `
export const JSON_HEADERS = { "content-type": "application/json" };
export const scopeParam = null;
let cached = null;
export function shared() {
  cached ??= Promise.resolve({});
  return cached;
}
export function headersFor(ctx, role) {
  return { ...JSON_HEADERS, "x-role": role };
}
export function resolvePath(ctx, template) {
  const base = process.env.ENVELOPE_TEST_BASE ?? "http://localhost:9";
  return base + template;
}
`;

// The main configuration: a global fastapi envelope over a configured 422,
// with the legacy op overridden back to the crust envelope per-operation.
const MAIN_EXPECTATIONS = `{ validationStatus: 422, validationEnvelope: "fastapi", operations: { "POST /api/legacy": { validationEnvelope: "crust" } } }`;

interface ManifestLite {
  cases: {
    operation: string;
    case: string;
    mutation: string;
    expectStatus: number;
    expectationSource: string;
    validationOracle?: {
      envelope: string;
      source: string;
      target: { loc: string[]; kind: string };
    };
    prerequisites: string[];
  }[];
  unsupported: { operation: string; assumption: string }[];
}

async function manifestOf(path: string): Promise<ManifestLite> {
  return JSON.parse(await Bun.file(path).text()) as ManifestLite;
}

interface GenBundle {
  result: GenerateResult;
  setupPath: string;
  manifest: ManifestLite;
  file: (tag: string) => Promise<string>;
}

// Generate a focused spec into a fresh out dir under the shared tmpdir.
// `expectations: null` reuses the plain setup module written in beforeAll;
// anything else becomes a `<name>-setup.ts` exporting that block.
async function generate(
  name: string,
  spec: unknown,
  expectations: string | null,
): Promise<GenBundle> {
  const specPath = join(dir, `${name}-spec.json`);
  await writeFile(specPath, JSON.stringify(spec));
  const setupPath = expectations === null ? join(dir, "setup.ts") : join(dir, `${name}-setup.ts`);
  if (expectations !== null) {
    await writeFile(setupPath, `${SETUP}\nexport const expectations = ${expectations};\n`);
  }
  const result = await generateFixtures({
    swagger: specPath,
    out: join(dir, name),
    setup: setupPath,
    flows: false,
    log: () => {},
  });
  const manifest = await manifestOf(result.manifestPath);
  const outDir = result.outDir;
  const file = (tag: string) => Bun.file(join(outDir, `${tag}.gen.crust.ts`)).text();
  return { result, setupPath, manifest, file };
}

// The e2e server's oracles: the same constraints the spec documents, written
// as a real validator. Each returns the FastAPI-style error list for a body.
interface Err {
  loc: string[];
  msg: string;
  type: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fastapiErrors(body: unknown): Err[] {
  const errs: Err[] = [];
  if (!isPlainObject(body)) {
    return [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }];
  }
  const email = body.email;
  if (email === undefined) {
    errs.push({ loc: ["body", "email"], msg: "Field required", type: "missing" });
  } else if (typeof email !== "string" || !email.includes("@")) {
    errs.push({ loc: ["body", "email"], msg: "Value error: invalid email", type: "value_error" });
  }
  const age = body.age;
  if (age === undefined) {
    errs.push({ loc: ["body", "age"], msg: "Field required", type: "missing" });
  } else if (typeof age !== "number" || !Number.isInteger(age)) {
    errs.push({ loc: ["body", "age"], msg: "Input should be a valid integer", type: "int_type" });
  } else if (age < 0) {
    errs.push({ loc: ["body", "age"], msg: "Input should be >= 0", type: "greater_than_equal" });
  } else if (age > 120) {
    errs.push({ loc: ["body", "age"], msg: "Input should be <= 120", type: "less_than_equal" });
  }
  const role = body.role;
  if (role === undefined) {
    errs.push({ loc: ["body", "role"], msg: "Field required", type: "missing" });
  } else if (typeof role !== "string") {
    errs.push({
      loc: ["body", "role"],
      msg: "Input should be a valid string",
      type: "string_type",
    });
  } else if (role !== "admin" && role !== "user") {
    errs.push({ loc: ["body", "role"], msg: "Input should be 'admin' or 'user'", type: "enum" });
  }
  const code = body.code;
  if (code !== undefined && (typeof code !== "string" || !/^[A-Z]{3}$/.test(code))) {
    errs.push({
      loc: ["body", "code"],
      msg: "String should match pattern",
      type: "string_pattern",
    });
  }
  const note = body.note;
  if (note !== undefined) {
    if (typeof note !== "string") {
      errs.push({
        loc: ["body", "note"],
        msg: "Input should be a valid string",
        type: "string_type",
      });
    } else if (note.length < 2) {
      errs.push({
        loc: ["body", "note"],
        msg: "String should have >= 2 chars",
        type: "string_too_short",
      });
    } else if (note.length > 10) {
      errs.push({
        loc: ["body", "note"],
        msg: "String should have <= 10 chars",
        type: "string_too_long",
      });
    }
  }
  if ("crustUnexpectedProp" in body) {
    errs.push({
      loc: ["body", "crustUnexpectedProp"],
      msg: "Extra inputs are not permitted",
      type: "extra_forbidden",
    });
  }
  return errs;
}

function legacyErrors(body: unknown): Err[] {
  const errs: Err[] = [];
  if (!isPlainObject(body)) {
    return [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }];
  }
  const name = body.name;
  if (name === undefined) {
    errs.push({ loc: ["body", "name"], msg: "Field required", type: "missing" });
  } else if (typeof name !== "string" || name.length < 2) {
    errs.push({
      loc: ["body", "name"],
      msg: "String should have >= 2 chars",
      type: "string_too_short",
    });
  }
  if ("crustUnexpectedProp" in body) {
    errs.push({
      loc: ["body", "crustUnexpectedProp"],
      msg: "Extra inputs are not permitted",
      type: "extra_forbidden",
    });
  }
  return errs;
}

function gapErrors(body: unknown): Err[] {
  const errs: Err[] = [];
  if (!isPlainObject(body)) {
    return [{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }];
  }
  const token = body.token;
  if (token === undefined) {
    errs.push({ loc: ["body", "token"], msg: "Field required", type: "missing" });
  } else if (typeof token !== "string") {
    errs.push({
      loc: ["body", "token"],
      msg: "Input should be a valid string",
      type: "string_type",
    });
  } else if (token.length < 3) {
    errs.push({
      loc: ["body", "token"],
      msg: "String should have >= 3 chars",
      type: "string_too_short",
    });
  }
  if ("crustUnexpectedProp" in body) {
    errs.push({
      loc: ["body", "crustUnexpectedProp"],
      msg: "Extra inputs are not permitted",
      type: "extra_forbidden",
    });
  }
  return errs;
}

type Mode =
  | "ok"
  | "wrong-status"
  | "no-traceid"
  | "wrong-field"
  | "crust-shaped"
  | "fastapi-shaped"
  | "generic";

function jsonBody(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The repo's biome binary, run through bun (its JS wrapper picks the
// platform executable). Config resolves from the spawned cwd, so the
// caller places the mirrored biome.json at that root.
const BIOME_BIN = join(import.meta.dir, "..", "node_modules", "@biomejs", "biome", "bin", "biome");

async function runBiome(args: string[], cwd: string): Promise<number> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", BIOME_BIN, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new Error(`biome spawn failed: ${(err as Error).message}`);
  }
  // Drain BOTH pipes before awaiting the exit — `exitCode` is still
  // undefined while the child runs, and a non-drained pipe deadlocks a
  // child that writes enough to fill it. Piped stdio is a stream at
  // runtime; the cast only narrows bun-types' `number | stream | undefined`.
  const [out, errText] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text(),
  ]);
  let code: number;
  try {
    code = await proc.exited;
  } catch (err) {
    throw new Error(`biome process died: ${(err as Error).message}\n${errText}`);
  }
  if (code !== 0) {
    // Surface the child's own diagnosis — an opaque non-zero exit made the
    // first run of this suite undiagnosable.
    throw new Error(`biome ${args.join(" ")} exited ${code}\n${out + errText}`);
  }
  return code;
}
describe("gen-fixtures — validationEnvelope (configured validation-response envelope)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-env-"));
    await writeFile(join(dir, "spec.json"), JSON.stringify(SPEC));
    await writeFile(join(dir, "setup.ts"), SETUP);
    // Mirror the repo's own formatter settings into the project root, so the
    // emitter's style walk (up from --out) and the biome subprocess in the
    // formatting test below resolve the SAME config. Tracked at run time: if
    // the repo's config changes, the mirror follows it.
    const repoBiome = JSON.parse(
      await readFile(join(import.meta.dir, "..", "biome.json"), "utf8"),
    ) as { formatter: unknown; javascript: unknown };
    await writeFile(
      join(dir, "biome.json"),
      `${JSON.stringify(
        { formatter: repoBiome.formatter, javascript: repoBiome.javascript },
        null,
        2,
      )}\n`,
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("config validation", () => {
    test("invalid validationEnvelope values refuse generation before any output", async () => {
      const bads: [string, string][] = [
        ["global non-envelope", `{ validationStatus: 422, validationEnvelope: "django" }`],
        ["global wrong case", `{ validationStatus: 422, validationEnvelope: "FASTAPI" }`],
        ["global empty string", `{ validationStatus: 422, validationEnvelope: "" }`],
        ["global number", `{ validationStatus: 422, validationEnvelope: 42 }`],
        ["global null", `{ validationStatus: 422, validationEnvelope: null }`],
        [
          "per-op non-envelope",
          `{ validationStatus: 422, operations: { "POST /api/gap": { validationEnvelope: "fast" } } }`,
        ],
        [
          "per-op number",
          `{ validationStatus: 422, operations: { "POST /api/gap": { validationEnvelope: 0 } } }`,
        ],
        [
          "unknown key beside a valid envelope",
          `{ validationEnvelope: "fastapi", envelopes: "fastapi" }`,
        ],
      ];
      for (const [what, cfg] of bads) {
        const safe = what.replace(/[^a-z0-9]+/gi, "-");
        const setupPath = join(dir, `env-bad-${safe}-setup.ts`);
        await writeFile(setupPath, `${SETUP}\nexport const expectations = ${cfg};\n`);
        const out = join(dir, `env-bad-${safe}-out`);
        await expect(
          generateFixtures({
            swagger: join(dir, "spec.json"),
            out,
            setup: setupPath,
            flows: false,
            log: () => {},
          }),
        ).rejects.toThrow(/validationEnvelope/);
        // Refused BEFORE writing: the out dir is never created.
        expect(existsSync(out)).toBe(false);
      }
    });

    test("an invalid envelope through the CLI is exit 2, naming the two allowed values", async () => {
      const { runCli } = await import("../src/genFixtures/cli");
      const setupPath = join(dir, "env-bad-cli-setup.ts");
      await writeFile(
        setupPath,
        `${SETUP}\nexport const expectations = { validationStatus: 422, validationEnvelope: "django" };\n`,
      );
      const out = join(dir, "env-bad-cli-out");
      const chunks: string[] = [];
      const real = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: unknown }).write = (c: unknown) => {
        chunks.push(String(c));
        return true;
      };
      let code = 0;
      try {
        code = await runCli([join(dir, "spec.json"), "-o", out, "-s", setupPath, "--no-flows"]);
      } finally {
        (process.stderr as unknown as { write: unknown }).write = real;
      }
      expect(code).toBe(2);
      const err = chunks.join("");
      expect(err).toContain("validationEnvelope");
      expect(err).toContain('must be "crust" or "fastapi"');
      expect(existsSync(out)).toBe(false);
    });

    test("both valid envelope values generate", async () => {
      for (const env of ["crust", "fastapi"]) {
        const { result } = await generate(
          `env-ok-${env}`,
          SPEC,
          `{ validationStatus: 422, validationEnvelope: "${env}" }`,
        );
        expect(result.files.length).toBe(3);
        expect(result.totalCases).toBe(21);
      }
    });
  });

  describe("the unconfigured default keeps the crust convention", () => {
    test("no envelope configuration keeps the crust predicate, disclosed and provenanced", async () => {
      const { result, manifest, file } = await generate("env-default", SPEC, null);
      // The only matrix the contract alone can drive is the documented-400
      // op; the 422-answering ops are disclosed, not silently dropped.
      expect(result.files.length).toBe(1);
      expect(result.files[0]).toContain("crust.gen.crust.ts");
      expect(manifest.unsupported.map((u) => u.operation).sort()).toEqual([
        "POST /api/fastapi",
        "POST /api/gap",
      ]);
      const text = await file("crust");
      expect(text).toContain('d.code === "validation"');
      expect(text).toContain("d.fieldErrors !== undefined");
      expect(text).toContain('"name" in d.fieldErrors');
      // The fastapi shape never leaks into an unconfigured generation.
      expect(text).not.toContain("detail");
      expect(text).not.toContain(".loc");
      // Every generated case records the DEFAULT crust oracle with its own
      // target — carried from derivation, never parsed from the case name.
      expect(manifest.cases.length).toBe(4);
      for (const c of manifest.cases) {
        expect(c.operation).toBe("POST /api/legacy");
        expect(c.expectStatus).toBe(400);
        expect(c.expectationSource).toBe("contract:paths./api/legacy.post.responses.400");
        expect(c.validationOracle?.envelope).toBe("crust");
        expect(c.validationOracle?.source).toBe("default");
      }
      const byName = new Map(manifest.cases.map((c) => [c.case, c]));
      const expectTarget = (caseName: string, loc: string[], kind: string) => {
        const c = byName.get(caseName);
        expect(c).toBeDefined();
        expect(c!.validationOracle?.target).toEqual({ loc, kind });
      };
      expectTarget(
        "POST /api/legacy missing required 'name' -> 400",
        ["body", "name"],
        "missing-required",
      );
      expectTarget("POST /api/legacy wrong type for 'name' -> 400", ["body", "name"], "wrong-type");
      expectTarget("POST /api/legacy too short 'name' -> 400", ["body", "name"], "bound");
      expectTarget(
        "POST /api/legacy unexpected extra property -> 400",
        ["body", "crustUnexpectedProp"],
        "unexpected-property",
      );
    });

    test("a configured 422 never selects the envelope — status and envelope provenance stay independent", async () => {
      const { manifest, setupPath, file } = await generate(
        "env-noenv",
        SPEC,
        `{ validationStatus: 422 }`,
      );
      // The matrix at 422 exists (the config fills the gap), but its
      // predicate is the crust convention: no envelope was configured
      // anywhere, so a status code alone never selects one.
      const fastapi = await file("fastapi");
      const gap = await file("gap");
      for (const text of [fastapi, gap]) {
        expect(text).toContain('d.code === "validation"');
        // The word "detail" itself may appear in the DOCUMENTED 422 response
        // schema — it is attached whenever the configured status lands on a
        // documented response, envelope-independent. What must be absent is
        // the fastapi PREDICATE, whose marker is `d.detail`; the schema's own
        // `detail:` key does not contain that substring.
        expect(text).not.toContain("d.detail");
        expect(text).not.toContain(".loc");
      }
      // The gap op: the STATUS provenance is configured while the ENVELOPE
      // provenance is the default — one case, two independent sources.
      const gapCase = manifest.cases.find(
        (c) => c.operation === "POST /api/gap" && c.case.includes("missing required"),
      );
      expect(gapCase?.expectStatus).toBe(422);
      expect(gapCase?.expectationSource).toBe(`configured:${setupPath}`);
      expect(gapCase?.validationOracle).toEqual({
        envelope: "crust",
        source: "default",
        target: { loc: ["body", "token"], kind: "missing-required" },
      });
      // The documented-400 op stays 400 under the configured 422 (the
      // existing precedence is untouched) with the default envelope.
      const legacyCase = manifest.cases.find(
        (c) => c.operation === "POST /api/legacy" && c.case.includes("missing required"),
      );
      expect(legacyCase?.expectStatus).toBe(400);
      expect(legacyCase?.expectationSource).toBe("contract:paths./api/legacy.post.responses.400");
      expect(legacyCase?.validationOracle?.envelope).toBe("crust");
      expect(legacyCase?.validationOracle?.source).toBe("default");
    });

    test("a non-validation case carries no oracle", async () => {
      // A contract that documents a 404 (unknown-id family) next to a
      // documented-400 validation matrix, with no expectations at all: the
      // 404 case is not a validation case, so it gets no oracle; the 400
      // cases keep the default-crust one.
      const spec = {
        openapi: "3.0.0",
        info: { title: "mix", version: "1" },
        paths: {
          "/api/echo/{echoId}": {
            get: {
              tags: ["mix"],
              responses: {
                "200": { description: "ok" },
                "404": { description: "gone" },
              },
            },
          },
          "/api/v": {
            post: {
              tags: ["mix"],
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["name"],
                      additionalProperties: false,
                      properties: { name: { type: "string", minLength: 2 } },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "ok" },
                "400": { description: "bad" },
              },
            },
          },
        },
      };
      const { manifest } = await generate("env-mix", spec, null);
      const echoCase = manifest.cases.find((c) => c.operation === "GET /api/echo/{echoId}");
      expect(echoCase).toBeDefined();
      expect(echoCase?.expectStatus).toBe(404);
      expect("validationOracle" in (echoCase as object)).toBe(false);
      const vCases = manifest.cases.filter((c) => c.operation === "POST /api/v");
      expect(vCases.length).toBe(4);
      for (const c of vCases) {
        expect(c.validationOracle?.envelope).toBe("crust");
        expect(c.validationOracle?.source).toBe("default");
      }
    });
  });

  describe("envelope selection and provenance", () => {
    test("global fastapi with a per-op crust override: each file keeps its own shape", async () => {
      const { manifest, file } = await generate("env-main", SPEC, MAIN_EXPECTATIONS);
      const fastapi = await file("fastapi");
      expect(fastapi).toContain("d.detail");
      expect(fastapi).toContain('e.loc[1] === "email"');
      expect(fastapi).toContain('e.loc[1] === "crustUnexpectedProp"');
      expect(fastapi).not.toContain("fieldErrors");
      expect(fastapi).not.toContain('d.code === "validation"');
      const crust = await file("crust");
      expect(crust).toContain('d.code === "validation"');
      expect(crust).toContain("d.fieldErrors !== undefined");
      expect(crust).toContain('"name" in d.fieldErrors');
      expect(crust).not.toContain("detail");
      const gap = await file("gap");
      expect(gap).toContain("d.detail");
      expect(gap).not.toContain("fieldErrors");
      // 13 + 4 + 4 = 21 cases across the three ops.
      const counts = new Map<string, number>();
      for (const c of manifest.cases) counts.set(c.operation, (counts.get(c.operation) ?? 0) + 1);
      expect(counts.get("POST /api/fastapi")).toBe(13);
      expect(counts.get("POST /api/legacy")).toBe(4);
      expect(counts.get("POST /api/gap")).toBe(4);
    });

    test("status provenance and envelope provenance are independent", async () => {
      const { manifest, setupPath } = await generate("env-prov", SPEC, MAIN_EXPECTATIONS);
      const by = (op: string, needle: string) =>
        manifest.cases.find((c) => c.operation === op && c.case.includes(needle));
      // Documented 400 beats the configured 422 (contract STATUS); the
      // per-op crust envelope still applies to the case (configured
      // ENVELOPE) — two mechanisms, one case.
      const legacy = by("POST /api/legacy", "missing required 'name'");
      expect(legacy?.expectStatus).toBe(400);
      expect(legacy?.expectationSource).toBe("contract:paths./api/legacy.post.responses.400");
      expect(legacy?.validationOracle?.envelope).toBe("crust");
      expect(legacy?.validationOracle?.source).toBe(`configured:${setupPath}`);
      // The 422 gate: the contract documents no 400, so the STATUS comes
      // from the configuration (a documented 422 supplies the response
      // schema, not the status provenance); the ENVELOPE comes from the
      // global configuration.
      const fastapi = by("POST /api/fastapi", "missing required 'email'");
      expect(fastapi?.expectStatus).toBe(422);
      expect(fastapi?.expectationSource).toBe(`configured:${setupPath}`);
      expect(fastapi?.validationOracle?.envelope).toBe("fastapi");
      expect(fastapi?.validationOracle?.source).toBe(`configured:${setupPath}`);
      // The gap op: both provenances configured, the global envelope.
      const gap = by("POST /api/gap", "missing required 'token'");
      expect(gap?.expectStatus).toBe(422);
      expect(gap?.expectationSource).toBe(`configured:${setupPath}`);
      expect(gap?.validationOracle?.envelope).toBe("fastapi");
      expect(gap?.validationOracle?.source).toBe(`configured:${setupPath}`);
    });

    test("an explicit global crust is a configured choice, not the default", async () => {
      const oneProp = (field: string) => ({
        type: "object",
        required: [field],
        properties: { [field]: { type: "string" } },
      });
      const spec = {
        openapi: "3.0.0",
        info: { title: "exp", version: "1" },
        paths: {
          "/api/a": {
            post: {
              tags: ["ab"],
              requestBody: {
                content: { "application/json": { schema: oneProp("x") } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
          "/api/b": {
            post: {
              tags: ["ab"],
              requestBody: {
                content: { "application/json": { schema: oneProp("y") } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const cfg = JSON.stringify({
        validationStatus: 422,
        validationEnvelope: "crust",
        operations: { "POST /api/a": { validationEnvelope: "fastapi" } },
      });
      const { manifest, setupPath, file } = await generate("env-exp", spec, cfg);
      // Per-op fastapi beats the explicit global crust.
      const aCases = manifest.cases.filter((c) => c.operation === "POST /api/a");
      expect(aCases.length).toBe(2);
      for (const c of aCases) {
        expect(c.expectStatus).toBe(422);
        expect(c.validationOracle?.envelope).toBe("fastapi");
        expect(c.validationOracle?.source).toBe(`configured:${setupPath}`);
      }
      // The other op falls through to the EXPLICIT global — envelope
      // "crust", but the source is the module, not the default convention.
      const bCases = manifest.cases.filter((c) => c.operation === "POST /api/b");
      expect(bCases.length).toBe(2);
      for (const c of bCases) {
        expect(c.validationOracle?.envelope).toBe("crust");
        expect(c.validationOracle?.source).toBe(`configured:${setupPath}`);
      }
      const text = await file("ab");
      expect(text).toContain("d.detail");
      expect(text).toContain('d.code === "validation"');
    });
  });
  describe("the emitted fastapi predicate — direct truth table", () => {
    // The generated file is imported and its data matcher called with
    // synthetic bodies, so the predicate is pinned WITHOUT a server: every
    // mutation family (the loc comes from the manifest's oracle target) must
    // accept the exact location and refuse every malformation.
    interface FixtureLite {
      name: string;
      setup: () => Promise<unknown>;
      input: (ctx: unknown) => Record<string, unknown>;
      output: { status: number; data: (d: unknown) => boolean; schema?: unknown };
    }

    test("every mutation family: the exact location passes, every malformation fails", async () => {
      const { result, manifest } = await generate("env-tt", SPEC, MAIN_EXPECTATIONS);
      const fastapiFile = result.files.find((f) => f.includes("fastapi.gen.crust.ts"));
      expect(fastapiFile).toBeDefined();
      const mod = (await import(fastapiFile!)) as { default: FixtureLite[] };
      expect(mod.default.length).toBe(13);
      const oracles = new Map(manifest.cases.map((c) => [c.case, c.validationOracle]));
      const msg = "boom";
      const type = "boom_type";
      for (const fx of mod.default) {
        const oracle = oracles.get(fx.name);
        expect(oracle).toBeDefined();
        const loc = oracle!.target.loc;
        const data = fx.output.data;
        // Positives — the exact location; msg/type CONTENT is never read.
        expect(data({ detail: [{ loc, msg, type }] })).toBe(true);
        // A wrong error may precede the right one: some() is the contract.
        expect(
          data({
            detail: [
              { loc: ["body", "WRONG"], msg, type },
              { loc, msg, type },
            ],
          }),
        ).toBe(true);
        // Extra properties on the entry (real FastAPI sends input/url) are
        // ignored — the predicate names the location, not the message.
        expect(data({ detail: [{ loc, msg, type, input: { value: 7 }, url: "/x" }] })).toBe(true);
        // Negatives — every malformation the predicate must refuse.
        const negatives: unknown[] = [
          { detail: [{ loc: ["body", "WRONG"], msg, type }] }, // wrong field
          { detail: [{ loc: ["query", "x"], msg, type }] }, // query location
          { detail: [{ loc: ["path", "id"], msg, type }] }, // path location
          { detail: [{ loc: [...loc, "extra"], msg, type }] }, // loc too long
          { detail: [{ loc: ["body"], msg, type }] }, // loc too short
          { detail: "boom" }, // detail not an array
          {}, // detail missing
          { detail: null }, // detail null
          { detail: [{ msg, type }] }, // entry without loc
          { detail: [{ loc, type }] }, // msg missing
          { detail: [{ loc, msg: "", type }] }, // msg empty
          { detail: [{ loc, msg: 42, type }] }, // msg not a string
          { detail: [{ loc, msg }] }, // type missing
          { detail: [{ loc, msg, type: "" }] }, // type empty
          { detail: [null] }, // entry null
          { detail: ["boom"] }, // entry not an object
        ];
        for (const body of negatives) {
          expect(data(body)).toBe(false);
        }
      }
    });
  });

  describe("dropUnattributable", () => {
    test("drops fastapi cases without a target; keeps everything else, in order", () => {
      const mk = (patch: Partial<GenCase>): GenCase => ({
        name: "case",
        auth: "none",
        method: "post",
        path: "/x",
        expectStatus: 422,
        expectationSource: "configured:m",
        ...patch,
      });
      const fastapiNoTarget = mk({
        name: "fastapi without target",
        validationEnvelope: "fastapi",
        expectValidationField: "a",
      });
      const fastapiWithTarget = mk({
        name: "fastapi with target",
        validationEnvelope: "fastapi",
        expectValidationField: "b",
        validationTarget: { loc: ["body", "b"], kind: "bound", field: "b" },
      });
      const crustNoTarget = mk({
        name: "crust without target",
        expectValidationField: "c",
      });
      const fastapiNonValidation = mk({
        name: "fastapi non-validation",
        validationEnvelope: "fastapi",
      });
      const input = [fastapiNoTarget, fastapiWithTarget, crustNoTarget, fastapiNonValidation];
      const { kept, dropped } = dropUnattributable(input);
      expect(dropped.length).toBe(1);
      expect(dropped[0]!.operation).toBe("POST /x");
      // The disclosed assumption names the envelope and the refusal to be
      // permissive — the manifest is where a reviewer sees the loss.
      expect(dropped[0]!.assumption).toContain("fastapi");
      expect(dropped[0]!.assumption).toContain("matched permissively");
      expect(kept.map((c) => c.name)).toEqual([
        "fastapi with target",
        "crust without target",
        "fastapi non-validation",
      ]);
    });
  });

  describe("the runner end to end against a FastAPI-shaped server", () => {
    let server: ReturnType<typeof Bun.serve> | undefined;
    let e2eDir: string;
    let e2eResult: GenerateResult;
    let mode: Mode = "ok";
    let lastFastapiBody: unknown = null;
    let lastLegacyBody: unknown = null;

    // One mode variable drives all three routes; each route only misbehaves
    // in the modes its own file is run under, so a single global mode is
    // sufficient for every scenario in this block.
    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      if (url.pathname === "/api/fastapi") {
        const errs = fastapiErrors(body);
        if (errs.length === 0) return jsonBody({ id: "thing-1" }, 201);
        if (mode === "crust-shaped") {
          lastFastapiBody = {
            error: "Validation failed",
            code: "validation",
            fieldErrors: { [errs[0]!.loc[1] ?? "body"]: errs[0]!.msg },
          };
          return jsonBody(lastFastapiBody, 422);
        }
        const detail =
          mode === "wrong-field"
            ? errs.map((e) => ({ loc: ["body", "WRONG"], msg: e.msg, type: e.type }))
            : errs;
        const resp: Record<string, unknown> = { detail, traceId: "tr-1" };
        if (mode === "no-traceid") delete resp.traceId;
        lastFastapiBody = resp;
        return jsonBody(resp, mode === "wrong-status" ? 400 : 422);
      }
      if (url.pathname === "/api/legacy") {
        const errs = legacyErrors(body);
        if (mode === "fastapi-shaped") {
          lastLegacyBody = {
            detail: errs.map((e) => ({ loc: e.loc, msg: e.msg, type: "fastapi_error" })),
          };
          return jsonBody(lastLegacyBody, 400);
        }
        if (errs.length === 0) return jsonBody({ ok: true }, 200);
        const fieldErrors: Record<string, string> = {};
        for (const e of errs) fieldErrors[e.loc[e.loc.length - 1] ?? "body"] = e.msg;
        lastLegacyBody = { error: "Validation failed", code: "validation", fieldErrors };
        return jsonBody(lastLegacyBody, 400);
      }
      if (url.pathname === "/api/gap") {
        const errs = gapErrors(body);
        if (mode === "generic") return jsonBody({}, 422);
        if (errs.length === 0) return jsonBody({ ok: true }, 200);
        return jsonBody({ detail: errs }, 422);
      }
      return new Response("not found", { status: 404 });
    };

    beforeAll(async () => {
      e2eDir = join(dir, "e2e");
      // writeFile does not create parents — the out dir is the generator's
      // job, but the setup file's directory is ours.
      await mkdir(e2eDir, { recursive: true });
      const setupPath = join(e2eDir, "setup-envelope.ts");
      await writeFile(setupPath, `${SETUP}\nexport const expectations = ${MAIN_EXPECTATIONS};\n`);
      e2eResult = await generateFixtures({
        swagger: join(dir, "spec.json"),
        out: join(e2eDir, "out"),
        setup: setupPath,
        flows: false,
        log: () => {},
      });
      server = Bun.serve({ port: 0, fetch: handler });
      process.env.ENVELOPE_TEST_BASE = `http://localhost:${server.port}`;
    });

    afterAll(async () => {
      server?.stop();
      delete process.env.ENVELOPE_TEST_BASE;
    });

    test("a FastAPI-shaped answer passes — no code, no fieldErrors anywhere in the exchange", async () => {
      mode = "ok";
      lastFastapiBody = null;
      lastLegacyBody = null;
      const report = await runFixtures({
        target: join(e2eDir, "out", "*.crust.ts"),
        threads: 1,
      });
      expect(e2eResult.totalCases).toBe(21);
      expect(report.totals.pass).toBe(21);
      expect(report.totals.fail).toBe(0);
      expect(report.totals.error).toBe(0);
      // The server answered the fastapi op with nothing but detail (+ the
      // documented traceId). The exchange contained no crust-shaped keys at
      // all — this is the regression the envelope configuration exists for.
      expect(lastFastapiBody).not.toBeNull();
      const sent = JSON.stringify(lastFastapiBody);
      expect(sent).toContain("detail");
      expect(sent).toContain("traceId");
      expect(sent).not.toContain("fieldErrors");
      expect(sent).not.toContain('"code"');
    });

    test("a wrong status fails on the status — the predicate is not reached", async () => {
      mode = "wrong-status";
      const report = await runFixtures({
        target: join(e2eDir, "out", "fastapi.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(13);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        expect(r.failures[0]?.path).toBe("output.status");
        expect(r.failures[0]?.expected).toBe(422);
        expect(r.failures[0]?.actual).toBe(400);
      }
    });

    test("every error loc corrupted to the wrong field fails on the predicate", async () => {
      mode = "wrong-field";
      const report = await runFixtures({
        target: join(e2eDir, "out", "fastapi.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(13);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        expect(r.failures[0]?.path).toBe("output.data");
      }
    });

    test("the schema catches what the predicate passes — a missing documented field", async () => {
      mode = "no-traceid";
      const report = await runFixtures({
        target: join(e2eDir, "out", "fastapi.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(13);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        // The predicate PASSED (detail was intact); the documented schema
        // failed on the missing required traceId — exactly one violation,
        // which is what makes predicate and schema cumulative.
        expect(r.failures).toHaveLength(1);
        expect(r.failures[0]?.path).toBe("output.data/traceId");
      }
    });

    test("a crust-shaped answer fails the fastapi envelope — no permissive fallback", async () => {
      mode = "crust-shaped";
      const report = await runFixtures({
        target: join(e2eDir, "out", "fastapi.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(13);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        expect(r.failures[0]?.path).toBe("output.data");
      }
    });

    test("a fastapi-shaped answer fails the crust envelope — no permissive fallback", async () => {
      mode = "fastapi-shaped";
      lastLegacyBody = null;
      const report = await runFixtures({
        target: join(e2eDir, "out", "crust.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(4);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        expect(r.failures[0]?.path).toBe("output.data");
      }
      // The answer really was fastapi-shaped: the failure is the crust
      // predicate refusing a detail array, not a shape mistake by the test.
      expect(JSON.stringify(lastLegacyBody)).toContain("detail");
    });

    test("a status-only body fails the fastapi envelope — generic bodies are not accepted", async () => {
      mode = "generic";
      const report = await runFixtures({
        target: join(e2eDir, "out", "gap.gen.crust.ts"),
        threads: 1,
      });
      expect(report.totals.fail).toBe(4);
      expect(report.totals.pass).toBe(0);
      for (const r of report.results) {
        expect(r.status).toBe("fail");
        expect(r.failures[0]?.path).toBe("output.data");
      }
    });
  });
  describe("determinism and formatting", () => {
    let a: GenerateResult;
    let b: GenerateResult;

    beforeAll(async () => {
      // One spec file and one setup module shared by BOTH generations (the
      // same pattern as the F6 determinism test), so the manifest's spec
      // pointer and the generated import specifier are identical on both
      // sides and the comparison is a pure byte comparison.
      const setupPath = join(dir, "det-setup.ts");
      await writeFile(setupPath, `${SETUP}\nexport const expectations = ${MAIN_EXPECTATIONS};\n`);
      a = await generateFixtures({
        swagger: join(dir, "spec.json"),
        out: join(dir, "det-a"),
        setup: setupPath,
        flows: false,
        log: () => {},
      });
      b = await generateFixtures({
        swagger: join(dir, "spec.json"),
        out: join(dir, "det-b"),
        setup: setupPath,
        flows: false,
        log: () => {},
      });
    });

    test("two configured generations are byte-identical", async () => {
      expect(a.files.length).toBe(b.files.length);
      for (let i = 0; i < a.files.length; i++) {
        const fa = a.files[i]!;
        const fb = join(join(dir, "det-b"), fa.split("/").pop()!);
        expect(await Bun.file(fb).text()).toBe(await Bun.file(fa).text());
      }
      expect(await Bun.file(b.manifestPath).text()).toBe(await Bun.file(a.manifestPath).text());
    });

    test("the generated fastapi file is biome-format-idempotent under the mirrored repo config", async () => {
      const file = join(dir, "det-a", "fastapi.gen.crust.ts");
      const before = await Bun.file(file).text();
      // The mirror written in the outer beforeAll carries the repo's own
      // formatter settings, and this subprocess resolves it from its cwd —
      // so it formats with exactly the settings the emitter used. `format`
      // exits non-zero when the bytes need reformatting (runBiome surfaces
      // its output in the error), and --write must then be a byte no-op: a
      // consumer's biome pre-commit hook would change nothing.
      await runBiome(["format", "det-a/fastapi.gen.crust.ts"], dir);
      await runBiome(["format", "--write", "det-a/fastapi.gen.crust.ts"], dir);
      expect(await Bun.file(file).text()).toBe(before);
    });
  });
});
