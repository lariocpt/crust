// Content discovery + the route table (plan §2, §4.6). Discovery is
// deterministic by construction: lexicographic (code-unit) order, exclude
// wins over include, dotfiles excluded unless the include pattern starts
// with `.`, symlinks never followed, only .md files. The route table is the
// single place a page acquires its route: frontmatter `route` wins, else
// content.route(relativePath); every candidate goes through normalizeRoute
// (already-normalized-or-error, plan §2 — no auto-fixing), collisions run
// BOTH passes (exact + case-insensitive), and drafts are excluded from the
// production table while staying listed (with their routes) for the dev
// server and the link checker.

import { lstat } from "node:fs/promises";
import { posix } from "node:path";
import { compareStrings, type Diagnostic, isDiagnostic, sortDiagnostics } from "./diagnostics";
import { canonicalUrl, findRouteCollisions, normalizeRoute } from "./routes";
import type { Page, ResolvedSite } from "./types";

export interface DiscoveredFile {
  absolutePath: string;
  /** posix, relative to content.directory, extension stripped (plan §2). */
  relativePath: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Discover the .md sources under `content.directory`. Globs run with
 * `cwd = content.directory`; results are posix-relative. A symlink (to a
 * file OR a directory) is skipped via lstat — the plan's containment story
 * says symlinks never extend a boundary, and discovery is where that
 * boundary is enforced for inputs.
 */
export async function discoverContent(resolvedSite: ResolvedSite): Promise<DiscoveredFile[]> {
  const dir = resolvedSite.content.directory;
  const found = new Set<string>();
  for (const pattern of resolvedSite.content.include) {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({
      cwd: dir,
      onlyFiles: true,
      // dotfiles are excluded unless the pattern itself reaches for them
      dot: pattern.startsWith("."),
      followSymlinks: false,
    })) {
      found.add(toPosix(rel));
    }
  }
  const excludes = resolvedSite.content.exclude.map((p) => new Bun.Glob(p));
  const kept = [...found]
    .filter((rel) => !excludes.some((g) => g.match(rel)))
    .filter((rel) => rel.endsWith(".md"))
    .sort(compareStrings);

  const out: DiscoveredFile[] = [];
  for (const rel of kept) {
    const absolutePath = posix.resolve(dir, rel);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(absolutePath);
    } catch {
      continue; // vanished between scan and stat — not an error, it is simply not there
    }
    if (st.isSymbolicLink()) continue;
    out.push({ absolutePath, relativePath: rel.replace(/\.md$/, "") });
  }
  return out;
}

/** A page that has a final route, canonical URL, and resolved layout key. */
export interface RoutedPage extends Page {
  route: string;
  canonicalUrl: string;
  layout: string;
}

export interface RouteTable {
  /** Production pages (drafts excluded), in lexicographic route order. */
  pages: RoutedPage[];
  /** Draft pages WITH their routes — dev server + link checking only. */
  drafts: RoutedPage[];
  /** Page warnings + every route/layout/collision problem, sorted. */
  diagnostics: Diagnostic[];
  /** Production route → page. Drafts are NOT here (chunk 6/7 consult both). */
  routeIndex: Map<string, RoutedPage>;
}

/**
 * Turn parsed pages into the route table. A page whose route is missing,
 * malformed, or whose layout is unknown is reported and DROPPED from the
 * table (the build fails on the error — the table stays internally sound for
 * everything else that consumes it in the same run).
 *
 * Decisions pinned here:
 *  - `content.route` throwing is a route.invalid diagnostic naming the page,
 *    never a raw exception escaping the table. A route() returning a
 *    non-string (number, undefined, …) is the SAME code: normalizeRoute
 *    rejects it with the received type named.
 *  - Collisions run over production pages AND drafts: a draft at /foo and a
 *    page at /foo is ambiguous for link resolution in every mode, so it is
 *    an error in every mode (crust rule 1 — no false pass in dev either).
 *    A page that already failed validation is dropped BEFORE the collision
 *    pass — it can never go live, so it cannot squat a route (its own
 *    errors are still all surfaced).
 *  - Zero production pages is a `content.no-pages` WARNING (never an error,
 *    never silence): the build would emit no content pages, only the
 *    generated 404 page. The message names the draft count in the
 *    drafts-only case.
 */
export function buildRouteTable(pages: readonly Page[], resolvedSite: ResolvedSite): RouteTable {
  const diagnostics: Diagnostic[] = [];
  const routed: RoutedPage[] = [];
  const routeFn = resolvedSite.content.route;
  const layoutKeys = Object.keys(resolvedSite.layouts).sort(compareStrings);

  for (const page of pages) {
    diagnostics.push(...page.diagnostics);
    // a page that already failed validation is never routed
    if (page.diagnostics.some((d) => d.severity === "error")) continue;

    let candidate: unknown = page.route;
    if (candidate === undefined) {
      if (!routeFn) {
        diagnostics.push({
          code: "route.missing",
          severity: "error",
          sourcePath: page.sourcePath,
          message: `page ${page.sourcePath} has no route: no frontmatter "route" and content.route is not configured`,
        });
        continue;
      }
      try {
        candidate = routeFn({ relativePath: page.relativePath });
      } catch (e) {
        diagnostics.push({
          code: "route.invalid",
          severity: "error",
          sourcePath: page.sourcePath,
          message: `content.route threw for page ${page.sourcePath}: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
    }
    let route: string;
    try {
      route = normalizeRoute(candidate, { sourcePath: page.sourcePath });
    } catch (d) {
      if (!isDiagnostic(d)) throw d;
      diagnostics.push(d);
      continue;
    }

    const layout = page.layout ?? resolvedSite.content.defaultLayout;
    if (!Object.hasOwn(resolvedSite.layouts, layout)) {
      diagnostics.push({
        code: "layout.unknown",
        severity: "error",
        sourcePath: page.sourcePath,
        message: `layout "${layout}" for page ${page.sourcePath} is not a key of layouts (available: ${layoutKeys.join(", ")})`,
      });
      continue;
    }
    routed.push({ ...page, route, layout, canonicalUrl: canonicalUrl(resolvedSite.site, route) });
  }

  // Deterministic table order (plan §4.6): route first, sourcePath breaks ties.
  routed.sort(
    (a, b) => compareStrings(a.route, b.route) || compareStrings(a.sourcePath, b.sourcePath),
  );
  diagnostics.push(
    ...findRouteCollisions(routed.map((p) => ({ route: p.route, sourcePath: p.sourcePath }))),
  );

  const production = routed.filter((p) => !p.draft);
  const drafts = routed.filter((p) => p.draft);

  // A production build emits one file per PRODUCTION page; zero of those
  // means the site renders only the generated 404 page. That is SUSPICIOUS
  // (empty content dir, everything accidentally a draft) but LEGAL — pinned
  // as a warning, never an error, and never silence.
  if (production.length === 0) {
    diagnostics.push({
      code: "content.no-pages",
      severity: "warning",
      sourcePath: "",
      message:
        drafts.length === 0
          ? "the content directory produced zero pages; a production build would emit no content pages (only the generated 404 page)"
          : `no non-draft pages found (${drafts.length} draft page${drafts.length === 1 ? "" : "s"}); a production build would emit no content pages (only the generated 404 page)`,
    });
  }

  return {
    pages: production,
    drafts,
    diagnostics: sortDiagnostics(diagnostics),
    routeIndex: new Map(production.map((p) => [p.route, p])),
  };
}
