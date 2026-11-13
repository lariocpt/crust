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

VS Code uses a DIFFERENT schema in `.vscode/mcp.json` (workspace) or the
user-level MCP settings — the `mcpServers` shape above silently fails there
("command is required" or the server just never appears):

```json
{
  "servers": {
    "crust": { "type": "stdio", "command": "/home/user/.local/bin/crust", "args": ["mcp"] }
  }
}
```

Two traps, both verified: (1) `"command"` must be the ABSOLUTE path — a
GUI-launched VS Code does not inherit the shell's PATH, so bare `"crust"`
dies `spawn crust ENOENT` if the launcher lives outside the default
lookup dirs; (2) VS Code's MCP support ships inside the Chat/Copilot Chat
extension — Code - OSS / VSCodium has no MCP host without an extension
(Cline, Roo Code or Continue each carry their own MCP settings).

Grammar lands automatically: the one-shot tools pass line/fixture text to a
fresh crust child untouched, so anything the lexer accepts (`--redirect`,
new builtins) is an MCP tool call the moment the installed binary has it —
no MCP-side change per feature.

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

## Tool classes and teardown tiers

The `initialize` handshake carries this taxonomy in `instructions` (0.3.6):

- **Static check** — `crust_check_line`: parses, runs nothing.
- **Execution** — `crust_run_line` and the test/gen tools: arbitrary stages,
  real side effects. Target approval, credentials, writes and cleanup stay
  the caller's responsibility.
- **Network/load generation** — `crust_load_run`, `crust_verify_web_links`:
  bounded generation, approved non-production targets only.
- **Long-lived resources** — mock server, procs, log sessions: held by the
  server process, die when it exits.

Teardown has three tiers and no tool crosses them: **local processes** are
killed whole (process group, grandchildren included); **mock sessions** close
(port released — `--state` files/DBs are application data and stay on disk);
**application data** is never touched — a container, row or queue a proc
created remotely survives its local teardown, releasing it is your job.

Transport contract: stdio JSON-RPC, one frame per line; one-shot tools spawn
a fresh crust child per call (`cwd`/`env` per call, nothing persists). A
refusal whose error string never appears in crust's own output (an
"unavailable tool" style host error) never reached the server — debug the
host's spawn command, not crust.

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
  … | stats | assert`); gates go in `assert` — one predicate, or an array of
  them (0.3.6), one assert stage per gate. An `expect` inside `target` runs BEFORE
  stats and suppresses the summary when it fails; a post-stats `assert`
  failure is `isError` with the stats still included. A run that measured
  nothing is refused (`empty`), never a green gate.

## Limits, stated

- One tool call runs at a time (the interrupt bus is process-global).
- Output is tail-capped per stream and truncation is always announced.
- `crust_procs_stop` reports "teardown still in flight past 10s" honestly
  when a child ignores SIGTERM — crust kills it on server exit.
