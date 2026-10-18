# G21 — agent-skills builtins page: Traps bullet-1 measured table, row 1 base64 value does not match its own annotation

**Doc:** website `src/pages/docs/agent-skills/builtins.mdx` L210 (Traps bullet
1, three-line measured table, row 1). Audit T62, parity check 2026-10-18.

## Measured (site page vs `skills/crust-builtins/SKILL.md` L150–151, both fully read 2026-10-18)

Site L207–213 (the table, "Measured on a file containing `alpha\nbeta\n`"):

```text
base64 in.ts          → YjY0aW4udHh0          "in.ts"
read in.ts | base64   → YWxwaGEKYmV0YQo=      "alpha\nbeta\n"   = /usr/bin/base64
lines in.ts | base64  → YWxwaGE= / YmV0YQ==   once per line
```

SKILL.md L150–151 (canonical): "crust's encodes the five characters of the
path (`aW4udHM=`) and now says so on stderr."

Settled by computation — base64 is deterministic, no live probe needed:

- `base64("in.ts")` = `aW4udHM=` — the SKILL side is right.
- `YjY0aW4udHh0` = `base64("b64in.txt")` — a 9-byte payload. The displayed
  value does not match its annotated operand "in.ts" (5 bytes → 8 base64
  chars, `aW4udHM=`).
- Rows 2–3 verified correct: `YWxwaGEKYmV0YQo=` = "alpha\nbeta\n" (whole
  content); `YWxwaGE=`/`YmV0YQ==` = "alpha"/"beta" (per line). The
  inconsistency is isolated to row 1.

So the measured row is internally inconsistent as printed: either the value
was measured on a different operand (a 9-char file name, `b64in.txt`), or the
annotation was copied from a different example. Either way, the row as printed
is wrong, and it contradicts SKILL on the one quantitative claim the bullet
makes.

## Out of scope for this gap (cross-refs, NOT closed here)

The rest of Traps bullet 1 (the `read`-whole-content vs `lines`-per-line
distinction, the UTF-8/binary-safety PNG half) and bullets 2–7 are all
consistent with SKILL and carried by W252/SK22 with probes queued (T61). Not
part of this finding.

## Fix

Website: in `agent-skills/builtins.mdx` Traps bullet 1, either set row 1 to
`base64 in.ts → aW4udHM= "in.ts"`, or — if the measurement was really taken on
a 9-char file — correct the operand AND the annotation to the real file. The
table says "Measured", so regenerate all three rows live against a scratch
file containing `alpha\nbeta\n` and paste the real outputs rather than patching
one cell.

Verification: recompute every displayed value (`echo -n in.ts | base64`,
`printf 'alpha\nbeta\n' | base64`, per-line) and diff against the table; then
the usual website gates (`bun run build`,
`bun scripts/lint-examples.mjs ../crust/bin/crust`, `bun run check-links`).

## Commit

`docs(agent-skills): builtins Traps table — row 1 value does not match its annotation (audit T62)` (site).
