// The emitted style must match the project that receives the generated
// files: a biome project's pre-commit hook (biome check --write) normalises
// the gen output to its own formatter, so an emit that disagrees diffs the
// whole matrix on every regeneration. The contract under test:
//
//   1. the nearest biome.json governs — walked up from --out, then from cwd
//      when the out tree is not inside the working project;
//   2. `indentStyle: "tab"` -> a tab, `"space"` -> `indentWidth` spaces, an
//      absent key -> biome's own default (space/2), applied over the
//      top-level formatter in the order biome applies them
//      (javascript.formatter last);
//   3. `lineWidth` (biome's default 80 when the key is absent) governs where
//      long calls, import lists and matcher chains wrap;
//   4. `javascript.formatter.quoteStyle` (biome's default "double") governs
//      string literals, with biome's escape-minimising flip;
//   5. `assist.actions.source.organizeImports` (ON by default in biome 2.x)
//      sorts imported names in CLDR ASCII natural order; only an explicit
//      "off" or `assist.enabled: false` keeps the legacy code-point sort;
//   6. no biome.json on either walk -> the historical 2-space form, byte for
//      byte (zero behaviour change for non-biome repos);
//   7. a config biome itself would reject (unparseable) is disclosed and
//      treated as absent — generation never fails on a broken formatter.
//
// Three layers, mirroring launcher-manifest.test.ts: the pure unit (the
// resolution truth table and the reindent mapping), in-process generation
// into temp projects, and the real subprocess through the CLI with an
// explicit cwd — the only way to pin the TRUE "no biome.json anywhere"
// path, because an in-process run's cwd is this repo, whose biome.json is
// space/2.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "../src/genFixtures/generate";
import {
  DEFAULT_INDENT_UNIT,
  findBiomeJsonUp,
  indentUnitForBiomeConfig,
  reindentTwoSpace,
  resolveEmitStyle,
  resolveIndentUnit,
  styleForBiomeConfig,
} from "../src/genFixtures/indent";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

// ---------------------------------------------------------------------------
// Layer 1 — unit
// ---------------------------------------------------------------------------

describe("indentUnitForBiomeConfig", () => {
  test("absent keys take biome's own defaults (space/2)", () => {
    expect(indentUnitForBiomeConfig({})).toBe("  ");
    expect(indentUnitForBiomeConfig(null)).toBe("  ");
    expect(indentUnitForBiomeConfig("not an object")).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { lineWidth: 100 } })).toBe("  ");
  });

  test("a tab style emits a tab, regardless of indentWidth", () => {
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "tab" } })).toBe("\t");
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "tab", indentWidth: 4 } })).toBe(
      "\t",
    );
  });

  test("a space style emits indentWidth spaces", () => {
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "space", indentWidth: 4 } })).toBe(
      "    ",
    );
    expect(indentUnitForBiomeConfig({ formatter: { indentWidth: 8 } })).toBe("        ");
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "space" } })).toBe("  ");
  });

  test("javascript.formatter applies over the top-level formatter", () => {
    expect(
      indentUnitForBiomeConfig({
        formatter: { indentStyle: "space", indentWidth: 2 },
        javascript: { formatter: { indentStyle: "tab" } },
      }),
    ).toBe("\t");
    expect(
      indentUnitForBiomeConfig({
        formatter: { indentStyle: "tab" },
        javascript: { formatter: { indentStyle: "space", indentWidth: 4 } },
      }),
    ).toBe("    ");
    // The repo that pins the style under javascript.formatter ALONE.
    expect(indentUnitForBiomeConfig({ javascript: { formatter: { indentWidth: 6 } } })).toBe(
      "      ",
    );
    // The other keys javascript.formatter carries must not leak a style in.
    expect(
      indentUnitForBiomeConfig({
        formatter: { indentStyle: "tab" },
        javascript: { formatter: { quoteStyle: "double" } },
      }),
    ).toBe("\t");
  });

  test("values biome would reject fall back to the defaults", () => {
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "tabs" } })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "Tab" } })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentWidth: 0 } })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentWidth: -2 } })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentWidth: 2.5 } })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentWidth: "4" } })).toBe("  ");
    // `formatter: null` disables the formatter entirely — it contributes nothing.
    expect(indentUnitForBiomeConfig({ formatter: null })).toBe("  ");
    expect(indentUnitForBiomeConfig({ formatter: { indentStyle: "tab" }, javascript: null })).toBe(
      "\t",
    );
  });
});

describe("findBiomeJsonUp", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-genfx-find-"));
    await writeFile(join(dir, "biome.json"), "{}");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the nearest biome.json on the chain wins", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "biome.json"), "{}");
    await mkdir(join(dir, "sub", "deep"), { recursive: true });
    expect(findBiomeJsonUp(join(dir, "sub", "deep"))).toBe(join(dir, "sub", "biome.json"));
    expect(findBiomeJsonUp(join(dir, "sub"))).toBe(join(dir, "sub", "biome.json"));
    expect(findBiomeJsonUp(join(dir, "other"))).toBe(join(dir, "biome.json"));
  });

  test("a directory that does not exist yet walks from its resolved path", async () => {
    // --out does not exist before generation; the walk must still start there.
    expect(findBiomeJsonUp(join(dir, "never-made"))).toBe(join(dir, "biome.json"));
  });

  test("no biome.json on the chain -> null", async () => {
    const clean = await mkdtemp(join(tmpdir(), "crust-genfx-clean-"));
    try {
      expect(findBiomeJsonUp(join(clean, "x", "y"))).toBeNull();
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  });
});

