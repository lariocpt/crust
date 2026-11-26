// The document fence (plan §1 "value-range fence"): a post-render scan over
// (final markup, merged value ranges) that turns the fence rules into build
// errors. Enforced by this file, NOT by inspecting the template literal —
// `html\`<scr${"i"}pt>\`` proves the literal cannot be trusted.
//
// ALL scans are single-pass linear-time state machines (plan, risks: "the
// fence is a build-time DoS surface — no backtracking regexes"). The
// structure pass walks the document once with an explicit character loop;
// every follow-up check is O(n + m log m) over the recorded regions.
//
// Soundness note: interpolated values are ALWAYS escaped by html.ts, so a
// value can never contribute a raw `<`, `>`, `&`, `"`, or `'` to the final
// document. Every structural boundary the scanner finds (`<`, `<!--`,
// attribute quotes) therefore comes from LITERAL template text — the scanner
// parses exactly what a browser would parse, and the tracked ranges mark the
// (escaped) value text the fence rules must police.

import type { Diagnostic, DiagnosticCode } from "./diagnostics";
import { isDiagnostic } from "./diagnostics";
import { URL_ATTRIBUTES, type UrlPolicyOptions, validateUrl } from "./url";

/** A half-open character range [start, end) in the final markup. */
export type Range = readonly [start: number, end: number];

/** An attribute as the scanner sees it in the final document. */
interface ParsedAttribute {
  /** Literal text (kept as-is; checks compare it lowercased). */
  name: string;
  nameStart: number;
  nameEnd: number;
  /** Raw value text (between the quotes, or the unquoted run); absent when the attribute is value-less. */
  value?: string;
  valueStart?: number;
  valueEnd?: number;
  /** The value existed but carried no quotes. */
  unquoted: boolean;
  /** The opening quote was never closed (value runs to end of document). */
  unterminated: boolean;
}

/** An opening tag as the scanner sees it. */
interface ParsedTag {
  /** Lowercased tag name. */
  name: string;
  nameStart: number;
  nameEnd: number;
  selfClosing: boolean;
  attributes: ParsedAttribute[];
}

interface CommentRegion {
  start: number;
  end: number;
  terminated: boolean;
}

interface RawBody {
  kind: "script" | "style";
  start: number;
  end: number;
  tagName: string;
}

interface UnterminatedQuote {
  tagName: string;
  attrName: string;
}

interface ScanResult {
  tags: ParsedTag[];
  comments: CommentRegion[];
  /** `<!...>` (doctype) and `<?...>` (bogus comment) regions — inert text, not comments. */
  declarations: { start: number; end: number }[];
  rawBodies: RawBody[];
  unterminatedQuotes: UnterminatedQuote[];
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

function isAsciiLetter(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Case-insensitive `markup.startsWith(needle, at)` for an already-lowercased ASCII needle. */
function startsWithLower(markup: string, needle: string, at: number): boolean {
  if (at + needle.length > markup.length) return false;
  for (let c = 0; c < needle.length; c++) {
    let ch = markup.charCodeAt(at + c);
    if (ch >= 0x41 && ch <= 0x5a) ch += 32;
    if (ch !== needle.charCodeAt(c)) return false;
  }
  return true;
}

/**
 * True iff [s, e) intersects any tracked range. `ranges` must be sorted by
 * start and non-overlapping (the invariant html.ts maintains), which makes
 * the ends strictly increasing and binary-searchable. A zero-length probe
 * never intersects (nothing was emitted, so nothing can cross a boundary).
 */
export function rangesOverlap(ranges: readonly Range[], s: number, e: number): boolean {
  if (e <= s) return false;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] <= s) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo][0] < e;
}

