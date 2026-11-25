// The markdown pipeline (plan §2 content contract, §4 steps 1-2).
//
// v1 feature list — EXACT (everything else renders as plain text):
//   ATX headings (# .. ######) with generated id slugs, paragraphs, bullet
//   and ordered lists, GFM task-list items (`- [ ]` / `- [x]`, hand-rolled —
//   see taskItems), fenced code blocks (``` and ~~~, `language-` class) and
//   indented code blocks, inline code, links, autolinks, images,
//   emphasis/strong, GFM strikethrough (~~x~~), GFM tables, blockquotes,
//   thematic breaks.
// NOT enabled: raw HTML (html:false — escaped to inert text), linkify,
// typographer/smartquotes, syntax highlighting, footnotes, definition lists.
//
// Trust story (plan §1: "markdown produces trusted Html"): every text node
// markdown-it emits is escaped by the renderer itself — html:false means raw
// HTML in the source renders as visible inert text, and code spans / fences
// escape their content too. So the whole rendered body goes to
// `trustedHtml(markup)` with NO value ranges: there is no unescaped
// author-controlled value inside it for the fence to police.
//
// The one author-controlled ATTRIBUTE surface is link/image destinations —
// in EVERY kind: inline `[x](…)` and `[x][ref]` links, autolinks
// (markdown-it 14's AUTOLINK_RE admits ANY `scheme:` inside `<…>`,
// including `javascript:`), images, and links/images nested inside an
// image's LABEL (the label is re-parsed as its own inline). markdown-it's
// own safety net turns a `javascript:` link into literal text — safe but
// SILENT, and crust rule 1 forbids silent handling — so `md.validateLink`
// is overridden to admit every destination to the token stream, and OUR
// policy (url.ts `validateUrl`) runs over every href/src in the collect
// pass: a destination that fails becomes a `link.invalid` diagnostic AND
// loses its attribute, so the emitted markup is inert even if a caller
// continues past the error.
//
// Line coordinates: block tokens carry `map` ([start, end) lines, 0-based
// and BODY-relative); the inline token carrying a link carries its own map.
// File line = bodyStartLine + map[0] (frontmatter's full-file offset). A
// destination inside a token with no map at all gets `line: undefined` —
// best-effort by design, never a guessed coordinate.

import { posix } from "node:path";
import type { Options as MdOptions, Renderer, StateCore, Token } from "markdown-it";
import MarkdownIt from "markdown-it";
import { type Diagnostic, isDiagnostic } from "./diagnostics";
import { type Html, trustedHtml } from "./html";
import { normalizeRoute } from "./routes";
import type { Heading, InternalLink, RouteResolver } from "./types";
import { validateUrl } from "./url";

export interface MarkdownOptions {
  /** posix path used in diagnostics. */
  sourcePath: string;
  /** frontmatter's bodyStartLine: body line 0 is this file line. */
  bodyStartLine: number;
  /**
   * The site's base URL, path prefix INCLUDED (e.g. `https://x.dev/docs`).
   * The URL policy's base for relative refs is this plus `pageRoute`, which is
   * exactly the page's canonical URL — never `new URL(site).origin`, which
   * would drop the prefix (see url.ts).
   */
  siteUrl: string;
  /** The page's normalized route; base for relative .md resolution. */
  pageRoute?: string;
  /** Route-table lookup for internal .md links (chunk 6 wires the real one). */
  resolveInternal?: RouteResolver;
}

export interface MarkdownResult {
  /** The rendered body as trusted markup (see the trust story above). */
  html: Html;
  headings: Heading[];
  /** Internal links for chunk 7's link validation. */
  links: InternalLink[];
  diagnostics: Diagnostic[];
  /** Plain text of the first top-level paragraph ("" when there is none). */
  firstParagraph: string;
}

