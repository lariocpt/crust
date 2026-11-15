---
name: crust-mcp
description: Drive crust from an MCP-capable agent through stdio JSON-RPC — choose among run/check, fixture/pipes, generation, load, link verification, and held mock/procs/log tools. Understand host-specific registration, per-tool schemas, syntax-only validation, optional load gates, error results, and what persists or requires separate application cleanup.
---

# crust over MCP

`crust mcp` speaks JSON-RPC 2.0 over stdio — one message per line. It is a
whole-process MODE, not a REPL builtin: the host owns stdin and stdout.
Repository execution, credential, write, cleanup, and load policies apply;
this skill grants no permission to install or run anything.

## Install & configure

Use an approved existing Crust executable, or install only when authorized.
The compiled binary embeds its runtime. Register it in the settings of the
particular MCP host; there is no universal configuration shape. For hosts
using `mcpServers` (for example Claude-style configuration):

```json
{ "mcpServers": { "crust": { "command": "crust", "args": ["mcp"] } } }
```

VS Code's workspace `.vscode/mcp.json` uses a different shape:

```json
{
  "servers": {
    "crust": { "type": "stdio", "command": "/ABS/PATH/to/crust", "args": ["mcp"] }
  }
}
```

Prefer an absolute executable path when the GUI host's PATH differs from
your shell; bare `crust` works only if that host can resolve it. Code - OSS
or VSCodium needs an MCP-capable host extension. Registration in Copilot
does not register the server in another agent: each host can have separate
settings, permissions, and tool-exposure/discovery policies.

New grammar is available through `crust_run_line` when the installed binary
supports it. Dedicated named tools still have wrapper schemas: new CLI
arguments do not automatically become new MCP arguments or tools.

When execution is approved, the transport can be checked directly:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | crust mcp
```

Startup loads normal Crust config, including user `init.ts` code and optional
`--env-file`; starting the server is not a side-effect-free syntax check.

## Two execution planes — what persists

| Plane | Tools | State |
| --- | --- | --- |
| **One-shot** | `crust_run_line`, `crust_check_line`, `crust_test_fixture`, `crust_test_pipes`, `crust_gen_fixtures`, `crust_verify_web_links`, `crust_load_run` | a fresh child per call; accepted overrides do not create a persistent session |
| **Lifecycle** | `crust_mock_server_start/stop/list/violations`, `crust_procs_start/stop`, `crust_logs_open/query/close` | held in the server across calls; server shutdown tears down held jobs |

Read the schema before supplying overrides:

- `crust_check_line` accepts only `line`, with a fixed 15s watchdog.
- `crust_gen_fixtures` and `crust_verify_web_links` accept `cwd` and
  `timeout_ms`, but NOT `env`.
- Run-line, test, and load tools accept per-call `env` overlays on the
  inherited environment, not a replacement. An export in one child does
  not carry into the next.
- Generator `parameterValues`, `resolveParameter`, and `expectations`
  belong in its setup module, not top-level MCP arguments. `out` is deleted
  and recreated. Review supported cases, prerequisites, and omissions in
  `gen-manifest.json`; generation is not execution or verified coverage.

`crust_run_line` accepts ordinary grammar, including multiple script lines:

```crust
range(1,5) | (n => n * n) | stats
```

## Tool classes and teardown tiers

The `initialize` handshake advertises these classes:

- **Syntax check** — `crust_check_line` launches a `--check` child and may
  launch `sh -n`. It does not execute supplied stages, read their referenced
  data, or send their requests. It does NOT inspect TypeScript fixture
  contents or prove that a command will pass.
- **Execution** — run-line, tests, and generation can perform real I/O,
  imports, writes, or arbitrary stages; approvals remain the caller's job.
- **Network/load generation** — load and link verification need approved,
  bounded targets; load requires separate non-production approval.
- **Long-lived resources** — mock, procs, and log sessions remain held.

Stopping local processes kills supervised groups; stopping mocks releases
listeners. Persisted state files/DBs and remote resources survive local
teardown. Execution tools CAN create/change/delete application data;
teardown does not undo those actions. Define application cleanup separately.

## Honest failure — read the actual gate

Nonzero child exits and killed timeouts yield `isError` with captured output
(subject to announced caps). A failing `assert` becomes an error through the
child's nonzero exit. `isError: false` is NOT independent proof that requests
succeeded or that all desired checks ran.

Timed HTTP failures are records (`status: 0`), not necessarily exceptions.
Proxy conformance violations are findings to inspect with
`crust_mock_server_violations`, not automatic tool failures. Log queries
can explicitly return "zero items"; zero matches are not universal errors.

Known-tool argument/run failures yield error results; unknown tool names or
malformed protocol parameters can instead yield JSON-RPC errors. A host-side
"unavailable tool" string alone does not prove where dispatch failed:
inspect host registration/exposure and server frames before attributing it.

## Picking the right tool

- Check generated Crust command text first, then run only the approved
  scope. Syntax checks do not validate fixtures or their imported helpers.
- `crust_procs_start` supervises dev services (env/after/ready/restart).
  Query `{proc, stream, line}` records with `crust_logs_query`. Gate readiness
  in a follow-up rather than sleeping:

```crust
wait :3000/health
```

- `crust_logs_open` holds a tail/shell/`procs({…})` stream with a ring buffer.
  Query the buffered past, then live for bounded `live_ms`; `json: true`
  parses NDJSON items before the fragment. The following is a
  `crust_logs_query` fragment, whose upstream records are supplied by the
  tool, not a standalone command:

```text
filter (l => l.proc === "api") | (l => l.line) | grep -i timeout
```

- `crust_mock_server_start` defaults to `port: 0`; use the returned `url`.
  `proxy` audits a real upstream; inspect findings explicitly.
- `crust_load_run` composes `load … | parallel … | target | stats`, adding
  post-stats `assert` stages ONLY when supplied. Without `assert`, an empty
  or all-failed measurement can exit 0. Supply status-first gates before
  latency/rate thresholds, for example:

```json
{
  "target": "GET http://localhost:3000/health --timeout 2s",
  "duration": "10s",
  "rate": 25,
  "assert": [
    "s => s.status[\"200\"] === s.count",
    "s => s.p95 < 250"
  ]
}
```

With an assertion, a tagged empty stats summary is refused. An `expect`
inside `target` runs BEFORE stats, so its failure suppresses the summary;
post-stats gates preserve it. Window/final guards need `stats_every`; without
it the tag keys are absent and guarded thresholds short-circuit. Dropped
slots warn on stderr, not as an automatic failure or stats-summary field:
passing a minimum-rps gate does not prove the full target was offered.

## Limits, stated

- One tool call runs at a time; a long crawl or load blocks subsequent calls.
- Output is tail-capped per stream (256 KB); truncation is announced.
- Lifecycle relative paths resolve against the server's cwd; use absolute
  paths or configure the host's working directory.
- A procs stop past 10s can report "teardown still in flight"; that is not
  proof all children have already exited.
