import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline";
import { GET, glob, load, range, read, tail } from "../src/sources";
import { pidsMatching } from "./procFind";

// Can this kernel host an IPv6 loopback listener at all? Asked once, by trying:
// Bun.listen({hostname:"::1"}) THROWS EADDRNOTAVAIL where IPv6 is disabled, so
// the v6 readiness tests below must skip rather than explode there.
const hasIpv6Loopback = (() => {
  try {
    const probe = Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
})();

describe("range", () => {
  test("inclusive integer range", async () => {
    expect(await range(0, 4).collect()).toEqual([0, 1, 2, 3, 4]);
  });

  test("single-item range", async () => {
    expect(await range(7, 7).collect()).toEqual([7]);
  });

  test("empty when start > end", async () => {
    expect(await range(5, 3).collect()).toEqual([]);
  });

  test("returns a Pipeline (so it composes)", () => {
    expect(range(0, 4)).toBeInstanceOf(Pipeline);
  });
});

describe("glob", () => {
  test("matches files in the test directory", async () => {
    const files = await glob("tests/*.test.ts").collect();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith(".test.ts"))).toBe(true);
  });

  test("supports ** double-star", async () => {
    const files = await glob("src/**/*.ts").collect();
    expect(files.length).toBeGreaterThan(0);
  });

  test("empty pipeline on zero matches", async () => {
    expect(await glob("nonexistent-dir/*.zzz").collect()).toEqual([]);
  });
});

describe("read", () => {
  test("reads a file as concatenated text", async () => {
    const text = await read("package.json").text();
    expect(text).toContain('"name": "crust"');
  });

  test("read.json parses", async () => {
    const json = await read("package.json").json<{ name: string }>();
    expect(json.name).toBe("crust");
  });
});