/**
 * GitHub-style slug: lowercase → NFKD with combining marks stripped
 * ("Ünïcödé" → "unicode") → whitespace runs to `-` → keep only unicode
 * letters, digits, `-` and `_` → collapse repeated `-` → trim `-`.
 * An empty result (emoji-only heading) becomes "" and the caller's
 * collision step substitutes the fallback id "section".
 */
export function slugify(text: string): string {
  const stripped = text.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const dashed = stripped.replace(/\s+/g, "-");
  // The per-char class keeps unicode letters/digits (and the -/_ that
  // GitHub's slugger also keeps); everything else — punctuation, emoji — dies.
  const kept = [...dashed]
    .filter((ch) => /[\p{L}\p{N}_-]/u.test(ch))
    .join("")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return kept;
}

/**
 * Final id for one heading: `slugify` output, "section" when empty, and on
 * collision `-1`/`-2`/… in document order (applied AFTER the slug, and
 * incremented past ids that are already taken — "Foo", "foo-1", "Foo" gives
 * foo, foo-1, foo-2).
 */
function uniqueId(used: Set<string>, text: string): string {
  const base = slugify(text) === "" ? "section" : slugify(text);
  let candidate = base;
  let n = 0;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

/** Plain text of inline tokens: markdown syntax stripped, entities decoded
 * (markdown-it's entity rule already decoded them into the text tokens). */
function plainText(children: readonly Token[] | null): string {
  if (!children) return "";
  let out = "";
  for (const t of children) {
    // text_special is markdown-it 14's decoded entity/escape token — its
    // content is the decoded character and belongs in the plain text.
    if (
      t.type === "text" ||
      t.type === "text_special" ||
      t.type === "code_inline" ||
      t.type === "html_inline"
    ) {
      out += t.content;
    } else if (t.type === "softbreak" || t.type === "hardbreak") {
      out += " ";
    } else {
      out += plainText(t.children);
    }
  }
  return out;
}

interface RenderState {
  headings: Heading[];
  links: InternalLink[];
  diagnostics: Diagnostic[];
  used: Set<string>;
  firstParagraph: string | null;
}

/**
 * GFM task-list items, hand-rolled (markdown-it core has none): a bullet
 * item whose FIRST paragraph starts `[ ] ` / `[x] ` becomes a disabled
 * checkbox input wrapped in a `<label>` — GitHub's own shape. It runs after
 * inline parsing (at that point the marker is plain text — a bare `[x]` is
 * not a link), cutting the marker from the first text token and inserting a
 * custom token the renderer turns into the input. Tight-list paragraphs are
 * hidden; the label/checkbox still render because the paragraph rules emit
 * them even when the `<p>` itself is suppressed.
 */
function taskItems(md: MarkdownIt): void {
  md.core.ruler.after("inline", "crust-task-item", (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 1; i + 2 < toks.length; i++) {
      if (toks[i].type !== "paragraph_open" || toks[i - 1].type !== "list_item_open") continue;
      const inline = toks[i + 1];
      if (inline.type !== "inline" || !inline.children) continue;
      const first = inline.children[0];
      if (first?.type !== "text") continue;
      const m = /^\[([ xX])\][ \t]+/.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("crust_task_box", "", 0);
      box.meta = { checked: m[1] !== " " };
      inline.children.unshift(box);
      toks[i].meta = { crustTask: true };
      toks[i].attrSet("class", "task-list-item");
      toks[i + 2].meta = { crustTask: true };
    }
  });
  md.renderer.rules.crust_task_box = (tokens: Token[], idx: number) =>
    tokens[idx].meta.checked
      ? '<input checked="" disabled="" type="checkbox" />'
      : '<input disabled="" type="checkbox" />';
  const open = (
    tokens: Token[],
    idx: number,
    options: MdOptions,
    _env: unknown,
    self: Renderer,
  ) => {
    const base = self.renderToken(tokens, idx, options);
    return tokens[idx].meta?.crustTask ? `${base}<label>` : base;
  };
  const close = (
    tokens: Token[],
    idx: number,
    options: MdOptions,
    _env: unknown,
    self: Renderer,
  ) => {
    const base = self.renderToken(tokens, idx, options);
    return tokens[idx].meta?.crustTask ? `</label>${base}` : base;
  };
  md.renderer.rules.paragraph_open = open;
  md.renderer.rules.paragraph_close = close;
}

