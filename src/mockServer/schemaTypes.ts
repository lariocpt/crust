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

/**
 * A string that satisfies a simple `pattern`, best effort.
 *
 * Lived in genFixtures until 2026-09-09, when the mock needed it too: a sweep of 300 real-world
 * specs showed the mock synthesising "string" for pattern-constrained fields and its own validator
 * rejecting the result. Moved here rather than copied, so the generator and the mock cannot drift
 * apart about what satisfies a pattern.
 *
 * Deliberately conservative: if regex syntax survives the substitutions it could not be sampled,
 * so it returns a neutral value rather than something that merely looks plausible.
 */
export function sampleFromPattern(pattern: string): string {
  let out = pattern.replace(/^\^/, "").replace(/\$$/, "");
  out = out.replace(/\\d\{(\d+),\d+\}/g, (_m, n) => "1".repeat(Number(n)));
  out = out.replace(/\\d\{(\d+)\}/g, (_m, n) => "1".repeat(Number(n)));
  out = out.replace(/\\d/g, "1");
  // If regex syntax survives, we couldn't sample it — return something sane.
  return /[\\[\](){}|?*+]/.test(out) ? "gen-value-x" : out;
}
