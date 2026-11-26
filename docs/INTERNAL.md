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

## The `@crust/site` package (and why there is no third binary variant)

The site generator ships as the **`@crust/site` npm package** — the
`packages/site` workspace, own `package.json`, own semver, real dependencies
(`markdown-it` + `yaml` only) — run under plain Bun: `bunx @crust/site
build|dev`. The crust binary carries only a `site` **redirect stub**
(`src/builtinFns/site.ts`, the mongo-hint pattern: valid shape → redirect
message + exit 1, argument errors → exit 2, `--help` → exit 0; `crust
--check 'site build'` validates against the stub's `SITE_SPEC`).

**Do not build a third binary variant for this.** The measured basis
(crust AGENTS.md, 2026-11-12, Bun 1.3.14/1.4.3/1.4.4-canary): a compiled Bun
binary cannot resolve bare npm specifiers from files OUTSIDE its own bundle —
the mongo shim failed on `bson`, runtime `NODE_PATH` failed, absolute-path
imports failed the same way. A site's `site.config.ts` and layouts are exactly
such files: user-authored, imported from disk at run time, importing
`@crust/site` by bare specifier. No compiled binary can carry a builder whose
input must `import` from the user's tree, so the answer is a plain npm
package under Bun, and the stub exists only so `crust site …` fails loudly
with directions instead of `sh`'s 127.

Release coupling — a REQUIRED STEP for the first site release (`release.yml`
does not publish `@crust/site` today): publish it from the **same tag** as
the binaries, after the binary uploads. It is a JS package — no new
binaries, so the binary-before-launcher invariant is untouched. A LAN
Verdaccio mirror is optional in the Jenkins job (remember the Groovy
triple-quote backslash rule from the Jenkinsfile section above).

