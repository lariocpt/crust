# crust — internal (LAN) channels

Public installs come from GitHub Releases and npmjs.org; see the
[README](../README.md). This page documents the parallel LAN plane, which
predates the public one and is still what the Jenkins job publishes. It is only
reachable on the home network.

## Install from the LAN plane

```bash
curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust
npm i -g crust --registry https://npm.in.drlario.org
```

Both resolve the same binary that Jenkins published and verify the same sha256.

## Two planes, one launcher

The npm launcher (`npm/lib/install.mjs`) resolves its binary from whichever
plane it was published for. The plane is stamped into the published
`package.json` as `crust.source`, and `CRUST_SOURCE` overrides it at runtime:

| Plane | `crust.source` | Package | Resolves via |
|---|---|---|---|
| Public | `github` | `@lariocpt/crust` on npmjs.org | GitHub Releases asset + `SHA256SUMS` |
| LAN | `apps` | `crust` on npm.in.drlario.org | `apps.in.drlario.org/index.tsv` |

The in-repo `npm/package.json` keeps the LAN defaults, so a Jenkins build needs
no change; the release workflow stamps the public values into a staging copy at
publish time.

Useful overrides:

- `CRUST_SOURCE=apps npm i -g @lariocpt/crust` — public package, LAN binary.
- `CRUST_APPS_URL=https://host` — point the apps plane somewhere else.
- `CRUST_GITHUB_REPO=owner/repo` — point the github plane at a fork.

## Versioning

The two LAN planes version the same build differently, deliberately:

- apps plane: `<base>+<shortsha>` (e.g. `0.2.0+78f2a43`)
- npm plane: `<base>-ci.<build>.<sha>` (e.g. `0.2.0-ci.42.78f2a43`)

semver ignores build metadata after `+` when ordering, so the registry cannot
use the apps form; the shared short sha ties one back to the other and is what
the launcher matches on. The public plane has no such split — the release tag
`vX.Y.Z` is the version on both channels.

## Install manifest

The launcher records what it installed in `install-manifest.json` inside the
package directory: the plane (`source`), the binary's version (`version`), the
package version that asked for it (`packageVersion`), the cached `bin` path,
its `sha256`, and the plane it came `from`. Every run re-validates the file:
a missing file, a parse error, a vanished `bin`, a different `source`, or a
different `packageVersion` is a cache miss — the binary is re-resolved, the
sha256 re-verified, and the manifest rewritten. A package version bump
therefore self-heals instead of leaving a stale manifest shadowing the new
release until the file is deleted by hand.

`packageVersion` was added with the validation, so manifests written by older
launcher releases lack it; those are accepted on a core-version match of the
binary's own version (`0.2.0+78f2a43` ≡ `0.2.0-ci.42.78f2a43` ≡ `0.2.0`),
which means upgrading the launcher costs at most one re-verification, after
which the new shape pins the binary.

## Publishing

- **LAN:** the Jenkins job `crust` (see [`Jenkinsfile`](../Jenkinsfile)). Binary
  to `/srv/apps` first, then the npm launcher — the launcher resolves
  `index.tsv`, so publishing npm first ships a package that cannot install
  itself.
- **Public:** push a `v*` tag; `.github/workflows/release.yml` builds the four
  platform binaries, uploads them with `SHA256SUMS`, and only then publishes
  `@lariocpt/crust`. Same ordering invariant.
