// Job table for REPL job control (G10): `&`, `jobs`, `fg`, `bg`, `wait`, Ctrl-Z.
//
// Module state, like src/interrupt.ts — the REPL is one process with one table.
// The table is deliberately dumb: it owns numbering, status, the display strings
// and nothing else, so the builtins (`jobs`/`fg`/`bg`/`wait`) and the Ctrl-Z race
// stay readable.
//
// Everything here rests on measurements taken on Bun 1.4.3 / Linux BEFORE this
// file was written (and pinned by tests/jobs.test.ts), because the obvious
// approach does not work:
//
//   · `Subprocess.signal` DOES NOT EXIST in Bun 1.4.3 (not even with
//     `signals: true`), and SIGTSTP never stops a Bun-spawned child — POSIX
//     refuses it across sessions. SIGSTOP/SIGCONT DO work: `/proc/<pid>/stat`
//     goes `T` then `S`. So crust suspends with SIGSTOP, which the child cannot
//     catch or ignore — for a job table that is a stronger guarantee than a
//     shell's SIGTSTP, not a weaker one.
//   · `proc.exited` resolves with 128+signal for a signal death (143 for SIGTERM)
//     while `proc.exitCode` is null. The awaited value is the honest exit code,
//     and it is the same number a shell would report.
//   · `detached: true` really does setsid: the child becomes its own group AND
//     session leader, so `process.kill(-pid, …)` reaches the whole tree — a shell
//     that forked a grandchild is suspended as a unit (this is what makes Ctrl-Z
//     mean "suspend the job" rather than "suspend the shell"). `Job.group` records
//     that fact; it is NOT assumed, because signalling `-pid` of a child that is
//     not a leader can only ever ESRCH and silently do nothing useful.
//   · An un-awaited child KEEPS Bun's process alive, so `&` cannot just spawn and
//     forget — crust would sit at `exit` until the job finished. `proc.unref()`
//     releases that hold (the parent exits at once, the child lives on), which is
//     why the `&` spawn site must call `unref()` (runLine.ts, unit B). Awaiting
//     `proc.exited` holds the
//     parent on its OWN even for an unref'd child, so `wait`/`fg` need no `ref()` — and
//     deliberately do not take one: a ref would outlive an abandoned wait (Ctrl-C
//     during `wait %1`) and hang crust at `exit` over a job the user stopped
//     watching.

/** `running` = live, `stopped` = SIGSTOP'd, `done` = exited (reaped from `proc`). */
export type JobStatus = "running" | "stopped" | "done";

/**
 * The slice of `Bun.spawn`'s subprocess this table needs, so a test can hand in
 * a fake (and so a future spawn path is not forced to match a Bun version).
 */
export interface JobProcess {
  readonly pid: number;
  /** Resolves with the exit code — 128+signal when a signal killed it. */
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): unknown;
  // No `ref`/`unref` here on purpose: the `&` spawn site calls `unref()` on the
  // real subprocess itself and nothing in this table ref's or unref's anything —
  // see the measured reason in waitJob.
}

export interface Job {
  /** 1-based, stable, what `%N` and `jobs` show. Never reused. */
  index: number;
  pid: number;
  /** The command as typed — the label in `[1] 4242 sleep 30`. */
  label: string;
  status: JobStatus;
  proc: JobProcess;
  /** True once `proc.exited` has settled. */
  exited: boolean;
  /** The awaited `proc.exited` value: shell convention, 128+signal on a signal. */
  exitCode: number | null;
  /** True when the child leads its own process group (spawned detached). */
  group: boolean;
}

const table: Job[] = [];
let nextIndex = 1;

/** Register a spawned child as a job. The caller owns `unref()` — see above. */
export function registerJob(proc: JobProcess, label: string, opts: { group?: boolean } = {}): Job {
  const job: Job = {
    index: nextIndex++,
    pid: proc.pid,
    label,
    status: "running",
    proc,
    exited: false,
    exitCode: null,
    group: opts.group ?? false,
  };
  table.push(job);
  // Attach the completion watcher here rather than at the call site: a job can
  // finish while nobody is looking (`&` then `jobs` five minutes later), and a
  // stale `Running` line is a lie about a process that is already gone.
  proc.exited.then(
    (code) => {
      job.exited = true;
      job.exitCode = code;
      job.status = "done";
    },
    () => {
      // A spawn that died before it could be waited on is NOT a pass: `exitCode`
      // stays null and statusLabel says `Failed`, never `Done`.
      job.exited = true;
      job.status = "done";
    },
  );
  return job;
}

