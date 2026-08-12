import { basename, dirname, relative } from "node:path";
import type { FixtureFailure, RunReport } from "./types";

export function renderText(report: RunReport, useColor: boolean): string {
  const c = useColor ? ansi : noColor;
  const groups = new Map<string, typeof report.results>();
  for (const r of report.results) {
    const dir = dirname(r.file);
    const arr = groups.get(dir) ?? [];
    arr.push(r);
    groups.set(dir, arr);
  }
  const out: string[] = [];
  const cwd = process.cwd();
  for (const [dir, results] of groups) {
    const rel = relative(cwd, dir) || ".";
    out.push(`${rel}/`);
    for (const r of results) {
      const tag =
        r.status === "pass"
          ? c.green("PASS")
          : r.status === "fail"
            ? c.red("FAIL")
            : c.yellow("ERR ");
      const ms = `(${r.durationMs.toFixed(1)}ms)`;
      out.push(`  ${tag}  ${basename(r.file)}  ${r.name}  ${c.dim(ms)}`);
      if (r.status === "fail") {
        for (const f of r.failures) {
          out.push(`    ${c.red(f.path)}: expected ${fmt(f.expected)}, got ${fmt(f.actual)}`);
        }
      } else if (r.status === "error") {
        out.push(`    ${c.red("error")}: ${r.error?.message ?? "(unknown)"}`);
      }
    }
    out.push("");
  }
  const t = report.totals;
  const fileCount = new Set(report.results.map((r) => r.file)).size;
  out.push(
    `${fileCount} file(s), ${report.results.length} run(s): ` +
      `${c.green(t.pass + " pass")}, ${c.red(t.fail + " fail")}, ${c.yellow(t.error + " error")}` +
      `  (${t.ms.toFixed(1)}ms)`,
  );
  if (report.stress && report.stress.length > 0) {
    out.push("");
    out.push("stress (latency ms, status distribution):");
    for (const b of report.stress) {
      const dist = Object.entries(b.statusCodes)
        .sort((a, z) => Number(a[0]) - Number(z[0]))
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      out.push(
        `  ${b.fixture}  n=${b.count}  p50=${b.p50.toFixed(1)}  p95=${b.p95.toFixed(1)}  p99=${b.p99.toFixed(1)}  mean=${b.meanMs.toFixed(1)}  min=${b.minMs.toFixed(1)}  max=${b.maxMs.toFixed(1)}  [${dist}]`,
      );
    }
  }
  return out.join("\n") + "\n";
}

export function renderJson(report: RunReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function renderMarkdown(report: RunReport): string {
  const out: string[] = [];
  out.push("# Fixture report");
  out.push("");
  const t = report.totals;
  out.push(`**${t.pass} pass · ${t.fail} fail · ${t.error} error** in ${t.ms.toFixed(1)}ms\n`);
  out.push("| file | name | status | ms |");
  out.push("|---|---|---|---|");
  const cwd = process.cwd();
  for (const r of report.results) {
    const rel = relative(cwd, r.file);
    out.push(`| ${rel} | ${r.name} | ${r.status} | ${r.durationMs.toFixed(1)} |`);
  }
  const failures = report.results.filter((r) => r.status === "fail" || r.status === "error");
  if (failures.length > 0) {
    out.push("");
    out.push("## Failures");
    for (const r of failures) {
      out.push("");
      out.push(`### ${relative(cwd, r.file)} — ${r.name}`);
      if (r.status === "error") {
        out.push(`- error: \`${r.error?.message ?? ""}\``);
      } else {
        for (const f of r.failures) {
          out.push(`- \`${f.path}\`: expected \`${fmt(f.expected)}\`, got \`${fmt(f.actual)}\``);
        }
      }
    }
  }
  return out.join("\n") + "\n";
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const ansi = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
const noColor = {
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  dim: (s: string) => s,
};
