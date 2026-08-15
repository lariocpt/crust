import { FlagError, type FlagSpec, parseFlags } from "../args";
import { generateFixtures } from "./generate";

// The canonical invocation in the README, the docs and every skill passes
// exactly these two paths, so they are the defaults rather than required
// flags: `gen-fixtures ./openapi.json` is the whole command.
const DEFAULT_OUT = "tests/gen";
const DEFAULT_SETUP = "./tests/gen-setup.ts";

const USAGE = `gen-fixtures <spec> [-o <dir>] [-s <module>] [--no-flows]

Generate negative-case HTTP fixtures from an OpenAPI 3.x spec: 401 for
auth-gated ops, 403 for scope-gated ops, 404 for unknown ids, per-field
400s (missing required, wrong type, invalid enum) and boundary violations
(too short/long, below/above min/max, pattern, unexpected extra property)
with schema-valid base bodies. Output is one <tag>.gen.crust.ts per tag,
runnable by test-fixture.

Qualifying collection paths (POST + item {param} path) also get a CRUD flow
suite: <out>/flows/flows.gen.pipes + sibling flows.gen.setup.ts (auto-
detected), runnable by test-pipes. --no-flows suppresses it.

The --setup module carries the app-specific part (auth, scope substitution).
Required exports: shared(), headersFor(ctx, role), resolvePath(ctx, template),
scopeParam, JSON_HEADERS; optional scopeRoots. See the contract doc at the
top of src/genFixtures/generate.ts, and examples/gen-setup.ts in the crust
repo for a complete runnable module to copy.

  -o, --out <dir>       output directory (default: ${DEFAULT_OUT})
  -s, --setup <module>  setup module (default: ${DEFAULT_SETUP})
      --no-flows        skip the CRUD flow suite

The spec may also be given as --swagger <path>.
`;

export const SPEC: FlagSpec = {
  swagger: { type: "string", positional: 0 },
  out: { short: "o", type: "string" },
  setup: { short: "s", type: "string" },
  "no-flows": { type: "boolean" },
};

export async function runCli(args: string[]): Promise<number> {
  let swagger: string | undefined;
  let out = DEFAULT_OUT;
  let setup = DEFAULT_SETUP;
  let flows = true;

  try {
    const { values, rest, help } = parseFlags(args, SPEC);
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);
    swagger = values.swagger as string | undefined;
    out = (values.out as string | undefined) ?? DEFAULT_OUT;
    setup = (values.setup as string | undefined) ?? DEFAULT_SETUP;
    flows = values["no-flows"] !== true;
  } catch (err) {
    process.stderr.write(`gen-fixtures: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (!swagger) {
    process.stderr.write(`gen-fixtures: an OpenAPI spec path is required\n${USAGE}`);
    return 2;
  }

  try {
    const result = await generateFixtures({ swagger, out, setup, flows });
    process.stdout.write(
      `generated ${result.totalCases} cases across ${result.files.length} files -> ${result.outDir}\n`,
    );
    if (result.totalCases === 0) {
      process.stdout.write(
        "hint: cases derive from DOCUMENTED responses, not securitySchemes — " +
          "401 needs a documented 401 whose description says the caller is not " +
          'authenticated ("not authenticated" / "log in"), 403 needs scopeParam ' +
          "plus a documented 403, 404 needs non-scope path params plus a " +
          "documented 404, and the 400 matrix needs a JSON request-body schema " +
          "plus a documented 400. See docs/USAGE.md §gen-fixtures and " +
          "examples/gen-setup.ts.\n",
      );
    }
    if (result.flowFile) {
      process.stdout.write(`generated ${result.flowCount} CRUD flows -> ${result.flowFile}\n`);
    } else if (flows) {
      process.stdout.write(`generated 0 CRUD flows (no qualifying collection paths)\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`gen-fixtures: ${(err as Error).message}\n`);
    return 1;
  }
}
