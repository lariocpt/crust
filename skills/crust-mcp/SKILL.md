---
name: crust-mcp
description: Drive crust directly from an MCP-capable agent (OpenCode, Claude Code, Codex, Cursor) instead of a shell — `crust mcp` exposes every capability as a first-class tool: run_line, check_line, test_fixture/test_pipes, gen_fixtures, load_run, verify_web_links, plus lifecycle mock servers, supervised procs, and buffered log sessions that stay open across calls. Use when configuring crust as an MCP server, choosing which crust_* tool fits a task, or reasoning about what persists between tool calls and what does not.
---

# crust over MCP

`crust mcp` speaks JSON-RPC 2.0 over stdio — one message per line. It is a
whole-process MODE, not a REPL builtin: the MCP host owns stdin and stdout.

## Install & configure

`crust` must be on PATH (either channel works — same binary):

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
# or: npm i -g @lariocpt/crust
```

Then register it with the agent host — e.g. OpenCode / Claude Code style:

```json
{ "mcpServers": { "crust": { "command": "crust", "args": ["mcp"] } } }
```

Verify by hand — the transport is just lines on stdin:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | crust mcp
```

## Two execution planes — what persists

| Plane | Tools | State |
| --- | --- | --- |
| **One-shot** | `crust_run_line`, `crust_check_line`, `crust_test_fixture`, `crust_test_pipes`, `crust_gen_fixtures`, `crust_verify_web_links`, `crust_load_run` | a fresh crust CHILD per call — `cwd`/`env` apply per call and NEVER carry over; pass them explicitly |
| **Lifecycle** | `crust_mock_server_start/stop/list/violations`, `crust_procs_start/stop`, `crust_logs_open/query/close` | held IN the server across calls; every held job dies when the server exits |

`crust_run_line` runs ordinary crust grammar — one line, `|`-stages, lambdas:

```crust
range(1,5) | (n => n * n) | stats
```

## Honest failure — never a false pass over MCP

A nonzero child exit, a killed timeout, a failed `assert`, a mock validation
error is an **`isError` result** carrying the verbatim exit code and output.
Zero matches is answered with an explicit "zero items", never silence. Trust
`isError`; the text is evidence, not a verdict.

## Picking the right tool

- Validate generated crust first — `crust_check_line` parses without running
  (files and ports don't need to exist).
- `crust_procs_start` supervises dev services (env/after/ready/restart per
  proc). Its stream is queried through `crust_logs_query` — items are
  `{proc, stream, line}` objects. Gate readiness in a follow-up:

```crust
wait :3000/health
```

- `crust_logs_open` holds a tail/shell/`procs({…})` source with a ring buffer;
  `crust_logs_query` runs a pipeline fragment over the buffered past, then
  live for `live_ms` — `json: true` parses NDJSON items before the fragment:

```crust
filter (l => l.proc === "api") | (l => l.line) | grep -i timeout
```

- `crust_mock_server_start` defaults `port: 0` (OS-assigned) — always take
  the returned `url`. `proxy: "<upstream>"` turns it into a conformance audit;
  read findings with `crust_mock_server_violations`.
- `crust_load_run` composes the documented pipeline (`load … | parallel … |
  … | stats | assert`); an `assert` failure is `isError` — a run that
  measured nothing is refused (`empty`), never a green gate.

## Limits, stated

- One tool call runs at a time (the interrupt bus is process-global).
- Output is tail-capped per stream and truncation is always announced.
- `crust_procs_stop` reports "teardown still in flight past 10s" honestly
  when a child ignores SIGTERM — crust kills it on server exit.
