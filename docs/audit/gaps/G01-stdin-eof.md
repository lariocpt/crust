# G01 — "Shell stages see EOF on stdin" is wrong for script mode

**Doc:** `docs/USAGE.md:2191-2192` ("script/piped mode (stdin is drained before
the first line runs)") and the `cmd | crust` row of the run-mode table
(`docs/USAGE.md:69`).

## Measured (2026-10-16)

| invocation | behaviour |
|---|---|
| `printf 'DATA1\nDATA2\n' \| crust prog.crust` (prog has a `wc -l` shell stage) | stage printed **2** — it ate the piped data. `src/index.ts` never drains stdin in script-file mode (`markStdinConsumed` is called only on the piped-program path, `src/index.ts:275`) |
| `printf '…' \| crust` (piped *program*) | shell stage saw **0** lines — drained, as documented |
| `printf 'DATA1\nDATA2\n' \| crust -c 'stdin \| wc -l'` | **2** — the `stdin` source works in `-c`, nothing is drained |

So the drain is a property of `cmd | crust` only. The doc says "script/piped".

## Fix

Docs-only. Two edits, one truth:

- The limits bullet: name the mode — "Shell stages see EOF on stdin **when the
  program itself is piped in** (`cmd | crust`), because crust reads stdin to EOF
  before the first line runs. `crust file.crust` does **not** drain stdin: its
  shell stages inherit the pipe and will consume it, so never pipe *data* into a
  script that also reads stdin."
- The `cmd | crust` table row already says the right thing; make the wording
  match the bullet exactly, and add the `crust file.crust` + piped-data case.

## Decision to record: no code change

A guard is possible (script mode + stdin not a TTY + a shell stage that reads
stdin) but it cannot be detected reliably — `wc -l` and `cat` read stdin, `echo`
does not, and sh decides. A wrong guess would be a false alarm on working
scripts. State the rule instead of guessing it.

## Tests

Add to `tests/stdin.test.ts` (existing file) — pin the three measured cases so
the *documented* distinction is the tested one: piped-program drains (0),
script-file inherits (2), `-c` + `stdin` source reads (2). If they already
exist, no change; check first.

## Docs / website / KB

- `docs/USAGE.md`: limits bullet + run-mode table row.
- Website: the run-modes table lives in `src/pages/docs/quickstart.mdx` /
  `intro.mdx` (grep `| crust` to find the copy) — same correction.
- KB: one paragraph in `knowledge/learnings/round-10-limits-measured.md`.

## Commit

`docs(stdin): the EOF-on-stdin claim was about piped programs, not scripts`
