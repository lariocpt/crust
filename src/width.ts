/**
 * The terminal's unit is the CELL; a JS string's unit is the code unit.
 *
 * G32: `src/editor.ts` moved the caret with `CSI n D` built from `buf.length`, a
 * CHARACTER count, while a terminal's back-tab moves COLUMNS. Every double-width
 * glyph to the right of the caret left the visible caret a column too far right
 * (measured 8/8: `echo 日本` +2, `echo a✅b` +1, `echo 日本語日本x` +5, ASCII exact),
 * while the buffer and the paint were always right. The rule this module exists to
 * enforce: **characters for the buffer, cells for the terminal.**
 *
 * The width model is Unicode's East_Asian_Width property: `W`/`F` occupy two cells,
 * everything else one. That is not assumed for this project's terminal — it was
 * measured: 131 code points sampled across all 122 `W`/`F` ranges plus a spread of
 * non-wide ones agreed on 130. The exception is an *unassigned* code point in a
 * W-assigned plane (U+3EABF), where Unicode's default and the terminal's fallback
 * disagree; crust counts it 2 and drifts 1 column, which is a documented limit of a
 * table-driven measure, not a bug to chase.
 *
 * Ambiguous (`A`) renders NARROW here (measured: U+2500, U+00B1, U+00E9 → 1 cell
 * each). `cells()` follows the terminal rather than a guess about the user's locale,
 * and the tests pin that as a CHOICE, not a fact about terminals everywhere.
 */

import { WIDE_RANGES, ZERO_WIDTH_RANGES } from "./widthTable";

const ZWJ = "\u200d";
const VS16 = "\ufe0f"; // emoji presentation: promotes its base to two cells

/** Ranges are sorted and disjoint (tests/editor-cells.test.ts pins it). */
function inRanges(ranges: readonly [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (!range) return false;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Regional indicator — a PAIR of these is one flag glyph. */
const isRegionalIndicator = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;

// One grapheme cluster is one user-visible glyph. Without clustering, `👨‍👩`
// (three code points, one glyph) and `🇦🇺` (two indicators, one flag) count as
// several, and `e` + U+0301 counts as two when the terminal shows one.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A plain ASCII string is already measured in cells — the common keystroke. */
function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** How many COLUMNS does `text` occupy? Never `text.length`. */
export function cells(text: string): number {
  // The fast path keeps the fix free on the keystrokes users actually type: no
  // segmenter, no table, exactly what `length` used to return.
  if (isAscii(text)) return text.length;
  let total = 0;
  for (const { segment } of segmenter.segment(text)) total += clusterCells(segment);
  return total;
}

function clusterCells(cluster: string): number {
  // Emoji sequences show as ONE glyph whatever they contain: a ZWJ join (family),
  // or any base carrying VS16 (❤️ = U+2764 U+FE0F, measured 2 cells).
  if (cluster.includes(ZWJ)) return 2;
  if (cluster.includes(VS16)) return 2;

  const cps = [...cluster].map((ch) => ch.codePointAt(0) ?? 0);
  // A flag is a pair of regional indicators; a lone one is unresolved, and the
  // terminal here still gives it a cell for each.
  if (cps.length >= 2 && cps.every(isRegionalIndicator)) return 2;

  // Past that the cluster is a base plus its marks: only the base is visible.
  const base = cps[0];
  if (base === undefined) return 0;
  if (inRanges(ZERO_WIDTH_RANGES, base)) return 0;
  // VS15 (text presentation) is deliberately NOT special-cased: measured in a pty,
  // this terminal IGNORES it for emoji-presentation glyphs — U+231A U+FE0E and
  // U+1F600 U+FE0E both render 2 cells — while a narrow base with VS15 (U+2764
  // U+FE0E) renders 1. Falling through to the base's own width is therefore the
  // measured answer, not an unhandled case.
  if (inRanges(WIDE_RANGES, base)) return 2;
  return 1;
}

// --- G33: caret motion by grapheme ------------------------------------------
//
// The editor's buf/cursor are indexed in UTF-16 CODE UNITS, but the user's
// unit is the GLYPH. Stepping one unit lands inside a surrogate pair, between
// a base and its combining mark, mid ZWJ family or mid flag — and every
// following edit then commits the half pair to the submitted line. The helpers
// below give the editor the same clustering `cells()` uses, so the motion and
// the measure cannot drift.
//
// A LONE surrogate (only reachable from pre-G33 history or a pair split across
// two stdin chunks) is its own segment to the segmenter, so the helpers stay
// consistent for it. But well-formedness checks must NOT rely on the
// clustering: to the segmenter a lone surrogate is a whole cluster, which is
// why completion.ts's commonPrefix trims it explicitly.

/** Grapheme cluster start offsets of `text`, ascending (0 first when non-empty). */
function graphemeStarts(text: string): number[] {
  const starts: number[] = [];
  for (const { index } of segmenter.segment(text)) starts.push(index);
  return starts;
}

/**
 * Where the caret lands on a LEFT move from code-unit index `i`: the start of
 * the cluster that owns the unit just left of `i` (the largest cluster start
 * strictly less than `i`), or 0 when nothing is to the left. A caret stuck
 * mid-cluster lands on that cluster's own start, never inside it.
 */
export function graphemeStartBefore(text: string, i: number): number {
  let best = 0;
  for (const s of graphemeStarts(text)) {
    if (s < i) best = s;
    else break;
  }
  return best;
}

/**
 * Where the caret lands on a RIGHT move from code-unit index `i`: the end of
 * the cluster whose start is the largest cluster start ≤ `i` (the next start,
 * or the end of the text). A caret stuck mid-cluster exits that cluster.
 */
export function graphemeEndAfter(text: string, i: number): number {
  // The cluster whose start is the largest start ≤ i ends exactly where the
  // NEXT cluster begins: with sorted starts that is the first start > i, or
  // the end of the text.
  for (const s of graphemeStarts(text)) {
    if (s > i) return s;
  }
  return text.length;
}
