import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pipeline } from "../src/pipeline";
import { GET, glob, range, read, tail } from "../src/sources";

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
