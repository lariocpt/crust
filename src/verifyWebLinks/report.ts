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
