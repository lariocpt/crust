import { relative } from "node:path";
import { FlagError, type FlagSpec, parseFlags } from "../args";
import { runPipes } from "./runner";

const USAGE = `test-pipes <file|glob> [-b] [-t <ms>] [-s <module>]

Run .pipes files: one shorthand fixture pipeline per line.
  # comments and blank lines are skipped
  {"name":"Court"} | POST $BASE/api/buildings -H "authorization: Bearer $TOKEN" | assert (r => r.status === 201) | (r => r.json()) | capture BID (b => b.building.id)
  GET $BASE/api/buildings/$BID -H "authorization: Bearer $TOKEN" | expect 200
  sql "SELECT count(*)::int AS c FROM buildings" | assert (r => r.c === 1)

Lines run sequentially per file (DB assertions may depend on earlier lines);
capture writes $NAME for every later line in the same file. Env changes are
rolled back when the file finishes — files are hermetic.
Before a file runs, its setup module is imported and its default export
awaited: --setup <module>, else a sibling <name>.setup.ts. Setup seeds
process.env — that's how lines get $TOKEN-style values.

  -b, --bail            stop at the first failing line
  -t, --timeout <ms>    fail any line that runs longer
  -s, --setup <module>  setup module (default: sibling <name>.setup.ts)

The target may also be given as --target <file|glob>.
`;

export const SPEC: FlagSpec = {
  target: { type: "string", positional: 0 },
  bail: { short: "b", type: "boolean" },
  timeout: { short: "t", type: "number" },
  setup: { short: "s", type: "string" },
};

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let bail = false;
  let timeoutMs: number | undefined;
  let setup: string | undefined;

  try {
    const { values, rest, help } = parseFlags(args, SPEC);
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);
    target = values.target as string | undefined;
    bail = values.bail === true;
    timeoutMs = values.timeout as number | undefined;
    setup = values.setup as string | undefined;
  } catch (err) {
    process.stderr.write(`test-pipes: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (!target) {
    process.stderr.write(`test-pipes: a target file or glob is required\n${USAGE}`);
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
