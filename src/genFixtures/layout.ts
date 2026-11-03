/**
 * The biome-faithful emit primitives gen-fixtures builds its files from, so
 * that `biome check --write` on the result is a byte no-op:
 *
 *   - `quoteStringLiteral` — biome's quoteStyle, including its
 *     escape-minimising flip (a double-styled string full of `"` takes
 *     single quotes, exactly as biome's formatter rewrites it).
 *   - `asciiNatCompare` — the CLDR ASCII natural order biome's
 *     organizeImports assist sorts imported names with. It is NOT
 *     case-insensitive code-point order: uppercase sorts before its own
 *     lowercase (`A` < `a` < `B`), punctuation takes CLDR weights (`_`
 *     before digits before letters), and digit runs compare by length
 *     first, so `a2` < `a01` and `a9` < `a10`.
 *   - the `format*` helpers — biome's line-breaking shapes: a construct
 *     that fits the resolved lineWidth stays on one line; a call that does
 *     not breaks one argument per line with a trailing comma; an import
 *     list that does not breaks one specifier per line.
 *   - `formatJsonProperty` — biome's object/array layout for the inline
 *     JSON of a `schema:` fixture key: one line when it fits, one entry
 *     per line when it does not, object keys unquoted when they are valid
 *     identifiers (quoteProps "as-needed", biome's default), and a long
 *     atomic value moved below its key only when the key is at least
 *     `indentWidth + 3` columns wide — biome's own break-after-colon rule,
 *     which is why a 2277-column `body: '…'` stays on its line while a
 *     `description: "…"` moves below its key.
 *
 * All helpers emit in crust's native 2-space template form (reindentTwoSpace
 * maps it to the project's unit afterwards); fit checks count columns in the
 * FINAL style: one indent level costs `indentWidth` columns whether the unit
 * is a tab or spaces — biome measures a tab as indentWidth columns too.
 *
 * The weight table and the comparator are a direct port of biome's
 * `CldrAsciiCollator` (crates/biome_string_case), verified against the
 * running binary's organizeImports output — not a guess at "natural sort".
 */
import type { EmitStyle } from "./indent";

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * A JS string literal for `value` in the style's quote. "json" is the legacy
 * form: plain JSON.stringify output. Otherwise biome's rule: prefer the
 * configured quote, but when the content holds STRICTLY more of it than of
 * the other quote, flip to the other one — that is fewer escapes, and it is
 * what biome's formatter rewrites the source to.
 */
export function quoteStringLiteral(value: string, style: EmitStyle): string {
  const json = JSON.stringify(value);
  if (style.quoteStyle === "json") return json;
  const preferred = style.quoteStyle === "double" ? '"' : "'";
  const other = preferred === '"' ? "'" : '"';
  let preferredCount = 0;
  let otherCount = 0;
  for (const ch of value) {
    if (ch === preferred) preferredCount++;
    else if (ch === other) otherCount++;
  }
  const chosen = preferredCount > otherCount ? other : preferred;
  if (chosen === '"') return json;
  // Single-quoted: rebuild from the JSON form — unescape \", escape bare '.
  let out = "'";
  for (let i = 1; i < json.length - 1; i++) {
    const c = json[i]!;
    if (c === "\\") {
      const next = json[++i]!;
      out += next === '"' ? '"' : `\\${next}`;
    } else if (c === "'") out += "\\'";
    else out += c;
  }
  return `${out}'`;
}

// ---------------------------------------------------------------------------
// biome's natural order (CldrAsciiCollator port)
// ---------------------------------------------------------------------------

/**
 * Collation weight of every byte: the inverse of biome's COLLATION table
 * (rank -> byte), bytes >= 128 mapping to themselves as they do in biome.
 * Uppercase and lowercase interleave (A, a, B, b, …), punctuation sits below
 * digits, digits below letters.
 */
