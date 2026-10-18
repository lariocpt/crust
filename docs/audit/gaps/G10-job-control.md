# G10 — job control: `&`, `jobs`, `fg`, `bg`, Ctrl-Z

**Doc:** `docs/USAGE.md:2177-2182`; `docs/PLAN.md` says it \"needs Bun-side
support it doesn't yet expose\" — **that is now partly wrong**, see feasibility.

## Feasibility (measured on Bun 1.4.3, Linux — this decides the design)

- `Subprocess.signal` **does not exist** (`typeof p.signal === \"undefined\"`,
  even with `signals: true`). Don't plan around it.
- `proc.kill(\"SIGKILL\")` works and reaps (`exitCode null / signalCode SIGKILL`).
- `process.kill(pid, \"SIGSTOP\")` → `/proc/<pid>/stat` state **`T`**;
  `process.kill(pid, \"SIGCONT\")` → **`S`**. **Suspending a Bun-spawned child
  works via SIGSTOP/SIGCONT.**
- `SIGTSTP` never stops these children — not a Bun bug: the same `/bin/kill
  -TSTP` also failed against a `setsid` target (POSIX refuses SIGTSTP across
  sessions), and a plain Bun-spawned child ignored it too. **Use
  SIGSTOP/SIGCONT.** The only semantic loss is that the child cannot catch
  SIGSTOP — for a shell emulator that is an improvement.
- `detached: true` is *accepted* by `Bun.spawn`, which proves nothing (unknown
  options are ignored). Treat full POSIX pgrp/`tcsetpgrp` work as
  **bun:ffi-only** and out of scope for this gap.
- Today `&` already \"works\" by accident: `sleep 2 &` returns instantly because
  sh backgrounds a **grandchild** crust never sees, and `time` shows crust
  exiting in 16ms while `tail` waits 2s. No job table, no way to wait or list.

## Design — crust-managed jobs, no FFI

**Job table** (`src/jobs.ts`, module state like `interrupt.ts`): `{ index, pid,
label, status: running|stopped|done, proc, exited }`.

- `&` at the end of a **shell stage that is the whole line**: crust spawns it and
  does not await — registers the job, prints `[1] 4242 sleep 30`, returns to the
  prompt immediately. This replaces the orphaning-grandchild behaviour with a
  tracked one.
- `jobs` builtin — list `jobs`-style (`[1]  Running   sleep 30`, `Stopped`);
  reaps finished jobs as it lists.
- `fg [N|%N]` — SIGCONT (if stopped) + re-await `proc.exited`; the real exit code
  becomes the line's code; Ctrl-C during `fg` behaves like a normal foreground
  Ctrl-C (`src/interrupt.ts`).
- `bg [N|%N]` — SIGCONT, keep the prompt.
- `wait [N|%N]` — await without stealing stdin (cheap, and the honest primitive
  for scripts).
- `kill %N` — route to the job's pid via `process.kill`. (`kill` is not a crust
  builtin today; intercept only the `%job` operand form so `kill -9 1234` stays
  sh's.)
- **Ctrl-Z (`0x1a`)** while crust holds raw mode — i.e. during a crust pipeline,
  a builtin, or a `&` job — sends SIGSTOP to the active child/children,
  registers the job as Stopped, prints `[1]+  Stopped  <label>` and returns the
  prompt. Implement with the same race used by Ctrl-C in `src/interrupt.ts`:
  `Promise.race([proc.exited, suspendRequest])`, so the awaiting `runLine` can
  hand the prompt back without leaving the child running.
- **The inherit-stdio case must stay as it is and be documented, not broken.**
  During a foreground inherit-stdio child the editor is suspended and cooked, so
  a real Ctrl-Z stops crust *and* its child as one foreground group; the outer
  shell's `fg` resumes both, correctly. Doing better requires
  `setpgid`+`tcsetpgrp` (FFI) and is explicitly **not** in this gap; say so in
  the docs so nobody reads `fg`/`bg` as full shell job control.
- Exit-code honesty: a job that dies later must not change any line's exit code
  except via `fg`/`wait` — pin that.

## Tests

- `&`: `sleep 30 &` returns in well under 1s, `jobs` lists it Running, its pid
  is alive; `kill %1` then `jobs` reports Terminated/dead; nothing is orphaned
  when crust exits (pin whatever cleanup policy is chosen — if crust leaves
  running jobs alive, say so in the docs and pin it).
- `fg`: start `sleep 2 &`, `fg %1` blocks ~2s and returns **the child's** exit
  code (control: `sh \"exit 3\" &` then `fg %1` → exit 3).
- `bg`: SIGCONT observed via `/proc/<pid>/stat` `T` → `S`.
- Ctrl-Z: unit-level — the suspend race fires, the child reaches `T`, the job is
  listed Stopped, and a following `bg %1` resumes it. (Drive the interrupt/suspend
  bus directly rather than through a pty.)
- `wait %1` after the job already finished returns immediately, exit code
  preserved; `fg %9` on a nonexistent job → `crust: no job %9`, exit 1, and
  `jobs` unchanged.
- Controls: `sleep 1` (no `&`) still blocks and returns its code; Ctrl-C during a
  foreground child still exits 130 (`tests/interrupt.test.ts` stays green);
  `echo \"a & b\"` (quoted) is not treated as backgrounding; a pipeline ending in
  a shell stage with `&` mid-stage (`sh \"a & b\"`) is left to sh untouched.

## Docs / website / KB

- `docs/USAGE.md`: new **Job control** subsection (the supported set, `%N`
  syntax, SIGSTOP-not-SIGTSTP note, the inherit-stdio caveat, and the
  \"background jobs outlive crust\" policy line); limits bullet shrinks to what
  is genuinely still missing.
- `skills/crust-builtins/SKILL.md` (builtin table) + `skills/crust-cli/SKILL.md`.
- Website: new `src/pages/docs/` section or a block in `quickstart.mdx`, and
  register in `src/components/Sidebar.astro`.
- KB: `knowledge/learnings/round-10-job-control.md` — must record the
  SIGSTOP/SIGTSTP and `Subprocess.signal` findings, since `docs/PLAN.md`'s old
  claim sent a previous round astray.
- `docs/PLAN.md`: correct the \"needs Bun-side support\" line.

## Commit

`feat(jobs): & background jobs, jobs/fg/bg/wait, Ctrl-Z suspend via SIGSTOP`