function buildRenderer(opts: MarkdownOptions, state: RenderState): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    langPrefix: "language-",
  });
  // See the trust story in the header: OUR policy, not markdown-it's silent
  // text fallback. Every destination reaches the token stream and is judged
  // in the collect pass below.
  md.validateLink = () => true;
  taskItems(md);

  /** Judge one link/image destination; mutates the token, records results. */
  const applyDestination = (
    kind: "link" | "image",
    token: Token,
    attr: string,
    line: number | undefined,
  ): void => {
    const raw = token.attrGet(attr) ?? "";
    const hash = raw.indexOf("#");
    const path = hash === -1 ? raw : raw.slice(0, hash);
    const fragment = hash === -1 ? null : raw.slice(hash + 1);
    const reject = (why: string): void => {
      const idx = token.attrIndex(attr);
      if (idx >= 0 && token.attrs) token.attrs.splice(idx, 1);
      state.diagnostics.push({
        code: "link.invalid",
        severity: "error",
        sourcePath: opts.sourcePath,
        line,
        message: `${kind} destination ${JSON.stringify(raw)} rejected: ${why}`,
      });
    };
    const checkUrl = (): void => {
      try {
        validateUrl(raw, { siteUrl: opts.siteUrl, pageRoute: opts.pageRoute });
      } catch (d) {
        if (!isDiagnostic(d)) throw d;
        reject(d.message);
      }
    };
    if (path === "") {
      // Pure fragment: same page, safe by construction (validateUrl agrees).
      // Recorded for chunk 7's fragment check.
      if (kind === "link" && fragment !== null && fragment !== "") {
        state.links.push({
          route: opts.pageRoute ?? "/",
          fragment,
          line: line ?? null,
          exists: true,
          isDraft: false,
          kind: "fragment",
        });
      }
      return;
    }
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
    const rootRelative = path.startsWith("/");
    if (!absolute && !rootRelative && /\.md$/i.test(path)) {
      // Internal .md link: resolved against the page's ROUTE (plan §2),
      // extension stripped — the candidate is a route-shaped path.
      const base = posix.dirname(opts.pageRoute ?? "/");
      const candidateRaw = posix.resolve(base, path).replace(/\.md$/i, "");
      let candidate: string;
      try {
        candidate = normalizeRoute(candidateRaw, { sourcePath: opts.sourcePath });
      } catch (d) {
        if (!isDiagnostic(d)) throw d;
        reject(
          `internal link target ${JSON.stringify(candidateRaw)} is not a valid route: ${d.message}`,
        );
        return;
      }
      const resolved = opts.resolveInternal ? opts.resolveInternal(candidate) : null;
      if (resolved === "external") {
        checkUrl();
        return;
      }
      if (resolved !== null) {
        token.attrSet(attr, fragment === null ? resolved.route : `${resolved.route}#${fragment}`);
        state.links.push({
          route: resolved.route,
          fragment,
          line: line ?? null,
          exists: resolved.exists,
          isDraft: resolved.isDraft,
          kind: "page",
        });
      } else {
        // Not in the route table: recorded with exists:false (chunk 7 turns
        // that into link.broken); the destination stays as written.
        state.links.push({
          route: candidate,
          fragment,
          line: line ?? null,
          exists: false,
          isDraft: false,
          kind: "page",
        });
      }
      return;
    }
    checkUrl();
  };

  /**
   * Judge every destination in one inline token's children — RECURSIVELY
   * through image labels. markdown-it re-parses an image's label as its own
   * inline (the image token's `children`), so a link — or another image,
   * recursively — inside `![...](...)` reaches the token stream. The
   * contract is that EVERY destination reaching the token stream is judged:
   * silently skipping a nested one would let a `javascript:` destination hide
   * in an alt attribute (crust rule 1 — no silent handling).
   */
  const walkInline = (children: readonly Token[], line: number | undefined): void => {
    for (const child of children) {
      if (child.type === "link_open") {
        applyDestination("link", child, "href", line);
      } else if (child.type === "image") {
        applyDestination("image", child, "src", line);
        if (child.children) walkInline(child.children, line);
      }
    }
  };

  md.core.ruler.after("inline", "crust-collect", (core: StateCore) => {
    const toks = core.tokens;
    // A paragraph is the page's first BLOCK-LEVEL paragraph only when it is
    // a direct child of the document. Inside a blockquote, list, or list
    // item its <p> belongs to the container (a loose list item even emits a
    // VISIBLE <p> — the old hidden-flag test let those through, as did every
    // quoted paragraph), not to the page. Containers nest arbitrarily
    // (a list inside a blockquote), hence a stack, not a counter.
    const stack: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (
        t.type === "blockquote_open" ||
        t.type === "list_open" ||
        t.type === "bullet_list_open" ||
        t.type === "ordered_list_open" ||
        t.type === "list_item_open"
      ) {
        stack.push(t.type);
      } else if (
        t.type === "blockquote_close" ||
        t.type === "list_close" ||
        // markdown-it 14 emits the kind-specific close (no bare list_close
        // in output), so both must pop or a paragraph after a list is
        // forever "nested" to the stack.
        t.type === "bullet_list_close" ||
        t.type === "ordered_list_close" ||
        t.type === "list_item_close"
      ) {
        stack.pop();
      } else if (t.type === "heading_open") {
        const inline = toks[i + 1];
        const text = inline && inline.type === "inline" ? plainText(inline.children) : "";
        const id = uniqueId(state.used, text);
        t.attrSet("id", id);
        state.headings.push({ level: Number(t.tag.slice(1)), id, text });
      } else if (
        t.type === "paragraph_open" &&
        !t.hidden &&
        stack.length === 0 &&
        state.firstParagraph === null
      ) {
        const inline = toks[i + 1];
        if (inline && inline.type === "inline") state.firstParagraph = plainText(inline.children);
      } else if (t.type === "inline" && t.children) {
        const line = t.map ? opts.bodyStartLine + t.map[0] : undefined;
        walkInline(t.children, line);
      }
    }
  });
  return md;
}

