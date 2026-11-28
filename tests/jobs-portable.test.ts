import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  contJob,
  currentJob,
  killJob,
  registerJob,
  resetJobs,
  settleJobs,
  statusLabel,
  stopJob,
} from "../src/jobs";

const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await child.exited;
  }
  resetJobs();
});

function childJob() {
  const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  children.push(child);
  return registerJob(child, "portable sleep");
}

function unreadableProc(code: string) {
  const original = fs.readFileSync;
  return spyOn(fs, "readFileSync").mockImplementation(((path, ...args) => {
    if (String(path).startsWith("/proc/")) throw Object.assign(new Error(code), { code });
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFileSync);
}

describe("job liveness without usable /proc", () => {
  test.each(["ENOENT", "EACCES"])(
    "%s metadata does not fail a live or stopped job or prevent signals",
    async (code) => {
      const job = childJob();
      const stat = unreadableProc(code);
      try {
        await settleJobs(0);
        expect(job.status).toBe("running");
        expect(job.exited).toBe(false);
        expect(job.exitCode).toBeNull();
        expect(currentJob()).toBe(job);
        expect(statusLabel(job)).toBe("Running");
        expect(stopJob(job)).toBe(true);
        await settleJobs(0);
        expect(statusLabel(job)).toBe("Stopped");
        expect(contJob(job)).toBe(true);
        expect(killJob(job, "SIGTERM")).toBe(true);
        expect(await job.proc.exited).toBe(143);
        expect(statusLabel(job)).toBe("Terminated");
      } finally {
        stat.mockRestore();
      }
    },
  );

  test.each(["EPERM", "EACCES", "UNKNOWN"])(
    "an inconclusive signal probe (%s) cannot declare a job dead",
    async (code) => {
      const job = childJob();
      const stat = unreadableProc("ENOENT");
      const originalKill = process.kill;
      const probe = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === job.pid && signal === 0) throw Object.assign(new Error(code), { code });
        return originalKill(pid, signal);
      });
      try {
        await settleJobs(0);
        expect(probe).toHaveBeenCalledWith(job.pid, 0);
        expect(job.status).toBe("running");
        expect(job.exited).toBe(false);
        expect(job.exitCode).toBeNull();
      } finally {
        probe.mockRestore();
        stat.mockRestore();
      }
    },
  );

  test("ESRCH still settles a truly gone PID as Failed without inventing a code", async () => {
    const child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
    await child.exited;
    const job = registerJob(
      { pid: child.pid, exited: new Promise<number>(() => {}), kill: () => {} },
      "gone child",
    );
    const stat = unreadableProc("ENOENT");
    try {
      await settleJobs(0);
      expect(job.status).toBe("done");
      expect(job.exitCode).toBeNull();
      expect(statusLabel(job)).toBe("Failed");
    } finally {
      stat.mockRestore();
    }
  });

  test.skipIf(process.platform !== "linux")(
    "Linux zombie metadata still overrides a successful signal-zero probe",
    async () => {
      const job = registerJob(
        { pid: process.pid, exited: new Promise<number>(() => {}), kill: () => {} },
        "zombie observation",
      );
      const original = fs.readFileSync;
      const stat = spyOn(fs, "readFileSync").mockImplementation(((path, ...args) => {
        if (String(path) === `/proc/${job.pid}/stat`) return `${job.pid} (name with ) parens) Z 1`;
        return Reflect.apply(original, fs, [path, ...args]);
      }) as typeof fs.readFileSync);
      try {
        await settleJobs(0);
        expect(job.status).toBe("done");
        expect(statusLabel(job)).toBe("Failed");
      } finally {
        stat.mockRestore();
      }
    },
  );
});
