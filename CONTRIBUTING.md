# Contributing to crust

Thanks for taking a look. crust is a pipeline-first devops toolkit built on Bun,
shipped as one compiled binary.

## Getting set up

```bash
git clone https://github.com/lariocpt/crust.git && cd crust
bun install
bun test          # ~11s for the whole suite
bun src/index.ts  # run the REPL from source
```

`scripts/install-from-source.sh` compiles a binary for your own architecture —
useful on platforms the releases don't cover.

## The three rules that matter

1. **crust must never report a false pass.** A tool that exits 0 on failure is
   worse than a slow one. Errors propagate: a lambda that throws under
   `parallel` fails the line, a spawned shell stage's nonzero exit becomes the
   line's exit code, an unknown fixture key is an error rather than a silently
   undefined matcher. `tests/honest-failure.test.ts` is the contract — every
   case in it failed before, and its controls exist so that a fix cannot simply
   make everything fail.
2. **The primary argument is positional, and one parser owns every CLI.**
   `parseFlags(argv, spec)` in `src/args.ts` gives every tool builtin its
   positionals, short flags, `--flag=value`, uniform `--help` and uniform exit 2.
   Add a flag by extending that CLI's `SPEC`, never by hand-rolling a loop.
3. **Don't grow the grammar; give users the general mechanism.** A new stage
   keyword must not shadow a real binary — `lines` was free, `split` would have
   shadowed `/usr/bin/split`.

`AGENTS.md` is the fuller architecture guide; read it before touching the
pipeline.

## Before you open a PR

- `bun test` — every feature lands with tests.
- `bunx tsc --noEmit`
- `bun run check` (Biome; a pre-commit hook runs it on staged files)
- If you changed a documented capability, update `docs/USAGE.md` **and** the
  website. `tests/docs-lint.test.ts` parses every crust line in `docs/USAGE.md`
  and `README.md` against the live grammar, so stale examples fail the build.
  Never document behaviour you haven't run through `bun src/index.ts -c`.

Commits are conventional-ish (`fix:`, `feat:`, `docs:`, `perf:`) and the body is
expected to explain *why*, not restate the diff.

## Reporting a bug

Include the crust version (`crust -V`), your OS/architecture, the exact line you
ran, and what you expected instead. A line that reproduces it under
`crust --check` or `crust -c` is worth more than a description.
