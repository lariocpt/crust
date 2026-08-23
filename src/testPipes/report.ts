import { relative } from "node:path";
import { type JUnitCase, type JUnitSuite, renderJUnit } from "../junitXml";
import type { PipesReport } from "./runner";

// Extracted verbatim from the old inline printing in cli.ts — the no-`--out`
// stdout must stay byte-identical (the existing cli tests pin it).
export function renderText(report: PipesReport, cwd: string): string {
  const out: string[] = [];
  for (const r of report.results) {
    const loc = `${relative(cwd, r.file)}:${r.lineNo}`;
    if (r.status === "pass") {
      out.push(`  PASS  ${loc}  ${r.line.slice(0, 100)}  (${r.durationMs.toFixed(1)}ms)`);
    } else {
      out.push(`  FAIL  ${loc}  ${r.line.slice(0, 100)}\n        ${r.error}`);
    }
  }
  const { pass, fail, files } = report.totals;
  out.push(`\n${files} file(s): ${pass} pass, ${fail} fail${report.bailed ? "  (bailed)" : ""}`);
  return `${out.join("\n")}\n`;
}

export function renderJson(report: PipesReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// Suite per .pipes file, testcase per line. Pipes lines only pass or fail —
// errors="0" always.
export function renderJUnitXml(report: PipesReport, cwd: string): string {
  const byFile = new Map<string, PipesReport["results"]>();
  for (const r of report.results) {
    const arr = byFile.get(r.file) ?? [];
    arr.push(r);
    byFile.set(r.file, arr);
  }
  const suites: JUnitSuite[] = [];
  for (const [file, results] of byFile) {
    const rel = relative(cwd, file);
    const cases: JUnitCase[] = results.map((r) => {
      const c: JUnitCase = {
        name: `line ${r.lineNo}: ${r.line.slice(0, 100)}`,
        classname: rel,
        timeMs: r.durationMs,
      };
      if (r.status === "fail") {
        c.failure = { message: r.error ?? "failed", body: r.error ?? "" };
      }
      return c;
    });
    suites.push({ name: rel, cases });
  }
  return renderJUnit(suites, "test-pipes");
}
