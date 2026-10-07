---
name: crust-builtins
description: crust has two separate namespaces — tool builtins (`mock-server`, `test-fixture`, `verify-web-links`, `logs`, `dotenv`) that need a line of their own, and registered functions (`base64`, `salt`, `jwt`, `bundle`, `sql`, `wait`) that are space-separated stages usable as a source or mid-pipeline. Explains what the upstream item means to each one, why `bundle(5)` is a shell syntax error, and how to reach crypto/FS from a lambda. Use when a crust stage exits 2 with `syntax error near unexpected token`, when a mid-pipeline function eats the wrong argument, or when a lambda says `salt is not defined`.
---

# crust's two namespaces

| | What it is | Where it runs | Parens? |
| --- | --- | --- | --- |
| **Tool builtin** | `mock-server`, `test-fixture`, `test-pipes`, `gen-fixtures`, `verify-web-links`, `logs`, `dotenv`, `skills` | dispatched **before** pipeline parsing, in-process, own line | subcommand style: `logs tail -F app.log` |
| **Registered function** | `base64`, `salt`, `jwt`, `bundle`, `sql`, `wait` + anything you add with `crust.fn` | an ordinary pipeline stage, or a source when nothing is upstream | **space-separated**: `salt 16`, not `salt(16)` |

`cd`, `export`, `alias`, `source`, `exit`, `history` and `help` are builtins
too — the ones sh has its own version of, which is why a redirect on *those* is
left to sh. `procs`, `range`, `load`, `read`, `tail` and friends are **sources**,
not builtins.

The single most common mistake is writing the JS form:

```
bundle(5)   →  sh: -c: line 1: syntax error near unexpected token `('   (exit 2)
```

Parens are crust syntax only for **lexer sources** (`range(0,9)`,
`read("…")`) — everything else in a stage is a shell word list.

A stage that *starts* with `{` or `[` is a JSON literal only when it is one,
or still looks like someone typing one (a quote or colon, no shell operator).
Shell grouping and the shell's test bracket are therefore shell stages, in any
position — and a mid-pipeline one works too, which it used not to:

```crust
{ echo a; echo b; } | cat
[ -f package.json ] && echo there
```

## What the item means, per function

A registered function is called `fn(item, ...lineArgs)` mid-pipeline. So the
first slot is **your data**, and each function decides what to do with it:

| Function | As a source | Mid-pipeline |
| --- | --- | --- |
| `base64 [-d\|decode]` | encodes the literal argument | encodes (or decodes) **each item** |
| `salt [bytes] [hex\|base64\|base64url]` | one salt, size = the argument | **one salt per item**; the size is the argument *trailing* the item |
| `jwt sign\|verify\|decode --secret <s>` | payload/token = the argument | the item **is** the payload (sign) or token (verify/decode) |
| `sql "<query>" [params…]` | streams rows | the query stays the one you wrote; the item **binds as the first parameter** when the line declares none |
| `wait <target> [--timeout <dur>]` | waits for the argument | the item is the target |
| `bundle <entry> [--outfile…]` | bundles the argument | a string item **is an entrypoint** |

```crust
base64 hello
echo aGk= | base64 -d
salt 32 base64
lines users.csv | salt 16
jwt sign '{"sub":"42"}' --secret k
sql "select id, email from users limit 5" | (r => r.email)
range(2,2) | (n => "beta") | sql "SELECT name FROM t WHERE name = ?" | assert (r => r.name === "beta")
wait :3001/health --timeout 30s
bundle src/index.ts --outfile dist/app.js --minify
```

`wait` failing to become ready exits **1** — measured for every target form
(`:PORT`, `:PORT/path`, `port:PORT`) and for a `--timeout` that expires. crust
has no exit **124**: that number is `timeout(1)` killing crust from outside, so
wrapping a probe in `timeout` steals the code you were gating on.

## A lambda cannot call them

Registered functions live in crust's function table, not in the JS scope a
lambda compiles into:

```
range(2,2) | (x => salt(4))   →  crust: salt is not defined   (exit 1)
```

That is not a dead end: a lambda body has Bun's own globals, and `await` works
in it, so reach the underlying capability directly.

```crust
range(0,9) | (_ => crypto.getRandomValues(new Uint8Array(8)).toHex())
range(0,0) | (_ => JSON.parse(await Bun.file("package.json").text()).name)
```

Prefer the registered function when it fits (`salt 16` per item is shorter than
the `crypto` line); drop to a lambda when you need something crust doesn't ship.

## These are not shell commands

`base64`, `sort`, `head`, `wc` and friends exist as **real binaries** too. crust
runs its own when the name is registered (`base64 hello` encodes the *text*, not
a file), and sh's when it is not (`… | sort` is `/usr/bin/sort`). Neither one
takes a redirect: crust refuses it and tells you what to write instead — with
two different messages, because a function and a tool fail differently.

A **registered function** with a redirect is refused as a stage, and pointed at
a shell tail:

```
sql "select 1" > one.txt
  → crust: `> one.txt`: crust has no redirect except on a shell stage, whose
    text goes to sh as-is — a sql stage would read it as data. to save a
    pipeline, end the line with a shell stage instead: | cat > one.txt
```

```crust
base64 hello | cat > out.b64
```

A **tool builtin** is refused as a program, and the message prints the exact
whole-invocation redirect that works:

```
verify-web-links --base-url https://example.com --json > report.json
  → crust: verify-web-links is a crust builtin, it runs in-process and cannot
    redirect. Redirect the whole invocation instead:
    crust -c 'verify-web-links --base-url https://example.com --json' > report.json
```

```bash
crust -c 'verify-web-links --base-url https://example.com --json' > report.json
```

Tools that produce a file themselves have a flag for it (`-o` / `--outfile` /
`--report`); check that before reaching for `>`.
