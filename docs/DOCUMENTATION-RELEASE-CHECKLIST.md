# Documentation release checklist

Use this checklist for coordinated changes to Crust's usage documentation,
the separate `crust-website` repository, shipped skills, and MCP help/tool
descriptions. See [Contributing](../CONTRIBUTING.md) for general contribution
guidance and [USAGE](USAGE.md) for the capability reference.

Preparing this checklist does **not** authorize installs, upgrades, commits,
pushes, tags, publishing, deployment, services, application/API/DB requests,
fixture execution, or load. Examples below are validation instructions, not
permission to execute them. Keep secrets, environment files, tokens, journals,
and reports out of the review.

## 1. Identify the release candidate

- [ ] Record the source revision and website revision, release owner, intended
  channel, and intended publish date.
- [ ] Choose the scope: website only, source documentation, packaged skills,
  compiled MCP descriptions, or a coordinated release.
- [ ] Review the complete candidate diff, including pre-existing work. Do not
  label a candidate "documentation only" merely because this checklist was
  prepared for documentation.
- [ ] Preserve or explicitly account for the existing generator changes in
  `src/genFixtures/generate.ts`, `src/genFixtures/requestPlan.ts`,
  `src/genFixtures/baselineFormats.ts`, and
  `tests/gen-fixtures-request-plan.test.ts`. Do not silently discard or include
  them in a release.
- [ ] Leave the QA sibling repository and its `973c6bb` baseline untouched.
- [ ] Confirm dependency manifests, lockfiles, runtime configuration, and
  unrelated files have no unintended changes.

## 2. Review parity against the intended executable

- [ ] Keep [USAGE](USAGE.md), website overview/recipe pages, and the corresponding
  [shipped skills](../skills/) consistent with reviewed source contracts.
- [ ] Distinguish source-checkout examples from published executable behavior.
  Relative source imports are not an npm library API; plain Bun scripts do not
  automatically receive Crust globals.
- [ ] Check generator security/query prerequisites, supported static baselines,
  omitted operations/flows, output-directory deletion, and manifest provenance.
  Generation is not execution or evidence of complete API coverage.
- [ ] Check fixture JSON headers/body serialization, lazy setup and thunk
  behavior, result/report shapes, and failure/empty-run exit handling.
- [ ] Check status-first load gates, `--every`/`stats_every` for window/final
  guards, optional MCP assertions, and the limits of dropped-slot warnings.
  A passing minimum-rate gate does not prove the full target rate was offered.
- [ ] Check the builtin inventory, executable variants, actual runtime APIs,
  and installed-version compatibility. Do not invent APIs such as `Bun.jwt`.
- [ ] Review [MCP source help](../src/mcp/server.ts),
  [tool descriptions](../src/mcp/oneshot.ts), the
  [MCP skill](../skills/crust-mcp/SKILL.md), and both website MCP pages together:
  host-specific registration, accepted overrides, syntax-check limits,
  error results, and teardown boundaries must agree.
- [ ] Confirm changed MCP metadata did not alter handlers or schema structure
  unless execution changes were separately intended and reviewed.
- [ ] Keep standalone command fences runnable in shape. Mark fragments,
  illustrative output, synopsis placeholders, and source-checkout snippets
  accurately; syntax validation is not a runtime-success claim.
- [ ] Confirm no example, skill, or release note grants execution permission
  or embeds credentials or runtime parameter values that should remain private.

## 3. Refresh bounded validation on the final candidate

Use the already approved Bun installation on PATH. **Every local Bun validation
must use `--config=/dev/null`**: the normal preload can create/prune reports.
Do not install missing tools or expand test scope to satisfy this checklist.

### Source documentation

From the Crust repository:

```bash
CI=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null test tests/docs-lint.test.ts
git diff --check
```

- [ ] Record the targeted docs-test result for the final candidate, including
  the MCP skill's parser coverage.
- [ ] Confirm parsing does not drain example pipelines. Shell syntax preflight
  may launch `sh -n`; it is not a no-spawn guarantee.
- [ ] Separately verify that MCP source still parses and, for metadata-only
  edits, compare against the agreed baseline with only comments/documentation
  literals ignored. Do not start the MCP server to prove a text-only change.

### Website builds and internal links

From the sibling `crust-website` repository, run each mode sequentially:
both builds replace `dist/`, so finish one mode's link check before the next.

