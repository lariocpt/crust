// Page parsing: file → frontmatter → markdown → Page (plan §2 content
// contract). This is the ONLY place the frontmatter rules that are not
// frontmatter-syntax (chunk 2) get applied: the derived description, the
// parseData hook, the draft flag. Route/canonicalUrl are filled later
// (buildRouteTable / chunk 6) — a Page from here carries only what the file
// itself said.

import type { Diagnostic } from "./diagnostics";
import { parseFrontmatter } from "./frontmatter";
import { renderMarkdown } from "./markdown";
import type { FrontmatterResult, Page, ResolvedSite, RouteResolver } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The description derivation (plan §2): first paragraph plain text,
 * whitespace collapsed, truncated at 160 chars on a word boundary (the cut
 * is the last space at or before 160; a single over-long word keeps the raw
 * 160-char cut — a description is metadata, not a place to be clever).
 */
export function deriveDescription(firstParagraph: string): string {
  const collapsed = firstParagraph.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 160) return collapsed;
  const cut = collapsed.slice(0, 160);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).trimEnd();
}

export interface ParsePageInput {
  /** The .md file on disk. */
  absolutePath: string;
  /** posix, relative to content.directory, extension stripped (plan §2). */
  relativePath: string;
  /** posix path used in diagnostics. */
  sourcePath: string;
  resolvedSite: ResolvedSite;
  /**
   * The page's route, when the caller already knows it (chunk 6 computes
   * routes before rendering so relative .md links resolve against it).
   * Without it, relative .md links cannot be route-resolved and are
   * recorded exists:false — honest, never a silent pass.
   */
  pageRoute?: string;
  /** Route-table lookup handed to the markdown renderer (chunk 6 wires it). */
  routeResolver?: RouteResolver;
  /**
   * Already-parsed frontmatter (chunk 8's pre-pass reads the file and parses
   * the frontmatter ONCE, then hands it over so parsePage skips its own
   * read+parse — a frontmatter problem is diagnosed exactly once, and the
   * file is read exactly once). Without it, parsePage reads and parses as
   * before.
   */
  frontmatter?: FrontmatterResult;
}

/**
 * Parse one .md file into a Page. Frontmatter problems propagate as the
 * BuildError chunk 2 already raises (sorted, full-file coordinates);
 * render-level problems (link.invalid, data-invalid) come back on the Page
 * so a build can collect them across pages instead of dying on the first.
 */
export async function parsePage(input: ParsePageInput): Promise<Page> {
  const { absolutePath, relativePath, sourcePath, resolvedSite } = input;
  // Bun.file().text() hands back the raw bytes decoded; parseFrontmatter
  // normalizes CRLF/CR and strips a BOM, and the body it returns is already
  // LF-only — the markdown renderer never sees a CRLF. A caller that already
  // parsed the frontmatter (chunk 8's pre-pass) passes the result, and the
  // file is not re-read: the frontmatter — and its diagnostics — are
  // produced exactly once.
  const parsed =
    input.frontmatter ?? parseFrontmatter(await Bun.file(absolutePath).text(), sourcePath);
  // The URL policy's base is the FULL site URL — path prefix included — and
  // markdown.ts combines it with `pageRoute`, so the base for a relative ref
  // is exactly the page's canonical URL (url.ts: urlBase === canonicalUrl).
  // Handing over `new URL(site).origin` here is the bug this line pins: for a
  // prefixed site (https://x.dev/docs) an origin base silently drops the
  // prefix from every relative-ref resolution.
  const md = renderMarkdown(parsed.body, {
    sourcePath,
    bodyStartLine: parsed.bodyStartLine,
    siteUrl: resolvedSite.site,
    pageRoute: input.pageRoute,
    resolveInternal: input.routeResolver,
  });

  const diagnostics: Diagnostic[] = [...md.diagnostics];
  let description = parsed.frontmatter.description;
  const warnings: Diagnostic[] = [];
  if (description === undefined) {
    if (md.firstParagraph === "") {
      // Nothing to derive from (empty body, or a first paragraph with no
      // text). The description stays "" and the page is still legal — but
      // the warning must NOT claim a derivation happened (crust rule 1:
      // the code must be true).
      description = "";
      warnings.push({
        code: "frontmatter.missing-description",
        severity: "warning",
        sourcePath,
        line: 1,
        message:
          "no description in frontmatter and no text to derive one from (the body has no first paragraph, or it has no text); the description stays empty",
      });
    } else {
      description = deriveDescription(md.firstParagraph);
      warnings.push({
        code: "frontmatter.derived-description",
        severity: "warning",
        sourcePath,
        line: 1,
        message: `no description in frontmatter; derived from the first paragraph: ${JSON.stringify(description)}`,
      });
    }
  }

  // data: ONLY through content.parseData (plan §2 — raw frontmatter data is
  // never passed through unvalidated). No parseData → data stays {} even
  // when the frontmatter carried data.
  let data: Record<string, unknown> = {};
  const parseData = resolvedSite.content.parseData;
  if (parseData) {
    try {
      let result: unknown = parseData(parsed.frontmatter.data ?? {}, { sourcePath });
      // The contract says parseData returns `unknown` — an ASYNC hook returns
      // a Promise, which must be awaited (pinned): a rejected Promise is a
      // frontmatter.data-invalid like any other failure, never a raw
      // unhandled rejection and never a silent pass.
      if (result !== null && typeof result === "object") {
        const then = (result as { then?: unknown }).then;
        if (typeof then === "function") result = await result;
      }
      if (!isPlainObject(result)) {
        throw new Error(
          `parseData must return a plain object, returned ${result === null ? "null" : typeof result}`,
        );
      }
      data = result;
    } catch (e) {
      diagnostics.push({
        code: "frontmatter.data-invalid",
        severity: "error",
        sourcePath,
        line: parsed.dataLine,
        message: `content.parseData failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      data = {};
    }
  }

  return {
    sourcePath,
    relativePath,
    ...(parsed.frontmatter.route !== undefined ? { route: parsed.frontmatter.route } : {}),
    ...(parsed.frontmatter.layout !== undefined ? { layout: parsed.frontmatter.layout } : {}),
    title: parsed.frontmatter.title,
    description,
    headings: md.headings,
    data,
    draft: parsed.frontmatter.draft === true,
    body: md.html,
    links: md.links,
    warnings,
    diagnostics: [...diagnostics, ...warnings],
  };
}
