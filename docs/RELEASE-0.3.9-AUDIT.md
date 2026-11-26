# Published Crust 0.3.9 provenance audit

This audit informed the coordinated 0.4.0 milestone. It establishes that request
planning was already in the published 0.3.9 distribution; it is not evidence
that 0.4.0 has been published. See the
[release checklist](DOCUMENTATION-RELEASE-CHECKLIST.md) for publication gates.

## Source and registry identity

- The annotated `v0.3.9` tag resolves to
  `dbb3223ce8d96c06e79ae89b4a37e4a79903fe35`.
- Public npm metadata for both `@lariocpt/crust@0.3.9` and
  `@lariocpt/crust-mongo@0.3.9` records that same `gitHead`.
- Both downloaded npm tarballs passed their registry SHA-512 integrity and
  SHA-1 checks. Each contained 15 regular files: a stamped manifest, launcher,
  installer helpers, postinstall script, README, and ten skill files.
- All 14 non-manifest files in each package matched the tagged `npm/` and
  `skills/` sources byte for byte. Manifest differences are the release
  workflow's package name/version, public source, platform, and variant stamps.
- The packages contain launchers, not compiled binaries or the TypeScript
  source tree. Their public resolver selects `v${pkg.version}` release assets
  and verifies `SHA256SUMS`; it does not substitute the newest public release.

The source comparison is reproducible from the
[0.3.8-to-0.3.9 comparison](https://github.com/lariocpt/crust/compare/v0.3.8...v0.3.9)
and the [0.3.9 release](https://github.com/lariocpt/crust/releases/tag/v0.3.9).

## Runtime functionality already shipped

The tagged source includes effective operation/root security, supported header
authentication alternatives, merged parameters, static query baselines and lazy
query resolvers, conservative schema/format proofs, generated header guards,
and explicit unsupported prerequisites. A blocked derived CRUD flow is omitted
as a whole, including cleanup.

These changes and their offline regression tests are already in 0.3.9.
The isolated 0.4.0 milestone starts from public `main`; it does not import the
separate website-builder feature branch or claim those changes as new.

## Published binary evidence

The GitHub release includes eight platform/variant assets and `SHA256SUMS`.
The manifest and GitHub asset digests agreed for the inspected Linux x64 assets:

| Asset | SHA-256 |
| --- | --- |
| `crust-linux-x64` | `8c468b57fd6623d4a4dff3b2fcde391a925c19ce8a7f08fbe73fba89d1bde6ef` |
| `crust-linux-x64-mongo` | `15e5b2448a065b9a138b650957ee884f52c02b9aae7669fd8b8b3f88ded1fd60` |

A locally cached published Mongo binary matched its release checksum before
execution. Only its metadata flags were run, with configuration disabled:

- `--version`: `crust 0.3.9`.
- `--build-info`: version `0.3.9`, commit
  `dbb3223ce8d96c06e79ae89b4a37e4a79903fe35`, Bun `1.4.3`, platform `linux-x64`.

The clean binary was not independently executed in this audit.

## Boundaries

The audit did not install packages, execute package postinstall scripts, run an
application API, connect to an application database, execute fixtures or load
tests, or establish MCP-host registration. Matching shipped skills and compiled
source provenance does not prove that any host has installed or exposed them.
Existing published tags and package versions must not be overwritten.