function parseOpenTag(markup: string, start: number): { tag: ParsedTag; next: number } {
  const n = markup.length;
  let i = start + 1; // past '<'
  const nameStart = i;
  while (i < n && isAsciiLetter(markup[i])) i++;
  const nameEnd = i;
  const tag: ParsedTag = {
    name: markup.slice(nameStart, nameEnd).toLowerCase(),
    nameStart,
    nameEnd,
    selfClosing: false,
    attributes: [],
  };

  for (;;) {
    while (i < n && isWs(markup[i])) i++;
    if (i >= n) break; // tag runs to EOF; HTML emits it as-is
    const c = markup[i];
    if (c === ">") {
      i++;
      break;
    }
    if (c === "/") {
      // The self-closing marker. For script/style the RAW-TEXT phase that
      // follows ignores it (HTML: <script/> is NOT self-closed) — that is
      // handled by the caller.
      tag.selfClosing = true;
      i++;
      continue;
    }
    // Attribute name: runs until '=', ws, '/' or '>'. (A '"' that appears
    // here is a name character, matching the HTML tokenizer's attribute-name
    // state — <a "quoted"> parses a single attribute named `"quoted`.)
    const aNameStart = i;
    while (i < n && markup[i] !== "=" && markup[i] !== ">" && markup[i] !== "/" && !isWs(markup[i]))
      i++;
    const aNameEnd = i;
    if (aNameEnd === aNameStart) {
      // A character that cannot start a name in our stop-set logic; consume
      // it to keep the machine moving (unreachable for well-formed markup).
      i++;
      continue;
    }
    const attr: ParsedAttribute = {
      name: markup.slice(aNameStart, aNameEnd),
      nameStart: aNameStart,
      nameEnd: aNameEnd,
      unquoted: false,
      unterminated: false,
    };
    while (i < n && isWs(markup[i])) i++;
    if (i < n && markup[i] === "=") {
      i++;
      while (i < n && isWs(markup[i])) i++;
      if (i < n && (markup[i] === '"' || markup[i] === "'")) {
        const quote = markup[i];
        const vStart = i + 1;
        const vEnd = markup.indexOf(quote, vStart);
        if (vEnd === -1) {
          // Unclosed quote: the HTML tokenizer consumes the REST OF THE
          // DOCUMENT as this value. Policy: fence.unterminated (the document
          // is rejected; see the header of this file and the fence tests).
          attr.unterminated = true;
          attr.value = markup.slice(vStart);
          attr.valueStart = vStart;
          attr.valueEnd = n;
          i = n;
        } else {
          attr.value = markup.slice(vStart, vEnd);
          attr.valueStart = vStart;
          attr.valueEnd = vEnd;
          i = vEnd + 1;
        }
      } else if (i >= n || markup[i] === ">") {
        // '=' immediately followed by end-of-tag/EOF: the attribute is value-less.
      } else {
        const vStart = i;
        while (i < n && !isWs(markup[i]) && markup[i] !== ">") i++;
        attr.value = markup.slice(vStart, i);
        attr.valueStart = vStart;
        attr.valueEnd = i;
        attr.unquoted = true;
      }
    }
    // A value-less attribute (`<a href>`): no value to check. An empty URL
    // resolves to the current page — same-origin by construction.
    tag.attributes.push(attr);
  }

  return { tag, next: i };
}

/**
 * One linear pass over the whole document. Records every opening tag with its
 * attributes, every comment region, every inert declaration, and the raw-text
 * bodies of script/style elements.
 */
