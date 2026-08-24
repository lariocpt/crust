# crust

A pipeline-first devops toolkit built on Bun, shipped as one binary: a
spec-driven OpenAPI mock server, fixture and load-test runners, a process
orchestrator, and a link checker — every tool composes on the same `|` stream,
driven from an interactive REPL, a `crust -c` one-liner, or a `.crust` script.

```bash
npm i -g @lariocpt/crust
```

```bash
# Load testing
crust -c 'range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats'

# API smoke test — every fixture file's contents, POSTed and asserted
crust -c 'read fixtures/*.json | POST :3000/users | expect 201'

# Log mining
crust -c 'lines **/*.log | grep ERROR | filter (l => !l.includes("healthcheck")) | wc -l'
```

**Documentation: https://lariocpt.github.io/crust-website/**

Source and issues: https://github.com/lariocpt/crust

## What this package installs

This package is a ~4 KB launcher, not the binary. On first use it downloads the
`bun build --compile` executable for your platform from the matching GitHub
Release, verifies its published sha256 before the file is ever made executable,
and caches it under `~/.cache/crust`. Every install route resolves that same
artifact.

Supported platforms: linux x64/arm64, macOS x64/arm64. On anything else, build
from source — see the repository README.

### Environment variables

| Variable | Effect |
|---|---|
| `CRUST_SOURCE` | `github` (default for this package) or `apps` — which artifact plane to resolve from. |
| `CRUST_GITHUB_REPO` | Override the `owner/repo` the release is fetched from. |
| `CRUST_APPS_URL` | Base URL of a self-hosted artifact plane, used when `CRUST_SOURCE=apps`. |

MIT © Lario Borges
