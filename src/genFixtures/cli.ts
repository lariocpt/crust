import { generateFixtures } from "./generate";

const USAGE = `gen-fixtures --swagger <path> --out <dir> --setup <module>

Generate negative-case HTTP fixtures from an OpenAPI 3.x spec: 401 for
auth-gated ops, 403 for scope-gated ops, 404 for unknown ids, and per-field
400s (missing required, wrong type, invalid enum) with schema-valid base
bodies. Output is one <tag>.gen.crust.ts per tag, runnable by test-fixture.

The --setup module carries the app-specific part (auth, scope substitution).
Required exports: shared(), headersFor(ctx, role), resolvePath(ctx, template),
scopeParam, JSON_HEADERS; optional scopeRoots. See the contract doc at the
top of src/genFixtures/generate.ts.
`;

export async function runCli(args: string[]): Promise<number> {
  let swagger: string | undefined;
  let out: string | undefined;
  let setup: string | undefined;

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
    const result = await generateFixtures({ swagger, out, setup });
    process.stdout.write(
      `generated ${result.totalCases} cases across ${result.files.length} files -> ${result.outDir}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`gen-fixtures: ${(err as Error).message}\n`);
    return 1;
  }
}
