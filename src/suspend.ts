// Suspend bus for REPL Ctrl-Z — the same shape as src/interrupt.ts, and a
// SEPARATE bus rather than a second event on it, because the two presses must not
// be able to imitate each other:
//
//   · Ctrl-C kills the run and the line returns 130. Ctrl-Z must leave the child
//     ALIVE — SIGSTOP'd, and registered as a job the user can `bg`, `fg` or
//     `kill %N` afterwards — and the line returns 148 (128+SIGTSTP, the code a
//     shell reports for a suspended job).
//   · One latch cannot serve both: a suspended line still has to answer Ctrl-C
//     later in the same run, and an interrupted run must never be resumable.
//
// The closures registered here do two things, in this order: put the child in the
// job table (a child that was only ever foreground becomes a job exactly when it
// is stopped — a line that finishes normally registers nothing) and SIGSTOP it.
//
// Outside the REPL nothing calls beginRun(): suspendPromise() never resolves and
// the races cost nothing, exactly like interrupt.ts.

let running = false;
let suspended = false;
let promise: Promise<void> | null = null;
let resolvePromise: (() => void) | null = null;
const children = new Set<() => void>();

/** Arm the bus for one REPL line. Clears any state from the previous run. */
export function beginRun(): void {
  running = true;
  suspended = false;
  promise = null;
  resolvePromise = null;
  children.clear();
}

/** Ctrl-Z: stop every registered child and wake every parked race. Idempotent. */
export function fire(): void {
  if (!running || suspended) return;
  suspended = true;
  for (const stop of children) {
    try {
      stop();
    } catch {
      // a child that is already gone is a success, not an error
    }
  }
  children.clear();
  resolvePromise?.();
  resolvePromise = null;
}

/** The line finished, was cancelled, or was suspended and handed the prompt back. */
export function endRun(): void {
  running = false;
  suspended = false;
  children.clear();
  // Same reason as interrupt.ts: a RESOLVED promise left here would make every
  // later suspendPromise() caller win its race immediately, so a following line
  // would suspend the moment it started.
  promise = null;
  resolvePromise = null;
}

export function isSuspended(): boolean {
  return suspended;
}

/** Resolves when the current run is suspended; never resolves otherwise. */
export function suspendPromise(): Promise<void> {
  if (suspended) return Promise.resolve();
  if (!promise) {
    promise = new Promise<void>((res) => {
      resolvePromise = res;
    });
  }
  return promise;
}

/**
 * Register a child's suspend action; returns the unregister. A child that spawns
 * after the press is stopped on the spot — the same rule as interrupt.ts's
 * `registerChild`, and for the same reason: a straggler must not escape the key
 * the user already pressed.
 */
export function registerChild(stop: () => void): () => void {
  if (suspended) {
    try {
      stop();
    } catch {}
    return () => {};
  }
  children.add(stop);
  return () => {
    children.delete(stop);
  };
}