describe("resolveIndentUnit", () => {
  let clean: string;
  let outTree: string;
  let cwdTree: string;

  beforeAll(async () => {
    clean = await mkdtemp(join(tmpdir(), "crust-genfx-res-"));
    outTree = join(clean, "outproj");
    cwdTree = join(clean, "cwdproj");
    await mkdir(outTree, { recursive: true });
    await mkdir(cwdTree, { recursive: true });
    await writeFile(join(outTree, "biome.json"), "{}");
    await writeFile(join(cwdTree, "biome.json"), "{}");
  });
  afterAll(async () => {
    await rm(clean, { recursive: true, force: true });
  });

  test("a biome.json in the out tree governs, even when cwd has one", async () => {
    await writeFile(
      join(outTree, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "space", indentWidth: 4 } }),
    );
    await writeFile(
      join(cwdTree, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "tab" } }),
    );
    const logs: string[] = [];
    const r = resolveIndentUnit(join(outTree, "tests", "gen"), (l) => logs.push(l), cwdTree);
    expect(r).toEqual({ unit: "    ", biomeJson: join(outTree, "biome.json") });
    expect(logs).toEqual([]);
  });

  test("the cwd fallback applies only when the out walk finds nothing", async () => {
    // Out tree with no biome.json of its own; cwd tree has the tab config.
    await rm(join(outTree, "biome.json"), { force: true });
    await writeFile(
      join(cwdTree, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "tab" } }),
    );
    const r = resolveIndentUnit(join(outTree, "tests", "gen"), () => {}, cwdTree);
    expect(r).toEqual({ unit: "\t", biomeJson: join(cwdTree, "biome.json") });
  });

  test("no biome.json on either walk -> the legacy 2-space unit, silent", async () => {
    const nowhere = await mkdtemp(join(tmpdir(), "crust-genfx-nowhere-"));
    try {
      const logs: string[] = [];
      const r = resolveIndentUnit(join(nowhere, "out"), (l) => logs.push(l), nowhere);
      expect(r).toEqual({ unit: DEFAULT_INDENT_UNIT, biomeJson: null });
      expect(logs).toEqual([]);
    } finally {
      await rm(nowhere, { recursive: true, force: true });
    }
  });

  test("a biome at its own default resolves to the 2-space unit but names the file", async () => {
    // Same output as the fallback, but the decision was a biome.json — which
    // is why the unit alone does not tell the story and the resolution carries
    // the path.
    await writeFile(
      join(cwdTree, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "space", indentWidth: 2 } }),
    );
    const nowhere = await mkdtemp(join(tmpdir(), "crust-genfx-nowhere2-"));
    try {
      const r = resolveIndentUnit(join(nowhere, "out"), () => {}, cwdTree);
      expect(r).toEqual({ unit: "  ", biomeJson: join(cwdTree, "biome.json") });
    } finally {
      await rm(nowhere, { recursive: true, force: true });
    }
  });

  test("an unparseable biome.json is disclosed and treated as absent", async () => {
    await writeFile(join(cwdTree, "biome.json"), "{ not json,");
    const nowhere = await mkdtemp(join(tmpdir(), "crust-genfx-bad-"));
    try {
      const logs: string[] = [];
      const r = resolveIndentUnit(join(nowhere, "out"), (l) => logs.push(l), cwdTree);
      expect(r).toEqual({ unit: DEFAULT_INDENT_UNIT, biomeJson: null });
      expect(logs).toEqual([
        `gen-fixtures: biome.json at ${join(cwdTree, "biome.json")} is not valid JSON — ` +
          "biome will reject it too, so the output keeps crust's 2-space form",
      ]);
    } finally {
      await rm(nowhere, { recursive: true, force: true });
    }
  });
});

