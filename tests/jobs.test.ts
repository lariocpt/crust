// G10 unit A — the job table (`src/jobs.ts`): the part of job control that is
// testable without a REPL. RED against the pre-change tree, where the module
// does not exist at all (every case fails to even resolve).
//
// Real children on purpose. A table mocked over a fake process would pin
// nothing about SIGSTOP/SIGCONT, and those are the whole reason crust can do
// this. Measured on Bun 1.4.3 / Linux before writing any of it:
//   · `Subprocess.signal` DOES NOT EXIST — `proc.kill(sig)` / `process.kill` only.
//   · `SIGTSTP` never stops a Bun-spawned child; `SIGSTOP` does (stat `T`),
//     `SIGCONT` releases it (`S`).
//   · `proc.exited` resolves with 128+signal for a signal death (143 for SIGTERM)
//     while `proc.exitCode` is null — so the awaited value is the honest code.
//   · `detached: true` DOES setsid: the child leads its own pgrp/session, so
//     `process.kill(-pid, …)` reaches the whole tree (a forked grandchild
//     included — pinned below), which is what makes Ctrl-Z mean "suspend the job".
//   · An un-awaited child HOLDS Bun's loop open (crust would sit at `exit` until
//     the job finished); `proc.unref()` releases it — the parent exits at once
//     and the child lives on. And awaiting `proc.exited` waits ON ITS OWN, even
//     for an unref'd child, so `wait`/`fg` need no `ref()`. The first draft of
//     this assumed they did; the probe says otherwise, so the assumption is
//     measured out rather than carried.
//   · `process.kill(-pid, …)` on a child that is NOT a group leader would signal
//     CRUST's own group — so signalling is group-only for jobs registered as such.
//
// Every child is reaped in afterEach; the suite budget is seconds, not 30s.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  contJob,
  currentJob,
  formatJobLine,
  formatSpawned,
  getJob,
  type Job,
  type JobProcess,
  killJob,
  listJobs,
  registerJob,
  resetJobs,
  statusLabel,
  stopJob,
  waitJob,
} from "../src/jobs";

// ---------- harness ----------

/** `/proc/<pid>/stat` state letter (`R`/`S`/`D`/`T`/`Z`), or "gone". */
function procState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces/parens: everything after `") "` is positional.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[0] ?? "gone";
  } catch {
    return "gone";
  }
}

/** Poll until the process reaches one of `want` (or the deadline); returns it. */
async function waitState(pid: number, want: string[], ms = 2000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const s = procState(pid);
    if (want.includes(s)) return s;
    if (Date.now() > until) return s;
    await Bun.sleep(20);
  }
}

/** Assert a process reaches one of `want`, naming it in the failure message. */
async function expectState(pid: number, want: string[], what: string): Promise<void> {
  const s = await waitState(pid, want);
  expect(want, `${what} — observed state ${JSON.stringify(s)}`).toContain(s);
}

/** Direct children of `pid` (to prove a GROUP signal reaches the whole tree). */
function kidsOf(pid: number): number[] {
  const out: number[] = [];
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (rest[1] === String(pid)) out.push(Number(e));
    } catch {}
  }
  return out;
}

const spawned: { pid: number; proc: JobProcess }[] = [];

/**
 * A real child, spawned the way `&` will (detached = own process group, unref'd =
 * crust's event loop is not held by it) and remembered for cleanup.
 */
function spawnChild(cmd: string[], detached: boolean): JobProcess {
  const proc = Bun.spawn(cmd, {
    stdio: ["inherit", "inherit", "inherit"],
    detached,
  });
  proc.unref();
  spawned.push({ pid: proc.pid, proc });
  return proc;
}

/** Spawn a real child and register it, exactly as `&` will. */
function spawnJob(
  label: string,
  cmd: string[] = ["sleep", "30"],
  opts: { group?: boolean; detached?: boolean } = {},
): Job {
  return registerJob(spawnChild(cmd, opts.detached !== false), label, { group: opts.group });
}

afterEach(async () => {
  const batch = spawned.splice(0, spawned.length);
  for (const { pid } of batch) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const { proc } of batch) {
    try {
      await proc.exited;
    } catch {}
  }
  resetJobs();
});

// ---------- registration and listing ----------

