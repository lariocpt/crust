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
    const grown = growToLength(pattern, candidate, minLen);
    if (grown !== null) return grown;
  }
  // The whole design rests on this line.
  return matchesPattern(pattern, candidate) ? candidate : PATTERN_FALLBACK;
}

/**
 * Stretch a verified sample up to `minLen`, or leave it alone.
 *
 * Three real shapes defeated quantifier-widening on its own. `[A-z0-9]` has NO quantifier, so there
 * is nothing to widen — but `pattern` is an UNANCHORED partial match, so repeating the sample still
 * satisfies it. `^$|[\x00-\x7F]+` puts the empty branch first, and rebuilding chose the same branch
 * again. And `[\w :+=./\n-]*` asked for 600 characters, which the build cap refused outright.
 *
 * Every candidate is verified before it is returned, so a genuinely unsatisfiable length — `^[a-z]{3}$`
 * asked for ten characters — finds nothing and the original stands. Stretching a value into a
 * mismatch is the fault this sampler exists to avoid.
 */
function growToLength(pattern: string, candidate: string, minLen: number): string | null {
  const tries: string[] = [];
  const widened = buildFromPattern(pattern, minLen - candidate.length);
  if (widened !== null) tries.push(widened);
  // Each alternation branch in turn: the first may be the one that cannot grow.
  for (const branch of splitTopLevel(pattern, "|")) {
    const built = buildFromPattern(branch, minLen);
    if (built !== null) tries.push(built);
  }
  // Repetition, which is what an unanchored pattern with no quantifier needs.
  if (candidate.length > 0) tries.push(candidate.repeat(Math.ceil(minLen / candidate.length)));

  for (const t of tries) if (t.length >= minLen && matchesPattern(pattern, t)) return t;
  // Nothing reached it; the longest that still matches beats a shorter one.
  let best: string | null = null;
  for (const t of tries) {
    if (
      t.length > candidate.length &&
      matchesPattern(pattern, t) &&
      (best === null || t.length > best.length)
    ) {
      best = t;
    }
  }
  return best;
}