describe("styleForBiomeConfig", () => {
  // organizeImports — the truth table. Biome 2.x defaults the assist ON:
  // an absent key (or a value biome would reject) still re-sorts, and only
  // an explicit "off" — or a disabled assist — keeps the legacy code-point
  // order. Measured: a config with no assist key at all still re-sorted a
  // code-point-sorted import list under both biome 2.4.13 and 2.5.7.
  test("organizeImports defaults to on for an empty config", () => {
    expect(styleForBiomeConfig({}).organizeImports).toBe(true);
  });

  test("an absent assist key keeps organizeImports on", () => {
    expect(styleForBiomeConfig({ formatter: { indentStyle: "tab" } }).organizeImports).toBe(true);
  });

  test('an explicit organizeImports "on" is on', () => {
    expect(
      styleForBiomeConfig({ assist: { actions: { source: { organizeImports: "on" } } } })
        .organizeImports,
    ).toBe(true);
  });

  test('an explicit organizeImports "off" is off', () => {
    expect(
      styleForBiomeConfig({ assist: { actions: { source: { organizeImports: "off" } } } })
        .organizeImports,
    ).toBe(false);
  });

  test("assist.enabled false wins over an explicit on", () => {
    expect(
      styleForBiomeConfig({
        assist: { enabled: false, actions: { source: { organizeImports: "on" } } },
      }).organizeImports,
    ).toBe(false);
  });

  test("a value biome would reject leaves the default (on) standing", () => {
    expect(
      styleForBiomeConfig({ assist: { actions: { source: { organizeImports: "maybe" } } } })
        .organizeImports,
    ).toBe(true);
  });

  // lineWidth — biome's default 80 when the key is absent, the javascript
  // layer on top of the top level, rejected values fall back to the default.
  test("lineWidth defaults to 80 when absent", () => {
    expect(styleForBiomeConfig({}).lineWidth).toBe(80);
  });

  test("the javascript layer overrides the top-level lineWidth", () => {
    expect(
      styleForBiomeConfig({
        formatter: { lineWidth: 100 },
        javascript: { formatter: { lineWidth: 120 } },
      }).lineWidth,
    ).toBe(120);
  });

  test("a lineWidth biome would reject falls back to 80", () => {
    for (const bad of [0, -5, 2.5, "80"]) {
      expect(styleForBiomeConfig({ formatter: { lineWidth: bad } }).lineWidth).toBe(80);
    }
  });

  // quoteStyle — javascript.formatter only (biome 2.x has no top-level
  // quoteStyle to layer), default "double". The escape-minimising flip is
  // applied at emit time, not here.
  test("quoteStyle defaults to double", () => {
    expect(styleForBiomeConfig({}).quoteStyle).toBe("double");
  });

  test("quoteStyle single stands", () => {
    expect(
      styleForBiomeConfig({ javascript: { formatter: { quoteStyle: "single" } } }).quoteStyle,
    ).toBe("single");
  });

  test("a top-level formatter.quoteStyle is not a biome 2.x key — ignored", () => {
    expect(styleForBiomeConfig({ formatter: { quoteStyle: "single" } }).quoteStyle).toBe("double");
  });

  test("a quoteStyle biome would reject falls back to double", () => {
    expect(
      styleForBiomeConfig({ javascript: { formatter: { quoteStyle: "backtick" } } }).quoteStyle,
    ).toBe("double");
  });

  // indent — a tab unit counts as the resolved indentWidth columns in the
  // fit checks, whatever the indent style; the javascript layer wins.
  test("a tab config gives a tab unit at the default count", () => {
    const s = styleForBiomeConfig({ formatter: { indentStyle: "tab" } });
    expect(s.unit).toBe("\t");
    expect(s.indentWidth).toBe(2);
  });

  test("a tab with a wider indentWidth keeps the tab but the wider count", () => {
    const s = styleForBiomeConfig({ formatter: { indentStyle: "tab", indentWidth: 4 } });
    expect(s.unit).toBe("\t");
    expect(s.indentWidth).toBe(4);
  });

  test("the javascript layer overrides the top-level indent", () => {
    expect(
      styleForBiomeConfig({
        formatter: { indentStyle: "tab" },
        javascript: { formatter: { indentStyle: "space", indentWidth: 4 } },
      }).unit,
    ).toBe("    ");
  });
});

describe("resolveEmitStyle", () => {
  let clean: string;
  let outTree: string;
  let cwdTree: string;

  beforeAll(async () => {
    clean = await mkdtemp(join(tmpdir(), "crust-genfx-style-"));
    outTree = join(clean, "outproj");
    cwdTree = join(clean, "cwdproj");
    await mkdir(outTree, { recursive: true });
    await mkdir(cwdTree, { recursive: true });
  });
  afterAll(async () => {
    await rm(clean, { recursive: true, force: true });
  });

  test("no biome.json on either walk -> the legacy record, silent", () => {
    const logs: string[] = [];
    const style = resolveEmitStyle(join(clean, "elsewhere", "out"), (l) => logs.push(l), clean);
    expect(style).toEqual({
      unit: DEFAULT_INDENT_UNIT,
      indentWidth: 2,
      lineWidth: Number.POSITIVE_INFINITY,
      quoteStyle: "json",
      organizeImports: false,
      legacy: true,
      biomeJson: null,
    });
    expect(logs).toEqual([]);
  });

  test("a biome.json in the out tree governs, with the full record", async () => {
    await writeFile(
      join(outTree, "biome.json"),
      JSON.stringify({
        formatter: { indentStyle: "tab" },
        javascript: { formatter: { quoteStyle: "single" } },
      }),
    );
    const style = resolveEmitStyle(join(outTree, "tests", "gen"), () => {}, cwdTree);
    expect(style).toEqual({
      unit: "\t",
      indentWidth: 2,
      lineWidth: 80,
      quoteStyle: "single",
      organizeImports: true,
      legacy: false,
      biomeJson: join(outTree, "biome.json"),
    });
  });

  test("the cwd fallback names the config it found, off wins for the sort", async () => {
    await rm(join(outTree, "biome.json"), { force: true });
    await writeFile(
      join(cwdTree, "biome.json"),
      JSON.stringify({
        formatter: { indentStyle: "space", indentWidth: 4 },
        assist: { actions: { source: { organizeImports: "off" } } },
      }),
    );
    const style = resolveEmitStyle(join(outTree, "tests", "gen"), () => {}, cwdTree);
    expect(style).toEqual({
      unit: "    ",
      indentWidth: 4,
      lineWidth: 80,
      quoteStyle: "double",
      organizeImports: false,
      legacy: false,
      biomeJson: join(cwdTree, "biome.json"),
    });
  });
});

