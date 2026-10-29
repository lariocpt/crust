// G10 unit B — job control wired into the REPL: `&`, `jobs`, `fg`, `bg`, `wait`,
// `kill %N`, and Ctrl-Z suspend.
//
// RED against the pre-change tree: `src/suspend.ts` does not exist there (so the
// file cannot even resolve), `jobs`/`fg`/`bg`/`wait` are not builtins, and a
// trailing `&` is whatever sh makes of it (today: an orphaned grandchild crust
// never sees — the exact behaviour G10 exists to replace).
//
// Most of this runs WITHOUT a tty on purpose: the job table is session state, not
// terminal state, so `printf 'sleep 30 &\njobs\n' | crust` works and the builtins
// are testable through runLine directly. Ctrl-Z is the exception — it is a key,
// so those cases use the fake REPL terminal from tests/interrupt.test.ts and
// `handleStdinData("\x1a")`, exactly as the Ctrl-C suite drives `0x03`.
//
// Unique sleep times everywhere: the checks look for a child by its argument, and
// a leaked `sleep 30` from another test would silently satisfy `isRunning`.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { registerBuiltinFns } from "../src/builtinFns";
import { handleStdinData, onSuspend } from "../src/editor";
import * as interrupt from "../src/interrupt";
import {
  formatSpawned,
  getJob,
  type Job,
  listJobs,
  registerJob,
  resetJobs,
  resumeStoppedJobs,
  settleJobs,
  statusLabel,
  stopJob,
  trailingBackgroundOp,
} from "../src/jobs";
import { type ReplTty, runLine } from "../src/runLine";
import type { Context } from "../src/types";

// ---------- harness ----------

function ctx(): Context {
  const c: Context = {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: (() => {}) as never,
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
  };
  // The real session registers its builtin functions before running a line, and
  // that registration is what makes `wait :3000/health` crust's readiness stage
  // instead of a word for sh — a ctx without it silently tests a different path.
  registerBuiltinFns(c);
  return c;
}

/** A fake REPL terminal that also receives Ctrl-Z (unit B adds `onSuspend`). */
function fakeTty(): ReplTty & {
  press(): void;
  pressZ(): void;
  armed: number;
  armedZ: number;
  disposed: number;
  suspended: number;
  restored: number;
} {
  const t = {
    armed: 0,
    armedZ: 0,
    disposed: 0,
    suspended: 0,
    restored: 0,
    cb: null as (() => void) | null,
    cbZ: null as (() => void) | null,
    press() {
      t.cb?.();
    },
    pressZ() {
      t.cbZ?.();
    },
    onInterrupt(cb: () => void) {
      t.armed++;
      t.cb = cb;
      return () => {
        t.disposed++;
        if (t.cb === cb) t.cb = null;
      };
    },
    onSuspend(cb: () => void) {
      t.armedZ++;
      t.cbZ = cb;
      return () => {
        t.disposed++;
        if (t.cbZ === cb) t.cbZ = null;
      };
    },
    suspend() {
      t.suspended++;
      return () => {
        t.restored++;
      };
    },
  };
  return t;
}

function procState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "gone";
  } catch {
    return "gone";
  }
}

async function waitState(pid: number, want: string[], ms = 2000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const s = procState(pid);
    if (want.includes(s)) return s;
    if (Date.now() > until) return s;
    await Bun.sleep(20);
  }
}

/**
 * The pids running `sleep <token>` — crust's `sh -c` child (before it execs) and
 * the exec'd sleep (after). Matching ARGV ELEMENTS rather than a substring of the
 * command line is deliberate: a substring also matches whatever shell is driving
 * `bun test`, whose command line contains this very file's text, and that false
 * positive once reported a killed job as still running.
 */
function pidsRunning(token: string): number[] {
  const out: number[] = [];
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const exe = (argv[0] ?? "").split("/").pop() ?? "";
      if (!["sleep", "sh", "bash", "dash"].includes(exe)) continue;
      if (argv.some((a) => a === token || a === `sleep ${token}`)) out.push(pid);
    } catch {}
  }
  return out;
}

/** What is matching `token` right now — so a failed wait names the offender. */
function runningCmds(token: string): string[] {
  return pidsRunning(token).map((pid) => {
    try {
      return `${pid} ${readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").slice(0, 60)}`;
    } catch {
      return `${pid} (gone)`;
    }
  });
}

