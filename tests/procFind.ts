// Find running processes by their full command line, without `pgrep`.
//
// WHY NOT pgrep. It lives in procps, which slim container images do not ship —
// `oven/bun:1`, the image the publish gate runs the suite in, has no pgrep at
// all. Bun.spawnSync of a missing binary does not throw; it returns empty
// stdout. Every "is the child gone?" assertion built on that therefore PASSED
// VACUOUSLY in exactly the environment that gates a release, which is the
// false pass this project refuses to ship (AGENTS.md design rule 1).
//
// So: read /proc directly on Linux, and where that does not exist fall back to
// ps — but if the probe itself cannot run, THROW. "I could not look" must
// never be spelled the same way as "I looked and found nothing".
import { readdirSync, readFileSync } from "node:fs";

export function pidsMatching(needle: string): number[] {
  if (process.platform === "linux") {
    const pids: number[] = [];
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      let cmd: string;
      try {
        // NUL-separated argv; the separators matter because "sleep 26.317"
        // must match `sh -c sleep 26.317` as one contiguous string.
        cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {
        continue; // exited between readdir and read — not our process
      }
      if (pid !== process.pid && cmd.includes(needle)) pids.push(pid);
    }
    return pids;
  }

  const r = Bun.spawnSync(["ps", "-eo", "pid=,args="]);
  if (!r.success) {
    throw new Error(
      `cannot probe for running processes on ${process.platform}: ` +
        `ps exited ${r.exitCode} (${r.stderr.toString().trim() || "no stderr"})`,
    );
  }
  return r.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(needle))
    .map((l) => Number(l.split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

export const isRunning = (needle: string): boolean => pidsMatching(needle).length > 0;
