# crust — agent guide

A Bun-powered shell, compiled to a single binary. TypeScript, `bun:test`,
Biome, husky + lint-staged.

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
  truthy-pass a Promise).

## Tests

`bun test` — the whole suite runs in ~3s; keep it that way. Every feature
lands with tests (see `tests/test-fixture.test.ts` and
`tests/pipeline.test.ts` for the harness patterns — throwaway Bun.serve +
tmpdir fixtures). Pre-commit runs lint-staged (biome) but NOT the suite —
run `bun test` yourself before pushing.

## Publishing (Jenkins job `crust`)

One build publishes TWO channels that must stay in lockstep: the ~90MB
binary to apps.in.drlario.org (versioned `BASE+sha`) and a ~4KB npm launcher
to npm.in.drlario.org (`BASE-ci.N.sha`). Order is load-bearing — binary
before npm (the launcher resolves index.tsv). The Jenkinsfile's sh blocks
are Groovy triple-single-quoted: **escape backslashes** (`\\(` not `\(`) or
the pipeline won't compile. Sibling containers can't resolve LAN DNS —
`--add-host npm.in.drlario.org:host-gateway` where needed.

## Docs are part of the deliverable

`docs/USAGE.md` and the website (`~/Projects/personal/crust-website`) must
describe what the binary actually does — this project once advertised a load
pipeline that didn't parse. If you add or change a capability, update both,
and never document behavior you haven't run through `bun src/index.ts -c`.
