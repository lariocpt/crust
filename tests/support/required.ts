/** Require fixture data to be present before a test inspects it. */
export function required<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("expected test fixture value to be present");
  }
  return value;
}