describe("tail", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "crust-tail-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("emits the last N lines and stops when not following", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "a\nb\nc\nd\ne\n");
      expect(await tail(p, { lines: 3 }).collect()).toEqual(["c", "d", "e"]);
    });
  });

  test("defaults to 10 lines, returns all if file has fewer", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "a\nb\nc\n");
      expect(await tail(p).collect()).toEqual(["a", "b", "c"]);
    });
  });

  test("handles a file without a trailing newline", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "a\nb\nc");
      expect(await tail(p, { lines: 2 }).collect()).toEqual(["b", "c"]);
    });
  });

  test("lines: 0 skips the initial cut", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "a\nb\nc\n");
      expect(await tail(p, { lines: 0 }).collect()).toEqual([]);
    });
  });

  test("follow: streams appended lines", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "init\n");
      const it = tail(p, { lines: 1, follow: true, pollMs: 20 }).lines();
      const iter = it[Symbol.asyncIterator]();

      const first = await iter.next();
      expect(first.value).toBe("init");

      const collected: string[] = [];
      const consume = (async () => {
        for (let i = 0; i < 3; i++) {
          const n = await iter.next();
          if (n.done) break;
          collected.push(n.value as string);
        }
      })();

      // Stagger writes so the poll loop has a chance to pick each up.
      await Bun.sleep(40);
      appendFileSync(p, "one\n");
      await Bun.sleep(40);
      appendFileSync(p, "two\nthree\n");

      await Promise.race([
        consume,
        Bun.sleep(2000).then(() => {
          throw new Error("timeout waiting for follow lines");
        }),
      ]);
      expect(collected).toEqual(["one", "two", "three"]);
    });
  });

  test("follow: handles a truncate that shrinks the file below offset", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      // A long enough prior line that the replacement is reliably
      // shorter than the old offset — that's the case `stat` can see.
      await writeFile(p, "old line that takes some bytes\n");
      const iter = tail(p, { lines: 1, follow: true, pollMs: 20 }).lines()[Symbol.asyncIterator]();

      expect((await iter.next()).value).toBe("old line that takes some bytes");

      await Bun.sleep(40);
      await writeFile(p, "fresh\n");

      const next = await Promise.race([
        iter.next(),
        Bun.sleep(2000).then(() => {
          throw new Error("timeout after truncate");
        }),
      ]);
      expect(next.value).toBe("fresh");
    });
  });

  test("follow: handles rotate-and-recreate", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "before\n");
      const iter = tail(p, { lines: 1, follow: true, pollMs: 20 }).lines()[Symbol.asyncIterator]();

      expect((await iter.next()).value).toBe("before");

      await Bun.sleep(40);
      await rename(p, `${p}.1`);
      await writeFile(p, "after\n");

      const next = await Promise.race([
        iter.next(),
        Bun.sleep(2000).then(() => {
          throw new Error("timeout after rotate");
        }),
      ]);
      expect(next.value).toBe("after");
    });
  });

  test("follow: tolerates a missing file at startup", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "not-yet");
      const iter = tail(p, { follow: true, pollMs: 20 }).lines()[Symbol.asyncIterator]();

      const consume = iter.next();
      await Bun.sleep(40);
      await writeFile(p, "hello\n");

      const next = await Promise.race([
        consume,
        Bun.sleep(2000).then(() => {
          throw new Error("timeout waiting for late-created file");
        }),
      ]);
      expect(next.value).toBe("hello");
    });
  });

  test("non-follow on a missing file rejects", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "missing");
      await expect(tail(p).collect()).rejects.toThrow();
    });
  });

  test("returns a Pipeline (so it composes)", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "a\nb\nc\n");
      const pipe = tail(p, { lines: 2 });
      expect(pipe).toBeInstanceOf(Pipeline);
      expect(await pipe.collect()).toEqual(["b", "c"]);
    });
  });

  test("composes through a filter to skim for substrings", async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, "log");
      await writeFile(p, "INFO ok\nERROR boom\nINFO ok\nERROR oops\n");
      const errs = await tail(p, { lines: 100 })
        .filter((l) => l.includes("ERROR"))
        .collect();
      expect(errs).toEqual(["ERROR boom", "ERROR oops"]);
    });
  });

  test("tail([a, b]) merges lines from multiple files (non-follow)", async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, "a.log");
      const b = join(dir, "b.log");
      await writeFile(a, "A1\nA2\n");
      await writeFile(b, "B1\nB2\n");
      const lines = await tail([a, b], { lines: 100 }).collect();
      expect(new Set(lines)).toEqual(new Set(["A1", "A2", "B1", "B2"]));
      expect(lines).toHaveLength(4);
    });
  });

  test("tail(glob-pattern) expands and reads matching files", async () => {
    await withTempDir(async (dir) => {
      const prev = process.cwd();
      process.chdir(dir);
      try {
        await writeFile(join(dir, "alpha.log"), "A1\n");
        await writeFile(join(dir, "beta.log"), "B1\n");
        await writeFile(join(dir, "ignore.txt"), "skip\n");
        const lines = await tail("*.log", { lines: 100 }).collect();
        expect(new Set(lines)).toEqual(new Set(["A1", "B1"]));
      } finally {
        process.chdir(prev);
      }
    });
  });

  test("tail([]) with no matching glob throws (non-follow)", async () => {
    await withTempDir(async (dir) => {
      const prev = process.cwd();
      process.chdir(dir);
      try {
        expect(tail("nope-*.log", { lines: 1 }).collect()).rejects.toThrow(/no files matched/);
      } finally {
        process.chdir(prev);
      }
    });
  });

  test("tail([a, b], { follow: true }) interleaves lines appended to either file", async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, "a.log");
      const b = join(dir, "b.log");
      await writeFile(a, "");
      await writeFile(b, "");
      const lines: string[] = [];
      const iter = tail([a, b], { lines: 0, follow: true, pollMs: 25 })
        .lines()
        [Symbol.asyncIterator]();
      const collector = (async () => {
        while (lines.length < 4) {
          const { value, done } = await iter.next();
          if (done) break;
          lines.push(value);
        }
      })();
      await Bun.sleep(50);
      appendFileSync(a, "A1\n");
      appendFileSync(b, "B1\n");
      appendFileSync(a, "A2\n");
      appendFileSync(b, "B2\n");
      await Promise.race([collector, Bun.sleep(2000)]);
      await (iter.return?.() ?? Promise.resolve());
      expect(new Set(lines)).toEqual(new Set(["A1", "A2", "B1", "B2"]));
    });
  });
});