/** A snapshot for `jobs`. Finished jobs STAY listed — that is how `wait %1` can
 * still report the code of a job that ended minutes ago. */
export function listJobs(): Job[] {
  return [...table];
}

/** The `+` job: the newest one still alive. Null when every job has finished. */
export function currentJob(): Job | null {
  return table.filter((job) => job.status !== "done").at(-1) ?? null;
}

/**
 * Resolve a job spec: `%1`, `1`, `%`/`%+` (the current job), or nothing at all
 * (also the current job — `fg` with no argument means the one you just stopped).
 * Junk, zero, negatives and unknown indices are null, and the caller reports
 * `no job`, which is the honest answer rather than a guess.
 */
export function getJob(spec?: string | null): Job | null {
  if (spec === undefined || spec === null || spec === "" || spec === "%" || spec === "%+") {
    return currentJob();
  }
  const m = /^%?(\d+)$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  for (const job of table) if (job.index === n) return job;
  return null;
}

/**
 * Send a signal to a job. A group job is signalled at `-pid` so the whole tree
 * gets it, falling back to the bare pid when the group is already gone (the same
 * escalation `killGroup` in src/sources.ts uses). False when the job is finished
 * or the process is unreachable — a caller must not report success on a signal
 * that hit nothing.
 */
function send(job: Job, signal: NodeJS.Signals | number): boolean {
  if (job.status === "done") return false;
  const targets = job.group ? [-job.pid, job.pid] : [job.pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      // try the next target
    }
  }
  return false;
}

/** Ctrl-Z / `kill -STOP`: SIGSTOP the job. The child cannot catch this — by design. */
export function stopJob(job: Job): boolean {
  if (!send(job, "SIGSTOP")) return false;
  job.status = "stopped";
  return true;
}

/** `bg`, and the resume half of `fg`: SIGCONT the job. */
export function contJob(job: Job): boolean {
  if (!send(job, "SIGCONT")) return false;
  job.status = "running";
  return true;
}

/** `kill %N` and the table's own teardown. Default SIGTERM, like sh's `kill`. */
export function killJob(job: Job, signal: NodeJS.Signals | number = "SIGTERM"): boolean {
  // The status is NOT written here — the watcher set it when the child actually
  // died. Claiming `done` at the moment of the signal would hide a SIGTERM the
  // process ignored.
  return send(job, signal);
}

/**
 * Await a job and return its exit code — the primitive behind `wait` and `fg`.
 * No `proc.ref()`: measured on Bun 1.4.3, awaiting `proc.exited` holds the parent
 * for the child even after `unref()` (407ms against a 0.4s child, three runs), so
 * a ref would buy nothing and cost an abandoned wait — Ctrl-C out of `wait %1`
 * would leave the job ref'd and hang crust at `exit`.
 */
export async function waitJob(job: Job): Promise<number> {
  return job.proc.exited;
}

/** What `&` prints when it backgrounds: `[1] 4242 sleep 30`. */
export function formatSpawned(job: Job): string {
  return `[${job.index}] ${job.pid} ${job.label}`;
}

/**
 * Status as `jobs` shows it. `Exit N` for a nonzero code instead of a bare
 * `Done`: a job that died with 3 must not read like one that succeeded (AGENTS.md
 * rule 1 — crust never reports a false pass).
 */
export function statusLabel(job: Job): string {
  if (job.status === "running") return "Running";
  if (job.status === "stopped") return "Stopped";
  const code = job.exitCode;
  if (code === null) return "Failed";
  if (code === 0) return "Done";
  // 128+signal is how the death by signal arrives (measured: 143 for SIGTERM).
  if (code >= 128) return "Terminated";
  return `Exit ${code}`;
}

/** One `jobs` line: `[1]+  Running   sleep 30`. `current` adds the `+`. */
export function formatJobLine(job: Job, current = false): string {
  const mark = current ? "+" : " ";
  return `[${job.index}]${mark}  ${statusLabel(job).padEnd(9)} ${job.label}`;
}

/**
 * Empty the table. Exported for tests — the table is module state (like the
 * editor's stdin seam), and a test must be able to start from an empty one.
 * Nothing in the REPL calls it: jobs live as long as the session.
 */
export function resetJobs(): void {
  table.length = 0;
  nextIndex = 1;
}