function scanDocument(markup: string): ScanResult {
  const result: ScanResult = {
    tags: [],
    comments: [],
    declarations: [],
    rawBodies: [],
    unterminatedQuotes: [],
  };
  const n = markup.length;
  let i = 0;

  while (i < n) {
    if (markup[i] !== "<") {
      i++;
      continue;
    }
    // markup[i] === '<'
    if (markup.startsWith("<!--", i)) {
      // Comment close positions per the HTML tokenizer, all linear:
      //  - `<!-->`  — comment-start state sees '>' → closed empty comment
      //    (the "incorrect-comment-syntax" parse error; the '>' is NOT data)
      //  - `<!--->` — comment-start-dash state sees '>' → closed empty comment
      //  - otherwise the first `-->` OR `--!>` (comment end / end-bang states)
      // The old `indexOf("-->", i+4)` rule disagreed with browsers on all
      // three shapes: it ran the comment to EOF, so a value AFTER a closed
      // `<!-->`/`<!--->`/`--!>` comment was falsely fenced as comment data.
      let end = -1;
      if (markup[i + 4] === ">") end = i + 5;
      else if (markup[i + 4] === "-" && markup[i + 5] === ">") end = i + 6;
      else {
        for (let k = i + 4; ; ) {
          const d = markup.indexOf("--", k);
          if (d === -1) break;
          if (markup[d + 2] === ">") {
            end = d + 3;
            break;
          }
          if (markup[d + 2] === "!" && markup[d + 3] === ">") {
            end = d + 4;
            break;
          }
          // advance by 1, not 2: `--->` closes at the SECOND dash pair
          k = d + 1;
        }
      }
      result.comments.push({ start: i, end: end === -1 ? n : end, terminated: end !== -1 });
      i = end === -1 ? n : end;
      continue;
    }
    if (markup.startsWith("<!", i) || markup.startsWith("<?", i)) {
      // Doctype or bogus comment: inert until the first '>'. No attributes
      // are parsed here (a bogus comment has none; a doctype's quirks are
      // not a fence concern). Values cannot produce '<!' (escaped), so a
      // tracked range can never land inside this region.
      const close = markup.indexOf(">", i + 2);
      const end = close === -1 ? n : close + 1;
      result.declarations.push({ start: i, end });
      i = end;
      continue;
    }
    if (markup.startsWith("</", i)) {
      // Closing tag: consume to the matching '>' (or EOF). Closing tag names
      // are NOT fence-checked — the rule is about tag-OPEN contexts, and a
      // bogus closing tag is inert.
      let j = i + 2;
      while (j < n && markup[j] !== ">") j++;
      i = j < n ? j + 1 : n;
      continue;
    }
    if (i + 1 < n && isAsciiLetter(markup[i + 1])) {
      const { tag, next } = parseOpenTag(markup, i);
      result.tags.push(tag);
      for (const attr of tag.attributes) {
        if (attr.unterminated)
          result.unterminatedQuotes.push({ tagName: tag.name, attrName: attr.name });
      }
      if (tag.name === "script" || tag.name === "style") {
        // RAW TEXT element: the body runs to the matching end tag, and the
        // self-closing '/' is ignored (HTML5: <script src="x"/> still opens a
        // raw-text element — everything up to </script> is its body).
        const endTag = `</${tag.name}`;
        const endTagLen = endTag.length;
        let j = next;
        let bodyEnd = n;
        let nextI = n;
        while (j < n) {
          // Case-INSENSITIVE: `</SCRIPT>` closes `<script>` in every browser.
          // A case-sensitive match would run the body to EOF — a false
          // script-body on `<SCRIPT src=x></SCRIPT>…`, and (worse) the rest
          // of the document would never be scanned.
          if (startsWithLower(markup, endTag, j)) {
            const after = j + endTagLen;
            if (after >= n) {
              // End tag truncated at EOF: the element never closes, so the
              // body is everything to EOF (the tokenizer agrees).
              bodyEnd = n;
              nextI = n;
              break;
            }
            if (isWs(markup[after]) || markup[after] === ">") {
              // The body ends where the END TAG BEGINS (j); the end tag's
              // own text is not body content.
              bodyEnd = j;
              let k = after;
              while (k < n && markup[k] !== ">") k++;
              nextI = k < n ? k + 1 : n;
              break;
            }
            // `</scriptx` etc. — the name does not match exactly; keep
            // scanning (the text is body content).
          }
          j++;
        }
        result.rawBodies.push({
          kind: tag.name as "script" | "style",
          start: next,
          end: bodyEnd,
          tagName: tag.name,
        });
        i = nextI;
        continue;
      }
      i = next;
      continue;
    }
    // '<' followed by anything else (digit, punctuation) is literal text in
    // HTML (e.g. "a < b").
    i++;
  }

  return result;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function isHexDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/**
 * Decode the HTML entity references that html.ts's escaper produces (plus
 * numeric references and &apos;), used to recover the URL a BROWSER would
 * interpret from a quoted attribute value. Unknown or malformed references
 * pass through as literal text — conservative: a surviving `&#` then trips
 * the url.entity-escape reject downstream, it can never hide a scheme.
 * Single pass, linear.
 */
export function decodeEntities(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const amp = text.indexOf("&", i);
    if (amp === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, amp);
    i = amp; // position of '&'
    let j = i + 1;
    let decoded: string | undefined;
    if (j < n && text[j] === "#") {
      j++;
      let radix = 10;
      if (j < n && (text[j] === "x" || text[j] === "X")) {
        radix = 16;
        j++;
      }
      const d0 = j;
      while (
        j < n &&
        (radix === 16
          ? isHexDigit(text[j])
          : text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39)
      )
        j++;
      if (j > d0 && j < n && text[j] === ";") {
        const code = Number.parseInt(text.slice(d0, j), radix);
        if (Number.isFinite(code) && code >= 1 && code <= 0x10ffff) {
          decoded = String.fromCodePoint(code);
          j++;
        }
      }
    } else {
      const d0 = j;
      while (j < n && isAsciiLetter(text[j])) j++;
      if (j > d0 && j < n && text[j] === ";") {
        const mapped = NAMED_ENTITIES[text.slice(d0, j).toLowerCase()];
        if (mapped !== undefined) {
          decoded = mapped;
          j++;
        }
      }
    }
    if (decoded !== undefined) {
      out += decoded;
      i = j;
    } else {
      out += "&";
      i++;
    }
  }
  return out;
}