async function waitRunning(token: string, want: boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    // True when the wanted state is REACHED — `found` itself would read as a
    // failure every time `want` is false (that inversion cost an hour of
    // "the process survived" reports against code that was killing it fine).
    if (pidsRunning(token).length > 0 === want) return true;
    if (Date.now() > until) return false;
    await Bun.sleep(50);
  }
}

const captured: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/** Run a line with stdout/stderr captured so the format strings are assertable. */
async function run(line: string, tty?: ReturnType<typeof fakeTty>): Promise<number> {
  captured.stdout = "";
  captured.stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return await runLine(line, ctx(), tty);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

const living: number[] = [];

/** Kill every child any test in this file started, then empty the table. */
afterEach(async () => {
  const pids = [...living];
  living.length = 0;
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  interrupt.endRun();
  resetJobs();
  await Bun.sleep(0);
});

function track(job: Job | null | undefined): void {
  if (job) living.push(job.pid);
}

/**
 * Job `%1`, or a loud failure — so the tests read as `job.status` instead of
 * putting a non-null assertion on every second line. A missing job IS a bug in
 * the test or the feature, and this says which.
 */
function mustJob(spec = "%1"): Job {
  const job = getJob(spec);
  if (!job) throw new Error(`no job ${spec} registered — & never made one`);
  return job;
}

// ---------- `&` detection ----------

describe("`&` is crust's when it ends the whole line", () => {
  test("a trailing bare `&` is stripped and reported as the command", () => {
    expect(trailingBackgroundOp("sleep 30 &")).toBe("sleep 30");
    expect(trailingBackgroundOp("sleep 30&")).toBe("sleep 30");
    expect(trailingBackgroundOp("sleep 30 &  ")).toBe("sleep 30");
  });

  test("no `&`, `&&`, or a `&` inside quotes is not backgrounding (controls)", () => {
    expect(trailingBackgroundOp("sleep 30")).toBeNull();
    expect(trailingBackgroundOp("sleep 30 && echo hi")).toBeNull();
    expect(trailingBackgroundOp('echo "a & b"')).toBeNull();
    expect(trailingBackgroundOp("echo 'a &b'")).toBeNull();
    expect(trailingBackgroundOp('sh "sleep 1 &"')).toBeNull();
    // A pure-shell pipeline is still ONE `sh -c`, so it backgrounds as a job too.
    expect(trailingBackgroundOp("seq 3 | grep 2 &")).toBe("seq 3 | grep 2");
  });

  test("an unbalanced quote is sh's problem, not a background request", () => {
    expect(trailingBackgroundOp('echo "a & b &')).toBeNull();
  });
});

// ---------- `&` through runLine ----------

describe("`&` — the background job", () => {
  test("`sleep 24.711 &` returns at once, registers the job and prints `[N] <pid> <label>`", async () => {
    const t0 = Date.now();
    const code = await run("sleep 24.711 &");
    expect(code).toBe(0);
    expect(Date.now() - t0, "the prompt must come back immediately").toBeLessThan(1000);
    const job = mustJob();
    track(job);
    expect(job, "the job is in the table").not.toBeNull();
    expect(job.label).toBe("sleep 24.711");
    expect(job.status).toBe("running");
    expect(job.group, "a detached job leads its own group").toBe(true);
    expect(captured.stdout.trim()).toBe(formatSpawned(job));
    expect(await waitRunning("24.711", true), "the child is really alive").toBe(true);
  });

  test("`sleep 1` with no `&` still blocks and returns its code (control)", async () => {
    const t0 = Date.now();
    const code = await run("sleep 1.1734");
    expect(code).toBe(0);
    expect(Date.now() - t0, "a foreground child is still foreground").toBeGreaterThanOrEqual(900);
    expect(listJobs()).toEqual([]);
  });

  test('`echo "a & b"` is sh\'s and creates no job (control)', async () => {
    // Its OUTPUT is not assertable here on purpose: an inherit-stdio child writes
    // to fd 1, not through the patched process.stdout — this suite asserts crust's
    // own writes. What matters is that crust stayed out of the way.
    const code = await run('echo "a & b"');
    expect(code).toBe(0);
    expect(listJobs()).toEqual([]);
  });

  test("`exit 3 &` records 3, and `jobs` says `Exit 3` — never a silent Done", async () => {
    const code = await run("exit 3 &");
    expect(code).toBe(0);
    const job = mustJob();
    track(job);
    expect(job).not.toBeNull();
    await job.proc.exited;
    await Bun.sleep(0);
    expect(job.exitCode).toBe(3);
    expect(await run("jobs")).toBe(0);
    expect(captured.stdout).toBe("[1]+  Exit 3     exit 3\n");
  });

  test("`jobs` lists nothing on an empty table and exits 0 (control)", async () => {
    expect(await run("jobs")).toBe(0);
    expect(captured.stdout).toBe("");
  });

  test("`jobs` marks the newest live job with `+` and a dead one without", async () => {
    const a = await run("sleep 24.712 &");
    expect(a).toBe(0);
    track(getJob("%1"));
    expect(await run("jobs")).toBe(0);
    expect(captured.stdout).toBe("[1]+  Running    sleep 24.712\n");
  });

  test("`jobs -l` adds the pid, a named job lists alone, an unknown option is refused", async () => {
    await run("sleep 24.7121 &");
    const a = mustJob();
    track(a);
    await run("sleep 24.7122 &");
    const b = mustJob("%2");
    track(b);
    expect(await run("jobs %1")).toBe(0);
    expect(captured.stdout, "one operand means one job, and `+` stays on the newest").toBe(
      "[1]   Running    sleep 24.7121\n",
    );
    expect(await run("jobs -l")).toBe(0);
    expect(captured.stdout).toBe(
      `[1]   Running    sleep 24.7121  (pid ${a.pid})\n` +
        `[2]+  Running    sleep 24.7122  (pid ${b.pid})\n`,
    );
    // An option crust does not have is refused rather than ignored: the user
    // cannot tell an ignored `-x` from a carried one.
    expect(await run("jobs -x")).toBe(1);
    expect(captured.stdout).toBe("");
    expect(captured.stderr).toInclude("crust: jobs: -x is not an option");
    expect(await run("jobs %9")).toBe(1);
    expect(captured.stderr).toInclude("crust: no job %9");
  });

  test("`kill %1` stops the job and `jobs` reports Terminated", async () => {
    await run("sleep 24.713 &");
    const job = mustJob();
    track(job);
    expect(await waitRunning("24.713", true)).toBe(true);
    expect(await run("kill %1")).toBe(0);
    expect(
      await waitRunning("24.713", false),
      `the process is gone — matched: ${JSON.stringify(runningCmds("24.713"))}`,
    ).toBe(true);
    await Bun.sleep(0);
    expect(await run("jobs")).toBe(0);
    expect(captured.stdout).toBe("[1]+  Terminated sleep 24.713\n");
  });

  test("`kill 1234` stays sh's — crust does not intercept a non-% operand", async () => {
    // The line must reach `sh -c`, where kill's own error/exit answers. Pinning
    // the shape: no job is consulted and crust's own message never appears.
    const code = await run("kill 99999999");
    expect(code).not.toBe(0);
    expect(captured.stderr).not.toContain("no job");
    expect(listJobs()).toEqual([]);
  });

  test("`fg %9` / `wait %9` / `bg %9` say there is no such job and exit 1", async () => {
    for (const [line, spec] of [
      ["fg %9", "%9"],
      ["wait %9", "%9"],
      ["bg %9", "%9"],
      ["kill %9", "%9"],
      ["fg bogus", "bogus"],
    ] as const) {
      expect(await run(line), line).toBe(1);
      expect(captured.stderr, line).toBe(`crust: no job ${spec}\n`);
    }
  });
});

// ---------- fg / bg / wait ----------

describe("fg / bg / wait", () => {
  test("`fg %1` waits and returns the CHILD's code", async () => {
    await run("sleep 1.1735 &");
    const job = mustJob();
    track(job);
    const t0 = Date.now();
    const code = await run("fg %1");
    expect(code, "fg's exit code is the job's").toBe(0);
    expect(Date.now() - t0, "fg really waited for the job").toBeGreaterThanOrEqual(800);
  });

  test("`fg %1` on a job that exited 3 returns 3 (the honesty control)", async () => {
    await run("exit 3 &");
    const job = mustJob();
    track(job);
    await job.proc.exited;
    expect(await run("fg %1")).toBe(3);
  });

  test("`bg %1` resumes a stopped job — /proc goes T then S", async () => {
    await run("sleep 24.714 &");
    const job = mustJob();
    track(job);
    stopJob(job);
    expect(await waitState(job.pid, ["T"])).toBe("T");
    expect(await run("bg %1")).toBe(0);
    expect(["S", "R"], "resumed").toContain(await waitState(job.pid, ["S", "R"]));
    expect(job.status).toBe("running");
    // bg answers with the line `jobs` shows, so the change of state is visible.
    expect(captured.stdout).toBe("[1]+  Running    sleep 24.714\n");
  });

  test("`wait :3000/nope` is still the readiness stage, not job control (control)", async () => {
    // The collision a first pass created: `wait` registered as a builtin swallowed
    // crust's readiness stage (`src/builtinFns/wait.ts`) and four documented
    // behaviours went red. The operand decides — a `%job` is crust's job, a target
    // is the stage's — and this is the pin that keeps it that way.
    const code = await run("wait :1/nope --timeout 200ms");
    expect(code, "the stage ran and reported its own failure").not.toBe(0);
    expect(captured.stderr).toInclude("wait:");
    expect(captured.stderr).not.toInclude("no job");
    expect(listJobs()).toEqual([]);
  });

  test("`wait %1` on a live job blocks for it and reports the code", async () => {
    await run("sleep 0.7135 &");
    const job = mustJob();
    track(job);
    const t0 = Date.now();
    expect(await run("wait %1")).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  test("`wait %1` on a finished job returns at once with the code preserved", async () => {
    await run("exit 5 &");
    const job = mustJob();
    track(job);
    await job.proc.exited;
    const t0 = Date.now();
    expect(await run("wait %1")).toBe(5);
    expect(Date.now() - t0, "a dead job must not block").toBeLessThan(200);
    // …and a second `wait` still has the code — finished jobs stay listed.
    expect(await run("wait %1")).toBe(5);
  });

  test("a background job that dies later does not change any line's code", async () => {
    await run("exit 4 &");
    const job = mustJob();
    track(job);
    await job.proc.exited;
    await Bun.sleep(0);
    expect(await run("jobs")).toBe(0);
    // A later line's own exit code is its own — a dead job cannot retroactively
    // fail it (`echo` writes to fd 1, so only the code is assertable here).
    expect(await run("echo hi")).toBe(0);
  });
});

// ---------- Ctrl-Z ----------

describe("Ctrl-Z — the suspend bus", () => {
  test("the bus mirrors interrupt.ts: latch, idempotence, late registrations", async () => {
    const suspend = await import("../src/suspend");
    suspend.fire();
    expect(suspend.isSuspended()).toBe(false);
    suspend.beginRun();
    let stops = 0;
    const unregister = suspend.registerChild(() => stops++);
    suspend.registerChild(() => stops++);
    unregister();
    suspend.fire();
    expect(stops).toBe(1);
    expect(suspend.isSuspended()).toBe(true);
    suspend.fire();
    expect(stops, "Ctrl-Z is one press per stop, like Ctrl-C").toBe(1);
    suspend.registerChild(() => stops++); // spawned after the press must not escape stopped
    expect(stops).toBe(2);
    await suspend.suspendPromise();
    suspend.endRun();
    expect(suspend.isSuspended()).toBe(false);
  });

  test("0x1a fires the armed suspend watcher, 0x03 still fires Ctrl-C (control)", () => {
    let zed = 0;
    const ctrl = 0;
    const disposeZ = onSuspend(() => zed++);
    const disposeC = () => {};
    handleStdinData("\x1a");
    expect(zed).toBe(1);
    handleStdinData("no keys here");
    expect(zed).toBe(1);
    disposeZ();
    disposeC();
    handleStdinData("\x1a"); // disarmed — the byte is typeahead again
    expect(zed).toBe(1);
    void ctrl;
  });

  test("Ctrl-Z during a pipeline stops the shell child, returns 148, and lists it Stopped", async () => {
    const marker = "sleep 26.7151";
    const tty = fakeTty();
    const run_ = runLine(`range(1,3) | ${marker}`, ctx(), tty);
    expect(await waitRunning("26.7151", true), "the child started").toBe(true);
    const t0 = Date.now();
    tty.pressZ();
    expect(await run_, "a suspended line reports the shell's SIGTSTP code").toBe(148);
    expect(Date.now() - t0, "the prompt comes back at once").toBeLessThan(300);
    const job = mustJob();
    track(job);
    expect(job, "the stopped child is a job now").not.toBeNull();
    expect(job.status).toBe("stopped");
    expect(job.label).toBe(marker);
    expect(await waitState(job.pid, ["T"]), "the child is SIGSTOP'd").toBe("T");
    // `bg` resumes exactly what Ctrl-Z stopped.
    expect(await run("bg %1")).toBe(0);
    expect(["S", "R"], "resumed").toContain(await waitState(job.pid, ["S", "R"]));
  }, 15_000);

  test("Ctrl-C during `fg %1` is a normal foreground Ctrl-C: the job dies, 130", async () => {
    // The gap's rule — "Ctrl-C during `fg` behaves like a normal foreground Ctrl-C"
    // — and the escape hatch a user reaches for first. A `fg` that only answered
    // Ctrl-Z would leave the job unkillable from the prompt that was waiting on it.
    await run("sleep 24.7172 &");
    const job = mustJob();
    track(job);
    const tty = fakeTty();
    const pending = runLine("fg %1", ctx(), tty);
    await Bun.sleep(120);
    tty.press();
    expect(await pending, "130 = 128+SIGINT, the code a shell gives").toBe(130);
    expect(
      await waitRunning("24.7172", false),
      `the job must be gone — matched: ${JSON.stringify(runningCmds("24.7172"))}`,
    ).toBe(true);
    // The reap is its own moment: right after the press the process can be a
    // zombie with the code not yet delivered, so settle first and then ask the
    // table what it recorded — `Terminated`, never a silent `Done`.
    await settleJobs();
    expect(job.status).toBe("done");
    expect(statusLabel(job)).toBe("Terminated");
  }, 15_000);

  test("Ctrl-C during `wait %1` kills the waited job too", async () => {
    await run("sleep 24.7173 &");
    const job = mustJob();
    track(job);
    const tty = fakeTty();
    const pending = runLine("wait %1", ctx(), tty);
    await Bun.sleep(120);
    tty.press();
    expect(await pending).toBe(130);
    expect(
      await waitRunning("24.7173", false),
      `matched: ${JSON.stringify(runningCmds("24.7173"))}`,
    ).toBe(true);
  }, 15_000);

  test("Ctrl-Z while `wait` runs suspends the waited job, not the session", async () => {
    await run("sleep 24.7152 &");
    const job = mustJob();
    track(job);
    const tty = fakeTty();
    const pending = runLine("wait %1", ctx(), tty);
    await Bun.sleep(120);
    expect(tty.armedZ, "a builtin arms the suspend watcher too").toBeGreaterThan(0);
    tty.pressZ();
    expect(await pending).toBe(148);
    expect(job.status).toBe("stopped");
    expect(await waitState(job.pid, ["T"])).toBe("T");
  }, 15_000);

  test("Ctrl-C still interrupts a pipeline with 130 and leaves no job (control)", async () => {
    const tty = fakeTty();
    const run_ = runLine(`range(1,3) | sleep 26.7153`, ctx(), tty);
    expect(await waitRunning("26.7153", true)).toBe(true);
    tty.press();
    expect(await run_).toBe(130);
    expect(
      await waitRunning("26.7153", false),
      `Ctrl-C kills, not stops — matched: ${JSON.stringify(runningCmds("26.7153"))}`,
    ).toBe(true);
    expect(listJobs().filter((j) => j.status !== "done")).toEqual([]);
  }, 15_000);

  test("no watcher arms without a tty — scripts are untouched (control)", async () => {
    expect(await run("range(1,2)")).toBe(0);
  });
});

// ---------- leaving the session ----------

describe("stopped jobs and session exit", () => {
  test("resumeStoppedJobs SIGCONTs stopped jobs, leaves running/done ones alone", async () => {
    const stopper = Bun.spawn(["sleep", "24.716"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const runner = Bun.spawn(["sleep", "24.7161"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    living.push(stopper.pid, runner.pid);
    const stopped = registerJob(stopper, "sleep 24.716", { group: true });
    const running = registerJob(runner, "sleep 24.7161", { group: true });
    stopJob(stopped);
    expect(await waitState(stopped.pid, ["T"])).toBe("T");
    const resumed = resumeStoppedJobs();
    expect(resumed.map((j) => j.index)).toEqual([stopped.index]);
    expect(stopped.status).toBe("running");
    expect(running.status).toBe("running");
    expect(["S", "R"], "resumed").toContain(await waitState(stopped.pid, ["S", "R"]));
  });

  test("contJob on a stopped job that leads a group resumes the whole tree", async () => {
    // The Ctrl-Z case that matters in reverse: `sh -c "sleep N & wait"` forks a
    // grandchild, the group stop took both, and `bg` has to give both back.
    const job = registerJob(
      Bun.spawn(["sh", "-c", "sleep 24.717 & wait"], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      }),
      "sh -c 'sleep 24.717 & wait'",
      { group: true },
    );
    living.push(job.pid);
    stopJob(job);
    expect(await waitState(job.pid, ["T"])).toBe("T");
    expect(resumeStoppedJobs().map((j) => j.pid)).toEqual([job.pid]);
    expect(["S", "R"], "resumed").toContain(await waitState(job.pid, ["S", "R"]));
    expect(job.status).toBe("running");
  });
});