describe("reindentTwoSpace", () => {
  test("the 2-space unit returns the input itself (the zero-behaviour-change path)", () => {
    const t = 'export default [\n  {\n    name: "x",\n  },\n];\n';
    expect(reindentTwoSpace(t, DEFAULT_INDENT_UNIT)).toBe(t);
  });

  test("a tab unit: each 2-space level becomes one tab", () => {
    expect(
      reindentTwoSpace('export default [\n  {\n    name: "x",\n      deep: 1,\n  },\n];', "\t"),
    ).toBe('export default [\n\t{\n\t\tname: "x",\n\t\t\tdeep: 1,\n\t},\n];');
  });

  test("a 4-space unit: each 2-space level becomes one 4-space unit", () => {
    expect(reindentTwoSpace("if (x) {\n  y();\n    z();\n}", "    ")).toBe(
      "if (x) {\n    y();\n        z();\n}",
    );
  });

  test("blank lines, column-0 lines and tab-leading lines pass through untouched", () => {
    const t = "\nconst a = 1;\n\nfunction f() {\n\treturn a;\n}";
    expect(reindentTwoSpace(t, "\t")).toBe(t);
  });

  test("an odd leading run keeps its remainder after the units", () => {
    // 3 spaces = 1 level + 1 remainder space.
    expect(reindentTwoSpace("   x", "\t")).toBe("\t x");
    // 5 spaces = 2 levels + 1 remainder space.
    expect(reindentTwoSpace("     x", "\t")).toBe("\t\t x");
    // The same rule with a multi-character unit: 4 spaces = 2 levels.
    expect(reindentTwoSpace("    x", "    ")).toBe("        x");
  });

  test("no trailing newline: the last line is still reindented", () => {
    expect(reindentTwoSpace("a\n  b", "\t")).toBe("a\n\tb");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — in-process generation into temp projects
// ---------------------------------------------------------------------------

const SPEC = {
  openapi: "3.0.0",
  info: { title: "indent", version: "1" },
  paths: {
    "/api/things/{thingId}/widgets": {
      post: {
        tags: ["widgets"],
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
          "201": { description: "created" },
          "400": { description: "Validation failed" },
          "401": { description: "Not authenticated" },
          "403": { description: "Not a member" },
        },
      },
    },
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

// The deterministic prefix of <tag>.gen.crust.ts: the header plus the FIRST
// fixture entry (the 401 case — no data/schema lines, so the entry is fully
// fixed by the spec above). Authored per style, by hand from the contract,
// and every non-legacy form verified byte for byte against the running
// biome: `biome check --write` on the emitted file is a no-op (2.4.13 and
// 2.5.7 agree on all of them).
//
// The import line is 78 columns, so it stays on one line in every style
// (width 80 and 100 alike). What the styles split on is the NAME ORDER:
// biome 2.x's organizeImports assist is ON by default, so every emit that
// resolves through a biome.json takes the natural order (headersFor before
// JSON_HEADERS — the pair where case-sensitive and case-insensitive order
// disagree), and only the TRUE legacy form (no biome.json) and an explicit
// organizeImports "off" keep the legacy code-point sort. The biome styles
// also take the quote flip — `body` holds `"` so it takes single quotes
// under quoteStyle "double" — while the legacy forms keep the escaped
// JSON.stringify output byte for byte.
//
// (The consumer-shaped project — explicit double, explicit on, no lineWidth
// — resolves to the SAME style as the bare tab config, and its output is
// byte-identical to the tab goldens: the consumer test reuses them, which is
// itself the pin that the two configs must not drift.)

const WIDGETS_HEADER = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  "// Regenerate: gen-fixtures --swagger <spec> --out <dir> --setup <module>",
  'import { headersFor, JSON_HEADERS, resolvePath, shared } from "../../setup.ts";',
  "",
  "type Ctx = Awaited<ReturnType<typeof shared>>;",
  "",
  "export default [",
];

// The legacy header: the code-point sort the emitter keeps when no biome.json
// is in play, or when one explicitly says organizeImports "off".
const WIDGETS_HEADER_LEGACY = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  "// Regenerate: gen-fixtures --swagger <spec> --out <dir> --setup <module>",
  'import { JSON_HEADERS, headersFor, resolvePath, shared } from "../../setup.ts";',
  "",
  "type Ctx = Awaited<ReturnType<typeof shared>>;",
  "",
  "export default [",
];

const WIDGETS_ENTRY_401_NATIVE = [
  "  {",
  '    name: "POST /api/things/{thingId}/widgets without credentials -> 401",',
  "    setup: shared,",
  "    input: (ctx: Ctx) => ({",
  '      url: resolvePath(ctx, "/api/things/{thingId}/widgets"),',
  '      method: "POST",',
  "      headers: JSON_HEADERS,",
  '      body: \'{"name":"gen-value-x"}\',',
  "    }),",
  "    output: {",
  "      status: 401,",
  "    },",
  "  },",
];

const WIDGETS_ENTRY_401_TAB = [
  "\t{",
  '\t\tname: "POST /api/things/{thingId}/widgets without credentials -> 401",',
  "\t\tsetup: shared,",
  "\t\tinput: (ctx: Ctx) => ({",
  '\t\t\turl: resolvePath(ctx, "/api/things/{thingId}/widgets"),',
  '\t\t\tmethod: "POST",',
  "\t\t\theaders: JSON_HEADERS,",
  '\t\t\tbody: \'{"name":"gen-value-x"}\',',
  "\t\t}),",
  "\t\toutput: {",
  "\t\t\tstatus: 401,",
  "\t\t},",
  "\t},",
];

const WIDGETS_ENTRY_401_SPACE4 = [
  "    {",
  '        name: "POST /api/things/{thingId}/widgets without credentials -> 401",',
  "        setup: shared,",
  "        input: (ctx: Ctx) => ({",
  '            url: resolvePath(ctx, "/api/things/{thingId}/widgets"),',
  '            method: "POST",',
  "            headers: JSON_HEADERS,",
  '            body: \'{"name":"gen-value-x"}\',',
  "        }),",
  "        output: {",
  "            status: 401,",
  "        },",
  "    },",
];

// The TRUE legacy form — no biome.json anywhere, emitted by the subprocess
// tests with a clean cwd. Identical to the 0.3.2 output, byte for byte.

const WIDGETS_ENTRY_401_LEGACY = [
  "  {",
  '    name: "POST /api/things/{thingId}/widgets without credentials -> 401",',
  "    setup: shared,",
  "    input: (ctx: Ctx) => ({",
  '      url: resolvePath(ctx, "/api/things/{thingId}/widgets"),',
  '      method: "POST",',
  "      headers: JSON_HEADERS,",
  '      body: "{\\"name\\":\\"gen-value-x\\"}",',
  "    }),",
  "    output: {",
  "      status: 401,",
  "    },",
  "  },",
];

// The name lines of the second and third entries (403, then the first 400
// case) plus the 400 case's fieldErrors matcher. Three shapes, all
// biome-faithful (measured, not guessed):
//
//   - native (crust's own space/2 config, lineWidth 100): the header fits
//     and the whole chain fits on one line below the arrow;
//   - tab (biome's default width 80): the header fits but the chain does
//     not — one operand per line, `&&` trailing;
//   - space4 (width 80 at indentWidth 4): even the header does not fit —
//     the type literal breaks one member per line, then the per-operand
//     chain.
//
// In every shape the broken chain sits ONE indent level below the `data:`
// property — that is where biome puts an arrow body that breaks. (The
// legacy template broke after the arrow too and kept the chain on one line
// regardless of width, which for a width that fits the chain is the same
// line biome keeps — the two width-80 shapes are where 0.3.3 diverges from
// 0.3.2.)
const WIDGETS_LATER_LINES: Record<string, string[]> = {
  native: [
    '    name: "POST /api/things/{thingId}/widgets as non-member -> 403",',
    "    name: \"POST /api/things/{thingId}/widgets missing required 'name' -> 400\",",
    '        d.code === "validation" && d.fieldErrors !== undefined && "name" in d.fieldErrors,',
  ],
  tab: [
    '\t\tname: "POST /api/things/{thingId}/widgets as non-member -> 403",',
    "\t\tname: \"POST /api/things/{thingId}/widgets missing required 'name' -> 400\",",
    '\t\t\t\td.code === "validation" &&',
    "\t\t\t\td.fieldErrors !== undefined &&",
    '\t\t\t\t"name" in d.fieldErrors,',
  ],
  space4: [
    '        name: "POST /api/things/{thingId}/widgets as non-member -> 403",',
    "        name: \"POST /api/things/{thingId}/widgets missing required 'name' -> 400\",",
    "            data: (d: {",
    "                code?: string;",
    "                fieldErrors?: Record<string, unknown>;",
    "            }) =>",
    '                d.code === "validation" &&',
    "                d.fieldErrors !== undefined &&",
    '                "name" in d.fieldErrors,',
  ],
};

const FLOWS_SETUP_NATIVE = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  'import { headersFor, resolvePath, shared } from "../../../setup.ts";',
  "",
  "export default async function setup(): Promise<void> {",
  "  const ctx = await shared();",
  '  const headers = headersFor(ctx, "member");',
  '  const auth = Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type");',
  "  if (auth.length === 0) {",
  "    throw new Error(\"gen flows: headersFor(ctx, 'member') returned no auth header\");",
  "  }",
  "  if (auth.length > 1) {",
  "    // Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently",
  "    // dropping the rest would make every generated request fail mysteriously.",
  "    throw new Error(",
  "      `gen flows: headersFor(ctx, 'member') returned ${auth.length} auth headers (${auth",
  "        .map(([k]) => k)",
  "        .join(",
  '          ", ",',
  "        )}) — generated flows can send only one; reduce headersFor to a single auth header`,",
  "    );",
  "  }",
  "  process.env.GEN_AUTH_HEADER = `${auth[0]![0]}: ${auth[0]![1]}`;",
  '  process.env.GEN_URL_API_THINGS = resolvePath(ctx, "/api/things");',
  "}",
];

const FLOWS_SETUP_TAB = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  'import { headersFor, resolvePath, shared } from "../../../setup.ts";',
  "",
  "export default async function setup(): Promise<void> {",
  "\tconst ctx = await shared();",
  '\tconst headers = headersFor(ctx, "member");',
  "\tconst auth = Object.entries(headers).filter(",
  '\t\t([k]) => k.toLowerCase() !== "content-type",',
  "\t);",
  "\tif (auth.length === 0) {",
  "\t\tthrow new Error(",
  "\t\t\t\"gen flows: headersFor(ctx, 'member') returned no auth header\",",
  "\t\t);",
  "\t}",
  "\tif (auth.length > 1) {",
  "\t\t// Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently",
  "\t\t// dropping the rest would make every generated request fail mysteriously.",
  "\t\tthrow new Error(",
  "\t\t\t`gen flows: headersFor(ctx, 'member') returned ${auth.length} auth headers (${auth",
  "\t\t\t\t.map(([k]) => k)",
  "\t\t\t\t.join(",
  '\t\t\t\t\t", ",',
  "\t\t\t\t)}) — generated flows can send only one; reduce headersFor to a single auth header`,",
  "\t\t);",
  "\t}",
  "\tprocess.env.GEN_AUTH_HEADER = `${auth[0]![0]}: ${auth[0]![1]}`;",
  '\tprocess.env.GEN_URL_API_THINGS = resolvePath(ctx, "/api/things");',
  "}",
];

const FLOWS_SETUP_SPACE4 = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  'import { headersFor, resolvePath, shared } from "../../../setup.ts";',
  "",
  "export default async function setup(): Promise<void> {",
  "    const ctx = await shared();",
  '    const headers = headersFor(ctx, "member");',
  "    const auth = Object.entries(headers).filter(",
  '        ([k]) => k.toLowerCase() !== "content-type",',
  "    );",
  "    if (auth.length === 0) {",
  "        throw new Error(",
  "            \"gen flows: headersFor(ctx, 'member') returned no auth header\",",
  "        );",
  "    }",
  "    if (auth.length > 1) {",
  "        // Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently",
  "        // dropping the rest would make every generated request fail mysteriously.",
  "        throw new Error(",
  "            `gen flows: headersFor(ctx, 'member') returned ${auth.length} auth headers (${auth",
  "                .map(([k]) => k)",
  "                .join(",
  '                    ", ",',
  "                )}) — generated flows can send only one; reduce headersFor to a single auth header`,",
  "        );",
  "    }",
  "    process.env.GEN_AUTH_HEADER = `${auth[0]![0]}: ${auth[0]![1]}`;",
  '    process.env.GEN_URL_API_THINGS = resolvePath(ctx, "/api/things");',
  "}",
];

