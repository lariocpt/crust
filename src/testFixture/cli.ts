#!/usr/bin/env bun
import { extname } from "node:path";
import { renderJson, renderMarkdown, renderText } from "./report";
import { runFixtures } from "./runner";

const USAGE = `test-fixture --target <file|glob> [--out <path>] [--threads N] [--count N]

Run .crust.ts fixture files. Each file exports a Fixture (or array) with
{ input, output } objects. Fields whose value is a 0-arg function are
resolved at run time; functions in 'output' with one or more arguments
are matcher predicates over the actual value.

  --count N      run each fixture N times (stress mode). Combine with
                 --threads to drive concurrency. Reports p50/p95/p99
                 latency, mean/min/max, and status-code distribution
                 when N > 1. Use the 'random' helper inside fixtures
                 (import { random } from "crust/testFixture/random")
                 to vary inputs across iterations.
`;

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let out: string | undefined;
  let threads = 1;
  let count = 1;

  function intFlag(value: string | undefined, name: string): number | null {
    const n = parseInt(value ?? "", 10);
    if (!Number.isFinite(n)) {
      process.stderr.write(`test-fixture: ${name} requires an integer\n`);
      return null;
    }
    return n;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (a === "--target") {
      target = args[++i];
    } else if (a.startsWith("--target=")) {
      target = a.slice("--target=".length);
    } else if (a === "--out") {
      out = args[++i];
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--threads") {
      const n = intFlag(args[++i], "--threads");
      if (n === null) return 2;
      threads = n;
    } else if (a.startsWith("--threads=")) {
      const n = intFlag(a.slice("--threads=".length), "--threads");
      if (n === null) return 2;
      threads = n;
    } else if (a === "--count") {
      const n = intFlag(args[++i], "--count");
      if (n === null) return 2;
      count = n;
    } else if (a.startsWith("--count=")) {
      const n = intFlag(a.slice("--count=".length), "--count");
      if (n === null) return 2;
      count = n;
    } else {
      process.stderr.write(`test-fixture: unknown arg '${a}'\n`);
      return 2;
    }
  }

  if (!target) {
    process.stderr.write("test-fixture: --target is required\n");
    process.stderr.write(USAGE);
    return 2;
  }

  let report: Awaited<ReturnType<typeof runFixtures>>;
  try {
    report = await runFixtures({ target, threads, count });
  } catch (err) {
    process.stderr.write(`test-fixture: ${(err as Error).message}\n`);
    return 2;
  }

  if (report.results.length === 0) {
    process.stderr.write(`test-fixture: no files matched ${target}\n`);
    return 2;
  }

  const ext = out ? extname(out) : "";
  let text: string;
  if (ext === ".json") text = renderJson(report);
  else if (ext === ".md") text = renderMarkdown(report);
  else text = renderText(report, !out && process.stdout.isTTY === true);

  if (out) {
    await Bun.write(out, text);
  } else {
    process.stdout.write(text);
  }

  return report.totals.fail + report.totals.error > 0 ? 1 : 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
