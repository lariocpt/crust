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
 * A string that satisfies a `pattern`, or a neutral fallback when one cannot be constructed.
 *
 * THE SAFETY PROPERTY, which matters more than the coverage: whatever this builds is CHECKED
 * against the real regex before being returned. A wrong guess degrades to FALLBACK rather than to
 * a confidently wrong value, so sampling can never make a field worse than not sampling at all.
 * Knowingly wrong beats confidently wrong — the caller can see `gen-value-x` and judge it, where a
 * plausible-looking wrong value would just be believed.
 *
 * It understands what real specs use, learned by counting them across 300 APIs-guru definitions:
 * character classes (`[a-z]`, `[0-9]`, negated, ranges and literals), the shorthands `\d \w \s .`,
 * the quantifiers `{n} {n,m} + * ?`, literal runs, and alternation (first branch). Anchors are
 * stripped. Anything else — back-references, lookaround, unicode property classes — is left to the
 * check to reject, which is exactly what the check is for.
 */
export const PATTERN_FALLBACK = "gen-value-x";

export function matchesPattern(pattern: string, value: string): boolean {
  // The "u" flag first, because it is what a modern validator applies; a pattern that is only legal
  // without it still gets its chance. A pattern that compiles under neither cannot be checked at
  // all, and an unverifiable claim is not one crust makes.
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    /* not unicode-legal — try the plain form */
  }
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * `minLen` asks for a value at least that long. It is a REQUEST, never a promise: the length is
 * bought by expanding a quantifier that was already open-ended (`+`, `*`, `{n,}`, `{n,m}`), so a
 * fixed-width pattern simply comes back at its own width. Padding it to fit would break the very
 * match this function verifies — which is precisely the bug this parameter exists to remove.
 */
export function sampleFromPattern(pattern: string, minLen = 0): string {
  const candidate = buildFromPattern(pattern);
  if (candidate === null) return PATTERN_FALLBACK;
  if (minLen > candidate.length && matchesPattern(pattern, candidate)) {
    const grown = buildFromPattern(pattern, minLen - candidate.length);
    if (grown !== null && grown.length > candidate.length && matchesPattern(pattern, grown))
      return grown;
  }
  // The whole design rests on this line.
  return matchesPattern(pattern, candidate) ? candidate : PATTERN_FALLBACK;
}

/** Structural walk over the pattern. Returns null the moment it meets something it cannot build. */
function buildFromPattern(pattern: string, extra = 0): string | null {
  let src = pattern.trim();
  if (!src) return null;
  // alternation at the top level: take the first branch that yields something
  if (src.includes("|")) {
    for (const branch of splitTopLevel(src, "|")) {
      const v = buildFromPattern(branch, extra);
      if (v !== null) return v;
    }
    return null;
  }
  src = src.replace(/^\^/, "").replace(/^\^/, "").replace(/\$$/, "");

  let out = "";
  let i = 0;
  let guard = 0;
  while (i < src.length) {
    if (++guard > 500) return null;
    let atom: string | null = null;

    if (src[i] === "\\") {
      const c = src[i + 1];
      i += 2;
      if (c === "d") atom = "1";
      else if (c === "w") atom = "a";
      else if (c === "s") atom = " ";
      else if (c && /[.\\/:+*?()[\]{}|^$@-]/.test(c))
        atom = c; // escaped literal
      else return null; // \p{...}, back-reference, anything unhandled
    } else if (src[i] === "[") {
      const close = findClassEnd(src, i);
      if (close < 0) return null;
      atom = pickFromClass(src.slice(i + 1, close));
      if (atom === null) return null;
      i = close + 1;
    } else if (src[i] === ".") {
      atom = "a";
      i += 1;
    } else if ("()".includes(src[i]!)) {
      // a plain group adds no characters of its own; a special group we cannot read
      if (src.startsWith("(?", i)) return null;
      i += 1;
      continue;
    } else if ("+*?{".includes(src[i]!)) {
      return null; // a quantifier with nothing before it
    } else {
      atom = src[i]!;
      i += 1;
    }

    // quantifier attached to that atom. `room` is how far this one may be stretched to spend the
    // caller's `extra` budget — 0 for a fixed width, so a `{3}` is never widened into a mismatch.
    let count = 1;
    let room = 0;
    if (src[i] === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) return null;
      const body = src.slice(i + 1, close);
      const m = /^(\d+)(,(\d*))?$/.exec(body);
      if (!m) return null;
      count = Number(m[1]);
      if (m[2] !== undefined)
        room = m[3] ? Math.max(0, Number(m[3]) - count) : Number.MAX_SAFE_INTEGER;
      i = close + 1;
    } else if (src[i] === "+") {
      count = 1;
      room = Number.MAX_SAFE_INTEGER;
      i += 1;
    } else if (src[i] === "*") {
      count = 0;
      room = Number.MAX_SAFE_INTEGER;
      i += 1;
    } else if (src[i] === "?") {
      count = 0;
      room = 1;
      i += 1;
    }
    if (extra > 0 && room > 0 && atom.length === 1) {
      const take = Math.min(extra, room);
      count += take;
      extra -= take;
    }
    if (count > 256) return null; // refuse to build something unreviewable
    out += atom.repeat(count);
  }
  return out;
}

/** A representative character from a character class, or null if it is negated-and-unreadable. */
function pickFromClass(body: string): string | null {
  if (!body) return null;
  if (body.startsWith("^")) {
    // negated: almost anything works; pick a letter unless the class excludes letters
    return /[a-zA-Z]/.test(body.slice(1)) ? "0" : "a";
  }
  let i = 0;
  while (i < body.length) {
    if (body[i] === "\\") {
      const c = body[i + 1];
      if (c === "d") return "1";
      if (c === "w") return "a";
      if (c === "s") return " ";
      if (c && /[.\\/:+*?()[\]{}|^$@-]/.test(c)) return c;
      return null; // \p{...} and friends
    }
    // a range like a-z, and never the trailing hyphen of "a-z-"
    if (body[i + 1] === "-" && i + 2 < body.length && body[i + 2] !== "]") {
      return body[i]!;
    }
    if (body[i] !== "-") return body[i]!;
    i += 1;
  }
  return null;
}

function findClassEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "]" && i > open + 1) return i;
  }
  return -1;
}

/** Split on a delimiter that is not inside a group or class. */
function splitTopLevel(src: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      cur += c + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (!inClass && c === "(") depth++;
    else if (!inClass && c === ")") depth--;
    if (c === delim && depth === 0 && !inClass) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
