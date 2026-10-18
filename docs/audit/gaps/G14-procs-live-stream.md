# G14 — procs page: Knobs stream set omits `live`

**Doc:** website `src/pages/docs/recipes/dev-tail.mdx` ("One dev tail"),
L222–231 "## Knobs" (audit W581) vs the page's own liveness section
(audit W572).

## Measured

- W581 (Knobs bullet) lists the stream set as **stdout/stderr/exit/ready** —
  no `live`.
- W572 (liveness) says liveness progress "lands on a `live` stream".
- The two lines on the same page disagree about the stream-kind set.

## Probe (first task)

1. Scratch procs spec: one proc whose `ready:` probe wedges (a route that
   never answers, or `--timeout` short) so `probe failed (1/3)` items emit.
2. Capture the stream tag on those items in the merged tail.
3. Verdict: tag is `live` → Knobs line is incomplete (X confirmed, fix the
   Knobs line); tag is something else → W572's "live stream" claim is the
   stale one (fix W572 instead).
4. Settle the stream-kind union from `src` while the rig is up (the audit
   flagged this as review-only; the probe makes it V either way).

## Fix

One-line doc fix on the losing side of the pair. Website commit + gates
(build, lint-examples, check-links).

## Commit

`docs(procs): …` (site).
