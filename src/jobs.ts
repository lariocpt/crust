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
//   · An un-awaited child KEEPS Bun's process alive when nothing else is pending,
//     and `proc.unref()` releases that hold. For crust that is the WRONG lever:
//     a script's line loop holds no event-loop handle of its own, so an unref'd job
//     let Bun decide the process was finished AT the `&` line and skip the rest of
//     the script with exit 0 (measured in the compiled binary — the silent false
//     pass this repo exists to prevent). The spawn site therefore keeps the child
//     ref'd and relies on every crust exit being an explicit `process.exit()`,
//     which does not wait for children: `&` neither blocks the prompt (measured 9ms
//     to exit with a 30s job running) nor truncates the script. Awaiting
//     `proc.exited` holds the parent on its own regardless, which is why `wait`/`fg`
//     need no `ref()` and deliberately take none.

import { readFileSync } from "node:fs";
import * as suspend from "./suspend";

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
  // No `ref`/`unref` here on purpose: nothing in this table ref's or unref's
  // anything, and the reason `&` does not unref is the last bullet above.
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

/** Register a spawned child as a job. Whether it leads a group is the caller's
 * fact to state, not this table's to guess (see `Job.group`). */
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
 * The newest job ever registered, dead or alive — what `jobs` marks `+`, because
 * that is what bash's `%+` means and a finished job still needs a mark while it is
 * listed. Resolving a bare `%` is NOT this: `getJob("%")` is `currentJob()`, so
 * `fg` with no argument never reaches for a job that already exited.
 */