describe("job table — registration and listing", () => {
  test("an empty table lists nothing and resolves no job (control)", () => {
    expect(listJobs()).toEqual([]);
    expect(currentJob()).toBeNull();
    expect(getJob()).toBeNull();
    expect(getJob("%1")).toBeNull();
  });

  test("jobs are numbered from 1 in registration order", () => {
    const a = spawnJob("sleep 30");
    const b = spawnJob("sleep 31");
    expect(a.index).toBe(1);
    expect(b.index).toBe(2);
    expect(listJobs().map((j) => [j.index, j.label])).toEqual([
      [1, "sleep 30"],
      [2, "sleep 31"],
    ]);
    expect(a.status).toBe("running");
    expect(a.exited).toBe(false);
    expect(a.exitCode).toBeNull();
  });

  test("the spawn line crust prints for `&` is `[N] <pid> <label>`", () => {
    const j = spawnJob("sleep 30");
    expect(formatSpawned(j)).toBe(`[${j.index}] ${j.pid} sleep 30`);
  });

  test("a running job lists as Running and the newest job carries the + mark", () => {
    const a = spawnJob("sleep 30");
    const b = spawnJob("sleep 31");
    expect(formatJobLine(a, false)).toBe("[1]   Running   sleep 30");
    expect(formatJobLine(b, true)).toBe("[2]+  Running   sleep 31");
  });

  test("the + job is the newest that is still alive, and stops once all are gone", async () => {
    const a = spawnJob("sleep 30");
    const b = spawnJob("sleep 31");
    expect(currentJob()?.index).toBe(2);
    killJob(a);
    await a.proc.exited;
    expect(currentJob()?.index).toBe(2);
    killJob(b);
    await b.proc.exited;
    expect(currentJob()).toBeNull();
  });
});

// ---------- suspend / resume ----------

describe("job table — SIGSTOP / SIGCONT", () => {
  test("stopJob stops the child (state T) and marks the job Stopped", async () => {
    const j = spawnJob("sleep 30");
    await expectState(j.pid, ["S", "R", "D"], "the child is running before the stop");
    expect(stopJob(j)).toBe(true);
    expect(await waitState(j.pid, ["T"])).toBe("T");
    expect(j.status).toBe("stopped");
    expect(formatJobLine(j, true)).toBe("[1]+  Stopped   sleep 30");
  });

  test("contJob releases it (T -> S) and marks it Running again", async () => {
    const j = spawnJob("sleep 30");
    stopJob(j);
    expect(await waitState(j.pid, ["T"])).toBe("T");
    expect(contJob(j)).toBe(true);
    await expectState(j.pid, ["S", "R", "gone"], "the released child");
    expect(j.status).toBe("running");
  });

  test("a group job's signals reach the WHOLE tree — a stopped leader stops its grandchild", async () => {
    // sh forks a real grandchild here, so this is the Ctrl-Z case that matters:
    // suspending `sleep 20 & wait` must not leave a rogue `sleep` running.
    const j = spawnJob("sh -c 'sleep 20 & wait'", ["sh", "-c", "sleep 20 & wait"], {
      group: true,
    });
    let kids: number[] = [];
    const until = Date.now() + 2000;
    while (kids.length === 0 && Date.now() < until) {
      kids = kidsOf(j.pid);
      if (kids.length === 0) await Bun.sleep(20);
    }
    expect(kids.length, "the shell forked a child").toBeGreaterThan(0);
    expect(stopJob(j)).toBe(true);
    expect(await waitState(j.pid, ["T"])).toBe("T");
    for (const k of kids) expect(await waitState(k, ["T"]), `grandchild ${k}`).toBe("T");
    contJob(j);
    await expectState(j.pid, ["S", "R"], "the released leader");
    for (const k of kids) await expectState(k, ["S", "R"], `released grandchild ${k}`);
  });

  test("stopping a non-group job stops THAT child only — crust and its siblings are untouched", async () => {
    // Both children share CRUST's process group (spawned WITHOUT detached), so
    // an implementation that aimed at "the job's group" instead of the job's pid
    // would take the bystander — and the REPL itself — down with it. (The
    // ESRCH side of it is unpinnable here: a non-leader has no group to signal,
    // which is what the group test above exists for.)
    const bystander = spawnChild(["sleep", "30"], false);
    const j = spawnJob("sleep 31", ["sleep", "31"], { group: false, detached: false });
    await expectState(bystander.pid, ["S", "R", "D"], "the bystander starts running");
    expect(stopJob(j)).toBe(true);
    expect(await waitState(j.pid, ["T"])).toBe("T");
    expect(j.status).toBe("stopped");
    expect(procState(process.pid), "crust itself is never stopped").not.toBe("T");
    expect(procState(bystander.pid), "the sibling keeps running").not.toBe("T");
    contJob(j);
    await expectState(j.pid, ["S", "R"], "the released job");
  });
});

