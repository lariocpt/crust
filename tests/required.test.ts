import { describe, expect, test } from "bun:test";
import { required } from "./support/required";

describe("required fixture values", () => {
  test("rejects null and undefined", () => {
    expect(() => required(null)).toThrow("expected test fixture value to be present");
    expect(() => required(undefined)).toThrow("expected test fixture value to be present");
  });

  test("preserves falsy values and object identity", () => {
    expect(required(false)).toBe(false);
    expect(required(0)).toBe(0);
    expect(required("")).toBe("");
    const value = { present: true };
    expect(required(value)).toBe(value);
  });
});
