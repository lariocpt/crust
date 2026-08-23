#!/usr/bin/env bun
import { extname } from "node:path";
import { FlagError, type FlagSpec, parseFlags } from "../args";
import { renderJson, renderJUnitXml, renderMarkdown, renderText } from "./report";
import { runFixtures } from "./runner";

const USAGE = `test-fixture <file|glob> [-o <path>] [-j N] [-n N] [-t <ms>] [-b]

Run .crust.ts fixture files. Each file exports a Fixture (or array) with
{ input, output } objects. Fields whose value is a 0-arg function are
resolved at run time; functions in 'output' with one or more arguments
are matcher predicates over the actual value.

  -n, --count N     run each fixture N times (stress mode). Combine with
                    --threads to drive concurrency. Reports p50/p95/p99
                    latency, mean/min/max, and status-code distribution
                    when N > 1. Use the 'random' helper inside fixtures
                    (import { random } from "crust/testFixture/random")
                    to vary inputs across iterations.
  -j, --threads N   concurrency
  -o, --out <path>  report file; .json/.md/.xml (JUnit) pick the format
  -t, --timeout <ms> fail any fixture whose request runs longer (a fixture's
                    own input.signal wins over this).
  -b, --bail        stop starting new fixtures after the first fail/error;
                    in-flight fixtures finish.

The target may also be given as --target <file|glob>.
`;

export const SPEC: FlagSpec = {
  target: { type: "string", positional: 0 },
  out: { short: "o", type: "string" },
  threads: { short: "j", type: "number" },
  count: { short: "n", type: "number" },
  timeout: { short: "t", type: "number" },
  bail: { short: "b", type: "boolean" },
};

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let out: string | undefined;
  let threads = 1;
  let count = 1;
  let timeoutMs: number | undefined;
  let bail = false;

  try {
    const { values, rest, help } = parseFlags(args, SPEC);
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);
    target = values.target as string | undefined;
    out = values.out as string | undefined;
    threads = (values.threads as number | undefined) ?? 1;
    count = (values.count as number | undefined) ?? 1;
    timeoutMs = values.timeout as number | undefined;
    bail = values.bail === true;
  } catch (err) {
    process.stderr.write(`test-fixture: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (!target) {
    process.stderr.write(`test-fixture: a target file or glob is required\n${USAGE}`);
    return 2;
  }

  let report: Awaited<ReturnType<typeof runFixtures>>;
  try {
    report = await runFixtures({ target, threads, count, timeoutMs, bail });
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
  else if (ext === ".xml") text = renderJUnitXml(report);
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
