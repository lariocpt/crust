// Frontmatter: a `---` YAML block at the top of every .md file, parsed with
// eemeli/yaml + LineCounter so every diagnostic lands in the FULL file's
// coordinates (Bun's built-in YAML gives no positions — plan §0). Strict:
// missing/unclosed block, non-mapping, duplicate keys, unknown keys and bad
// values are all ERRORS, collected into one BuildError. The delimiter is
// `---` at column 0 (trailing space/tab allowed) — an indented `---` is
// content, not a fence — and a leading BOM is stripped as input noise.

import { isMap, isNode, LineCounter, parseDocument } from "yaml";
import { BuildError, type Diagnostic, isDiagnostic } from "./diagnostics";
import { normalizeRoute } from "./routes";
import type { FrontmatterResult, PageFrontmatter } from "./types";

const KNOWN_KEYS = ["title", "description", "layout", "route", "draft", "data"] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Parse a .md file's frontmatter. Throws `BuildError` (sorted) on ANY problem;
 * on success returns the validated frontmatter, the body, and the body's
 * first line so later chunks can locate markdown errors in file coordinates.
 */
export function parseFrontmatter(text: string, sourcePath: string): FrontmatterResult {
  // A single leading BOM is an input artifact (Windows editors write one);
  // strip it, as eemeli/yaml does, and as the CRLF normalization below. A
  // U+FEFF mid-file is content (a zero-width no-break space), not a BOM.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // CRLF/CR → LF before counting: line COUNT is preserved, and every later
  // chunk emits LF-only (plan, Windows table: "Normalize CRLF on input").
  const lines = src.replace(/\r\n?/g, "\n").split("\n");

  const structural = (message: string): never => {
    throw new BuildError([
      {
        code: "frontmatter.missing",
        message,
        severity: "error",
        sourcePath,
        line: 1,
        column: 1,
      },
    ]);
  };

  // The delimiter is `---` at column 0 with optional trailing whitespace:
  //   - leading whitespace is a Markdown code-block signal and must NOT
  //     delimit — a file that is an indented code block of dashes is body,
  //     not frontmatter (trailing space/tab is an editor artifact: allowed);
  //   - `----` is not a delimiter (it is horizontal-rule-ish content);
  //   - an indented `---` INSIDE the block is YAML content — a block scalar
  //     keeps it verbatim (eemeli/yaml only treats a column-0 marker as a
  //     document terminator) — so the closer must be column-0 or it would
  //     slice a scalar early and move the rest of the frontmatter into the
  //     body (a silent misparse, never a fix).
  const DELIMITER = /^---[ \t]*$/;

  if (!DELIMITER.test(lines[0] ?? "")) {
    structural('file does not begin with a column-0 "---" frontmatter delimiter line');
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (DELIMITER.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close === -1) structural('frontmatter block is not closed (missing closing "---" line)');

  // The YAML block occupies file lines 2..close; every position below is
  // reported in FULL-FILE coordinates by adding this offset.
  const lineOffset = 1;
  const block = lines.slice(1, close).join("\n");
  const lineCounter = new LineCounter();
  const doc = parseDocument(block, { lineCounter, logLevel: "silent" });

  const located = (offset: number): { line: number; column: number } => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line + lineOffset, column: pos.col };
  };
  const nodeOffset = (node: unknown, fallback: number): number => {
    const range = isNode(node) ? node.range : undefined;
    return range ? range[0] : fallback;
  };

  // Parse errors: duplicate keys are located and reported, and validation
  // continues (yaml resolves duplicates to the last value, so the remaining
  // keys are still checkable). Any other syntax error means the document
  // cannot be trusted at all — report and stop, but report ALL syntax errors.
  const errors: Diagnostic[] = [];
  let fatal = false;
  for (const err of doc.errors) {
    const at = located(err.pos ? err.pos[0] : 0);
    if (err.code === "DUPLICATE_KEY") {
      errors.push({
        code: "frontmatter.duplicate-key",
        message: `duplicate frontmatter key: ${err.message.split("\n")[0]}`,
        severity: "error",
        sourcePath,
        line: at.line,
        column: at.column,
      });
    } else {
      fatal = true;
      errors.push({
        code: "frontmatter.parse-error",
        message: `frontmatter YAML is not parseable: ${err.message.split("\n")[0]}`,
        severity: "error",
        sourcePath,
        line: at.line,
        column: at.column,
      });
    }
  }
  if (fatal) throw new BuildError(errors);

  if (!doc.contents || !isMap(doc.contents)) {
    const at = doc.contents ? located(nodeOffset(doc.contents, 0)) : { line: 1, column: 1 };
    errors.push({
      code: "frontmatter.not-mapping",
      message: "frontmatter must be a YAML mapping of key: value pairs",
      severity: "error",
      sourcePath,
      line: at.line,
      column: at.column,
    });
    throw new BuildError(errors);
  }

  const frontmatter: PageFrontmatter = { title: "" };
  let hasTitle = false;
  const badValue = (at: { line: number; column: number }, key: KnownKey, why: string): void => {
    errors.push({
      code: "frontmatter.bad-value",
      message: `frontmatter key "${key}": ${why}`,
      severity: "error",
      sourcePath,
      line: at.line,
      column: at.column,
    });
  };

  for (const item of doc.contents.items) {
    const keyPos = located(nodeOffset(item.key, 0));
    const key = isNode(item.key) ? (item.key.toJS(doc) as unknown) : null;
    if (typeof key !== "string") {
      errors.push({
        code: "frontmatter.unknown-key",
        message: "frontmatter keys must be plain strings",
        severity: "error",
        sourcePath,
        line: keyPos.line,
        column: keyPos.column,
      });
      continue;
    }
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      errors.push({
        code: "frontmatter.unknown-key",
        message: `unknown frontmatter key "${key}" (allowed: ${KNOWN_KEYS.join(", ")})`,
        severity: "error",
        sourcePath,
        line: keyPos.line,
        column: keyPos.column,
      });
      continue;
    }
    const value = isNode(item.value) ? item.value.toJS(doc) : undefined;
    const valPos = located(nodeOffset(item.value, 0));

    switch (key) {
      case "title":
        hasTitle = true;
        if (typeof value !== "string" || value.trim() === "") {
          badValue(valPos, "title", "must be a non-empty string");
        } else {
          frontmatter.title = value;
        }
        break;
      case "description":
        if (typeof value !== "string" || value === "") {
          badValue(valPos, "description", "must be a non-empty string when present");
        } else {
          frontmatter.description = value;
        }
        break;
      case "layout":
        if (typeof value !== "string" || value === "") {
          badValue(valPos, "layout", "must be a non-empty string");
        } else {
          frontmatter.layout = value;
        }
        break;
      case "route":
        try {
          frontmatter.route = normalizeRoute(value, { sourcePath });
        } catch (d) {
          if (!isDiagnostic(d)) throw d;
          // Keep the route.* code (codes are never repurposed) but locate the
          // problem at the route KEY, which is what the author must fix.
          errors.push({ ...d, line: keyPos.line, column: keyPos.column });
        }
        break;
      case "draft":
        if (typeof value !== "boolean") badValue(valPos, "draft", "must be a boolean");
        else frontmatter.draft = value;
        break;
      case "data":
        if (!isPlainObject(value))
          badValue(valPos, "data", "must be a plain object (a YAML mapping)");
        else frontmatter.data = value;
        break;
    }
  }

  if (!hasTitle) {
    errors.push({
      code: "frontmatter.missing-title",
      message: 'frontmatter is missing the required key "title"',
      severity: "error",
      sourcePath,
      line: 1,
      column: 1,
    });
  }
  if (errors.length > 0) throw new BuildError(errors);

  return {
    frontmatter,
    body: lines.slice(close + 1).join("\n"),
    bodyStartLine: close + 2,
  };
}
