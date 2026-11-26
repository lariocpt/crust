// The diagnostics contract (plan §5): a closed code vocabulary in one frozen
// registry, deterministic sorting, and BuildError as the single failed-build
// carrier holding ALL diagnostics, already sorted.
import { describe, expect, test } from "bun:test";
import {
  BuildError,
  type Diagnostic,
  DiagnosticCodes,
  isDiagnostic,
  sortDiagnostics,
} from "../src/diagnostics";

function diag(partial: Partial<Diagnostic> & { code: Diagnostic["code"] }): Diagnostic {
  return { message: "m", severity: "error", ...partial };
}

describe("the code registry", () => {
  test("is frozen", () => {
    expect(Object.isFrozen(DiagnosticCodes)).toBe(true);
  });

  test("every entry maps the code to itself (registry doubles as validator)", () => {
    for (const [key, value] of Object.entries(DiagnosticCodes)) {
      expect<string>(value).toBe(key);
    }
  });

  test("every code is namespace.name", () => {
    for (const code of Object.keys(DiagnosticCodes)) {
      expect(code).toMatch(/^[a-z][a-z-]*\.[a-z][a-z-]*$/);
    }
  });

  test("every chunk-2 code is registered", () => {
    const expected = [
      "config.unknown-key",
      "config.site",
      "config.layout-type",
      "config.asset-name-clash",
      "config.asset-name",
      "config.output-overlap",
      "config.port",
      "config.type",
      "route.invalid",
      "route.query-fragment",
      "route.traversal",
      "route.shape",
      "route.case-collision",
      "route.duplicate",
      "frontmatter.missing",
      "frontmatter.not-mapping",
      "frontmatter.duplicate-key",
      "frontmatter.unknown-key",
      "frontmatter.missing-title",
      "frontmatter.bad-value",
      "frontmatter.parse-error",
    ];
    for (const code of expected) {
      expect(Object.hasOwn(DiagnosticCodes, code)).toBe(true);
    }
  });
});

describe("isDiagnostic", () => {
  test("accepts a registered code with a severity", () => {
    expect(isDiagnostic(diag({ code: "route.shape", sourcePath: "a.md", line: 2 }))).toBe(true);
  });

  test("rejects an unregistered code (a typo fails loudly, never passes)", () => {
    expect(isDiagnostic({ code: "route.shpe", message: "m", severity: "error" })).toBe(false);
  });

  test("rejects a missing or invalid severity", () => {
    expect(isDiagnostic({ code: "route.shape", message: "m" })).toBe(false);
    expect(isDiagnostic({ code: "route.shape", message: "m", severity: "info" })).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isDiagnostic(null)).toBe(false);
    expect(isDiagnostic("route.shape")).toBe(false);
    expect(isDiagnostic(undefined)).toBe(false);
  });
});

describe("sortDiagnostics", () => {
  test("orders by sourcePath, then line, then code", () => {
    const sorted = sortDiagnostics([
      diag({ code: "route.shape", sourcePath: "b.md", line: 1 }),
      diag({ code: "frontmatter.bad-value", sourcePath: "a.md", line: 9 }),
      diag({ code: "route.traversal", sourcePath: "a.md", line: 2 }),
      diag({ code: "route.duplicate", sourcePath: "a.md", line: 2 }),
    ]);
    expect(sorted.map((d) => [d.sourcePath, d.line, d.code])).toEqual([
      ["a.md", 2, "route.duplicate"],
      ["a.md", 2, "route.traversal"],
      ["a.md", 9, "frontmatter.bad-value"],
      ["b.md", 1, "route.shape"],
    ]);
  });

  test("diagnostics without a sourcePath sort first; without a line before line 1", () => {
    const sorted = sortDiagnostics([
      diag({ code: "config.site" }),
      diag({ code: "config.port", sourcePath: "a.md" }),
      diag({ code: "config.type", sourcePath: "", line: 1 }),
    ]);
    expect(sorted.map((d) => d.code)).toEqual(["config.site", "config.type", "config.port"]);
  });

  test("orders by code units, not locale collation (byte-identical across machines)", () => {
    // Control against a locale-dependent sort slipping back in. Measured in
    // this environment: localeCompare (en collation, case as a secondary
    // key) orders "ab.md" BEFORE "aB.md", while code units (0x42 < 0x61)
    // order "aB.md" before "ab.md". A locale-dependent order means two
    // machines rebuild the same project with differently-ordered
    // diagnostics — plan §4.6 byte-identical rebuilds, broken.
    const ds = sortDiagnostics([
      diag({ code: "route.shape", sourcePath: "ab.md" }),
      diag({ code: "route.shape", sourcePath: "aB.md" }),
      diag({ code: "route.shape", sourcePath: "a.b.md" }),
      diag({ code: "route.shape", sourcePath: "a-b.md" }),
    ]);
    expect(ds.map((d) => d.sourcePath)).toEqual(["a-b.md", "a.b.md", "aB.md", "ab.md"]);
  });

  test("is stable: ties keep input order", () => {
    const a = diag({
      code: "frontmatter.bad-value",
      sourcePath: "a.md",
      line: 2,
      message: "first",
    });
    const b = diag({
      code: "frontmatter.bad-value",
      sourcePath: "a.md",
      line: 2,
      message: "second",
    });
    expect(sortDiagnostics([a, b]).map((d) => d.message)).toEqual(["first", "second"]);
    expect(sortDiagnostics([b, a]).map((d) => d.message)).toEqual(["second", "first"]);
  });

  test("does not mutate the input", () => {
    const input = [
      diag({ code: "route.shape", sourcePath: "b.md" }),
      diag({ code: "config.site" }),
    ];
    const before = [...input];
    sortDiagnostics(input);
    expect(input).toEqual(before);
  });
});

describe("BuildError", () => {
  test("carries the diagnostics already sorted", () => {
    const err = new BuildError([
      diag({ code: "route.shape", sourcePath: "z.md", line: 1 }),
      diag({ code: "frontmatter.missing", sourcePath: "a.md", line: 1 }),
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BuildError);
    expect(err.name).toBe("BuildError");
    expect(err.diagnostics.map((d) => d.sourcePath)).toEqual(["a.md", "z.md"]);
  });

  test("summarizes errors and warnings in the message", () => {
    const err = new BuildError([
      diag({ code: "config.site" }),
      diag({ code: "route.shape", sourcePath: "z.md" }),
      diag({ code: "route.duplicate", sourcePath: "z.md", severity: "warning" }),
    ]);
    expect(err.message).toContain("2 errors");
    expect(err.message).toContain("1 warning");
  });

  test("accepts an explicit message", () => {
    const err = new BuildError([diag({ code: "config.site" })], "custom");
    expect(err.message).toBe("custom");
  });
});