// The legacy flows file: every line fits the historical form — the join
// call inline, the throws inline — exactly what 0.3.2 emitted.

const FLOWS_SETUP_LEGACY = [
  "// GENERATED by crust gen-fixtures — DO NOT EDIT.",
  'import { headersFor, resolvePath, shared } from "../../../setup.ts";',
  "",
  "export default async function setup(): Promise<void> {",
  "  const ctx = await shared();",
  '  const headers = headersFor(ctx, "member");',
  '  const auth = Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type");',
  "  if (auth.length === 0) {",
  "    throw new Error(\"gen flows: headersFor(ctx, 'member') returned no auth header\");",
  "  }",
  "  if (auth.length > 1) {",
  "    // Flows carry exactly ONE auth header ($GEN_AUTH_HEADER) — silently",
  "    // dropping the rest would make every generated request fail mysteriously.",
  "    throw new Error(",
  "      `gen flows: headersFor(ctx, 'member') returned ${auth.length} auth headers (${auth",
  "        .map(([k]) => k)",
  '        .join(", ")}) — generated flows can send only one; reduce headersFor to a single auth header`,',
  "    );",
  "  }",
  "  process.env.GEN_AUTH_HEADER = `${auth[0]![0]}: ${auth[0]![1]}`;",
  '  process.env.GEN_URL_API_THINGS = resolvePath(ctx, "/api/things");',
  "}",
];