/**
 * Render one page body. The result's `html` is trusted markup (see the
 * header); `diagnostics` carries link.invalid / markdown.parse-error errors
 * in FULL-FILE line coordinates. A markdown-it internal throw never escapes:
 * it becomes a markdown.parse-error diagnostic (at bodyStartLine — the
 * renderer gives no finer coordinate) and an empty body.
 */
export function renderMarkdown(body: string, opts: MarkdownOptions): MarkdownResult {
  const state: RenderState = {
    headings: [],
    links: [],
    diagnostics: [],
    used: new Set(),
    firstParagraph: null,
  };
  let markup = "";
  try {
    markup = buildRenderer(opts, state).render(body, {});
  } catch (e) {
    if (isDiagnostic(e)) {
      state.diagnostics.push({
        ...e,
        sourcePath: e.sourcePath === "" ? opts.sourcePath : e.sourcePath,
        line: e.line ?? opts.bodyStartLine,
      });
    } else {
      state.diagnostics.push({
        code: "markdown.parse-error",
        severity: "error",
        sourcePath: opts.sourcePath,
        line: opts.bodyStartLine,
        message: `markdown rendering failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return {
    html: trustedHtml(markup),
    headings: state.headings,
    links: state.links,
    diagnostics: state.diagnostics,
    firstParagraph: state.firstParagraph ?? "",
  };
}
