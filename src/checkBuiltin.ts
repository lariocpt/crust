import { type FlagSpec, parseFlags } from "./args";

// Parse-only validation of a BUILTIN line, for `crust --check`.
//
// `--check` used to hand builtin lines to the pipeline parser, where they
// classify as an opaque shell stage — so `test-pipes --bogus x` and a
// `mock-server` with no spec both reported "ok". That is exactly why every
// stale invocation in the shipped skills and docs sailed through a green
// `bun test`: the only lint that looked at them could not see inside them.
//
// Specs are imported lazily so the normal run path keeps its module graph.

interface BuiltinCheck {
  /** the arg spec the CLI itself parses with */
  spec: FlagSpec;
  /** flag that must end up set (positionally or by its legacy long name) */
  requires?: string;
  /** any ONE of these must be set */
  requiresAnyOf?: string[];
  /** bare words that are subcommands, not arguments */
  subcommands?: string[];
}

async function specFor(name: string): Promise<BuiltinCheck | null> {
  switch (name) {
    case "test-fixture":
      return { spec: (await import("./testFixture/cli")).SPEC, requires: "target" };
    case "test-pipes":
      return { spec: (await import("./testPipes/cli")).SPEC, requires: "target" };
    case "gen-fixtures":
      return { spec: (await import("./genFixtures/cli")).SPEC, requires: "swagger" };
    case "mock-server":
      return { spec: (await import("./mockServer/cli")).SPEC, requires: "swagger" };
    case "verify-web-links":
      return {
        spec: (await import("./verifyWebLinks/cli")).SPEC,
        requiresAnyOf: ["source", "sitemap", "site-map-url", "base-url"],
      };
    case "dotenv":
      return {
        spec: (await import("./builtins")).DOTENV_SPEC,
        subcommands: ["status", "list", "clear"],
      };
    default:
      // Builtins with no flag spec (cd, export, alias, source, exit, history,
      // help, skills, logs) are not checked — there is nothing declarative to
      // check them against.
      return null;
  }
}

/**
 * Returns an error message when the builtin invocation is wrong, or null when
 * it is fine (or not a builtin we can check).
 */
export async function checkBuiltinLine(name: string, argv: string[]): Promise<string | null> {
  const check = await specFor(name);
  if (!check) return null;

  if (check.subcommands && argv.length > 0 && check.subcommands.includes(argv[0]!)) {
    // Subcommands take nothing — the runtime rejects trailing junk, so --check
    // must too or a doc'd `dotenv status --nonsense` would lint clean and fail live.
    if (argv.length > 1) return `${name} ${argv[0]}: unexpected argument "${argv[1]}"`;
    return null;
  }

  try {
    const { values, rest, help } = parseFlags(argv, check.spec);
    if (help) return null;
    if (rest.length > 0) return `${name}: unexpected argument "${rest[0]}"`;
    if (check.requires && values[check.requires] === undefined) {
      return `${name}: missing its ${check.requires} argument`;
    }
    if (check.requiresAnyOf && !check.requiresAnyOf.some((k) => values[k] !== undefined)) {
      return `${name}: missing its target (${check.requiresAnyOf[0]})`;
    }
    return null;
  } catch (err) {
    return `${name}: ${(err as Error).message}`;
  }
}
