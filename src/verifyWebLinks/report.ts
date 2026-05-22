import type { CrawlResult, Failure, VerifyReport } from "./types";

export function renderText(report: VerifyReport): string {
  const lines: string[] = [];
  const { pages, assets, failures } = report.totals;
  lines.push(`verify-web-links: ${pages} page(s), ${assets} asset(s), ${failures} failure(s)`);
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
