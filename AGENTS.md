# crust — agent guide

A pipeline-first devops toolkit with an interactive REPL and `.crust` script
runner, compiled to a single Bun binary. TypeScript, `bun:test`, Biome,
husky + lint-staged.

## Architecture (read these before touching the pipeline)

- `src/lexer.ts` → classifies each `|`-separated stage into a `StageKind`
  (`src/types.ts`). `src/parser.ts` builds sources (`buildSource`) and
  applies transforms (`applyStage`). New shell syntax = lexer kind + types
  union + both parser switches (the switches are exhaustive — tsc will tell
  you what you missed).
- `src/sources.ts` / `src/transforms.ts` / `src/sinks.ts` — pipeline
  primitives over `Pipeline` (`src/pipeline.ts`). Reuse `mergeAsync` for
  anything that fans in streams; reuse `pipelineStage()` for new stages.
- Builtins (`test-fixture`, `mock-server`, `verify-web-links`, `dotenv`…)
  live in `src/builtins.ts` + their own directories; they're dispatched
  before pipeline parsing in `src/runLine.ts`.
- `new Function` evaluation of user-typed lambdas is deliberate (the user's
  own terminal is the trust boundary) — don't "fix" it.

## Design rules (v0.2 — apply these to anything new)

1. **crust must never report a false pass.** A tool that exits 0 on failure is
   worse than a slow one. Errors propagate: a lambda that throws under
   `parallel` fails the line, a spawned shell stage's nonzero exit becomes the
   line's exit code (the `| head -3` early-exit exemption stays), an unknown
   fixture `output` key is an error not a silently-undefined matcher, and a
   matcher that throws is reported as `predicate threw`, not as a mismatch.
   `tests/honest-failure.test.ts` is the contract — every case there failed
   before, and its controls exist so a fix can't just make everything fail.
2. **The primary argument is positional, and one parser owns every CLI.**
   `parseFlags(argv, spec)` in `src/args.ts` gives all six tool builtins
   positionals, short flags, `--flag=value`, a value-swallow guard, uniform
   `--help` and uniform exit 2. Add a flag by extending that CLI's `SPEC`, never
   by hand-rolling a loop. Legacy long flags (`--target`, `--swagger`,
   `--config`) stay accepted forever, undocumented.
3. **Don't grow the grammar; give users the general mechanism.** Aliases expand
   at the head of every stage (single pass, no rescan), so users shorten what
   *they* repeat instead of the language carrying a shorthand for each keyword.
   A new stage keyword must not shadow a real binary — `lines` is free, `split`
   would have shadowed `/usr/bin/split`.

Corollary for docs: `crust --check '<line>'` parses without running (no I/O, no
spawn), which is how `tests/docs-lint.test.ts` and the website's CI validate
every example. If you change the grammar, those go red before users do.

## Hard constraints

- **The shipped artifact is a compiled Bun binary** (`bun build --compile`).
  Code that dynamically imports USER files (fixtures) works, but those files
  can only import relative modules and Bun builtins — NO third-party npm
  resolution at runtime. Never add a feature that requires fixtures to
  import npm packages; point users at `Bun.SQL`, `Bun.file`, etc.
- Keep the fixture runner semantics backward compatible: 0-arg functions
  resolve, 1-arg functions in `input` receive the setup context, 1+-arg
  functions in `output` are matchers `(actual, ctx)`, async matchers are
  awaited (`diffAsync` — sync `diff` must fail loudly on thenables, never
  truthy-pass a Promise). `output.schema` is a fixed contract (shipped in
  v0.2): a JSON Schema the response body must conform to (validated via the
  mockServer subset validator; extracted before the resolve walk so
  functions inside a schema are never invoked). Schemas are inline only —
  the runner has no spec to resolve against, so a `$ref` anywhere in one is
  a loud error, never a silent pass.

## Tests

`bun test` — the whole suite runs in ~9s; keep it in that range. Every feature
lands with tests (see `tests/test-fixture.test.ts` and
`tests/pipeline.test.ts` for the harness patterns — throwaway Bun.serve +
tmpdir fixtures). Pre-commit runs lint-staged (biome) but NOT the suite —
run `bun test` yourself before pushing.

## Publishing (two independent planes)

Both planes ship the SAME invariant: the binary must be published BEFORE the
npm launcher, because the launcher is ~4KB and resolves its ~90MB binary from
whatever the binary channel published. Publishing npm first ships a package
that cannot install itself.

- **Public** — `.github/workflows/release.yml`, triggered by pushing a `v*`
  tag. Builds linux/darwin × x64/arm64, uploads them plus `SHA256SUMS` to the
  GitHub Release, then publishes `@lariocpt/crust` to npmjs.org (needs the
  `NPM_TOKEN` repo secret). The version comes from the tag, and it is stamped
  into `package.json` before the compile — `src/index.ts` imports it for
  `--version`.
- **LAN** — Jenkins job `crust`: binary to apps.in.drlario.org (`BASE+sha`),
  launcher to npm.in.drlario.org (`BASE-ci.N.sha`). The Jenkinsfile's sh blocks
  are Groovy triple-single-quoted: **escape backslashes** (`\\(` not `\(`) or
  the pipeline won't compile. Sibling containers can't resolve LAN DNS —
  `--add-host npm.in.drlario.org:host-gateway` where needed.

Which plane a published launcher resolves from is the `crust.source` field in
`npm/package.json` (`"apps"` in-repo, restamped `"github"` by the release
workflow), overridable at runtime with `CRUST_SOURCE`. Both paths share one
verify-then-rename download in `npm/lib/install.mjs` — don't fork it.
Details in `docs/INTERNAL.md`.

## Docs are part of the deliverable

`docs/USAGE.md` and the website (the `crust-website` repo) must
describe what the binary actually does — this project once advertised a load
pipeline that didn't parse. If you add or change a capability, update both,
and never document behavior you haven't run through `bun src/index.ts -c`.

This is now enforced, not just asked for: `tests/docs-lint.test.ts` parses every
crust line in `docs/USAGE.md` and `README.md`, `tests/skills.test.ts` does the
same for the embedded skills, and the website's Jenkins `Grammar` stage runs its
examples through `crust --check` using the binary it already mounts. The website
is a separate repo and cannot import the lexer — `--check` is what bridges it.
