/**
 * gen-fixtures' emit style: match the project that receives the generated
 * files, not crust's own.
 *
 * A biome project's pre-commit hook (e.g. `biome check --write` on staged
 * files) normalises the emitted `<tag>.gen.crust.ts` and
 * `flows/flows.gen.setup.ts` to the repo's own indentation. Comparing raw
 * gen output against the committed, biome-normalised files then diffs the
 * WHOLE matrix as changed on every regeneration. So before emitting,
 * gen-fixtures looks for the nearest biome.json — walking up from the --out
 * directory, then from cwd when the out tree is not inside the working
 * project — and emits in the formatter indent that biome would apply to the
 * TypeScript it writes:
 *
 *   - `formatter.indentStyle: "tab"`   -> the tab character
 *   - `formatter.indentStyle: "space"` -> `indentWidth` spaces
 *   - a key absent -> biome's own default (space, 2)
 *
 * biome resolves a TS file's formatter options as its defaults, then the
 * top-level `formatter`, then the per-language `javascript.formatter` on top
 * of that — a repo that pins the style under `javascript.formatter` alone
 * must not get a different answer from crust.
 *
 * No biome.json on either walk -> the output keeps crust's historical
 * 2-space form byte for byte: zero behaviour change for non-biome repos, and
 * for the biome repos whose formatter is biome's own default. Only
 * `biome.json` is read — never `biome.jsonc`, whose comment form is a
 * different file — and the read is best-effort: a config biome itself would
 * reject (unparseable, unreadable) is disclosed and treated as absent, so a
 * broken formatter config never turns a generation into a failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// biome's own formatter defaults: what an absent key falls back to.
const BIOME_INDENT_STYLE = "space";
const BIOME_INDENT_WIDTH = 2;
/** The legacy emit style: the fallback when no biome.json is in play. */
export const DEFAULT_INDENT_UNIT = "  ";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The nearest biome.json on the ancestor chain of `dir` (inclusive), or null. */
export function findBiomeJsonUp(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    const candidate = join(cur, "biome.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null; // filesystem root reached
    cur = parent;
  }
}

/**
 * The indent unit a biome config gives the TypeScript it would format.
 * `formatter: null` (formatter disabled) and any non-object layer contribute
 * nothing, and a value biome would reject (`indentStyle: "tabs"`, a
 * non-integer width) is treated as absent — the defaults stand.
 */
export function indentUnitForBiomeConfig(config: unknown): string {
  const top = isRecord(config) && isRecord(config.formatter) ? config.formatter : {};
  const js =
    isRecord(config) && isRecord(config.javascript) && isRecord(config.javascript.formatter)
      ? (config.javascript.formatter as Record<string, unknown>)
      : {};
  let style: string = BIOME_INDENT_STYLE;
  let width = BIOME_INDENT_WIDTH;
  for (const layer of [top, js]) {
    // Later layer wins, the order biome applies: javascript over the top level.
    if (layer.indentStyle === "tab" || layer.indentStyle === "space") {
      style = layer.indentStyle;
    }
    if (Number.isInteger(layer.indentWidth) && (layer.indentWidth as number) > 0) {
      width = layer.indentWidth as number;
    }
  }
  // `indentStyle: "tab"` ignores indentWidth entirely — a tab is a tab.
  return style === "tab" ? "\t" : " ".repeat(width);
}

export interface IndentResolution {
  /** The unit to emit with: "\t", N spaces, or the legacy 2-space form. */
  unit: string;
  /** The biome.json that decided it, or null when none was found. */
  biomeJson: string | null;
}

/**
 * The emit style for a generation into `outDir`. The walk starts at the out
 * directory — the files land in its tree, so its project governs — and only
 * when that walk finds nothing does it fall back to `cwd` (the working
 * project, for the case where --out sits outside it).
 */
export function resolveIndentUnit(
  outDir: string,
  log: (line: string) => void,
  cwd: string = process.cwd(),
): IndentResolution {
  const path = findBiomeJsonUp(outDir) ?? findBiomeJsonUp(cwd);
  if (path === null) return { unit: DEFAULT_INDENT_UNIT, biomeJson: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    log(
      `gen-fixtures: could not read biome.json at ${path} (${(err as Error).message}) — ` +
        "the output keeps crust's 2-space form",
    );
    return { unit: DEFAULT_INDENT_UNIT, biomeJson: null };
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    log(
      `gen-fixtures: biome.json at ${path} is not valid JSON — biome will reject it too, ` +
        "so the output keeps crust's 2-space form",
    );
    return { unit: DEFAULT_INDENT_UNIT, biomeJson: null };
  }
  return { unit: indentUnitForBiomeConfig(config), biomeJson: path };
}

/**
 * The generated text is authored in crust's native 2-space style; this maps
 * each line's nesting level to the unit the project wants. A level is two
 * leading spaces, so a line with 12 leading spaces is level 6 and becomes
 * `unit.repeat(6)`; a line whose leading run is not an even number of
 * spaces keeps the remainder after the units (nothing the generator emits
 * today does). Blank and column-0 lines pass through untouched.
 *
 * A 2-space unit returns the input itself: that is the zero-behaviour-change
 * path, and byte identity is the guarantee non-biome repos — and biome repos
 * on the default style — rely on.
 */
export function reindentTwoSpace(text: string, unit: string): string {
  if (unit === DEFAULT_INDENT_UNIT) return text;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let spaces = 0;
    while (spaces < line.length && line[spaces] === " ") spaces++;
    const level = Math.floor(spaces / 2);
    out.push(level === 0 ? line : unit.repeat(level) + line.slice(level * 2));
  }
  return out.join("\n");
}
