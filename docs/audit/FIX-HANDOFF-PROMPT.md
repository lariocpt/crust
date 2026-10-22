# crust — fix-phase handoff (2026-10-22)

You are implementing the fixes for the completed crust full-audit. You are a fast,
context-tight model. The context-discipline rules below are NON-NEGOTIABLE and
 outrank speed.

## 0. Context discipline (read first, obey always)
- Your memory is ONE file: `docs/audit/FIX-PROGRESS.md` (crust repo). If missing,
  create it exactly as:
    # FIX PROGRESS
    - NEXT: G06
    then ONE line per finished task: `- GNN | done | <commit sha> | <≤10-word note>`
  Read it at start and after EVERY task. It is the ONLY history you need.
  After each task, flip its `NEXT:` line to the following G. Commit + push the
  file with every task commit (it is part of the task).
  (When running under an orchestrator that assigns you a single task, the
  orchestrator owns this file instead — your task prompt overrides this bullet.)
- NEVER read or cat `docs/audit/full-audit.md` in full (≈150 KB, 979 rows).
  Targeted queries only, e.g.
  `awk '/^\| W473 \|/' docs/audit/full-audit.md | cut -c1-500` (one row) or
  `sed -n '40,60p' <file>`. Never `grep -n X full-audit.md | head -50`.
- NEVER print file contents into the chat. Chat gets ONLY: one line per task
  (`GNN: red tests → fix → gates green → sha`), gate pass/fail one-liners, and
  the final summary. Read → act → move on.
- Scratch files: create ONE dir `/tmp/crustfix/`; all probe/scratch output goes
  there; `rm -rf /tmp/crustfix` at the END of each task. Never create repo
  files that are not part of the fix.
- One task = one G. Per-task context budget: the NEXT line of the progress file
  + the gap file (≤105 lines) + the src regions the gap file names. Do not
  explore beyond the gap file's scope. If stuck, record `- GNN | BLOCKED | <why>`
  in the progress file and move to the next G.
- `git commit -F <file>` (write the message to a temp file first — apostrophes
  in `-m` break zsh). Push after every task.

## 1. State (verified on disk 2026-10-22 — trust it, do not re-audit)
- Full code review is COMPLETE: all ~979 claim rows adjudicated (C/V/X/R);
  website parity T1–T81 + components M1–M17 done; code review 68/71 rows closed
  (the rest are probe-owned). Every finding is catalogued as a G task.
  Do NOT re-review, re-scope, or "verify" prior verdicts.
- crust repo `/home/lario/Projects/personal/crust`: branch `main` @ `7a362e2`,
  clean, pushed. Binary `bin/crust-bin` built from `aaf04df`, verified
  `0.2.0-dev`. Gates green: `bun test` 1187/0, `bun run typecheck`,
  `bunx biome check .` (428 warnings / 18 infos / 0 errors — warnings are
  pre-existing; only NEW errors fail a task).
- website repo `/home/lario/Projects/static-websites/crust-website`
  (NOT `../crust-website`): `main` @ `7803ba5`, clean. Gates: `bun run build`,
  `bun scripts/lint-examples.mjs /home/lario/Projects/personal/crust/bin/crust-bin`,
  `bun run check-links` (baseline 29 pages / 348 examples 0 failed / 1163 links
  0 dead; re-baseline only if a task legitimately moves a count — say so in the
  progress note).
- Work directly on `main` in both repos (the plan file's branch names are from
  the pre-audit phase; the audit + this phase run on main, one commit per task).
- The user lifted the fix gate 2026-10-22: implement fixes NOW. The item-4 probe
  list is DEFERRED — do not start it. If a fix needs one specific runtime check,
  run exactly that one probe (prefix `CRUST_CONFIG=/dev/null`), capture output +
  exit code, and note it in the progress file; do not batch probes.

## 2. The task list
Work `G06 → G30` in order (G01–G05 already merged 2026-10-17). For each:
1. Read `docs/audit/gaps/GNN-*.md` (self-contained, ≤105 lines).
2. Follow its own plan + the loop in `docs/audit/CRUST_GAPS_PLAN.md`
   ("The loop (run this for every section)" — 152-line file, read once at the
   start, then never re-read): tests RED FIRST with the controls the gap file
   names → implement → crust gates green → update `docs/USAGE.md`, `README.md`
   (if user-facing), `CHANGELOG.md` (`## [Unreleased]`), affected
   `skills/*/SKILL.md` → update the website pages the gap file names + its
   gates → update the crust agent KB submodule if the loop requires, re-ingest
   → `git commit` (both repos if the task touches both) + push.
3. Tick the task's box in `CRUST_GAPS_PLAN.md` (one-line edit) — include it in
   the same commit.
4. Record the progress line, flip NEXT, clean `/tmp/crustfix`.
After G30: row W40 in full-audit.md (fetch that one row only) carries a
same-shape in-place candidate for the npm-packages page (twin of G30) — if the
row notes in-place, do it as one small website commit, recorded the same way.

## 3. Final wrap-up (after G30)
Append to `docs/audit/FIX-PROGRESS.md`: one line per G with sha + a `DONE
2026-10-NN` line, then update `docs/audit/resume-prompt.md`'s STATUS pointer to
"fix phase complete — next = item-4 probe list" (small edit; the probe list is
item 4 of `docs/audit/resume-history.md`). Commit, push. Then report in chat:
one line per G (sha + note), any BLOCKED items, gate state, nothing else.
