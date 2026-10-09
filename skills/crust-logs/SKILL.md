---
name: crust-logs
description: Search a live log stream with crust's `logs` session — it holds a tail/procs/shell source open, keeps a ring buffer, and re-runs every typed pipeline fragment over the buffered past and then the live stream; `json on` parses NDJSON at query time, `search` counts the buffer instantly, `buffer N` resizes without restarting. Use when tailing dev services or containers, when a grep workflow keeps losing history, or when you want to widen a filter over logs you already saw.
---

# crust logs

## What it is

`logs <source>` keeps the source open and a ring buffer (default 10,000 items)
behind it, so one query can look at the PAST you already streamed and stay
attached to the live firehose. Every line you type at `logs>` is an ordinary
crust pipeline fragment — the whole shell grammar is the query language.

```crust
logs tail -n 0 -F app.log
logs procs({web: "bun run dev", api: "bun api.ts"})
logs docker logs -f my-container
logs --buffer 50000 tail -F big.log
```

Boot prints what it holds: `logs: tail -n 0 -F app.log — buffering last 10000
items (`help` for commands, `exit` to leave)`.

## A fragment runs TWICE

Once over the buffer snapshot, then over the live stream until Ctrl-C, past a
`-- live --` marker. So side effects fire twice: append with `>>`, never `>`,
and a `POST` fragment re-sends buffered matches.

- **Ctrl-C once** ends the live view *gracefully* — the stream finishes, so
  terminal stages flush (a query ending in `stats` prints its summary right
  then; `wc -l` prints its count). **Ctrl-C twice** hard-cancels a stuck query.
  The session survives both.
- A query that fails on the retro pass prints its error and re-prompts. Errors
  never kill the session or the held source.

## Session commands

| command | what it does |
| --- | --- |
| `search <text>` | fixed substring over the BUFFER only — matches highlighted, and a count that always prints, zero included (`search: 5 matching item(s) of 36 buffered`). No live view, no Ctrl-C. For regex/case-folding/live, run a `grep` query |
| `json on` / `json off` | parse string items at QUERY time (see below) |
| `buffer` / `buffer N` | report usage (`buffer: 57/10000 items (pushed 57, evicted 0)`) or resize live, newest kept — widen a too-small window without losing the held source |
| `clear` | empty the buffer (`buffer cleared`) |
| `help` | the command list, including the double-run note |
| `exit` / Ctrl-D | tear the source down and leave (procs get SIGTERM→SIGKILL) |

Query errors print and re-prompt; up-arrow recalls earlier queries.

## json on — and the silent zero it prevents

With `json off` (the default) items are the raw strings. A lambda that reads
fields therefore matches NOTHING, quietly: 50 buffered NDJSON lines, and
`filter (e => e.level >= 30) | wc -l` reported `0`. `json on` fixes that at
query time: a string item parsing to a JSON **object or array** reaches your
lambdas parsed; plain text, strings that parse to primitives (`"42"` stays a
string), and non-string items flow through unchanged and are counted out loud.
The ring stores raw items, so `json off` is a lossless revert.

When the buffer looks like NDJSON the session prints, once, on your first
*pipeline fragment* (not on `help` or `search`):

```
hint: buffer looks like NDJSON — `json on` parses object lines at query time (`json off` reverts)
```

It never auto-enables — changing the item type under a lambda you already typed
would be a false picture.

## Item types by source

- `tail`/shell sources: plain **strings**.
- `procs({...})`: `{proc, stream, line}` **objects** — the session tells you so
  at boot (`logs: items are {proc, stream, line} objects — try (l => l.line) or
  filter (l => l.proc === "web")`). `(l => l.line)` extracts text,
  `filter (l => l.proc === "web")` selects one process, and `search` still works
  (it matches each item's rendered form).
- Pretty-printing is just another stage: `grep api_request | pino-pretty
  --colorize --singleLine` (`--colorize` forces ANSI through the pipe; local
  `node_modules/.bin` is on PATH). Normalize `procs` objects first.

## Traps

- `logs` is interactive-only. No tty → exit 2 and a pointer:
  `logs: interactive session needs a tty — for piped data use `cmd | crust -c 'stdin | …'``.
  For piped data there is no session — build the pipeline directly.
- The `logs` line owns its line: `logs tail -F app.log | grep ERROR` refuses
  (`logs is a crust builtin — it runs in-process, so sh cannot run it`) rather
  than letting sh report `command not found`. Type the filter at `logs>`.
- A gate query (`count 1`, `expect 200`) runs against the BUFFER first — a
  retro failure prints before a single live item arrives. That is the honest
  order, but it means `logs`+gate reflects history, not just what follows.
- `search` is buffer-only and fixed-substring: it never sees live items and
  never interprets regex.
- Ctrl-C at an idle `logs>` prompt is nothing: it prints `^C` and re-prompts,
  the source keeps running. `exit` (or Ctrl-D) is the teardown — verified with a
  `procs` source, including after a Ctrl-C: the group gets SIGTERM→SIGKILL and
  no `sleep` survives the session.