const CLDR_WEIGHTS: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 28, 29, 30, 31, 32, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 33, 39, 43, 55, 65, 56, 54, 42, 44, 45, 51, 59, 36, 35, 41, 52, 66, 67, 68,
  69, 70, 71, 72, 73, 74, 75, 38, 37, 60, 61, 62, 40, 50, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94,
  96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 46, 53, 47, 58, 34,
  57, 77, 79, 81, 83, 85, 87, 89, 91, 93, 95, 97, 99, 101, 103, 105, 107, 109, 111, 113, 115, 117,
  119, 121, 123, 125, 127, 48, 63, 49, 64, 27,
];
for (let i = 128; i < 256; i++) CLDR_WEIGHTS[i] = i;

const isDigitByte = (c: number): boolean => c >= 48 && c <= 57;

/**
 * Compare two strings the way biome's natural order does: equal bytes
 * advance; at the first difference, a digit run on either side compares by
 * how many digits each side has (so `9` < `10` and, with leading zeroes,
 * `2` < `01`), then digit by digit; anything else compares by CLDR weight.
 */
export function asciiNatCompare(a: string, b: string): number {
  const s1 = new TextEncoder().encode(a);
  const s2 = new TextEncoder().encode(b);
  let i = 0;
  let j = 0;
  let prev = -1; // the last byte both sides agreed on
  for (;;) {
    const c1 = i < s1.length ? (s1[i] as number) : -1;
    i++;
    const c2 = j < s2.length ? (s2[j] as number) : -1;
    j++;
    if (c1 === -1 && c2 === -1) return 0;
    if (c1 === -1) return -1; // a is a prefix of b
    if (c2 === -1) return 1;
    if (c1 === c2) {
      prev = c1;
      continue;
    }
    // The sides differ here. While digits are involved they compare as
    // numbers: the longer digit run wins outright, else digit by digit.
    let numOrd = 0;
    let x = c1;
    let y = c2;
    let fellThrough = false;
    for (;;) {
      const d1 = isDigitByte(x);
      const d2 = isDigitByte(y);
      if (!d1 && !d2) {
        if (numOrd === 0) {
          fellThrough = true;
          break;
        }
        return numOrd;
      }
      if (!d1 || !d2) {
        // One side ran out of digits mid-run: that run is the longer one —
        // but only if a run was actually under way (the last agreed byte was
        // a digit); otherwise this is not a number comparison at all.
        if (isDigitByte(prev)) return d1 ? 1 : -1;
        fellThrough = true;
        break;
      }
      numOrd = numOrd || (x === y ? 0 : x < y ? -1 : 1);
      const n1 = i < s1.length ? (s1[i] as number) : -1;
      i++;
      const n2 = j < s2.length ? (s2[j] as number) : -1;
      j++;
      if (n1 === -1 && n2 === -1) return numOrd;
      if (n1 === -1) return isDigitByte(n2) ? -1 : numOrd || -1;
      if (n2 === -1) return isDigitByte(n1) ? 1 : numOrd || 1;
      prev = x;
      x = n1;
      y = n2;
    }
    if (!fellThrough) return numOrd;
    // Not a number comparison after all: the two bytes weigh themselves.
    const ord = (CLDR_WEIGHTS[x] as number) - (CLDR_WEIGHTS[y] as number);
    if (ord !== 0) return ord < 0 ? -1 : 1;
    prev = x;
  }
}

/** Sort imported names the way biome orders them for this style. */
export function sortSpecifiers(names: Iterable<string>, style: EmitStyle): string[] {
  const list = [...names];
  return style.organizeImports ? list.sort(asciiNatCompare) : list.sort();
}

// ---------------------------------------------------------------------------
// Line fitting
// ---------------------------------------------------------------------------

/** Does `text` (content only, no indent) fit at `level` within lineWidth? */
export function fits(style: EmitStyle, level: number, text: string): boolean {
  return level * style.indentWidth + text.length <= style.lineWidth;
}

/** The 2-space template indent for `level`; reindentTwoSpace maps it later. */
export function pad(level: number): string {
  return "  ".repeat(level);
}

