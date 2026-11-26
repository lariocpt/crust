# Documentation release checklist

## v0.4.0 coordinated release

**Production release status: complete.** Crust `0.4.0` is published, the
coordinated website is live, and the backend's exact Mongo launcher pin is
validated, committed, and pushed. Package publication and the live website
were verified before the backend update.

The repository owner authorized production releases and requested the website
release followed by the backend's installation of live Crust `0.4.0`.
This release is a version/documentation milestone, not a new runtime-feature
release. The [0.3.9 audit](RELEASE-0.3.9-AUDIT.md) records what already shipped.

- [x] Isolate the candidate from public `main` without including unrelated
  website-builder or backend working-tree changes.
- [x] Bump the root manifest to `0.4.0`; retain the workflow-stamped npm template.
- [x] Prepare coordinated website release guidance and exact-version install
  instructions.
- [x] Pass fresh full source tests, TypeScript, Biome, and diff checks.
- [x] Pass both website build modes, generated internal links, and command
  grammar checks.
- [x] Commit and push the reviewed candidate, then create a new `v0.4.0` tag.
- [x] Pass release-workflow tests and binary publication, including binary
  stamps, compiled variant probes, and checksums.
- [x] Independently verify the checksum manifest and all eight released asset
  digests against GitHub's SHA-256 metadata.
- [x] Complete npm and GitHub Packages publication in the existing workflow,
  preserving binary-before-launcher ordering.
- [x] Verify both public npm packages and their released source provenance.
- [x] Deploy the coordinated website after the package release; verify its
  production workflow and live content.
- [x] Only then pin the backend's Mongo launcher and lockfile to live `0.4.0`,
  validate the intended tooling, and commit/push that branch.

### Publication evidence