describe("GET", () => {
  test("emits a single Response item", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    try {
      const responses = await GET(`http://localhost:${server.port}/`).collect();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(await responses[0]!.text()).toBe("ok");
    } finally {
      server.stop();
    }
  });
});

describe("procs", () => {
  test("merges tagged stdout/stderr/exit lines from multiple processes", async () => {
    const { procs } = await import("../src/sources");
    const lines = await procs({
      one: "echo hello",
      two: "echo oops 1>&2; exit 3",
    }).collect();
    const byProc = (p: string) => lines.filter((l) => l.proc === p);
    expect(byProc("one").some((l) => l.stream === "stdout" && l.line === "hello")).toBe(true);
    expect(byProc("one").some((l) => l.stream === "exit" && l.line.includes("0"))).toBe(true);
    expect(byProc("two").some((l) => l.stream === "stderr" && l.line === "oops")).toBe(true);
    expect(byProc("two").some((l) => l.stream === "exit" && l.line.includes("3"))).toBe(true);
  });

  test("is a shell-line source", async () => {
    const { runLine } = await import("../src/runLine");
    // smoke: parses and runs as the first stage (echo exits immediately)
    const code = await runLine('procs({x: "echo parsed"}) | (l => l.line)', {
      aliases: new Map(),
      functions: new Map(),
      history: [],
    } as never);
    expect(code).toBe(0);
  });
});

describe("procs object specs", () => {
  test("per-proc env is visible to the child", async () => {
    const { procs } = await import("../src/sources");
    const lines = await procs({
      envy: { cmd: 'echo "V=$PROC_TEST_VALUE"', env: { PROC_TEST_VALUE: "injected" } },
    }).collect();
    expect(lines.some((l) => l.stream === "stdout" && l.line === "V=injected")).toBe(true);
  });

  test("restart respawns a crashing process (bounded)", async () => {
    const { procs } = await import("../src/sources");
    const lines: Array<{ proc: string; stream: string; line: string }> = [];
    const pipeline = procs({
      flaky: { cmd: "echo ran; exit 1", restart: true },
    });
    // Collect until we've seen two runs, then close the pipeline.
    const iter = pipeline.lines();
    let runs = 0;
    for await (const l of iter) {
      lines.push(l);
      if (l.stream === "stdout" && l.line === "ran") runs++;
      if (runs >= 2) break;
    }
    await iter.return?.(undefined as never);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.line.startsWith("restarting in"))).toBe(true);
  });

  test("no restart without the flag", async () => {
    const { procs } = await import("../src/sources");
    const lines = await procs({ once: { cmd: "echo once; exit 1" } }).collect();
    const runs = lines.filter((l) => l.stream === "stdout" && l.line === "once").length;
    expect(runs).toBe(1);
    expect(lines.some((l) => l.line.startsWith("restarting"))).toBe(false);
  });
});

