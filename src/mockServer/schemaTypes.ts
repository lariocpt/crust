// One reading of a schema's `type`, shared by everything that has to act on it.
//
// OpenAPI 3.0 wrote `{ type: "string", nullable: true }`. 3.1 dropped `nullable` and aligned with
// JSON Schema, where `type` may be an ARRAY: `{ type: ["string", "null"] }`. Three call sites
// needed to understand both forms and only one did — validateRequest.ts normalised inline, while
// mockResponse.ts and genFixtures/generate.ts compared `type` to a string. So the mock synthesised
// `null` for every 3.1 union (falling through its switch) and the fixture generator silently
// skipped those fields, generating no boundary cases and reporting success.
//
// This is the primitive; callers must not re-derive it.

/**
 * Every type a schema permits, as a list.
 *
 * - `"string"` → `["string"]`
 * - `["string","null"]` → `["string","null"]` (3.1)
 * - `{ type: "string", nullable: true }` → `["string","null"]` (3.0, normalised onto the 3.1 form)
 * - absent or malformed → `[]`, meaning "unconstrained" — callers decide what that implies, since
 *   a missing `type` means "any type" to a validator but "probably an object" to a synthesiser.
 */
export function normaliseType(raw: unknown, nullable?: unknown): string[] {
  const types = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  if (nullable === true && types.length > 0 && !types.includes("null")) types.push("null");
  return types;
}