// ---------------------------------------------------------------------------
// Calls and imports
// ---------------------------------------------------------------------------

/**
 * `prefix callee(a, b)suffix` on one line when it fits; otherwise the call
 * breaks one argument per line with a trailing comma and the closing paren
 * back at the property's level — biome's shape for a call that does not fit.
 * An argument containing a hard newline never fits: the call always breaks.
 */
export function formatCall(
  style: EmitStyle,
  level: number,
  prefix: string,
  callee: string,
  args: string[],
  suffix: string,
): string {
  const one = `${callee}(${args.join(", ")})`;
  if (!one.includes("\n") && fits(style, level, `${prefix}${one}${suffix}`)) {
    return `${prefix}${one}${suffix}`;
  }
  const lines = [`${prefix}${callee}(`];
  for (const arg of args) lines.push(`${pad(level + 1)}${arg},`);
  lines.push(`${pad(level)})${suffix}`);
  return lines.join("\n");
}

/**
 * The import statement: one line when it fits, otherwise one specifier per
 * line with a trailing comma and `} from "…"` at column 0 — biome's shape.
 */
export function formatImport(style: EmitStyle, names: string[], specifier: string): string {
  const from = `from ${quoteStringLiteral(specifier, style)};`;
  const one = `import { ${names.join(", ")} } ${from}`;
  if (fits(style, 0, one)) return one;
  const lines = ["import {"];
  for (const n of names) lines.push(`${pad(1)}${n},`);
  lines.push(`} ${from}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline JSON values (the fixture `schema:` key)
// ---------------------------------------------------------------------------

const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9$_]*$/;

/** biome quoteProps "as-needed": bare when a valid identifier, quoted else. */
export function jsonKeyText(key: string, style: EmitStyle): string {
  return IDENT_KEY.test(key) ? key : quoteStringLiteral(key, style);
}

/** The one-line form of a JSON value in biome's layout. */
function jsonOneLine(value: unknown, style: EmitStyle): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((v) => jsonOneLine(v, style)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, v]) => `${jsonKeyText(k, style)}: ${jsonOneLine(v, style)}`)
      .join(", ");
    return `{ ${body} }`;
  }
  if (typeof value === "string") return quoteStringLiteral(value, style);
  return JSON.stringify(value) ?? "null";
}

function isJsonContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/**
 * A `key: value` property line at `level`, broken the way biome breaks it:
 * containers open their bracket on the key line and go one entry per line;
 * an atomic value moves below the key only when the key is wide enough
 * (biome's `indentWidth + 3` rule) — a short key keeps its overlong string
 * on the same line, overflowing, exactly as biome leaves `body: '…'` doing.
 */
export function formatJsonProperty(
  style: EmitStyle,
  key: string,
  value: unknown,
  level: number,
): string {
  const keyText = jsonKeyText(key, style);
  const one = jsonOneLine(value, style);
  if (fits(style, level, `${keyText}: ${one},`)) return `${keyText}: ${one},`;
  if (isJsonContainer(value)) return `${keyText}: ${formatJsonBroken(style, value, level)}`;
  if (keyText.length >= style.indentWidth + 3) {
    return `${keyText}:\n${pad(level + 1)}${one},`;
  }
  return `${keyText}: ${one},`;
}

/** A container already known not to fit at its key line: one entry per line. */
function formatJsonBroken(style: EmitStyle, value: unknown, level: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines = ["["];
    for (const item of value) {
      const text = isJsonContainer(item)
        ? formatJsonBroken(style, item, level + 1)
        : jsonOneLine(item, style);
      lines.push(`${pad(level + 1)}${text},`);
    }
    lines.push(`${pad(level)}]`);
    return lines.join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const lines = ["{"];
  for (const [k, v] of entries) {
    lines.push(`${pad(level + 1)}${formatJsonProperty(style, k, v, level + 1)}`);
  }
  lines.push(`${pad(level)}}`);
  return lines.join("\n");
}
