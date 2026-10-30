# G36 — version output, CI-tag provenance, and two documented-behaviour papercuts

**Status: OPEN** (small, non-blocking; batch of four from the 2026-10-30 dogfood,
NOTES-3). Grouped because all four are "what crust says about itself", and all four
are cheap enough to land in one pass.

## 1. `--version` prints a bare version string

Measured: `./bin/crust --version` → `0.2.0-dev`. Sibling tools print
`flawless-react 0.3.0-dev`. A bare `0.2.0-dev` is ambiguous in a log line that
interleaves tools — and `crust --version` is what CI pastes. Fix:
`crust <version>` (keep it one line; check nothing parses the old shape — the npm
installer and Jenkins both read version-ish strings, so verify before changing).

## 2. CI-built versions name a commit that is not reachable from main

Reported: registry `0.2.0-ci.34.25195c9` → `git log 25195c9..HEAD` **fails**: the sha
is not reachable from `main`. A published version whose provenance cannot be checked
out is not provenance. Fix in the Jenkins job: embed the ref it was cut from
(branch + sha), and prefer building what `main` can actually resolve.

## 3. The `$N` breaking change — already documented (report claim corrected)

The dogfood report asked for a changelog entry for "`$1` in a quoted string now
expands positionally". **It already exists**: `CHANGELOG.md:27` states it, with the
SQL consequence and the `?` form, and `docs/USAGE.md:177` repeats it. Verified
2026-10-30. What is genuinely missing is the *diagnostic* (filed in G34), not the
note. Recorded here so the correction is on the record and the item is not done twice.

## 4. `test-fixture` accepts exactly one target

Measured: `./bin/crust test-fixture 'a/*.ts' 'b/*.ts'` →
`test-fixture: unexpected argument "b/*.ts"` then the usage line. That is consistent
with `parseFlags` (one positional) so it is **by design**, not a bug — but two CI
scripts in the wild pass two globs. Two acceptable answers, pick one:
document "one target per call; use a `{a,b}` glob" in the builtins table row, or
accept multiple positionals like `test-pipes` does. Whichever is chosen, the error
text should say so — today it refuses without naming the workaround.

## Tests

- `--version` shape pinned by a CLI test (and the npm/Jenkins readers checked by hand
  in the same pass).
- `test-fixture` two-glob case pinned to whichever contract is chosen, including the
  error message wording.
- 2 and 3 are pipeline/doc work: verified by publishing a tag and reading it back.