async function scaffoldProject(
  style: "none" | "tab" | "space4" | "consumer" | "off",
): Promise<string> {
  const proj = await mkdtemp(join(tmpdir(), "crust-genfx-indent-"));
  await writeFile(join(proj, "spec.json"), JSON.stringify(SPEC));
  await writeFile(join(proj, "setup.ts"), SETUP);
  if (style === "tab")
    await writeFile(
      join(proj, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "tab" } }),
    );
  if (style === "space4")
    await writeFile(
      join(proj, "biome.json"),
      JSON.stringify({ formatter: { indentStyle: "space", indentWidth: 4 } }),
    );
  // The adopting project's shape (mybodycorpai): tab, explicit double, NO
  // lineWidth key (biome's default 80 governs), organizeImports on.
  if (style === "consumer")
    await writeFile(
      join(proj, "biome.json"),
      JSON.stringify(
        {
          formatter: { indentStyle: "tab" },
          javascript: { formatter: { quoteStyle: "double" } },
          assist: { actions: { source: { organizeImports: "on" } } },
        },
        null,
        2,
      ),
    );
  // The one non-legacy shape that keeps the legacy code-point import order.
  if (style === "off")
    await writeFile(
      join(proj, "biome.json"),
      JSON.stringify(
        {
          formatter: { indentStyle: "tab" },
          assist: { actions: { source: { organizeImports: "off" } } },
        },
        null,
        2,
      ),
    );
  return proj;
}

describe("generateFixtures: a biome.json above --out governs the emit", () => {
  let proj: string;

  beforeAll(async () => {
    proj = await scaffoldProject("tab");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("a tab project emits tabbed .crust.ts files", async () => {
    const logs: string[] = [];
    const result = await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen"),
      setup: join(proj, "setup.ts"),
      log: (l) => logs.push(l),
    });
    const widgets = (await Bun.file(result.files.find((f) => f.includes("widgets"))!).text()).split(
      "\n",
    );
    // Header + the whole first entry, byte for byte.
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_TAB.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_TAB,
    ]);
    for (const line of WIDGETS_LATER_LINES.tab) expect(widgets).toContain(line);
    // Nothing may still carry a space-led indent — the old form is gone.
    expect(widgets.join("\n")).not.toMatch(/^ /m);
    // The decision is disclosed, naming the file.
    expect(logs).toEqual([
      `gen-fixtures: emitting with tab indent (biome.json at ${join(proj, "biome.json")})`,
    ]);
  });

  test("a tab project emits a tabbed flows.gen.setup.ts", async () => {
    await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen2"),
      setup: join(proj, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(join(proj, "tests", "gen2", "flows", "flows.gen.setup.ts")).text();
    expect(text).toBe(FLOWS_SETUP_TAB.join("\n") + "\n");
  });
});

describe("generateFixtures: a space/indentWidth-4 project governs the emit", () => {
  let proj: string;

  beforeAll(async () => {
    proj = await scaffoldProject("space4");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("a 4-space project emits 4-space indents, no tabs, no leftover levels", async () => {
    const logs: string[] = [];
    const result = await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen"),
      setup: join(proj, "setup.ts"),
      log: (l) => logs.push(l),
    });
    const widgets = (await Bun.file(result.files.find((f) => f.includes("widgets"))!).text()).split(
      "\n",
    );
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_SPACE4.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_SPACE4,
    ]);
    for (const line of WIDGETS_LATER_LINES.space4) expect(widgets).toContain(line);
    const text = widgets.join("\n");
    expect(text).not.toMatch(/\t/);
    // A leftover NATIVE level (exactly 2 or 6 leading spaces — a run that is
    // not a multiple of 4) is a failed reindent: the 4-space form only runs
    // 4, 8, 12, 16.
    expect(text).not.toMatch(/^ {2}(?! )/m);
    expect(text).not.toMatch(/^ {6}(?! )/m);
    expect(logs).toEqual([
      `gen-fixtures: emitting with 4-space indent (biome.json at ${join(proj, "biome.json")})`,
    ]);
  });

  test("a 4-space project emits a 4-space flows.gen.setup.ts", async () => {
    await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen2"),
      setup: join(proj, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(join(proj, "tests", "gen2", "flows", "flows.gen.setup.ts")).text();
    expect(text).toBe(FLOWS_SETUP_SPACE4.join("\n") + "\n");
  });
});