| Item | Observed state |
| --- | --- |
| Released source commit | `f24c456f8d7124c5d2fb43b212e8aee9f5ab1117` |
| Source publication | Released source on public `main`; annotated `v0.4.0` tag remains unchanged |
| GitHub release | [Crust v0.4.0](https://github.com/lariocpt/crust/releases/tag/v0.4.0), published `2026-11-26T00:33:33Z`, non-draft and non-prerelease |
| Published artifacts | Eight Linux/macOS, x64/arm64, clean/Mongo binaries plus `SHA256SUMS` |
| Release workflow | [Run 45729364678](https://github.com/lariocpt/crust/actions/runs/45729364678), attempt 3 completed successfully at the released source commit |
| npm packages | `@lariocpt/crust` and `@lariocpt/crust-mongo` both contain `0.4.0`; both public `latest` tags resolve to `0.4.0` |
| GitHub Packages | Both `0.4.0` package publication steps succeeded in the same workflow |
| Website publication | Commit `8e0dfdb167e65d8b8babe7e9816a6ad7f79d1afd` pushed to website `main`; [production release guide](https://lariocpt.github.io/crust-website/docs/releases/) independently verified live |
| Website workflow | [Run 45731336320](https://github.com/lariocpt/crust-website/actions/runs/45731336320) passed public build, grammar, output, deployment, and live-link gates |
| Backend publication | `feature/crust-main` commit `06893a2f2e814c2a2d155140a130905e60d05eb6` pushed; manifest and lockfile both pin Mongo launcher `0.4.0` |

The original npm job and one npm-only retry both failed with `E404` on
`PUT https://registry.npmjs.org/@lariocpt%2fcrust`. Public reads of both existing
packages succeeded. The configured CI secret passed the workflow's nonempty
check, but that does not establish valid publishing access. The exact credential
or registry-access cause remains unverified. Local `npm whoami` returned
`ENEEDAUTH`; publication did not use a local publishing token.

The owner securely updated the repository's `NPM_TOKEN` secret, then the failed
npm job was rerun in the existing workflow. GitHub also scheduled fresh test
and binary-release jobs; all succeeded. This was not a no-rebuild retry.
Fresh verification confirmed the tag and all eight published binary digests
were unchanged. No tag move or manual package publication was performed.

Immediately after publication, exact-version npm metadata briefly returned
404 or stale content. Subsequent uncached public metadata and independent
tarball verification confirmed both exact versions, integrity hashes, and
`latest` tags before the website was pushed. No credentials were put in chat,
commits, or this record.

### Fresh candidate validation

- Full source suite: 1,621 passed, 7 environment-dependent skips, zero failures;
  17,510 assertions across 62 files, using Bun 1.4.4 and Node 22.
- The initial local run had three launcher failures because `node` was absent
  from `PATH`. Adding the existing Node 22 installation fixed all 22 targeted
  launcher tests and the subsequent full run without source changes.
- TypeScript passed. Read-only Biome checked 154 files without errors or fixes;
  566 warnings and 71 informational findings remain in unchanged source.
- Both website build modes and generated link checks passed. The public build
  produced 34 pages, 1,659 internal links and 55 anchor links, with no dead
  internal links. Its known Shiki language warning used plaintext fallback.
- Website grammar checks passed all 382 examples against the candidate's source
  entrypoint. The production deployment workflow and a separate local check
  also passed all 382 examples against the published compiled `0.4.0` binary.
- Diff checks passed. Runtime, test, skill and npm-template sources are unchanged
  from `v0.3.9`; unrelated website-builder and backend work remains excluded.

### Post-publication verification and limits

- Both public npm tarballs passed SHA-1 and SHA-512 integrity checks. Their
  `gitHead` values match the released source commit. Each package's 15
  non-manifest files are byte-identical to the tagged launcher/skill sources;
  manifests contain the expected name, version, variant, GitHub source, platform
  inventory, and only the reviewed postinstall lifecycle script.
- Public npm SHA-1 values: clean
  `f8547a09051b2c161fc37404322c3c0d78b84865`; Mongo
  `53756e11d9b2961e04a455204cd49e0ee1cd1435`.
- The checksum manifest's SHA-256 is
  `212140997a304d9e5e2d47a912afb3a8c4faa46ac976e0438a1b2259558aea87`.
  All eight entries matched GitHub asset digests before and after recovery.
- Published Linux x64 clean and Mongo launchers independently reported `0.4.0`
  and released source commit `f24c456f8d7124c5d2fb43b212e8aee9f5ab1117`.
  Actual downloaded binary SHA-256 values matched the release: clean
  `68b70224dd5d752f61b8ffc0ccc23577439171cfb324e22c02cfa6a4e4c64849`;
  Mongo `727fe90cf78fefb28ed8b6afdddf3627e6f0855a9237b6648657b29f5af2bffd`.
  These were metadata-only checks, not application execution.
- Independent HTTP requests returned 200 for the deployed homepage, docs index,
  and release guide. Navigation, one-H1 structure, release link, and both exact
  npm install commands were checked in addition to the workflow's live links.
- The backend's frozen install with lifecycle scripts disabled left its
  lockfile unchanged and changed only the Mongo launcher package. Fresh focused
  tooling/selector/transport tests passed 34 tests with zero failures;
  TypeScript, changed-JavaScript syntax, documentation links, and diff checks
  passed. Historical `0.3.8` generation records were not regenerated.
- Backend `make quality-check` was attempted after staging, but this branch
  lacks that target and a tracked pre-commit configuration. The existing hook's
  missing-config exception was scoped to the individual commit; no hook or
  quality configuration was changed. The focused checks above are not claimed
  to be a successful run of the unavailable target.
- Local Bun validation used `--config=/dev/null`; backend unit/type validation
  also disabled dotenv autoload and used a sanitized environment. Production
  workflow configuration is separate.
- No application API, application database, native/generated fixture suite,
  load, installed-host MCP smoke, or LAN/Jenkins validation is claimed. The
  release workflow's compiled Mongo probes are not application DB coverage.
  The backend's documented exporter/runtime integration limitations remain.

Keep credentials out of release review. Do not reuse published versions, move
released tags, or perform destructive rollback operations without a separately
reviewed destination and authorization.

## v0.3.9 release close-out

**Production release status: complete.** Crust v0.3.9 is published and the
coordinated public website deployment succeeded. The unchecked preparation
template previously in this file did not represent outstanding deployment
failures; this record replaces it with the completed gates and explicit
limitations.

See [Contributing](../CONTRIBUTING.md) for general contribution guidance and
[USAGE](USAGE.md) for the capability reference.

### Release identity and publication

| Item | Released value |
| --- | --- |
| Crust version | `0.3.9` |
| Source commit | `dbb3223ce8d96c06e79ae89b4a37e4a79903fe35` |
| Website commit | `a9630019dfd51630d1dd642a27451718cfa6f7b0` |
| GitHub release publication | `2026-11-16T00:02:14Z` |
| Channel | Production: GitHub Releases, npm, GitHub Packages, GitHub Pages |
| Authorization | Repository owner explicitly authorized commit/push/production release and existing workflow installs, full tests, Mongo probes, and live-site checks |
| Named release owner | Not separately recorded in this checklist |

- [x] Publish [Crust v0.3.9](https://github.com/lariocpt/crust/releases/tag/v0.3.9)
  as a non-draft, non-prerelease production release.
- [x] Publish `@lariocpt/crust` and `@lariocpt/crust-mongo` version `0.3.9` to
  npm and GitHub Packages. Public npm metadata confirms both versions exist
  and both `latest` tags resolve to `0.3.9`.
- [x] Deploy the [production website](https://lariocpt.github.io/crust-website/).
  A separate post-release homepage request returned HTTP 200.
- [x] Confirm both release repositories are clean and synchronized with their
  respective `origin/main` branches before this documentation close-out.

### Candidate review and documentation parity

- [x] Review the complete source and website candidates, including generator
  changes. This was not a documentation-only executable release.
- [x] Include the reviewed request planning, security/query prerequisites,
  conservative baseline/format proofs, operation/whole-flow omissions, and
  offline generator regression tests.
- [x] Coordinate USAGE, website overview/recipes, shipped skills, and MCP
  help/tool descriptions against reviewed source contracts.
- [x] Review fixture serialization/lazy setup, result and failure semantics,
  status-first load gates, window guards, optional assertions, dropped-slot
  limitations, builtin inventory, and executable/runtime distinctions.
- [x] Review command examples, source-checkout boundaries, execution-permission
  language, and credential safety.
- [x] Confirm MCP metadata edits did not intentionally change handlers or
  schema structure. An independent installed-host smoke check was not performed.
- [x] Preserve the QA sibling at `973c6bb`, including its untracked
  `crust/api-hand-rolled-docs/` directory. No QA files were changed.
- [x] Keep LAN/Jenkins and unrelated application/API/DB/load work outside scope.
  The approved CI Mongo probe is distinct from application database validation.

### Validation and release ordering

- [x] Pass local read-only Biome checks, TypeScript typecheck, and diff checks.
- [x] Pass the targeted generator/docs tests: 61 passed, 0 failed, with
  2,183 assertions before the final assertion-only CI repair.
- [x] Pass full tests and typecheck on the final released source commit in the
  [successful Crust workflow](https://github.com/lariocpt/crust/actions/runs/43777826030).
- [x] Build eight platform/variant binaries and verify stamped version/commit
  and Mongo variants in the approved production workflow.
- [x] Publish eight binaries plus `SHA256SUMS`. Independently compare all eight
  manifest checksums against GitHub's SHA-256 asset digests.
- [x] Preserve binary-before-launcher publication and release Crust before
  pushing the coordinated website candidate.
- [x] Pass the local public website build: 33 pages, 1,579 internal links,
  54 anchor links, and zero dead internal links.
- [x] Pass the public build, grammar gate using the published executable,
  public-output gate, deployment, and live-site link check in the
  [successful website workflow](https://github.com/lariocpt/crust-website/actions/runs/43778175733).
- [x] Obtain explicit approval for existing CI installs, full test scopes,
  downloads, Mongo probes, publication, and live-site checks. Earlier
  preparation-only restrictions did not remain a blocker after that approval.

Every local Bun validation used `--config=/dev/null` to avoid the default
preload's report creation/pruning. Existing production workflows ran under
their separately approved configuration; that local safeguard is not claimed
to have been inherited by CI. Syntax/example checks are not claims of runtime
success for documented application scenarios.

### Failures, warnings, and limitations

- The first release attempt,
  [run 43777684287](https://github.com/lariocpt/crust/actions/runs/43777684287),
  failed because three MCP handshake assertions still expected old wording.
  Release/package jobs were skipped. The assertion-only correction was
  committed as `dbb3223`, and the subsequent complete production workflow passed.
- Before retrying, GitHub and both npm packages were checked to confirm
  `0.3.9` was unpublished. The failed tag was updated with an exact remote-value
  lease. No already-published package version was replaced.
- One immediate exact-version npm lookup returned HTTP 404. Subsequent full
  package metadata confirmed both exact versions and integrity hashes;
  both `latest` endpoints also confirmed `0.3.9`.
- The local website build's unregistered `crust` Shiki language warning used
  plaintext fallback. CI also reported runner-image/Node-action migration
  notices. These did not fail the release or deployment.
- No fresh LAN-mode build/link check was performed for this public-only
  close-out, and no LAN/Jenkins deployment was performed.
- No separate published-binary MCP/host smoke session or installed-package
  skills/content comparison was performed. Successful packaging does not
  establish any host's registration or tool exposure. The original MCP
  investigation is ended; these are disclosed follow-ups, not active tasks.
- No approved per-channel rollback destinations were recorded. Prior source
  and website revisions are historical facts, not implicit rollback approval.
  Do not unpublish packages, reuse published versions, move released tags, or
  perform destructive Git operations as an improvised rollback.
- No application API, production database, application fixture, or load
  validation is claimed by this record.

### Historical documentation-parity evidence

These results predate the immutable release candidate and remain historical;
they must not be substituted for the final-candidate CI evidence above.

| Check | Historical result | Limit |
| --- | --- | --- |
| Targeted source docs tests | 21 passed, 0 failed | Parse-only examples; no full suite |
| Website command examples | 378 checked, 0 failed | Existing executable syntax-check path |
| LAN website build and links | 33 pages; 1,545 internal links; 54 anchors; 0 dead | Generated files only |
| Public-path build and links | 33 pages; 1,579 internal links; 54 anchors; 0 dead | Generated files only |
| MCP source comparison | Documentation literals/comments only | Handlers and schema structure unchanged |
| Diff checks | Passed in both repositories | Whitespace/patch checks only |

### Close-out disposition

- [x] Record immutable release identities, publication channels, workflow
  evidence, failures, accepted warnings, and unverified follow-ups.
- [x] Confirm production publication and the live website within the approved
  network scope.
- [x] Clean up release/deployment watcher processes.
- [x] Close the production release task. The limitations above remain
  explicitly unverified or outside scope; they are not represented as passed.

This record does not grant new execution or rollback permissions. Future
releases require their own candidate review, approvals, validation, and
publication evidence. Keep secrets, environment files, tokens, journals, and
reports out of release review.
