import type { CrawlResult, Failure, VerifyReport, VerifyTotals } from "./types";

/**
 * Everything this run discovered but did not verify, phrased for a human. The
 * same facts make `totals.complete` false, and `--strict` turns them into exit
 * 1: a run that did not finish must not read as "all clear" in either channel.
 */
export function incompleteReasons(t: VerifyTotals): string[] {
  const reasons: string[] = [];
  if (t.dropped > 0)
    reasons.push(`--max-pages reached — ${t.dropped} discovered URL(s) NOT checked`);
  if (t.anchorsSkipped > 0) {
    reasons.push(
      `${t.anchorsSkipped} #fragment link(s) NOT checked — crust never read the destination's HTML ` +
        `(--no-recurse / --exclude / --max-depth, or an off-origin link without --include-external)`,
    );
  }
  if (t.unparsedPages > 0) {
    reasons.push(
      `${t.unparsedPages} page(s) NOT read as HTML (the content-type said otherwise and the body ` +
        `agreed with the content-type) — links they contain were never followed`,
    );
  }
  return reasons;
}

/**
 * The minimal fix-list: one line per (page, element, broken-thing) triple,
 * nothing else — the reason stays in the full report above it. Link findings
 * contribute one row per source (element = the LinkKind that linked it,
 * broken = the failing URL); meta findings contribute `meta:<key>` rows with
 * the value diff. `--json` carries the structured `sources`/`meta` fields
 * instead — the data IS the fix-list there.
 */
export function fixListRows(failures: Failure[]): [string, string, string][] {
  const rows: [string, string, string][] = [];
  for (const f of failures) {
    if (f.kind === "meta-mismatch" && f.meta) {
      rows.push([
        f.url,
        `meta:${f.meta.key}`,
        `got ${JSON.stringify(f.meta.actual)} (expected ${JSON.stringify(f.meta.expected)})`,
      ]);
      continue;
    }
    if (f.kind === "meta-fixture-no-page") {
      rows.push([f.url, "meta:fixture", "not crawled"]);
      continue;
    }
    for (const s of f.sources ?? []) {
      rows.push([s.fromUrl, s.kind, f.url]);
    }
  }
  return rows.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2]));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function renderText(report: VerifyReport): string {
  const lines: string[] = [];
  const { pages, assets, failures, sniffedPages } = report.totals;
  lines.push(`verify-web-links: ${pages} page(s), ${assets} asset(s), ${failures} failure(s)`);
  for (const reason of incompleteReasons(report.totals)) {
    lines.push(`  note: ${reason}`);
  }
  if (sniffedPages > 0) {
    lines.push(
      `  note: ${sniffedPages} page(s) had to be recognised from their body or an xhtml content-type ` +
        `— the server serves HTML without saying text/html`,
    );
  }
  if (failures > 0) {
    lines.push("");
    const byKind = new Map<string, Failure[]>();
    for (const f of report.failures) {
      const arr = byKind.get(f.kind) ?? [];
      arr.push(f);
      byKind.set(f.kind, arr);
    }
    for (const [kind, arr] of byKind) {
      lines.push(`  [${kind}] ${arr.length}`);
      for (const f of arr) {
        lines.push(`    ${f.url}  — ${f.detail}`);
        // Where the failing thing was found — explicit lines, never buried in
        // the prose detail. `sitemap` means the URL came from a sitemap <loc>.
        for (const s of f.sources ?? []) {
          lines.push(`      from ${s.fromUrl} (${s.kind})`);
        }
      }
    }
    // The fix-list closes every failing run: aligned triples, one per
    // (page, element, broken-thing). A clean run never prints this section.
    const rows = fixListRows(report.failures);
    if (rows.length > 0) {
      const pageW = Math.max(4, ...rows.map((r) => r[0].length));
      const elemW = Math.max(7, ...rows.map((r) => r[1].length));
      lines.push("");
      lines.push("  fix list");
      lines.push(`  ${"page".padEnd(pageW)}  ${"element".padEnd(elemW)}  broken link / diff`);
      for (const [p, e, b] of rows) {
        lines.push(`  ${p.padEnd(pageW)}  ${e.padEnd(elemW)}  ${b}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function renderJson(report: VerifyReport): string {
  const results: Record<string, Omit<CrawlResult, "links"> & { linkCount: number }> = {};
  for (const [url, r] of report.results) {
    results[url] = {
      url: r.url,
      status: r.status,
      finalUrl: r.finalUrl,
      redirectChain: r.redirectChain,
      contentType: r.contentType,
      ids: r.ids,
      parsed: r.parsed,
      sniffedHtml: r.sniffedHtml,
      unparsedPage: r.unparsedPage,
      meta: r.meta,
      durationMs: r.durationMs,
      linkCount: r.links.length,
      ...(r.error ? { error: r.error } : {}),
    };
  }
  return JSON.stringify(
    {
      totals: report.totals,
      failures: report.failures,
      results,
    },
    null,
    2,
  );
}
