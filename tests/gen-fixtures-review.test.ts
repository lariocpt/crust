import { describe, expect, test } from "bun:test";
import { validValue, wrongTypeFor } from "../src/genFixtures/generate";
import { prove, provenValid } from "../src/genFixtures/proof";
import { divExact, isMultipleOf, numericBounds } from "../src/mockServer/schemaNumbers";
import { validateSchema } from "../src/mockServer/validateRequest";

describe("review: bounded multipleOf arithmetic", () => {
  test("large fractional quotients never become integral through relative tolerance", () => {
    for (const value of [1_000_000_000.25, -1_000_000_000.25, 1_000_000_000.5]) {
      expect(isMultipleOf(value, 1)).toBe(false);
      expect(prove(value, { type: "number", multipleOf: 1 }).violations).toContainEqual({
        pointer: "",
        rule: "multipleOf",
      });
    }
    expect(isMultipleOf(1.00000000025, 1e-9)).toBe(false);
    expect(isMultipleOf(1e-12, 1)).toBe(false);
    expect(isMultipleOf(-1e-12, 1)).toBe(false);
  });

  test("decimal multiples and zero remain valid controls", () => {
    for (const [value, step] of [
      [0.3, 0.1],
      [-0.3, 0.1],
      [0.6, 0.2],
      [1_000_000_000, 1],
      [0, 0.1],
    ]) {
      expect(isMultipleOf(value, step)).toBe(true);
      expect(provenValid(value, { type: "number", multipleOf: step })).toBe(true);
    }
  });

  test("division uses the same bounded integral-quotient decision", () => {
    expect(divExact(0.3, 0.1, "floor")).toBe(3);
    expect(divExact(-0.3, 0.1, "ceil")).toBe(-3);
    expect(divExact(1_000_000_000.25, 1, "ceil")).toBe(1_000_000_001);
    expect(divExact(1_000_000_000.25, 1, "floor")).toBe(1_000_000_000);
    expect(divExact(1e-12, 1, "ceil")).toBe(1);
    expect(divExact(-1e-12, 1, "floor")).toBe(-1);
  });

  test("invalid numeric inputs never prove a multiple", () => {
    for (const [value, step] of [
      [Infinity, 1],
      [NaN, 1],
      [1, Infinity],
      [1, 0],
      [1, -1],
    ]) {
      expect(isMultipleOf(value, step)).toBe(false);
    }
  });
});

describe("review: strongest numeric bounds", () => {
  const cases: [Record<string, unknown>, number, number][] = [
    [{ minimum: 10, exclusiveMinimum: 0 }, 5, 10],
    [{ minimum: 0, exclusiveMinimum: 10 }, 10, 11],
    [{ minimum: 10, exclusiveMinimum: 10 }, 10, 11],
    [{ maximum: 0, exclusiveMaximum: 10 }, 5, 0],
    [{ maximum: 10, exclusiveMaximum: 0 }, 0, -1],
    [{ maximum: 10, exclusiveMaximum: 10 }, 10, 9],
    [{ minimum: 1, exclusiveMinimum: true }, 1, 2],
    [{ maximum: 1, exclusiveMaximum: true }, 1, 0],
    [{ minimum: 1, exclusiveMinimum: false }, 0, 1],
    [{ maximum: 1, exclusiveMaximum: false }, 2, 1],
  ];
  for (const [bounds, bad, good] of cases) {
    test(JSON.stringify(bounds), () => {
      const schema = { type: "integer", ...bounds };
      expect(provenValid(bad, schema)).toBe(false);
      expect(validateSchema(bad, schema, {} as never)).not.toEqual([]);
      expect(provenValid(good, schema)).toBe(true);
      expect(validateSchema(good, schema, {} as never)).toEqual([]);
      expect(provenValid(validValue(schema), schema)).toBe(true);
    });
  }

  test("a weaker exclusive bound must not make a stronger inclusive bound open", () => {
    expect(numericBounds({ minimum: 10, exclusiveMinimum: 0 })).toEqual({
      min: 10,
      max: null,
      minOpen: false,
      maxOpen: false,
    });
    expect(numericBounds({ maximum: 0, exclusiveMaximum: 10 }).maxOpen).toBe(false);
  });
});

test("review: constrained string wrong-type mutations are actually non-string", () => {
  for (const schema of [
    { type: "string", pattern: "^.*$" },
    { type: "string", pattern: "^[0-9]+$" },
    { type: "string", format: "date" },
    { type: "string", format: "date-time" },
  ]) {
    const value = wrongTypeFor(schema);
    expect(value).toEqual({});
    expect(prove(value, schema).violations).toContainEqual({ pointer: "", rule: "type" });
  }
});