```bash
env -u PUBLIC_SITE -u SITE_URL -u BASE_PATH CI=1 ASTRO_TELEMETRY_DISABLED=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null --bun run build
env -u BASE_PATH BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null scripts/check-links.mjs

env PUBLIC_SITE=1 SITE_URL=https://lariocpt.github.io BASE_PATH=/crust-website CI=1 ASTRO_TELEMETRY_DISABLED=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null --bun run build
env BASE_PATH=/crust-website BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null scripts/check-links.mjs

CI=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --config=/dev/null scripts/lint-examples.mjs ../crust/bin/crust
git diff --check
```

- [ ] Record both build results and base-path-aware internal link/anchor counts.
  These checks inspect generated files, not external URLs or live endpoints.
- [ ] Record the existing executable's provenance from an approved source;
  `../crust/bin/crust` must already exist. Do not invoke a downloading launcher
  or rebuild it merely to complete the grammar check.
- [ ] Record the website grammar result. It covers Bash/Crust command fences,
  not TypeScript execution, imported fixture contents, or runtime correctness.
- [ ] Confirm compatibility with the executable the publishing workflow will
  use, not just the local executable. The Pages workflow obtains the latest
  published release; the PR workflow deliberately omits its grammar check.
- [ ] Inspect canonical/base-path handling, public-versus-LAN references, and
  `.nojekyll` in the appropriate build output. Record any accepted warnings.
- [ ] Mark broader typecheck, formatter/linter, full-suite, application, DB,
  fixture, and load checks as **not run** unless separately authorized and
  actually completed. A docs parser check does not substitute for them.

## 4. Prior documentation-parity evidence

The preceding documentation-parity pass recorded the results below. They were
not rerun when this checklist was prepared, are not tied here to an immutable
candidate revision, and must not be presented as fresh release evidence.

| Check | Recorded result | Limit |
| --- | --- | --- |
| Targeted source docs tests | 21 passed, 0 failed | Parse-only examples; no full suite |
| Website command examples | 378 checked, 0 failed | Existing executable's syntax-check path |
| LAN website build and links | 33 pages; 1,545 internal links; 54 anchors; 0 dead | Generated files only |
| Public-path build and links | 33 pages; 1,579 internal links; 54 anchors; 0 dead | Base `/crust-website`; generated files only |
| MCP source comparison | Documentation literals/comments only | Handlers and schema structure unchanged |
| Diff checks | Passed in both repositories | Whitespace/patch checks, not runtime verification |

The Shiki warning for the unregistered `crust` language fell back to plaintext
and did not fail the builds. No application/API/DB/load tests, full suite,
binary rebuild, package publication, or deployment was performed in that pass.
Dependencies and lockfiles were unchanged.

## 5. Obtain approval before publication

- [ ] Obtain explicit approval for the exact repositories, candidate revisions,
  channels, commit/push/tag actions, and deployment scope. Do not trigger a
  workflow as a substitute for obtaining execution approval.
- [ ] Review the current website `.github/workflows/pages.yml` and
  `.github/workflows/pr-checks.yml`. A push to `main` or manual Pages dispatch
  publishes; its pipeline also downloads an executable and performs a live
  post-deploy link crawl. Local static validation does not authorize these.
- [ ] Review the source [release workflow](../.github/workflows/release.yml).
  A `v*` tag push or manual release dispatch runs tests/typecheck, builds
  binaries, checks MongoDB variants, creates release assets, and publishes
  launchers/skills. These are not permitted by the current docs-only scope.
- [ ] Review CI runtime/configuration separately. Local `--config=/dev/null`
  safeguards are not automatically inherited by existing workflows; their
  installs, test scopes, downloads, and side effects need explicit approval.
- [ ] Resolve release-order dependencies. If docs require unreleased behavior,
  make the matching executable available before publishing those claims.
  Source MCP text edits do not update an already compiled binary.
- [ ] For an approved executable/package release, preserve the workflow's
  binary-before-launcher order and verify version/commit provenance. Skills
  shipped with packages and compiled MCP descriptions need their respective
  packaging/build steps; a website-only deployment does not distribute them.
- [ ] Record an approved rollback destination for each changed channel before
  publishing. Do not improvise destructive Git operations or version reuse.

## 6. Close out after an approved release

- [ ] Record the published website revision and, where applicable, executable
  version/commit and package version, with links to approved workflow runs.
- [ ] Verify publication and live links only within the separately approved
  network scope; do not infer permission to call application endpoints.
- [ ] If MCP metadata shipped, verify it through an approved binary/host
  session. Copilot registration does not establish another host's registration
  or tool exposure. Server startup can load user initialization code.
- [ ] Confirm the published skills and MCP descriptions match the intended
  release rather than a stale installed artifact.
- [ ] Record failed/skipped checks and accepted limitations explicitly.
- [ ] Mark the release complete only when required gates and approvals are
  satisfied; otherwise leave it pending with the owner and next action.
