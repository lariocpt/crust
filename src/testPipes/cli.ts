import { extname } from "node:path";
import { FlagError, type FlagSpec, parseFlags } from "../args";
import { renderJson, renderJUnitXml, renderText } from "./report";
import { runPipes } from "./runner";

const USAGE = `test-pipes <file|glob> [-o <path>] [-b] [-t <ms>] [-s <module>]

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

  -o, --out <path>      report file; .json/.xml (JUnit) pick the format
  -b, --bail            stop at the first failing line
  -t, --timeout <ms>    fail any line that runs longer
  -s, --setup <module>  setup module (default: sibling <name>.setup.ts)

The target may also be given as --target <file|glob>.
`;

export const SPEC: FlagSpec = {
  target: { type: "string", positional: 0 },
  out: { short: "o", type: "string" },
  bail: { short: "b", type: "boolean" },
  timeout: { short: "t", type: "number" },
  setup: { short: "s", type: "string" },
};

export async function runCli(args: string[]): Promise<number> {
  let target: string | undefined;
  let out: string | undefined;
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
    out = values.out as string | undefined;
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
  const ext = out ? extname(out) : "";
  let text: string;
  if (ext === ".json") text = renderJson(report);
  else if (ext === ".xml") text = renderJUnitXml(report, cwd);
  else text = renderText(report, cwd);

  if (out) {
    await Bun.write(out, text);
  } else {
    process.stdout.write(text);
  }

  return report.totals.fail > 0 ? 1 : 0;
}