// After a group SIGKILL, `child.exited` resolves when the direct child is
// reaped — the grandchild (the `sleep` under `sh -c`) is reaped by init a few
// ms later. Poll briefly so the assertion races the reaper, not the kill: a
// REAL orphan (SIGTERM ignored, no escalation) would live for 30s.
async function expectNoProcess(marker: string): Promise<void> {
  let out: number[] = [];
  for (let i = 0; i < 50; i++) {
    out = pidsMatching(marker);
    if (out.length === 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`orphaned process still alive after 500ms: ${marker} (pids ${out.join(", ")})`);
}

// Concurrent: each test owns its servers and pipelines, and the mandated
// 250ms restart backoffs + probe timeouts would otherwise stack serially.
describe.concurrent("procs readiness and ordering", () => {
  type Line = { proc: string; stream: string; line: string };

  // Bun.serve that answers 503 until `flipAfterMs`, then 200.
  function flipServer(flipAfterMs: number) {
    let up = false;
    const timer = setTimeout(() => {
      up = true;
    }, flipAfterMs);
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(up ? "ok" : "starting", { status: up ? 200 : 503 }),
    });
    return {
      url: `http://localhost:${server.port}/health`,
      stop: () => {
        clearTimeout(timer);
        server.stop(true);
      },
    };
  }

  // A TCP port that is (almost certainly) closed: bind, note, release.
  function deadPort(): number {
    const l = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
    const port = l.port;
    l.stop(true);
    return port;
  }

  async function collectUntil(
    pipeline: { lines(): AsyncIterable<Line> },
    done: (l: Line, all: Line[]) => boolean,
  ): Promise<Line[]> {
    const lines: Line[] = [];
    const iter = pipeline.lines()[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { value, done: d } = await iter.next();
        if (d) break;
        lines.push(value);
        if (done(value, lines)) break;
      }
    } finally {
      await iter.return?.(undefined as never);
    }
    return lines;
  }

  test("ready(http): probes until the target answers 2xx, then emits the ready line", async () => {
    const { procs } = await import("../src/sources");
    // 40ms flip with 10ms probes: several probes still hit the 503 window.
    const srv = flipServer(40);
    try {
      const lines = await collectUntil(
        procs({
          web: { cmd: "sleep 5", ready: { url: srv.url, intervalMs: 10, timeoutMs: 1000 } },
        }),
        (l) => l.stream === "ready" && l.line.startsWith("ready after"),
      );
      const ready = lines.find((l) => l.stream === "ready" && l.line.startsWith("ready after"));
      expect(ready).toBeDefined();
      expect(ready!.proc).toBe("web");
      expect(ready!.line).toMatch(/^ready after \d+ms \(http:\/\/localhost:/);
      expect(lines.some((l) => l.line.startsWith("not ready"))).toBe(false);
    } finally {
      srv.stop();
    }
  });

  // A service that binds "localhost" lands on ::1 wherever that resolves first
  // (`vite --host localhost` and friends), while the probe's connect path can be
  // restricted to 127.0.0.1 by glibc's ADDRCONFIG — which is precisely what
  // happens inside a default-bridge Docker container. readiness.ts fans out over
  // both loopback addresses so the two ends cannot disagree; these pin that.
  //
  // Skipped, not failed, where the kernel has no IPv6: Bun.listen on ::1 THROWS
  // EADDRNOTAVAIL there, and an environment that cannot host the scenario cannot
  // testify about it either way.
  test.skipIf(!hasIpv6Loopback)(
    "ready(tcp): a v6-only listener is found even though localhost may resolve to v4",
    async () => {
      const { procs } = await import("../src/sources");
      const listener = Bun.listen({
        hostname: "::1",
        port: 0,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      try {
        const lines = await collectUntil(
          procs({ db: { cmd: "sleep 5", ready: `port:${listener.port}` } }),
          (l) => l.stream === "ready" && l.line.startsWith("ready after"),
        );
        expect(lines.find((l) => l.line.startsWith("ready after"))).toBeDefined();
      } finally {
        listener.stop(true);
      }
    },
  );

  test.skipIf(!hasIpv6Loopback)(
    "ready(http): the :PORT shorthand reaches a v6-only server",
    async () => {
      const { procs } = await import("../src/sources");
      const srv = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") });
      try {
        const lines = await collectUntil(
          procs({ web: { cmd: "sleep 5", ready: `:${srv.port}/` } }),
          (l) => l.stream === "ready" && l.line.startsWith("ready after"),
        );
        expect(lines.find((l) => l.line.startsWith("ready after"))).toBeDefined();
      } finally {
        srv.stop(true);
      }
    },
  );

  test("ready(tcp): the port:N string form connects to a live listener", async () => {
    const { procs } = await import("../src/sources");
    const listener = Bun.listen({
      hostname: "localhost",
      port: 0,
      socket: {
        data() {},
        open(s) {
          s.end();
        },
      },
    });
    try {
      const lines = await collectUntil(
        procs({ db: { cmd: "sleep 5", ready: `port:${listener.port}` } }),
        (l) => l.stream === "ready" && l.line.startsWith("ready after"),
      );
      const ready = lines.find((l) => l.line.startsWith("ready after"));
      expect(ready).toBeDefined();
      expect(ready!.line).toContain(`(port:${listener.port})`);
    } finally {
      listener.stop(true);
    }
  });

  test("after: dependent spawns only once the dependency is ready", async () => {
    const { procs } = await import("../src/sources");
    // 40ms flip with 10ms probes: the dep is reliably not-yet-ready when
    // the dependent starts waiting.
    const srv = flipServer(40);
    try {
      const lines = await collectUntil(
        procs({
          dep: { cmd: "sleep 5", ready: { url: srv.url, intervalMs: 10, timeoutMs: 1000 } },
          app: { cmd: "echo B", after: "dep" },
        }),
        (l) => l.proc === "app" && l.stream === "stdout",
      );
      const waitIdx = lines.findIndex((l) => l.proc === "app" && l.line === "waiting for dep");
      const readyIdx = lines.findIndex(
        (l) => l.proc === "dep" && l.stream === "ready" && l.line.startsWith("ready after"),
      );
      const bIdx = lines.findIndex((l) => l.proc === "app" && l.stream === "stdout");
      expect(waitIdx).toBeGreaterThanOrEqual(0);
      expect(readyIdx).toBeGreaterThanOrEqual(0);
      expect(bIdx).toBeGreaterThan(readyIdx);
      expect(waitIdx).toBeLessThan(bIdx);
    } finally {
      srv.stop();
    }
  });

  test("after a dep WITHOUT ready: gates on the dep's spawn", async () => {
    const { procs } = await import("../src/sources");
    const lines = await procs({
      a: "echo A",
      b: { cmd: "echo B", after: "a" },
    }).collect();
    expect(
      lines.some((l) => l.proc === "b" && l.stream === "ready" && l.line === "waiting for a"),
    ).toBe(true);
    expect(lines.some((l) => l.proc === "a" && l.stream === "stdout" && l.line === "A")).toBe(true);
    expect(lines.some((l) => l.proc === "b" && l.stream === "stdout" && l.line === "B")).toBe(true);
  });

  test("ready timeout without restart fails the pipeline loudly", async () => {
    const { procs } = await import("../src/sources");
    const port = deadPort();
    await expect(
      procs({
        web: { cmd: "sleep 5", ready: { port, timeoutMs: 100, intervalMs: 10 } },
      }).collect(),
    ).rejects.toThrow(/not ready after 100ms/);
  });

  test("ready timeout with restart {max: 1}: not ready -> restarting -> giving up", async () => {
    const { procs } = await import("../src/sources");
    const port = deadPort();
    const lines = await procs({
      web: {
        cmd: "sleep 5",
        ready: { port, timeoutMs: 60, intervalMs: 10 },
        restart: { max: 1 },
      },
    }).collect();
    const notReadyIdx = lines.findIndex((l) => l.line.startsWith("not ready after"));
    const restartIdx = lines.findIndex((l) => l.line === "restarting in 250ms");
    const giveUpIdx = lines.findIndex((l) => l.line === "giving up after 1 restart(s)");
    expect(notReadyIdx).toBeGreaterThanOrEqual(0);
    expect(restartIdx).toBeGreaterThan(notReadyIdx);
    expect(giveUpIdx).toBeGreaterThan(restartIdx);
  });

  test("restart {max: 1}: exactly two spawns, then the give-up line", async () => {
    const { procs } = await import("../src/sources");
    const lines = await procs({
      flaky: { cmd: "echo ran; exit 1", restart: { max: 1 } },
    }).collect();
    const runs = lines.filter((l) => l.stream === "stdout" && l.line === "ran").length;
    expect(runs).toBe(2);
    expect(lines.filter((l) => l.line.startsWith("restarting in"))).toHaveLength(1);
    expect(lines.some((l) => l.line === "giving up after 1 restart(s)")).toBe(true);
  });

  test("a dep that gives up before becoming ready rejects its dependents", async () => {
    const { procs } = await import("../src/sources");
    const port = deadPort();
    await expect(
      procs({
        dep: {
          cmd: "sleep 5",
          ready: { port, timeoutMs: 60, intervalMs: 10 },
          restart: { max: 0 },
        },
        app: { cmd: "echo up", after: "dep" },
      }).collect(),
    ).rejects.toThrow(/dependency "dep" exited before becoming ready/);
  });

  test("ready-timeout kills do NOT reset the restart strikes (becameReady gating)", async () => {
    const { procs } = await import("../src/sources");
    const port = deadPort();
    // healthyUptimeMs: 0 — under the old wall-clock-only rule EVERY spawn
    // (alive ~60ms while its ready probe times out) would count as a healthy
    // stretch, reset the counter, and {max: 1} would restart forever. The
    // fix gates the reset on the proc actually having become READY.
    const lines = await procs(
      {
        web: {
          cmd: "sleep 5",
          ready: { port, timeoutMs: 60, intervalMs: 10 },
          restart: { max: 1 },
        },
      },
      { healthyUptimeMs: 0 },
    ).collect();
    expect(lines.filter((l) => l.line.startsWith("not ready after"))).toHaveLength(2);
    expect(lines.filter((l) => l.line.startsWith("restarting in"))).toHaveLength(1);
    expect(lines.some((l) => l.line === "giving up after 1 restart(s)")).toBe(true);
  });

  test("procs without ready: still count as ready at spawn for the strike reset", async () => {
    const { procs } = await import("../src/sources");
    // No ready: -> becameReady at spawn, so with healthyUptimeMs: 0 (ANY
    // uptime counts as healthy — a fast exit can live under 1ms) every crash
    // counts as a fresh healthy stretch and {max: 1} never gives up — the
    // pre-fix behavior for ready-less procs, preserved.
    const lines = await collectUntil(
      procs({ flaky: { cmd: "echo ran; exit 1", restart: { max: 1 } } }, { healthyUptimeMs: 0 }),
      (_l, all) => all.filter((x) => x.stream === "stdout" && x.line === "ran").length >= 3,
    );
    expect(lines.filter((l) => l.stream === "stdout" && l.line === "ran").length).toBe(3);
    expect(lines.some((l) => l.line.startsWith("giving up"))).toBe(false);
  });

  test("awaitReady: probeTimeoutMs override lets a slow-to-accept target pass", async () => {
    const { awaitReady, parseReadyTarget } = await import("../src/readiness");
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(40);
        return new Response("ok");
      },
    });
    try {
      const target = parseReadyTarget(`http://localhost:${server.port}/health`);
      // Default per-probe cap is min(intervalMs*4, 2000) = 20ms — a 40ms
      // TTFB can never answer in time, no matter how generous timeoutMs is.
      expect(await awaitReady(target, { intervalMs: 5, timeoutMs: 80 })).toBeNull();
      const res = await awaitReady(target, {
        intervalMs: 5,
        timeoutMs: 1000,
        probeTimeoutMs: 500,
      });
      expect(res).not.toBeNull();
      expect(res!.attempts).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("ready spec long form plumbs probeTimeoutMs through procs", async () => {
    const { procs } = await import("../src/sources");
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(40);
        return new Response("ok");
      },
    });
    try {
      const lines = await collectUntil(
        procs({
          web: {
            cmd: "sleep 5",
            ready: {
              url: `http://localhost:${server.port}/`,
              // intervalMs 5 keeps the default cap (20ms) safely under the
              // 40ms TTFB — without the probeTimeoutMs plumb-through this
              // test must fail, not race.
              intervalMs: 5,
              timeoutMs: 1000,
              probeTimeoutMs: 500,
            },
          },
        }),
        (l) => l.stream === "ready" && l.line.startsWith("ready after"),
      );
      expect(lines.some((l) => l.stream === "ready" && l.line.startsWith("ready after"))).toBe(
        true,
      );
      expect(lines.some((l) => l.line.startsWith("not ready"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("ready-timeout kill escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { procs } = await import("../src/sources");
    const port = deadPort();
    const marker = "sleep 31.415"; // unique matchable token for THIS test
    const lines = await procs(
      {
        stubborn: {
          cmd: `trap '' TERM; ${marker}`,
          ready: { port, timeoutMs: 60, intervalMs: 10 },
          restart: { max: 1 },
        },
      },
      { killGraceMs: 100 },
    ).collect();
    // The TERM-ignoring child must not wedge the restart loop: both spawns
    // get put down (escalated), then the strike budget trips.
    expect(lines.filter((l) => l.line.startsWith("restarting in"))).toHaveLength(1);
    expect(lines.some((l) => l.line === "giving up after 1 restart(s)")).toBe(true);
    // No orphans — SIGTERM was ignored, so only the SIGKILL can have worked.
    await expectNoProcess(marker);
  });

  test("unknown after name, self-dependency, and cycles throw synchronously", async () => {
    const { procs } = await import("../src/sources");
    expect(() => procs({ a: { cmd: "echo hi", after: "nope" } })).toThrow(/unknown proc "nope"/);
    expect(() => procs({ a: { cmd: "echo hi", after: "a" } })).toThrow(/cannot come after itself/);
    expect(() =>
      procs({
        a: { cmd: "echo a", after: "b" },
        b: { cmd: "echo b", after: "a" },
      }),
    ).toThrow(/dependency cycle/);
  });
});

// Serial ON PURPOSE: this test finds the pipeline's SIGINT handler by
// diffing process.listeners(), which would race any concurrently starting
// procs pipeline.
describe("procs kill escalation", () => {
  test("kill() (Ctrl-C path) owns the SIGTERM -> SIGKILL escalation and is idempotent", async () => {
    const { procs } = await import("../src/sources");
    const marker = "sleep 27.182"; // unique matchable token for THIS test
    const before = new Set(process.listeners("SIGINT"));
    const pipeline = procs(
      { stubborn: { cmd: `trap '' TERM; echo up; ${marker}` } },
      { killGraceMs: 100 },
    );
    const iter = pipeline.lines()[Symbol.asyncIterator]();
    // First line proves the child is up and the SIGINT handler is installed.
    const first = await iter.next();
    expect(first.value!.line).toBe("up");
    const added = process.listeners("SIGINT").filter((l) => !before.has(l));
    expect(added).toHaveLength(1);
    // Simulate Ctrl-C twice — the second call must reuse the in-flight
    // escalation, not stack a new timer.
    (added[0] as () => void)();
    (added[0] as () => void)();
    // The child ignores SIGTERM and the consumer never closes the iterator,
    // so ONLY kill()'s own escalation can end the wedged stream.
    const drain = (async () => {
      for (;;) {
        const { done } = await iter.next();
        if (done) return;
      }
    })();
    await Promise.race([
      drain,
      Bun.sleep(2000).then(() => {
        throw new Error("stream did not end after kill()");
      }),
    ]);
    await expectNoProcess(marker);
  });
});

describe("load", () => {
  test("emits paced ticks across phases with monotonic n", async () => {
    const ticks = await load([
      { durMs: 100, rps: 40 },
      { durMs: 100, rps: 80 },
    ]).collect();
    // targets: 4 + 8 = 12; wide tolerance for loaded CI hosts
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    expect(ticks.length).toBeLessThanOrEqual(12);
    expect(ticks[0]!.phase).toBe(0);
    expect(ticks[ticks.length - 1]!.phase).toBe(1);
    const ns = ticks.map((t) => t.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    for (const t of ticks) expect(t.lagMs).toBeGreaterThanOrEqual(0);
  });

  test("saturated consumer drops stale slots and reports the shortfall", async () => {
    let msg = "";
    const src = load([{ durMs: 200, rps: 100 }], {
      warn: (s) => {
        msg += s;
      },
    });
    const seen: unknown[] = [];
    for await (const t of src.lines()) {
      seen.push(t);
      await Bun.sleep(40); // downstream busy: ~5 pulls fit in the 200ms phase
    }
    expect(seen.length).toBeLessThan(20);
    expect(msg).toContain("load: target 20 ticks");
    expect(msg).toContain("dropped");
    expect(msg).toContain("achieved");
  });

  test("empty phase list throws", () => {
    expect(() => load([])).toThrow("load: needs at least one phase");
  });
});

describe("load batch emission", () => {
  test("high-rate: 5000/s emits far beyond the 1ms sleep floor", async () => {
    const ticks = await load([{ durMs: 100, rps: 5000 }]).collect();
    expect(ticks.length).toBeGreaterThanOrEqual(300);
    expect(ticks.length).toBeLessThanOrEqual(500);
    const ns = ticks.map((t) => t.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });

  test("maxLagMs drops consumer-stale slots (and only those)", async () => {
    let msg = "";
    const src = load([{ durMs: 120, rps: 100 }], {
      warn: (s) => {
        msg += s;
      },
      maxLagMs: 30,
    });
    const seen: unknown[] = [];
    for await (const t of src.lines()) {
      seen.push(t);
      await Bun.sleep(35); // every pull stalls past maxLagMs
    }
    expect(seen.length).toBeLessThan(12);
    expect(msg).toContain("dropped");
  });
});

describe("findTailWindowStart (bounded tail scan)", () => {
  const tmp = async (content: string) => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = await mkdtemp(join(tmpdir(), "crust-tw-"));
    const p = join(d, "f.log");
    await Bun.write(p, content);
    return { p, size: content.length, d };
  };

  test("unit matrix with 8-byte blocks", async () => {
    const { rm } = await import("node:fs/promises");
    const { findTailWindowStart } = await import("../src/sources");
    const cases: Array<[string, number, number]> = [
      // [content, n, expected start offset]
      ["a\nb\nc\n", 1, 4], // last line "c"
      ["a\nb\nc\n", 2, 2],
      ["a\nb\nc\n", 3, 0],
      ["a\nb\nc\n", 9, 0], // n > lines → BOF
      ["a\nb\nc", 1, 4], // unterminated final line
      ["abcdefghij\nklmnopqrst\nuvwxyz\n", 2, 11], // window spans blocks
      ["0123456\n89abcde\n", 1, 8], // newline exactly at a block edge (i=7)
      ["xxxxxxxxxxxxxxxxxxxxxxxx\nyy\n", 1, 25], // line longer than a block
      ["\n\n\n", 2, 1], // file of newlines: lines are "", ""
      ["", 1, 0],
    ];
    for (const [content, n, expected] of cases) {
      const { p, size, d } = await tmp(content);
      try {
        expect(await findTailWindowStart(p, size, n, 8)).toBe(expected);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    }
  });

  test("n<=0 returns size (reads nothing)", async () => {
    const { rm } = await import("node:fs/promises");
    const { findTailWindowStart } = await import("../src/sources");
    const { p, size, d } = await tmp("a\nb\n");
    try {
      expect(await findTailWindowStart(p, size, 0)).toBe(size);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("e2e: tail lines:N on a multi-MB file matches a JS reference", async () => {
    const { rm } = await import("node:fs/promises");
    const lines: string[] = [];
    for (let i = 0; i < 60_000; i++) lines.push(`line-${i}-${"x".repeat(30)}`);
    const content = `${lines.join("\n")}\n`; // ~2.2MB
    const { p, d } = await tmp(content);
    try {
      for (const n of [1, 10, 5000]) {
        const got = await tail(p, { lines: n }).collect();
        expect(got).toEqual(lines.slice(-n));
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("tail abort signal", () => {
  test("abort wakes a parked follow loop without waiting out the poll sleep", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-tail-abort-"));
    try {
      const p = join(dir, "quiet.log");
      await Bun.write(p, "old\n");
      const controller = new AbortController();
      // pollMs is LONG on purpose: only the abort can wake the loop in time.
      const iter = tail(p, { lines: 0, follow: true, pollMs: 5000, signal: controller.signal })
        .lines()
        [Symbol.asyncIterator]();
      const first = iter.next();
      await Bun.sleep(50); // let the loop park on its poll race
      const t0 = Date.now();
      controller.abort();
      void iter.return?.(undefined);
      const res = await Promise.race([first, Bun.sleep(2000).then(() => null)]);
      expect(res).not.toBe(null);
      expect((res as IteratorResult<string>).done).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