/** Structural walk over the pattern. Returns null the moment it meets something it cannot build. */
function buildFromPattern(pattern: string, extra = 0): string | null {
  const extraBudget = extra;
  let src = pattern.trim();
  if (!src) return null;
  // alternation at the top level: take the first branch that yields something.
  //
  // `includes("|")` is not the same question as "is there a top-level alternation". splitTopLevel
  // is right to refuse to split inside `(...)` or `[...]`, so a nested pipe — `[\w|-]`, `(a|b)` —
  // comes back as ONE branch identical to `src`, and recursing on it never shrinks the input:
  // RangeError, taking the whole synthesis down. The guard below cannot catch that; it counts
  // characters inside one call, not depth across calls. 198 of the 4,138 APIs-guru specs (4.8%)
  // died here, and because the sweep ran a subprocess per spec it recorded every one as a spec
  // that failed to LOAD, so the crash never surfaced as crust's.
  //
  // Only branch when there is really more than one branch. Otherwise fall through: the walk below
  // reads a character class properly, which is what the nested pipe almost always is.
  if (src.includes("|")) {
    const branches = splitTopLevel(src, "|");
    if (branches.length > 1) {
      for (const branch of branches) {
        const v = buildFromPattern(branch, extra);
        if (v !== null) return v;
      }
      return null;
    }
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
    } else if (src[i] === "|") {
      // A bare `|` here is an alternation the walk cannot choose between — it is only reached when
      // the pipe was nested in a group, since a top-level one was split off above and a class one is
      // consumed by the class reader. Treating it as a literal built BOTH branches joined by a pipe:
      // `(0000000000-|AAAAAAAA-…)` became "0000000000-|AAAAAAAA-…", 48 characters against a
      // maxLength of 47. Worse, it survived verification — matchesPattern is an UNANCHORED test, so
      // the regex found one branch inside the joined string and pronounced it good. 36 such values
      // across the corpus. Decline instead; the caller's fallback is the honest answer.
      return null;
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
    // 256 is the "unreviewable" guard, but a length the SCHEMA asked for is reviewable by
    // definition: cloudhsm declares `minLength: 600` and the cap rejected the build outright,
    // handing back the neutral value for a field that could have been satisfied exactly.
    if (count > Math.max(256, extraBudget)) return null;
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
      // \uXXXX is how AWS writes an ordinary ASCII range: [\u0031-\u0039] IS [1-9]. Abandoning the
      // class meant a plain digit field fell back to the neutral value on dozens of real specs.
      if (c === "u" && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
        return printableIn(Number.parseInt(body.slice(i + 2, i + 6), 16), body, i + 6);
      }
      // `\xNN` is the other spelling, and AWS uses it for ASCII ranges: `[\x00-\x7F]`.
      if (c === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
        return printableIn(Number.parseInt(body.slice(i + 2, i + 4), 16), body, i + 4);
      }
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

/**
 * A printable character for a class whose range STARTS at an unprintable one.
 *
 * `[\x00-\x7F]` begins at NUL. Taking the low bound is correct and useless: a mock body full of
 * control characters is legal and unreadable. Where the range reaches ordinary ASCII, "a" is picked
 * instead; where it does not, the low bound stands, because a wrong value is worse than an ugly one.
 */
function printableIn(codePoint: number, body: string, after: number): string {
  const low = String.fromCharCode(codePoint);
  if (codePoint >= 0x20) return low;
  // A range follows if the next character is "-" and something comes after it.
  if (body[after] !== "-") return low;
  const rest = body.slice(after + 1);
  const hex = /^\\[ux]([0-9a-fA-F]{2,4})/.exec(rest);
  const high = hex ? Number.parseInt(hex[1] as string, 16) : rest.charCodeAt(0);
  return Number.isFinite(high) && high >= 0x61 ? "a" : low;
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

/**
 * The type a schema states without saying `type`.
 *
 * `type` is optional in JSON Schema, and the other keywords are not decoration: `format`, `pattern`
 * and the length bounds apply only to strings, the numeric bounds only to numbers. sinao writes
 * `items: {format: "string"}` — `format` where they meant `type` — and crust found no type, fell
 * through to null, and produced `[null]` against an array of strings.
 *
 * This reads what the schema already states rather than guessing what the author meant, and it adds
 * nothing where there is nothing: a schema with no such keywords still has no type.
 */
export function inferType(s: Record<string, unknown>): string | undefined {
  if (s.properties !== undefined || s.additionalProperties !== undefined) return "object";
  if (s.items !== undefined || s.minItems !== undefined || s.maxItems !== undefined) return "array";
  if (
    s.format !== undefined ||
    s.pattern !== undefined ||
    s.minLength !== undefined ||
    s.maxLength !== undefined
  ) {
    return "string";
  }
  if (
    s.minimum !== undefined ||
    s.maximum !== undefined ||
    s.exclusiveMinimum !== undefined ||
    s.exclusiveMaximum !== undefined ||
    s.multipleOf !== undefined
  ) {
    return "number";
  }
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const first = s.enum.find((v) => v !== null);
    if (typeof first === "string") return "string";
    if (typeof first === "number") return "number";
    if (typeof first === "boolean") return "boolean";
  }
  return undefined;
}

/**
 * A value satisfying a well-known `format`, or null when the format is not one crust knows.
 *
 * Shared by the mock and the fixture generator: the generator had no `uri` at all and fell to its
 * neutral value, which is not a URI — 972 of its 1,090 format failures across the corpus.
 */
export function formatDefault(format: string | undefined): string | null {
  switch (format) {
    case "email":
      return "user@example.com";
    case "date-time":
      return "1970-01-01T00:00:00.000Z";
    case "date":
      return "1970-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
    case "byte":
      return "";
    default:
      return null;
  }
}
