// G10 unit B — job control in a REAL crust process.
//
// This file exists because the REPL-level suite could not see the worst bug in the
// feature. Under `bun test` the runner keeps the event loop full, so `proc.unref()`
// on a background job — the exact mechanism the feasibility notes prescribed — was
// invisible there, while in a real `crust script.crust` run it let Bun decide the
// process was finished AT the `&` line: every later line was skipped and the exit
// code was 0. Silent truncation with a pass. Nothing but spawning crust proves a
// script runs to its end, that the prompt comes back promptly, and that a job
// outlives the process.
//
// stdout/stderr go to FILES here, not pipes: a live background job inherits the
// pipe and keeps its reader waiting for the CHILD rather than for crust, which
// measures the pipe instead of the process (that trap cost two probes their numbers).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = `${import.meta.dir}/../src/index.ts`;
let dir: string;
const leaked: number[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-jobs-"));
});

afterAll(async () => {
  for (const pid of leaked) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  ms: number;
  /** the pid crust printed for job 1, when there was one */
  pid: number | null;
}

/** Run a .crust script in its own crust process, output to a file. */
async function runScript(name: string, body: string): Promise<Run> {
  const path = join(dir, name);
  const out = join(dir, `${name}.out`);
  await Bun.write(path, body);
  const file = Bun.file(out);
  const t0 = Date.now();
  const proc = Bun.spawn({
    cmd: ["bun", ENTRY, path],
    stdin: "ignore",
    stdout: file,
    stderr: file,
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-jobs-test-no-globals",
      XDG_DATA_HOME: dir,
    },
  });
  const code = await proc.exited;
  const ms = Date.now() - t0;
  const text = await file.text();
  const pid = /^\[\d\]\s+(\d+)\s/m.exec(text);
  return { code, out: text, ms, pid: pid ? Number(pid[1]) : null };
}

/**
 * Is `pid` a process RIGHT NOW? A zombie does not count: it is a process that has
 * already died and is only waiting to be reaped, so calling it alive would be the
 * same lie `jobs` telling a killed job is `Running` would be. (The first draft of
 * this helper only checked the pid was a finite number, which made the "the job
 * outlived crust" pin impossible to fail — a test that cannot fail is the thing
 * AGENTS rule 1 is about, so it measured nothing until it was rewritten.)
 */
function alive(pid: number | null): boolean {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
    return state !== "" && state !== "Z";
  } catch {
    return false;
  }
}

describe("`&` in a real crust process", () => {
  test("a backgrounded line does not end the script", async () => {
    const r = await runScript("trunc.crust", "sleep 0.2 &\njobs\necho after\n");
    expect(r.out, "the `&` line printed its job").toInclude("[1] ");
    expect(r.out, "the builtin on the next line still ran").toInclude("Running");
    expect(r.out, "…and the line after that").toInclude("after");
    expect(r.code).toBe(0);
  });

  // This is the regression pin for the `proc.unref()` the design notes prescribed,
  // and the shape of the bug is worth writing down: an unref'd child plus a later
  // line that AWAITS something with no event-loop handle of its own (here, the
  // pending job) let Bun decide the process was finished — the script stopped at
  // that line and exited 0. A following line that spawns its own child (an `echo`)
  // supplies a handle and hides it, which is why the first draft of this file's
  // truncation test stayed green against the broken code and this one does not.
  test("`wait %1` carries the job's exit code out of the process", async () => {
    const r = await runScript("wait3.crust", "exit 3 &\nwait %1\n");
    expect(r.code, "crust exits with the waited job's code").toBe(3);
    expect(r.out).toInclude("[1] ");
  });

  test("a job that dies nonzero does not fail a later line (honesty, both ways)", async () => {
    const r = await runScript("later.crust", "exit 4 &\necho hi\n");
    expect(r.out).toInclude("hi");
    expect(r.code, "a background job's 4 is not this line's failure").toBe(0);
  });

  test("crust exits without waiting for the job, and the job outlives it", async () => {
    const r = await runScript("outlive.crust", "sleep 14.7191 &\n");
    expect(r.code).toBe(0);
    expect(r.ms, `crust must not wait 14s for its job (took ${r.ms}ms)`).toBeLessThan(4000);
    expect(r.pid, "crust printed a pid").not.toBeNull();
    // The job is STILL THERE after crust is gone — the documented policy (`&` means
    // outlive the session), checked against /proc rather than taken on faith.
    expect(alive(r.pid), `job ${r.pid} must still be running`).toBe(true);
    if (r.pid) {
      leaked.push(r.pid);
      process.kill(r.pid, "SIGKILL");
    }
  });

  test("`kill %N` names the signal, and `jobs` reports what it has verified", async () => {
    // The line between `&` and `kill %1` is a real race, not a test artifact: a
    // `sh -c` that has not exec'd yet holds SIGTERM pending, so crust may send the
    // signal to a job that is genuinely still alive for a few more milliseconds.
    // That is why the kill line claims only the SEND, and why `jobs` here gets a
    // moment (a real foreground `sleep` line) to see the state it prints.
    const r = await runScript("kill1.crust", "sleep 14.7192 &\nkill %1\nsleep 0.35\njobs\n");
    expect(r.out).toInclude("Sent SIGTERM to job 1 (pid ");
    expect(r.out, "a job that died from the signal is not listed Running").not.toInclude("Running");
    expect(r.out).toInclude("Terminated");
    expect(r.code).toBe(0);
    if (r.pid && alive(r.pid)) leaked.push(r.pid);
  });

  test("`wait %1` after `kill %1` reports 143 = 128+SIGTERM, honestly", async () => {
    const r = await runScript("killwait.crust", "sleep 14.7193 &\nkill %1\nwait %1\n");
    expect(r.code, "crust exits with the signal-death code, not 0").toBe(143);
    if (r.pid && alive(r.pid)) leaked.push(r.pid);
  });

  test("a foreground child still blocks the script and returns its code (control)", async () => {
    const r = await runScript("fg.crust", "sleep 0.6\necho after\n");
    expect(r.ms, "no `&` means no early return").toBeGreaterThanOrEqual(500);
    expect(r.out).toInclude("after");
    expect(r.code).toBe(0);
  });

  test("`fg %9` in a script says there is no such job and exits 1", async () => {
    const r = await runScript("nojob.crust", "fg %9\n");
    expect(r.code).toBe(1);
    expect(r.out).toInclude("crust: no job %9");
  });
});