export function latestJob(): Job | null {
  return table.at(-1) ?? null;
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

/**
 * Await a job in the foreground, interruptibly — the body of `fg` and `wait %N`.
 * Ctrl-Z (the suspend bus, which runLine arms for every REPL line) stops THE JOB
 * and this resolves 148, 128+SIGTSTP, the code a shell gives a suspended job,
 * rather than the job's own. Ctrl-C kills the job and resolves 130. `resume` is `fg`'s SIGCONT of a stopped job; a plain
 * `wait` resumes nothing — waiting for a stopped job until someone frees it is
 * what bash does too.
 *
 * With no bus armed (a script, `-c`, piped stdin) `suspendPromise()` never
 * resolves, so this is an ordinary await and the line cannot be suspended.
 */
export async function waitJobForeground(job: Job, resume: boolean): Promise<number> {
  suspend.registerChild(() => {
    stopJob(job);
  });
  if (resume && job.status === "stopped") contJob(job);
  // Ctrl-C during `fg`/`wait` is a normal foreground Ctrl-C, which is what the gap
  // asks for and the escape a user reaches for first. At the REPL, raw mode turns
  // the key into a byte that runLine converts into a synthetic in-process SIGINT
  // (every other builtin waits on that same event), so a foreground wait answers
  // THAT: kill the job and hand the prompt back with 130, the same code the
  // pipeline returns when it is interrupted — without waiting for the death.
  // In a script nothing emits it, so the ordinary await is untouched.
  let resolveCancel: ((code: number) => void) | null = null;
  const cancelled = new Promise<number>((resolve) => {
    resolveCancel = resolve;
  });
  const killOnSigint = () => {
    killJob(job, "SIGINT");
    resolveCancel?.(130);
  };
  process.on("SIGINT", killOnSigint);
  try {
    const code = await Promise.race([
      // A rejected `exited` (a spawn that died before it could report) is not a
      // pass either: the table has already labelled it `Failed`, and the line says
      // 1 — a value of its own, so it cannot be mistaken for a suspend (null).
      waitJob(job).then(
        (c) => c as number | null,
        () => 1 as number | null,
      ),
      suspend.suspendPromise().then(() => null),
      cancelled,
    ]);
    return code === null ? 148 : code;
  } finally {
    // Off again: a listener that outlives its wait would make the NEXT Ctrl-C in
    // the session kill a job the user is no longer waiting for.
    process.off("SIGINT", killOnSigint);
  }
}

/**
 * Is this `wait` line aimed at a job? One `%` operand and nothing else, because
 * `wait :3000/health` is crust's readiness STAGE (src/builtinFns/wait.ts) and
 * swallowing that is not this feature's to do. Bare `wait` is the stage's too
 * (it reports its own missing-target error) — waiting for every job at once is
 * not implemented, and a builtin that quietly did something else would be worse.
 */
export function jobWaitSpec(argv: string[]): string | null {
  const [only, ...rest] = argv.filter((w) => w !== "");
  if (only === undefined || rest.length > 0) return null;
  return /^%(\+|\d+)$/.test(only) ? only : null;
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

/**
 * One `jobs` line: `[1]+  Running   sleep 30`. `current` adds the `+`, `long`
 * adds the pid (`jobs -l`) and the code once there is one to show.
 */
export function formatJobLine(job: Job, current = false, long = false): string {
  const mark = current ? "+" : " ";
  const suffix = long ? longSuffix(job) : "";
  return `[${job.index}]${mark}  ${statusLabel(job).padEnd(10)} ${job.label}${suffix}`;
}

/** The `-l` tail. No code is invented for a job that never reported one. */
function longSuffix(job: Job): string {
  if (job.status === "done" && job.exitCode !== null) {
    return `  (pid ${job.pid}, code ${job.exitCode})`;
  }
  return `  (pid ${job.pid})`;
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

/**
 * Does this pid exist and is it not a zombie? Both failure modes mean the same
 * thing to the table — the process is over — but they arrive at different times:
 * `Z` is death waiting to be reaped, `""` means it has been reaped and the
 * `proc.exited` handlers are a loop turn away. Waiting only for `Z` returned
 * immediately in a script (where lines run back to back) and printed a killed job
 * as `Running` — flaky in exactly that way, one run in five.
 */
function isLive(pid: number): boolean {
  const state = procState(pid);
  return state !== "" && state !== "Z";
}

/** `/proc/<pid>/stat` state letter, or "" when the process is gone entirely. */
function procState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Let a dead child's exit code LAND before the table is shown.
 *
 * A job killed by `kill %N` is gone from `/proc` inside a millisecond, but its
 * `proc.exited` only settles once Bun has reaped it — so `jobs` on the next line of
 * a script would call a process that no longer exists `Running`. That is a lie about
 * a process, the class of thing this repo refuses to ship, so the `jobs` builtin
 * waits (bounded) for any zombie in the table to be reaped before printing. A table
 * of genuinely live jobs returns without waiting.
 */
export async function settleJobs(budgetMs = 100): Promise<void> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const pending = table.filter((job) => job.status !== "done" && !isLive(job.pid));
    if (pending.length === 0) return;
    if (Date.now() > until) {
      // Out of budget: the process is gone and its exit status never arrived. The
      // honest label is `Failed` (gone, no code) — keeping `Running` for a pid that
      // does not exist is a statement about a process we can see is not there.
      for (const job of pending) {
        job.exited = true;
        job.status = "done";
      }
      return;
    }
    await Bun.sleep(5);
  }
}

/**
 * Resume every STOPPED job, for session exit. An orphan in `T` is not a job that
 * came back later — SIGSTOP survives reparenting, and no shell will ever resume a
 * process it did not stop, so a crust that exited over a stopped job would leave
 * it there until a reboot. RUNNING jobs are deliberately left alone: outliving
 * the session is what `&` means. Returns what was resumed so the REPL can say so.
 */
export function resumeStoppedJobs(): Job[] {
  const resumed: Job[] = [];
  for (const job of table) {
    if (job.status === "stopped" && contJob(job)) resumed.push(job);
  }
  return resumed;
}

/**
 * Is this `kill` operand list aimed at CRUST jobs? Returns one target per job
 * operand, or null when any operand is not one — `kill 1234`, `kill -9 1234` and
 * `kill %1 4321` all stay sh's, because a pid is the outer shell's business and
 * crust must not answer for a process it did not start.
 *
 * The `%` sigil is what makes an operand a job (`kill %`, `kill %1`, `kill %3`),
 * optionally after one `-SIGNAL` flag: `-9`, `-KILL`, `-SIGKILL`, `-TERM`.
 */
export function jobKillOperands(
  argv: string[],
): { spec: string; signal: NodeJS.Signals | number }[] | null {
  let signal: NodeJS.Signals | number = "SIGTERM";
  const specs: string[] = [];
  for (const word of argv) {
    if (!word) continue;
    if (word.startsWith("-") && word.length > 1) {
      const name = word.slice(1).toUpperCase();
      if (/^\d+$/.test(name)) {
        signal = Number(name);
      } else if (/^SIG?[A-Z][A-Z0-9]*$/.test(name)) {
        signal = `SIG${name.replace(/^SIG/, "")}` as NodeJS.Signals;
      } else {
        return null; // `-nonsense`, `--help`: not ours to interpret
      }
      continue;
    }
    // A bare number is a PID (sh's), and `%!`/`%?` patterns are not implemented,
    // so the only job shape here is `%`, `%+` or `%<digits>`.
    if (!/^%(\+|\d*)$/.test(word)) return null;
    specs.push(word);
  }
  if (specs.length === 0) return null;
  return specs.map((spec) => ({ spec, signal }));
}

/**
 * Is this shell command a background request — a trailing, UNQUOTED, single `&`?
 * Returns the command with the `&` removed, or null when there is none, it is
 * part of `&&`, it sits inside quotes (`echo "a & b"` stays sh's), or the line
 * carries unbalanced quotes (then sh owns the whole error).
 *
 * The quote scan mirrors `hasUnquotedShellMeta` in src/args.ts — the same rule
 * that decides whether crust may apply an assignment line — because a `&` the
 * user quoted is data, and mistaking it for a job request would silently run the
 * command detached and print a job line instead of its output.
 */
export function trailingBackgroundOp(text: string): string | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("&") || trimmed.endsWith("&&")) return null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length - 1; i++) {
    const ch = trimmed[i] ?? "";
    if (quote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
  }
  if (quote !== null) return null;
  return trimmed.slice(0, -1).trimEnd();
}
