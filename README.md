# crust

A Bun-powered shell with first-class pipelines and devops primitives. Globs, HTTP verbs, parallel workers, and TypeScript lambdas all compose under a single `|` / `.pipe()` abstraction.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
```

## What it looks like

```bash
# API testing
fixtures/*.json | POST :3000/users | expect 201

# Load testing
range(0, 10000) | parallel 100 | GET :3000/health | expect 200 | stats

# Log mining
**/*.log | (l => l.includes('ERROR')) | wc -l

# Health monitoring
range(0, 100).parallel(() => fetch(url)) | expect 200
```

## Docs

- [docs/USAGE.md](docs/USAGE.md) — user-facing reference: sources, transforms, sinks, builtins, editor keybindings, `init.ts` configuration, examples, limits.
- [docs/spec/v0.1-contract.md](docs/spec/v0.1-contract.md) — the green-light test contract.
- [docs/PLAN.md](docs/PLAN.md) — design notes.

## Dev

```bash
bun install
bun test          # red/green TDD harness
bun src/index.ts  # try the shell
```