// ---------- completion and exit codes ----------

describe("job table — finishing", () => {
  test("a clean exit is Done with code 0", async () => {
    const j = spawnJob("true", ["true"]);
    await j.proc.exited;
    await Bun.sleep(0);
    expect(j.status).toBe("done");
    expect(j.exited).toBe(true);
    expect(j.exitCode).toBe(0);
    expect(statusLabel(j)).toBe("Done");
    expect(formatJobLine(j, true)).toBe("[1]+  Done      true");
  });

  test("a nonzero exit is `Exit N` — never a silent Done (honest failure)", async () => {
    const j = spawnJob("sh -c 'exit 3'", ["sh", "-c", "exit 3"]);
    await j.proc.exited;
    await Bun.sleep(0);
    expect(j.exitCode).toBe(3);
    expect(statusLabel(j)).toBe("Exit 3");
    expect(formatJobLine(j, true)).toBe("[1]+  Exit 3    sh -c 'exit 3'");
  });

  test("a signal death is Terminated, with the shell's 128+signal code", async () => {
    const j = spawnJob("sleep 30");
    expect(killJob(j, "SIGTERM")).toBe(true);
    expect(await j.proc.exited).toBe(143); // measured: Bun resolves 128+15, exitCode null
    await Bun.sleep(0);
    expect(j.status).toBe("done");
    expect(j.exitCode).toBe(143);
    expect(statusLabel(j)).toBe("Terminated");
  });

  test("signalling a job that is already gone is false, not a throw", async () => {
    const j = spawnJob("true", ["true"]);
    await j.proc.exited;
    await Bun.sleep(0);
    expect(j.status).toBe("done");
    expect(killJob(j)).toBe(false);
    expect(stopJob(j)).toBe(false);
    expect(contJob(j)).toBe(false);
    expect(j.status).toBe("done"); // and the status is not rewritten
  });

  test("a child that dies with no code is Failed, never Done (honest failure)", async () => {
    // The one path where crust has no exit code: `proc.exited` rejecting. Reading
    // it as `Done`/0 is precisely the false pass AGENTS.md rule 1 forbids, so the
    // label says Failed and waitJob refuses to swallow it into a 0.
    let reject!: (err: Error) => void;
    const fake: JobProcess = {
      pid: 4243,
      exited: new Promise<number>((_res, rej) => {
        reject = rej;
      }),
      kill: () => {},
    };
    const job = registerJob(fake, "sleep 30");
    reject(new Error("child died before it could be waited on"));
    await Bun.sleep(0);
    expect(job.status).toBe("done");
    expect(job.exitCode).toBeNull();
    expect(statusLabel(job)).toBe("Failed");
    expect(formatJobLine(job, true)).toBe("[1]+  Failed    sleep 30");
    expect(await waitJob(job).catch((e: Error) => e.message)).toBe(
      "child died before it could be waited on",
    );
  });
});

// ---------- job specs ----------

describe("job table — %N specs", () => {
  test("`%N`, `N`, a bare `%` and `%+` all resolve; junk does not", () => {
    const a = spawnJob("sleep 30");
    const b = spawnJob("sleep 31");
    expect(getJob("%1")?.index).toBe(1);
    expect(getJob("1")?.index).toBe(1);
    expect(getJob("%2")?.index).toBe(2);
    expect(getJob("%")?.index).toBe(b.index);
    expect(getJob("%+")?.index).toBe(b.index);
    expect(getJob()?.index).toBe(b.index);
    expect(getJob("%3")).toBeNull();
    expect(getJob("%0")).toBeNull();
    expect(getJob("0")).toBeNull();
    expect(getJob("%-1")).toBeNull();
    expect(getJob("abc")).toBeNull();
    expect(getJob("%1x")).toBeNull();
    expect(a.pid).not.toBe(b.pid);
  });

  test("a resolved job is the SAME object the table holds (fg/bg mutate it)", () => {
    const a = spawnJob("sleep 30");
    expect(getJob("%1")).toBe(listJobs()[0]);
    expect(getJob("1")).toBe(a);
  });
});

