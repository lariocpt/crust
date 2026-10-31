# G36 — version output, CI-tag provenance, and two documented-behaviour papercuts

**FIXED 2026-10-31** — crust-only (no site change: the site displays no
`--version` output and its `test-fixture` examples are all single-target).
Items 1, 2 and 4 shipped in the crust commit (code + Jenkinsfile +
release.yml + USAGE.md + pins); item 3 stays a record-only correction (the
changelog entry already existed). KB (crust-agent submodule, local commit
only — ingest is operator-controlled, `98fad27d`): `round-9-cli-contract.md`
§9 (self-description contracts; explicitly marked as source state — released
0.2.4 still prints the bare version). **MCP reviewed — no overlap**: the
`--version` shape and the refusal wording are CLI-surface text no `crust_*`
tool consumes (the MCP server does not shell out to `--version`), so
`src/mcp/` and the skills stay as-is (recorded, not skipped).

**Dossier correction made in place:** item 4's option "accept multiple
positionals **like `test-pipes` does**" rested on a FALSE premise — measured
(`~/tmp/g36/` A3): `test-pipes` refuses a second target with the identical
`unexpected argument` error (its cli.ts had the same `rest.length > 0`
throw). Both tools are one-target by design (`parseFlags`, one positional —
design rule 2). The chosen shape is therefore the dossier's other option:
document one-target-per-call + name the workaround in the error. The twin
`test-pipes` message was fixed in the same commit (scope-extension precedent:
same papercut, found while fixing this one).

## 1. `--version` prints a bare version string — FIXED

Measured before: `./bin/crust --version` → `0.2.0-dev`. Readers checked by
hand first, as the dossier required: `tests/cli.test.ts` pinned `^\d+\.\d+`
(anchored — would break), the Jenkinsfile Build stage compared
`[ "$got" = "$APPS_VERSION" ]` (exact — would break),
`.github/workflows/release.yml` "Verify stamped version" compared the tag
(exact — would break). The npm launcher execs the binary (no version
parsing); `npm/lib/install.mjs` reads the registry index, not the binary;
the site and USAGE display no `--version` output.

Fix: `src/index.ts` now writes `crust ${pkg.version}`; all three exact
readers updated in the same commit; the pin now asserts
`/^crust \d+\.\d+/` (mutation-checked: reverting the source kills exactly
that test). Measured after: `crust 0.2.0-dev`.

## 2. CI-built versions name a commit not reachable from main — FIXED (gate)

Re-verified: `25195c9` is not even an object in the local clone
(`git cat-file`/`git log` both fail) — provenance nobody can check out.

Fix in the Jenkinsfile Version stage: record `GIT_BRANCH` into `version.env`
(and the build log), then gate publishing on main reachability —
`git fetch origin main` → `git merge-base --is-ancestor "$SHA" FETCH_HEAD`
(falling back to a cached `origin/main`). Provably unreachable → **FAIL**
with the branch named and the remedy ("merge to main first, or do not
publish this build"); origin/main unresolvable → loud **WARN** without
blocking (an infra failure must not masquerade as provenance, but a proven
unreachable sha never publishes). The git sequence was run locally against
this repo (HEAD on main → reachable → PASS path; the earlier `25195c9`
check demonstrates the FAIL path's predicate). All 7 Jenkinsfile `sh` blocks
pass `bash -n` after Groovy un-escaping.

## 3. The `$N` breaking change — record-only (unchanged)

The changelog entry the dogfood asked for already exists (`CHANGELOG.md:27`,
`docs/USAGE.md:177`). What was missing was the *diagnostic* — filed and
shipped in G34. Recorded here so the item is not done twice.

## 4. `test-fixture` refuses a second target without naming the workaround — FIXED

Measured before (exit 2 both): `test-fixture: unexpected argument
"b/*.crust.ts"` / `test-pipes: unexpected argument "b/*.pipes"` — no
workaround named. The workaround was MEASURED before being documented
(`~/tmp/g36/` A4): `test-fixture '{a,b}/*.crust.ts'` against a live mock
ran both directories (`2 file(s), 2 run(s): 2 pass, 0 fail, 0 error`,
exit 0) — `expandTarget` treats `{}` as glob syntax and `Bun.Glob` expands
braces.

Fix: both refusals now append `— one target per call; to run several sets,
use a brace glob like '{a,b}/*.crust.ts'` (`.pipes` for test-pipes);
`docs/USAGE.md` carries it in the builtins table row and the
`### test-fixture` section; two new pins in `tests/cli.test.ts` (exit 2 +
message wording, each mutation-checked in isolation).

## Tests & gates

- New pins: `--version` shape, test-fixture two-glob, test-pipes two-glob —
  each mutation-checked one site at a time (revert → exactly its own test
  dies, controls stay green).
- `bun test`: **1406 pass / 2 skip / 0 fail** (1408 total, 54 files — the
  baseline + the 2 new pins). `tsc --noEmit` clean. Biome 0 errors on the
  three changed src files. `release.yml` re-parsed as valid YAML. Binary
  rebuilt (`bun run build`) before the green probe and the site gates.
- Site gates re-run against the rebuilt binary (no site change): 31 pages /
  362 examples / 1313 links — unchanged.

## Commit

- crust (this commit) — `audit: G36 fixed` — src/index.ts, src/testFixture/cli.ts, src/testPipes/cli.ts, tests/cli.test.ts, Jenkinsfile, .github/workflows/release.yml, docs/USAGE.md, dossier, plan tick, FIX-PROGRESS ⑦
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `98fad27d`) — `round-9-cli-contract.md` §9
