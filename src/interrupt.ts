// Interrupt bus for REPL job control (Ctrl-C while a line runs).
//
// Why a bus and not just `iterator.return()`: per spec, `.return()` on an
// async generator that is parked on an `await` is QUEUED — it cannot wake a
// generator sitting in `await Bun.sleep(...)`. Long-poll sources (tail's
// follow loop) instead RACE their sleeps against interruptPromise(), and
// spawned children register a kill so cancellation reaches them without
// waiting for the drain to unwind on its own.
//
// Outside the REPL (scripts, -c, piped stdin) nothing ever calls beginRun():
// isInterrupted() stays false and interruptPromise() never resolves, so the
// races cost nothing and behavior is unchanged.

let running = false;
let interrupted = false;
let promise: Promise<void> | null = null;
let resolvePromise: (() => void) | null = null;
const children = new Set<() => void>();

/** Arm the bus for one REPL line. Clears any state from the previous run. */
export function beginRun(): void {
  running = true;
  interrupted = false;
  promise = null;
  resolvePromise = null;
  children.clear();
}

/** Ctrl-C: kill registered children, wake every parked race. Idempotent. */
export function fire(): void {
  if (!running || interrupted) return;
  interrupted = true;
  for (const kill of children) {
    try {
      kill();
    } catch {
      // a child that is already gone is a success, not an error
    }
  }
  children.clear();
  resolvePromise?.();
  resolvePromise = null;
}

/** The line finished (drained, failed, or was cancelled). */
export function endRun(): void {
  running = false;
  interrupted = false;
  children.clear();
  // Drop the cached promise: after a fired run it is RESOLVED, and any
  // interruptPromise() caller between now and the next beginRun (a tail
  // started at the idle prompt, or one that was mid-stat when fire hit)
  // would win its poll race instantly forever — a hot stat() loop at ~200%
  // CPU. An unresolved promise from a clean run is dropped too; abandoned
  // generators wake on their own sleep tick and process their queued return.
  promise = null;
  resolvePromise = null;
}

export function isInterrupted(): boolean {
  return interrupted;
}

/** Resolves when the current run is interrupted; never resolves otherwise. */
export function interruptPromise(): Promise<void> {
  if (interrupted) return Promise.resolve();
  if (!promise) {
    promise = new Promise<void>((res) => {
      resolvePromise = res;
    });
  }
  return promise;
}

/** Register a kill for a spawned child; returns the unregister. */
export function registerChild(kill: () => void): () => void {
  if (interrupted) {
    // Fired already — don't let a straggler spawn outlive the cancel.
    try {
      kill();
    } catch {}
    return () => {};
  }
  children.add(kill);
  return () => {
    children.delete(kill);
  };
}
