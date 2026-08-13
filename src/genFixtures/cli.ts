import { generateFixtures } from "./generate";

const USAGE = `gen-fixtures --swagger <path> --out <dir> --setup <module> [--no-flows]

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
`;

export async function runCli(args: string[]): Promise<number> {
  let swagger: string | undefined;
  let out: string | undefined;
  let setup: string | undefined;
  let flows = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (a === "--swagger") swagger = args[++i];
    else if (a.startsWith("--swagger=")) swagger = a.slice(10);
    else if (a === "--out") out = args[++i];
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--setup") setup = args[++i];
    else if (a.startsWith("--setup=")) setup = a.slice(8);
    else if (a === "--no-flows") flows = false;
    else {
      process.stderr.write(`gen-fixtures: unknown argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!swagger || !out || !setup) {
    process.stderr.write(`gen-fixtures: --swagger, --out and --setup are all required\n${USAGE}`);
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