describe("generateFixtures: no biome.json in the out tree, the cwd's biome.json governs", () => {
  // The in-process cwd is this repo, whose biome.json is space/2 with
  // lineWidth 100 and quoteStyle "double" — so the cwd fallback resolves to
  // the repo's own style: the legacy 2-space unit, but double-quoted strings
  // (with the flip), width-100 wrapping and the natural import order. This
  // pins the path every existing gen test (temp dirs, no biome.json in the
  // out tree) takes. The TRUE "no biome.json anywhere" resolution is pinned
  // by the resolveEmitStyle unit test above and the clean-cwd subprocess
  // test below, because an in-process run cannot unset this repo's own
  // config.
  let proj: string;

  beforeAll(async () => {
    proj = await scaffoldProject("none");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("the emit resolves to the repo's own style, 2-space unit included", async () => {
    const logs: string[] = [];
    const result = await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen"),
      setup: join(proj, "setup.ts"),
      log: (l) => logs.push(l),
    });
    const widgets = (await Bun.file(result.files.find((f) => f.includes("widgets"))!).text()).split(
      "\n",
    );
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_NATIVE.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_NATIVE,
    ]);
    for (const line of WIDGETS_LATER_LINES.native) expect(widgets).toContain(line);
    expect(widgets.join("\n")).not.toMatch(/\t/);
    // The 2-space unit is biome's own default, so the indent is not
    // disclosed — the run is silent. (The byte-for-byte zero-behaviour
    // change is the no-config path, pinned by the clean-cwd test below.)
    expect(logs).toEqual([]);
  });

  test("the flows.gen.setup.ts matches the repo-styled golden", async () => {
    await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen2"),
      setup: join(proj, "setup.ts"),
      log: () => {},
    });
    const text = await Bun.file(join(proj, "tests", "gen2", "flows", "flows.gen.setup.ts")).text();
    expect(text).toBe(FLOWS_SETUP_NATIVE.join("\n") + "\n");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the real CLI subprocess with an explicit cwd
// ---------------------------------------------------------------------------

function runGen(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, "gen-fixtures", ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-genfx-indent-no-globals",
    },
  });
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { code: proc.exitCode ?? -1, stdout, stderr };
  })();
}