// ---------- wait / fg: the unref-ref pair ----------

/**
 * Run a tiny bun program in its own process; report (elapsed ms, stdout).
 * The grandchild sleeps with stdio IGNORED: an inherited pipe stays open in the
 * child and keeps the pipe's reader waiting, so the timing would measure the
 * pipe and not the event loop (that mistake cost a probe an hour).
 */
function runLoopProbe(mode: "unref+pending" | "no-unref" | "unref+awaited"): {
  ms: number;
  out: string;
} {
  const src =
    `const p = Bun.spawn(["sleep", "0.4"], { stdio: ["ignore","ignore","ignore"], detached: true });` +
    (mode === "no-unref" ? "" : "p.unref();") +
    (mode === "unref+pending"
      ? `await Bun.sleep(150);console.log("nowait");` // an unrelated pending handle, like the REPL's stdin
      : mode === "unref+awaited"
        ? `const c = await p.exited;console.log("after", c);`
        : `console.log("nowait");`);
  const t0 = Date.now();
  const r = Bun.spawnSync({
    cmd: [process.execPath, "-e", src],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ms: Date.now() - t0, out: r.stdout.toString() };
}

describe("job table — waitJob", () => {
  test("the mechanism `&` and `wait` rest on, measured in a real process", () => {
    // (1) `&`: an un-awaited child with nothing else pending KEEPS a Bun process
    // alive — without unref, crust would sit at `exit` until the job finished
    // (measured 8s-and-counting with a `sleep 30`; 403ms here).
    expect(
      runLoopProbe("no-unref").ms,
      "no unref: the loop is held for the child — why `&` must unref",
    ).toBeGreaterThanOrEqual(350);
    // (2) unref + any other pending handle (the REPL's stdin, an `exit` path):
    // the parent exits at once and the child lives on.
    const released = runLoopProbe("unref+pending");
    expect(released.ms, `unref'd: the parent must not wait (saw ${released.ms}ms)`).toBeLessThan(
      350,
    );
    expect(released.out).toContain("nowait");
    // (3) `wait`/`fg`: awaiting `proc.exited` holds the parent ON ITS OWN, even
    // for an unref'd child — so waitJob needs no ref() (see its comment).
    const held = runLoopProbe("unref+awaited");
    expect(
      held.ms,
      `awaited: the parent must stay for the child (saw ${held.ms}ms)`,
    ).toBeGreaterThanOrEqual(350);
    expect(held.out).toContain("after 0");
  });

  test("waitJob reports the code a live child exits with, and preserves it", async () => {
    const j = spawnJob("sleep 30");
    const w = waitJob(j);
    await Bun.sleep(60);
    expect(killJob(j, "SIGTERM")).toBe(true);
    expect(await w).toBe(143);
    expect(j.exitCode).toBe(143);
  });

  test("a finished job returns its code at once (no hang, code preserved)", async () => {
    const j = spawnJob("sh -c 'exit 5'", ["sh", "-c", "exit 5"]);
    await j.proc.exited;
    await Bun.sleep(0);
    const t0 = Date.now();
    expect(await waitJob(j)).toBe(5);
    expect(Date.now() - t0, "a dead job must not block").toBeLessThan(150);
  });

  test("a live job resolves when the child exits — crust waits, not races past it", async () => {
    // The un-awaited child does NOT hold the loop (unref'd at spawn), so
    // `wait`/`fg` must re-ref it: without that, awaiting exited is not enough
    // for the process to stick around and the code would be lost.
    const j = spawnJob("sleep 30");
    const w = waitJob(j);
    await Bun.sleep(60);
    expect(killJob(j, "SIGTERM")).toBe(true);
    expect(await w).toBe(143);
  });

  test("two callers can wait the same job (fg then wait, or wait twice)", async () => {
    const j = spawnJob("sh -c 'exit 7'", ["sh", "-c", "exit 7"]);
    const first = waitJob(j);
    const second = waitJob(j);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(j.exitCode).toBe(7);
  });
});