function fenceDiagnostic(
  code: DiagnosticCode,
  message: string,
  extra?: Partial<Diagnostic>,
): Diagnostic {
  return { code, severity: "error", sourcePath: "", message, ...extra };
}

function isUrlAttribute(name: string): boolean {
  for (const attr of URL_ATTRIBUTES) {
    if (attr === name) return true;
  }
  return false;
}

/**
 * Run the fence over a rendered document. Returns every violation (empty =
 * clean); `finalizeDocument` wraps a non-empty result in one BuildError.
 *
 * Checks (all O(n + m log m), m = tracked ranges):
 *  - fence.script-body / fence.style-body — non-whitespace body of a
 *    script/style element (whitespace-only bodies pass: `<script src=x>\n</script>`)
 *  - fence.comment-value — a tracked value range inside a `<!-- ... -->`
 *    region (nothing is escapable inside a comment; `-->` injection)
 *  - fence.dynamic-tag-name / fence.dynamic-attr-name — a tag-open or
 *    attribute-name position covered by a tracked value range
 *  - fence.event-handler — any attribute matching /^on/i (the RENDERED name;
 *    a dynamic `onclick` value renders the literal text and is caught here
 *    as well as by fence.dynamic-attr-name)
 *  - fence.ping-attr / fence.srcdoc-attr — the attributes are banned outright
 *  - fence.unquoted-attribute — a present value without quotes
 *  - fence.unterminated — an opening quote never closed (the rest of the
 *    document is consumed by that value; the document is rejected)
 *  - fence.url-attribute — a URL-bearing attribute whose value region
 *    intersects a tracked range: the ENTIRE decoded value is re-run through
 *    validateUrl (a mixed literal+value attribute must resolve safely as a
 *    whole). Literal (untracked) values are trusted author markup and are
 *    NOT url-checked — documented policy, see the fence tests.
 */
