// `site` — a redirect stub, shaped after the clean-binary mongo hint
// (src/builtinFns/mongo.ts).
//
// The site generator is NOT part of the crust binary. It ships as the
// `@crust/site` workspace package (packages/site), run under plain Bun:
// `bunx @crust/site build`. A compiled Bun binary cannot resolve bare npm
// specifiers from files OUTSIDE its own bundle (measured 2026-11-12, Bun
// 1.4.3/1.4.4-canary — crust AGENTS.md), and a site's `site.config.ts` and
// layouts are imported from disk at run time — so no binary variant can
// carry the builder. Every build, clean or mongo, carries the stub instead,
// and it behaves the same from source: the tool is a separate package, so
// the answer is the redirect, everywhere.
//
// The contract, pinned by tests/site.test.ts:
//   - a valid invocation (`site`, `site build`, `site dev [configFile]`)
//     prints the redirect and exits NONZERO — never 0 (this process does
//     not build sites; a success exit would be a false pass) and never a
//     `sh: site: command not found` 127 (the registration in builtins.ts
//     is what keeps the name out of sh);
//   - argument errors (unknown flag/subcommand, stray arguments) exit 2
//     with the usage — the parseFlags convention every tool builtin keeps;
//   - `--help`/`-h` prints the usage on stdout and exits 0.
// Mongo's hint uses the same exit-code convention: a loud message, exit 1.

import { type FlagSpec, parseFlags } from "../args";

/** What `site` prints on a valid invocation — the redirect itself. */
export const SITE_REDIRECT_HINT =
  "site: site building is not part of the crust binary — the generator ships as the " +
  "@crust/site package, run under Bun. Install it and run: bunx @crust/site build " +
  "[site.config.ts] (or bunx @crust/site dev for the dev server)";

/** The screen `site --help` prints at parse time (same contract as mongoUsage). */
export const siteUsage =
  "usage: site build [configFile] | site dev [configFile]\n" +
  "  command     build (render the site) or dev (dev server) — the only two subcommands\n" +
  "  configFile  optional site.config.ts (default: ./site.config.ts)\n" +
  "\n" +
  "  this builtin is a redirect: site building lives in the @crust/site package,\n" +
  "  not in the crust binary — bunx @crust/site build [configFile]\n";

/**
 * The stub's CLI spec, also what `crust --check` validates against
 * (src/checkBuiltin.ts). `command`/`config` are positional slots — users
 * type `site build x`, never the flag forms — so the "valid: …" list the
 * parser prints for an unknown flag names the slots, not options.
 */
export const SITE_SPEC: FlagSpec = {
  command: { type: "string", positional: 0 },
  config: { type: "string", positional: 1 },
};

type SiteParse =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "ok"; command?: "build" | "dev"; config?: string };

/**
 * Parse `site`'s argv against SITE_SPEC. The tool runner and `--check` both
 * go through this, so a documented invocation can never lint clean and fail
 * live (the dotenv precedent — see src/checkBuiltin.ts).
 */
export function parseSiteArgs(argv: string[]): SiteParse {
  try {
    const { values, rest, help } = parseFlags(argv, SITE_SPEC);
    if (help) return { kind: "help" };
    if (rest.length > 0) return { kind: "error", message: `unexpected argument "${rest[0]}"` };
    const command = values.command as string | undefined;
    if (command === undefined) return { kind: "ok" };
    if (command !== "build" && command !== "dev") {
      return { kind: "error", message: `unknown command "${command}" (valid: build, dev)` };
    }
    return { kind: "ok", command, config: values.config as string | undefined };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

/** Error text for a wrong invocation, null when the shape is fine. Prefixed
 *  with `site: ` so `--check` prints `crust: site: …` exactly like every other
 *  builtin (the generic path in checkBuiltin.ts prefixes the name itself). */
export function checkSiteArgv(argv: string[]): string | null {
  const parsed = parseSiteArgs(argv);
  return parsed.kind === "error" ? `site: ${parsed.message}` : null;
}

/**
 * The tool entry point — `crust site …` from a shell (standaloneTools) and
 * the session builtin (builtins.ts) both land here, so the two spellings
 * cannot drift apart. Arguments are NOT env-expanded: the stub consumes no
 * value, it only checks the shape and redirects.
 */
export async function runSiteTool(argv: string[]): Promise<number> {
  const parsed = parseSiteArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(siteUsage);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`site: ${parsed.message}\n${siteUsage}`);
    return 2;
  }
  // A valid shape — and the stub's ONLY job is to say where the tool really
  // is. A bare `site` (no subcommand) gets the same redirect: naming the
  // package is the most useful answer to a first try, and the nonzero exit
  // keeps "nothing happened" from reading as "the build succeeded".
  process.stderr.write(`${SITE_REDIRECT_HINT}\n`);
  return 1;
}
