# Documentation release checklist

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
