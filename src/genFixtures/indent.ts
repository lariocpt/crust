/**
 * gen-fixtures' emit style: match the project that receives the generated
 * files, not crust's own.
 *
 * A biome project's pre-commit hook (e.g. `biome check --write` on staged
 * files) normalises the emitted `<tag>.gen.crust.ts` and
 * `flows/flows.gen.setup.ts` to the repo's own style. Comparing raw gen
 * output against the committed, biome-normalised files then diffs the WHOLE
 * matrix as changed on every regeneration. So before emitting, gen-fixtures
 * looks for the nearest biome.json — walking up from the --out directory,
 * then from cwd when the out tree is not inside the working project — and
 * resolves the full style biome would apply to the TypeScript it writes:
 *
 *   - indent: `formatter.indentStyle` "tab" -> a tab, "space" -> `indentWidth`
 *     spaces; a key absent -> biome's own default (space, 2)
 *   - `lineWidth`: `formatter.lineWidth`, default 80 — long calls and import
 *     lists wrap the way biome's formatter wraps them
 *   - `javascript.formatter.quoteStyle`: "double" (biome's default) or
 *     "single" — string literals are emitted in it, with biome's own
 *     escape-minimising flip when a string is full of the other quote
 *   - `assist.actions.source.organizeImports` (ON by default in biome 2.x)
 *     -> imported names are ordered the way the assist orders them (CLDR
 *     ASCII natural order) unless the config explicitly switches it "off" or
 *     disables the whole assist, so the assist has nothing to re-sort
 *
 * biome resolves a TS file's formatter options as its defaults, then the
 * top-level `formatter`, then the per-language `javascript.formatter` on top
 * of that — a repo that pins the style under `javascript.formatter` alone
 * must not get a different answer from crust.
 *
 * No biome.json on either walk -> the output keeps crust's historical
 * 2-space form byte for byte: zero behaviour change for non-biome repos.
 * Only `biome.json` is read — never `biome.jsonc`, whose comment form is a
 * different file — and the read is best-effort: a config biome itself would
 * reject (unparseable, unreadable) is disclosed and treated as absent, so a
 * broken formatter config never turns a generation into a failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// biome's own formatter defaults: what an absent key falls back to.
const BIOME_INDENT_STYLE = "space";
const BIOME_INDENT_WIDTH = 2;
const BIOME_LINE_WIDTH = 80;
const BIOME_QUOTE_STYLE = "double";
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

/**
 * The full emit style a biome.json resolves to — everything the emitter must
 * match so that `biome check --write` on the generated files is a no-op.
 */
export interface EmitStyle {
  /** The indent unit: "\t", N spaces, or the legacy 2-space form. */
  unit: string;
  /** Columns one indent level costs. A tab counts as biome's indentWidth. */
  indentWidth: number;
  /** Where biome wraps. Infinity in the legacy form — nothing ever wraps. */
  lineWidth: number;
  /**
   * The quote style for string literals. "json" is the legacy form: plain
   * JSON.stringify output, always double-quoted with escapes.
   */
  quoteStyle: "json" | "double" | "single";
  /**
   * Whether biome's organizeImports assist is in play: imported names then
   * take the natural order the assist sorts with, instead of the legacy
   * code-point `.sort()`. Biome 2.x defaults it ON — an absent key (or a
   * value biome would reject) leaves the default standing; only an explicit
   * "off", or `assist.enabled: false`, switches it off.
   */
  organizeImports: boolean;
  /** True when no biome.json was found — the 0.3.2 byte-for-byte contract. */
  legacy: boolean;
  /** The biome.json that decided it, or null when none was found. */
  biomeJson: string | null;
}

/**
 * The style a biome config gives the TypeScript it would format. Every key
 * biome would reject is treated as absent — the defaults stand, exactly as
 * `indentUnitForBiomeConfig` treats them.
 */
export function styleForBiomeConfig(config: unknown): Omit<EmitStyle, "legacy" | "biomeJson"> {
  const top = isRecord(config) && isRecord(config.formatter) ? config.formatter : {};
  const js =
    isRecord(config) && isRecord(config.javascript) && isRecord(config.javascript.formatter)
      ? (config.javascript.formatter as Record<string, unknown>)
      : {};
  let indentWidth = BIOME_INDENT_WIDTH;
  let lineWidth = BIOME_LINE_WIDTH;
  for (const layer of [top, js]) {
    // Later layer wins, the order biome applies: javascript over the top level.
    if (Number.isInteger(layer.indentWidth) && (layer.indentWidth as number) > 0) {
      indentWidth = layer.indentWidth as number;
    }
    if (Number.isInteger(layer.lineWidth) && (layer.lineWidth as number) > 0) {
      lineWidth = layer.lineWidth as number;
    }
  }
  // quoteStyle lives under javascript.formatter only — biome 2.x has no
  // top-level formatter.quoteStyle to layer.
  const quoteStyle =
    js.quoteStyle === "single" || js.quoteStyle === "double" ? js.quoteStyle : BIOME_QUOTE_STYLE;
  // organizeImports is an assist action biome 2.x switches ON by default:
  // the default stands unless the config says otherwise, so an ABSENT key
  // still re-sorts — only an explicit "off" (or the whole assist disabled)
  // keeps the legacy code-point order. Measured against biome 2.4.13 and
  // 2.5.7, which re-order a code-point-sorted import list either way.
  const assist = isRecord(config) && isRecord(config.assist) ? config.assist : {};
  const actions = isRecord(assist.actions) ? assist.actions : {};
  const source = isRecord(actions.source) ? actions.source : {};
  const organizeImports = assist.enabled !== false && source.organizeImports !== "off";
  return {
    unit: indentUnitForBiomeConfig(config),
    indentWidth,
    lineWidth,
    quoteStyle,
    organizeImports,
  };
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
export function resolveEmitStyle(
  outDir: string,
  log: (line: string) => void,
  cwd: string = process.cwd(),
): EmitStyle {
  const legacy: EmitStyle = {
    unit: DEFAULT_INDENT_UNIT,
    indentWidth: 2,
    lineWidth: Number.POSITIVE_INFINITY,
    quoteStyle: "json",
    organizeImports: false,
    legacy: true,
    biomeJson: null,
  };
  const path = findBiomeJsonUp(outDir) ?? findBiomeJsonUp(cwd);
  if (path === null) return legacy;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    log(
      `gen-fixtures: could not read biome.json at ${path} (${(err as Error).message}) — ` +
        "the output keeps crust's 2-space form",
    );
    return legacy;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    log(
      `gen-fixtures: biome.json at ${path} is not valid JSON — biome will reject it too, ` +
        "so the output keeps crust's 2-space form",
    );
    return legacy;
  }
  return { ...styleForBiomeConfig(config), legacy: false, biomeJson: path };
}

/**
 * The emit indent for a generation into `outDir` — the indent slice of
 * resolveEmitStyle, kept as its own entry point because the notice the CLI
 * logs is about the indent.
 */
export function resolveIndentUnit(
  outDir: string,
  log: (line: string) => void,
  cwd: string = process.cwd(),
): IndentResolution {
  const { unit, biomeJson } = resolveEmitStyle(outDir, log, cwd);
  return { unit, biomeJson };
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
