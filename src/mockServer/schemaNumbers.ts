export interface NumericBounds {
  min: number | null;
  max: number | null;
  minOpen: boolean;
  maxOpen: boolean;
}

/** Inclusive and numeric exclusive bounds are independent constraints, not overrides. */
export function numericBounds(schema: Record<string, unknown>): NumericBounds {
  let min = typeof schema.minimum === "number" ? schema.minimum : null;
  let max = typeof schema.maximum === "number" ? schema.maximum : null;
  let minOpen = schema.exclusiveMinimum === true && min !== null;
  let maxOpen = schema.exclusiveMaximum === true && max !== null;
  const lower = schema.exclusiveMinimum;
  const upper = schema.exclusiveMaximum;
  if (typeof lower === "number" && (min === null || lower >= min)) {
    min = lower;
    minOpen = true;
  }
  if (typeof upper === "number" && (max === null || upper <= max)) {
    max = upper;
    maxOpen = true;
  }
  return { min, max, minOpen, maxOpen };
}

/**
 * Allow decimal division noise (0.3 / 0.1), never a tolerance that grows to a
 * meaningful fraction of one. A nonzero value must not round to the zero multiple.
 */
function integralQuotient(value: number, step: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return null;
  if (value === 0) return 0;
  const quotient = value / step;
  if (!Number.isFinite(quotient)) return null;
  const rounded = Math.round(quotient);
  if (rounded === 0) return null;
  const tolerance = Math.min(1e-7, 4 * Number.EPSILON * Math.abs(quotient));
  return Math.abs(quotient - rounded) <= tolerance ? rounded : null;
}

export function isMultipleOf(value: number, step: number): boolean {
  return integralQuotient(value, step) !== null;
}

/** Round a quotient without losing a decimal bound to division noise. */
export function divExact(value: number, step: number, direction: "ceil" | "floor"): number {
  return integralQuotient(value, step) ?? Math[direction](value / step);
}
