#!/usr/bin/env bun
import { extname } from "node:path";
import { runFixtures } from "./runner";
import { renderJson, renderMarkdown, renderText } from "./report";

const USAGE = `test-fixture --target <file|glob> [--out <path>] [--threads N]

Run .crust.ts fixture files. Each file exports a Fixture (or array) with
{ input, output } objects. Fields whose value is a 0-arg function are
resolved at run time; functions in 'output' with one or more arguments
are matcher predicates over the actual value.
`;

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let out: string | undefined;
  let threads = 1;

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
      const n = parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(n)) {
        process.stderr.write(`test-fixture: --threads requires an integer\n`);
        return 2;
      }
      threads = n;
    } else if (a.startsWith("--threads=")) {
      const n = parseInt(a.slice("--threads=".length), 10);
      if (!Number.isFinite(n)) {
        process.stderr.write(`test-fixture: --threads requires an integer\n`);
        return 2;
      }
      threads = n;
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

  let report;
  try {
    report = await runFixtures({ target, threads });
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
  process.exit(await runCli(process.argv.slice(2)));
}
