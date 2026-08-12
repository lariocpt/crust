import { relative } from "node:path";
import { runPipes } from "./runner";

const USAGE = `test-pipes --target <file|glob> [--bail] [--timeout <ms>] [--setup <module>]

Run .pipes files: one shorthand fixture pipeline per line.
  # comments and blank lines are skipped
  {"name":"Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | expect 201
  sql "SELECT count(*)::int AS c FROM buildings" | assert (r => r.c === 1)

Lines run sequentially per file (DB assertions may depend on earlier lines).
Before a file runs, its setup module is imported and its default export
awaited: --setup <module>, else a sibling <name>.setup.ts. Setup seeds
process.env — that's how lines get $TOKEN-style values.

  --bail           stop at the first failing line
  --timeout <ms>   fail any line that runs longer
`;

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let bail = false;
  let timeoutMs: number | undefined;
  let setup: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (a === "--target") target = args[++i];
    else if (a.startsWith("--target=")) target = a.slice(9);
    else if (a === "--bail") bail = true;
    else if (a === "--timeout") timeoutMs = parseInt(args[++i] ?? "", 10);
    else if (a.startsWith("--timeout=")) timeoutMs = parseInt(a.slice(10), 10);
    else if (a === "--setup") setup = args[++i];
    else if (a.startsWith("--setup=")) setup = a.slice(8);
    else {
      process.stderr.write(`test-pipes: unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!target) {
    process.stderr.write(`test-pipes: --target is required\n${USAGE}`);
    return 2;
  }
  if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
    process.stderr.write("test-pipes: --timeout expects a number of ms\n");
    return 2;
  }

  let report: Awaited<ReturnType<typeof runPipes>>;
  try {
    report = await runPipes({ target, bail, timeoutMs, setup });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  const cwd = process.cwd();
  for (const r of report.results) {
    const loc = `${relative(cwd, r.file)}:${r.lineNo}`;
    if (r.status === "pass") {
      process.stdout.write(
        `  PASS  ${loc}  ${r.line.slice(0, 100)}  (${r.durationMs.toFixed(1)}ms)\n`,
      );
    } else {
      process.stdout.write(`  FAIL  ${loc}  ${r.line.slice(0, 100)}\n        ${r.error}\n`);
    }
  }
  const { pass, fail, files } = report.totals;
  process.stdout.write(
    `\n${files} file(s): ${pass} pass, ${fail} fail${report.bailed ? "  (bailed)" : ""}\n`,
  );
  return fail > 0 ? 1 : 0;
}