describe("gen-fixtures subprocess: a clean tree keeps the legacy 2-space form", () => {
  // cwd has no biome.json and neither does --out's chain (a fresh /tmp tree),
  // so this is the genuine fallback: no config in play at all.
  let proj: string;
  beforeAll(async () => {
    proj = await scaffoldProject("none");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("the CLI emits the historical form end to end", async () => {
    const out = join(proj, "tests", "gen");
    const r = await runGen(
      [join(proj, "spec.json"), "-o", out, "-s", join(proj, "setup.ts")],
      proj,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("emitting with");
    const widgets = (await Bun.file(join(out, "widgets.gen.crust.ts")).text()).split("\n");
    expect(
      widgets.slice(0, WIDGETS_HEADER_LEGACY.length + WIDGETS_ENTRY_401_LEGACY.length),
    ).toEqual([...WIDGETS_HEADER_LEGACY, ...WIDGETS_ENTRY_401_LEGACY]);
    expect(widgets.join("\n")).not.toMatch(/\t/);
    const setup = await Bun.file(join(out, "flows", "flows.gen.setup.ts")).text();
    expect(setup).toBe(FLOWS_SETUP_LEGACY.join("\n") + "\n");
  });
});

// The adopting project's shape (mybodycorpai): tab, explicit double, no
// lineWidth key (biome's default 80 governs), organizeImports on. This
// resolves to the SAME style as the bare tab config — the output must match
// the tab goldens byte for byte, and reusing them is the pin that the
// explicit keys never drift from biome's defaults.

describe("generateFixtures: the consumer-shaped config resolves like the tab config", () => {
  let proj: string;

  beforeAll(async () => {
    proj = await scaffoldProject("consumer");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("widgets and flows come out byte-identical to the tab goldens", async () => {
    const logs: string[] = [];
    const result = await generateFixtures({
      swagger: join(proj, "spec.json"),
      out: join(proj, "tests", "gen"),
      setup: join(proj, "setup.ts"),
      log: (l) => logs.push(l),
    });
    const widgets = (await Bun.file(result.files.find((f) => f.includes("widgets"))!).text()).split(
      "\n",
    );
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_TAB.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_TAB,
    ]);
    for (const line of WIDGETS_LATER_LINES.tab) expect(widgets).toContain(line);
    const flows = await Bun.file(join(proj, "tests", "gen", "flows", "flows.gen.setup.ts")).text();
    expect(flows).toBe(FLOWS_SETUP_TAB.join("\n") + "\n");
    // The tab unit is not biome's default, so the indent is disclosed.
    expect(logs).toEqual([
      `gen-fixtures: emitting with tab indent (biome.json at ${join(proj, "biome.json")})`,
    ]);
  });
});

// organizeImports is ON by default in biome 2.x, so an explicit "off" is
// the ONE non-legacy config that keeps the legacy code-point import order:
// every other config that resolves through a biome.json takes the natural
// order. The rest of the emit is plain tab-shaped.

describe('gen-fixtures subprocess: organizeImports "off" keeps the code-point sort', () => {
  let proj: string;
  beforeAll(async () => {
    proj = await scaffoldProject("off");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("the import keeps code-point order, everything else is tab-shaped", async () => {
    const out = join(proj, "tests", "gen");
    const r = await runGen(
      [join(proj, "spec.json"), "-o", out, "-s", join(proj, "setup.ts")],
      proj,
    );
    expect(r.code).toBe(0);
    const widgets = (await Bun.file(join(out, "widgets.gen.crust.ts")).text()).split("\n");
    expect(widgets.slice(0, WIDGETS_HEADER_LEGACY.length + WIDGETS_ENTRY_401_TAB.length)).toEqual([
      ...WIDGETS_HEADER_LEGACY,
      ...WIDGETS_ENTRY_401_TAB,
    ]);
    for (const line of WIDGETS_LATER_LINES.tab) expect(widgets).toContain(line);
    const setup = await Bun.file(join(out, "flows", "flows.gen.setup.ts")).text();
    expect(setup).toBe(FLOWS_SETUP_TAB.join("\n") + "\n");
  });
});

describe("gen-fixtures subprocess: the project's biome.json governs", () => {
  let proj: string;
  beforeAll(async () => {
    proj = await scaffoldProject("tab");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("a tab project's gen output is tabbed, disclosed on stdout", async () => {
    const out = join(proj, "tests", "gen");
    const r = await runGen(
      [join(proj, "spec.json"), "-o", out, "-s", join(proj, "setup.ts")],
      proj,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `emitting with tab indent (biome.json at ${join(proj, "biome.json")})`,
    );
    const widgets = (await Bun.file(join(out, "widgets.gen.crust.ts")).text()).split("\n");
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_TAB.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_TAB,
    ]);
    expect(widgets.join("\n")).not.toMatch(/^ /m);
    const setup = await Bun.file(join(out, "flows", "flows.gen.setup.ts")).text();
    expect(setup).toBe(FLOWS_SETUP_TAB.join("\n") + "\n");
  });
});

describe("gen-fixtures subprocess: a space/4 project's biome.json governs", () => {
  let proj: string;
  beforeAll(async () => {
    proj = await scaffoldProject("space4");
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  test("a 4-space project's gen output is 4-space, disclosed on stdout", async () => {
    const out = join(proj, "tests", "gen");
    const r = await runGen(
      [join(proj, "spec.json"), "-o", out, "-s", join(proj, "setup.ts")],
      proj,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `emitting with 4-space indent (biome.json at ${join(proj, "biome.json")})`,
    );
    const widgets = (await Bun.file(join(out, "widgets.gen.crust.ts")).text()).split("\n");
    expect(widgets.slice(0, WIDGETS_HEADER.length + WIDGETS_ENTRY_401_SPACE4.length)).toEqual([
      ...WIDGETS_HEADER,
      ...WIDGETS_ENTRY_401_SPACE4,
    ]);
    const text = widgets.join("\n");
    expect(text).not.toMatch(/\t/);
    expect(text).not.toMatch(/^ {2}(?! )/m);
    expect(text).not.toMatch(/^ {6}(?! )/m);
    const setup = await Bun.file(join(out, "flows", "flows.gen.setup.ts")).text();
    expect(setup).toBe(FLOWS_SETUP_SPACE4.join("\n") + "\n");
  });
});

describe("gen-fixtures subprocess: --out outside the working project falls back to cwd", () => {
  // The out tree sits in its own /tmp tree with no biome.json; only the cwd
  // carries the config. This is the case the cwd walk exists for.
  let proj: string;
  let elsewhere: string;
  // spec.json/setup.ts sit at the else tree's ROOT and --out is one level
  // below it, so setupSpecifier climbs ONE level (../setup.ts) instead of the
  // two the in-project tests see — and the flows file two, not three.
  const WIDGETS_HEADER_OUTSIDE = WIDGETS_HEADER.map((l) =>
    l.startsWith("import") ? l.replace("../../setup.ts", "../setup.ts") : l,
  );
  const FLOWS_SETUP_TAB_OUTSIDE = FLOWS_SETUP_TAB.map((l) =>
    l.startsWith("import") ? l.replace("../../../setup.ts", "../../setup.ts") : l,
  );
  beforeAll(async () => {
    proj = await scaffoldProject("tab");
    elsewhere = await mkdtemp(join(tmpdir(), "crust-genfx-outside-"));
    await writeFile(join(elsewhere, "spec.json"), JSON.stringify(SPEC));
    await writeFile(join(elsewhere, "setup.ts"), SETUP);
  });
  afterAll(async () => {
    await rm(proj, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });

  test("the cwd's biome.json reaches an out dir it does not contain", async () => {
    const r = await runGen(
      [
        join(elsewhere, "spec.json"),
        "-o",
        join(elsewhere, "gen"),
        "-s",
        join(elsewhere, "setup.ts"),
      ],
      proj,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `emitting with tab indent (biome.json at ${join(proj, "biome.json")})`,
    );
    const widgets = (await Bun.file(join(elsewhere, "gen", "widgets.gen.crust.ts")).text()).split(
      "\n",
    );
    expect(widgets.slice(0, WIDGETS_HEADER_OUTSIDE.length + WIDGETS_ENTRY_401_TAB.length)).toEqual([
      ...WIDGETS_HEADER_OUTSIDE,
      ...WIDGETS_ENTRY_401_TAB,
    ]);
    expect(widgets.join("\n")).not.toMatch(/^ /m);
    const setup = await Bun.file(join(elsewhere, "gen", "flows", "flows.gen.setup.ts")).text();
    expect(setup).toBe(FLOWS_SETUP_TAB_OUTSIDE.join("\n") + "\n");
  });
});
