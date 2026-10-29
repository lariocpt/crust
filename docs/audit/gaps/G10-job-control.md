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
- `SIGTSTP` never stops these children, and the reason is the runtime, not
  session boundaries (**re-measured during the implementation — the original
  note here blamed POSIX cross-session rules and was wrong**): a *compiled Bun
  binary* and `bun run` both survive a `kill -TSTP -<pgid>` aimed at their own
  group as leader (state stays `S`), and a child they spawn inherits that
  disposition across `exec` — the same `sleep` shrugs off `SIGTSTP` and stops on
  `SIGSTOP` two lines later. So **use SIGSTOP/SIGCONT**, and expect no
  tty-driven job control for crust or its children. The only semantic loss is
  that the child cannot catch SIGSTOP — for a shell emulator that is an
  improvement.
- ~~`detached: true` is accepted by `Bun.spawn`, which proves nothing~~
  **falsified by measurement**: it does the setsid. A detached child has
  `pgrp == session == pid` in `/proc/<pid>/stat`, and `kill -TERM -<pid>`
  reaches a forking `sh`'s forked grandchildren too. So a detached job is a
  real process group and `kill %N`/Ctrl-Z can hit the whole tree — which is
  what shipped. Full POSIX terminal handoff (`tcsetpgrp`) remains
  **bun:ffi-only** and out of scope.
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
- `wait %N` — await without stealing stdin (cheap, and the honest primitive
  for scripts). **Not as a builtin**: `wait` is crust's readiness *stage*
  (`src/builtinFns/wait.ts`) and registering it wholesale swallowed that stage —
  four tests went red. It is an operand-scoped interception in `runLine`, like
  `kill %N`, and bare `wait` stays the stage's.
- `kill %N` — route to the job's pid via `process.kill`. (`kill` is not a crust
  builtin today; intercept only the `%job` operand form so `kill -9 1234` stays
  sh's.)
- **Ctrl-Z (`0x1a`)** while crust holds raw mode — i.e. during a crust pipeline,
  a builtin, or a `&` job — sends SIGSTOP to the active child/children,
  registers the job as Stopped, prints `[1]+  Stopped  <label>` and returns the
  prompt. Implement with the same race used by Ctrl-C in `src/interrupt.ts`:
  `Promise.race([proc.exited, suspendRequest])`, so the awaiting `runLine` can
  hand the prompt back without leaving the child running.
- **The inherit-stdio case, as measured: Ctrl-Z does nothing at all.** The
  claim this file opened with — that a real Ctrl-Z stops crust *and* its child
  as one foreground group and the outer shell's `fg` resumes both — is
  **falsified**. In the same tmux pty where plain zsh suspends a job
  (`[3] + suspended`), crust + its `sleep` both stay `S`: the child's termios
  has `isig` and `susp = ^Z`, crust holds the tty as `pgid == sid == tpgid` with
  the child in that group (identical to zsh's), and the `^Z` is echoed — so the
  tty generated the SIGTSTP and the runtime ignored it (see above). The `^Z`
  echo is all the user sees; **Ctrl-C is the escape** (child dies, line 130). Doing better requires
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

## Shipped (5bb95c9, 2d09056, 760ec92) — four things the plan did not predict

1. **`proc.unref()` for `&` is wrong here**, opposite to the feasibility note.
   The script's line loop holds no event-loop handle of its own, so an unref'd
   child let Bun decide the process was finished at the next pending await:
   `sleep 30 &` then any line that awaits (a `wait`) skipped the rest of the
   file and exited **0**. Lines that spawn their own child hide it, which is why
   the first draft of the truncation test stayed green against the broken code.
   Children stay ref'd; crust exits via `shutdown()` → `process.exit()` in ~10ms
   with a 30s job running.
2. **`sh -c` holds SIGTERM pending while it starts up.** A `kill %1` on the line
   after `&` can legitimately find the job alive (~3ms later, dead within 20ms),
   so `kill` prints `Sent SIGTERM to job N (pid P)` — the send — and `jobs`
   reports verified state. `settleJobs()` before listing waits on *not provably
   alive* (`Z` **or** gone from /proc): polling only for `Z` printed a killed job
   as `Running` one run in five, because a rapidly reaped child is already out
   of /proc with `proc.exited` a loop turn away.
3. **Ctrl-C during `fg`/`wait` had to be built**, or the gap's own rule went
   unimplemented: it was a 15s unescapable wait, and `wait %N` bypasses the
   builtin branch so it needed both keys armed on its own.
4. **Exit resumes stopped jobs** with a notice. A `T` orphan survives
   reparenting and no shell resumes a process it did not stop, so it is leaked
   until reboot; running jobs are left alone because outliving the session is
   what `&` means.

Also `jobs [-l] [%N]`: `-l` adds `(pid …)` (and the code once there is one), a
job operand filters, an unknown option is refused — `jobs -l` parsed and ignored
its argument, which is a listing that looks like the one you asked for.

Probe corpus: `/tmp/opencode/probe-{grp,kill2,line,line2,line3,tstp}.ts`,
`tiny.ts`/`tiny2.ts` (+ compiled), `g10-pty*.sh`, `g10-tiny.sh`, `g10-pgid.sh`,
`g10-stty3.sh`, `state.py`, `pg.sh`.
