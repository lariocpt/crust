#!/usr/bin/env bun
// The crust-site CLI — `crust-site build [configFile]` and `crust-site
// dev [configFile]`.
//
// Scaffold (chunk 1 of the v1 build): the command surface exists and fails
// HONESTLY. A subcommand that would actually do work answers "not implemented
// yet" and exits 1 — never 0: a tool that exits 0 without doing its job is a
// false pass, and that is the failure the whole crust repo refuses to ship.
// Unknown subcommands and stray arguments exit 2 with the usage; `--help`
// exits 0 with the usage. Exit-code convention 0/1/2 is the same one the crust
// binary's `site` stub and its `--check` wiring use (parseFlags convention:
// 2 for argument errors), so the three surfaces cannot drift.
//
// The parser here is self-contained on purpose: this package is shipped to
// npm and must not import from the crust source tree (which stays
// zero-dependency). Later chunks extend the shape, not the convention.

const USAGE = `crust-site — the crust site generator (run under Bun)
usage:
  crust-site build [configFile]   render the site into output.directory
  crust-site dev [configFile]     start the dev server (rebuilds on change)
  crust-site --help               show this help

configFile defaults to ./site.config.ts
exit codes: 0 ok/help, 1 runtime failure, 2 argument error
`;

const COMMANDS = new Set(["build", "dev"]);

function main(): number {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    // A bare invocation has no subcommand — nothing ran, so the answer is the
    // usage and a nonzero code, never a success exit.
    process.stderr.write(USAGE);
    return 2;
  }

  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    process.stderr.write(
      `crust-site: unknown subcommand "${command}" (valid: build, dev)\n\n${USAGE}`,
    );
    return 2;
  }

  // `build`/`dev` take AT MOST one positional (the config file). A second one
  // is refused rather than dropped: a silently ignored argument is a
  // false pass wearing a success exit.
  if (rest.length > 1 || (rest.length === 1 && rest[0]!.startsWith("-"))) {
    process.stderr.write(
      `crust-site: ${command} takes at most one argument (configFile)\n\n${USAGE}`,
    );
    return 2;
  }

  // The real build/dev land in later chunks.
  process.stderr.write("crust-site: not implemented yet\n");
  return 1;
}

process.exit(main());