export function runFence(
  markup: string,
  ranges: readonly Range[],
  opts: UrlPolicyOptions,
): Diagnostic[] {
  const scan = scanDocument(markup);
  const diags: Diagnostic[] = [];

  for (const body of scan.rawBodies) {
    let hasNonWs = false;
    for (let m = body.start; m < body.end; m++) {
      if (!isWs(markup[m])) {
        hasNonWs = true;
        break;
      }
    }
    if (hasNonWs) {
      diags.push(
        fenceDiagnostic(
          body.kind === "script" ? "fence.script-body" : "fence.style-body",
          `<${body.kind}> at offset ${body.start} has an inline body; v1 ships all JS/CSS as hashed assets — use script()/stylesheet()`,
        ),
      );
    }
  }

  // Comment/value overlap in ONE merge pass: ranges are sorted+disjoint
  // (html.ts invariant) and comments are recorded in start order and disjoint
  // (the scan is sequential), so a moving cursor is linear. The naive
  // range×comment double loop is quadratic — a build-time DoS surface.
  let ci = 0;
  for (const range of ranges) {
    while (ci < scan.comments.length && scan.comments[ci].end <= range[0]) ci++;
    if (ci < scan.comments.length && scan.comments[ci].start < range[1]) {
      diags.push(
        fenceDiagnostic(
          "fence.comment-value",
          `a template value at offset ${range[0]} lands inside a <!-- ... --> comment; nothing is escapable inside a comment (a value can close it with '-->')`,
        ),
      );
    }
  }

  for (const tag of scan.tags) {
    if (rangesOverlap(ranges, tag.nameStart, tag.nameEnd)) {
      diags.push(
        fenceDiagnostic(
          "fence.dynamic-tag-name",
          `the tag name at offset ${tag.nameStart} contains a template value; tag names must be static`,
        ),
      );
    }
    for (const attr of tag.attributes) {
      const name = attr.name.toLowerCase();
      if (rangesOverlap(ranges, attr.nameStart, attr.nameEnd)) {
        diags.push(
          fenceDiagnostic(
            "fence.dynamic-attr-name",
            `the attribute name at offset ${attr.nameStart} (in <${tag.name}>) contains a template value; attribute names must be static`,
          ),
        );
      }
      if (name.startsWith("on")) {
        diags.push(
          fenceDiagnostic(
            "fence.event-handler",
            `attribute "${attr.name}" on <${tag.name}> is an event handler; inline handlers are banned (v1 CSP is script-src 'self')`,
          ),
        );
      }
      if (name === "ping") {
        diags.push(
          fenceDiagnostic(
            "fence.ping-attr",
            `attribute "ping" on <${tag.name}> is banned (it fires requests at click time)`,
          ),
        );
      }
      if (name === "srcdoc") {
        diags.push(
          fenceDiagnostic(
            "fence.srcdoc-attr",
            `attribute "srcdoc" on <${tag.name}> is banned (an iframe document is a second, unfenced HTML universe)`,
          ),
        );
      }
      if (attr.unquoted && attr.value !== undefined) {
        diags.push(
          fenceDiagnostic(
            "fence.unquoted-attribute",
            `attribute "${attr.name}" on <${tag.name}> has an unquoted value; attribute values must be enclosed in "..." or '...'`,
          ),
        );
      }
      if (attr.unterminated) {
        diags.push(
          fenceDiagnostic(
            "fence.unterminated",
            `attribute "${attr.name}" on <${tag.name}> opens a quoted value that is never closed; the rest of the document was consumed by it`,
          ),
        );
      }
      if (
        attr.value !== undefined &&
        attr.valueStart !== undefined &&
        attr.valueEnd !== undefined &&
        isUrlAttribute(name) &&
        rangesOverlap(ranges, attr.valueStart, attr.valueEnd)
      ) {
        const decoded = decodeEntities(attr.value);
        try {
          validateUrl(decoded, opts);
        } catch (d) {
          if (isDiagnostic(d)) {
            diags.push(
              fenceDiagnostic(
                "fence.url-attribute",
                `attribute "${attr.name}" on <${tag.name}> carries a template value that fails the URL policy (${d.code}): ${d.message}`,
              ),
            );
          } else {
            throw d;
          }
        }
      }
    }
  }

  return diags;
}
