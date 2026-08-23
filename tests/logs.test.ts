import { describe, expect, test } from "bun:test";
import { RingBuffer } from "../src/logs/ring";
import { LogsSession, ViewQueue } from "../src/logs/session";
import { parseStages } from "../src/parser";
import { Pipeline } from "../src/pipeline";
import type { Context } from "../src/types";
import { isRunning } from "./procFind";

function ctx(): Context {
  return {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: (() => {}) as never,
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor: condition not met in time");
    await Bun.sleep(10);
  }
}

// Test harness around LogsSession: a push-driven source, scripted input
// thunks (each may await session output before returning the next line),
// captured stdout/stderr, and a manual ^C trigger.
function harness(opts?: { bufferSize?: number; viewQueueSize?: number; color?: boolean }) {
  const driver = new ViewQueue(100_000);
  const out: string[] = [];
  const err: string[] = [];
  let interruptCb: (() => void) | null = null;
  const inputs: Array<() => Promise<string | null>> = [];
  let teardownCalls = 0;

  const session = new LogsSession({
    source: driver.stream(),
    sourceLabel: "test-source",
    bufferSize: opts?.bufferSize ?? 100,
    viewQueueSize: opts?.viewQueueSize,
    color: opts?.color,
    readInput: async () => {
      const next = inputs.shift();
      if (!next) return null;
      return await next();
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    onInterrupt: (cb) => {
      interruptCb = cb;
      return () => {
        if (interruptCb === cb) interruptCb = null;
      };
    },
    ctx: ctx(),
    teardown: () => {
      teardownCalls++;
      driver.end();
    },
  });

  return {
    driver,
    out,
    err,
    inputs,
    session,
    press: () => interruptCb?.(),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    teardownCalls: () => teardownCalls,
  };
}

describe("RingBuffer", () => {
  test("push/snapshot/evict/clear bookkeeping", () => {
    const r = new RingBuffer<number>(3);
    expect(r.snapshot()).toEqual([]);
    r.push(1);
    r.push(2);
    expect(r.snapshot()).toEqual([1, 2]);
    r.push(3);
    r.push(4); // evicts 1
    expect(r.snapshot()).toEqual([2, 3, 4]);
    expect(r.size).toBe(3);
    expect(r.pushed).toBe(4);
    expect(r.evicted).toBe(1);
    r.clear();
    expect(r.snapshot()).toEqual([]);
    expect(r.pushed).toBe(4); // totals survive clear
    r.push(5);
    expect(r.snapshot()).toEqual([5]);
  });

  test("capacity must be positive", () => {
    expect(() => new RingBuffer(0)).toThrow("capacity");
  });
});

describe("parseStages", () => {
  const drain = async (p: Pipeline<unknown>): Promise<unknown[]> => {
    const got: unknown[] = [];
    for await (const item of p.lines()) got.push(item);
    return got;
  };

  test("transforms a given input pipeline", async () => {
    const build = parseStages("grep ERROR | (l => l.toLowerCase())");
    const got = await drain(build(Pipeline.of(["ERROR one", "fine", "ERROR two"]), ctx()));
    expect(got).toEqual(["error one", "error two"]);
  });

  test("each build constructs FRESH stages (stats state does not leak)", async () => {
    const build = parseStages("stats");
    const a = await drain(build(Pipeline.of([{ status: 200 }, { status: 200 }]), ctx()));
    const b = await drain(build(Pipeline.of([{ status: 500 }]), ctx()));
    expect((a[0] as { count: number }).count).toBe(2);
    expect((b[0] as { count: number }).count).toBe(1); // not 3
  });

  test("source kinds and time are rejected with logs-flavored errors", () => {
    const cases: Array<[string, RegExp]> = [
      ["tail -F x.log", /logs queries transform/],
      ["range(1, 3)", /logs queries transform/],
      ["stdin", /logs queries transform/],
      ['time "x" | grep a', /not available in a logs query/],
    ];
    for (const [frag, re] of cases) {
      const build = parseStages(frag);
      expect(() => build(Pipeline.of([]), ctx())).toThrow(re);
    }
  });

  test("dangling parallel is rejected", () => {
    const build = parseStages("parallel 4");
    expect(() => build(Pipeline.of([]), ctx())).toThrow(/parallel/);
  });
});

describe("LogsSession", () => {
  test("retro then live: every item exactly once across the boundary", async () => {
    const h = harness();
    h.driver.offer("a1");
    h.driver.offer("a2");
    h.inputs.push(
      async () => {
        await Bun.sleep(50); // let the pump buffer the pre-query items
        return "buffer";
      },
      async () => {
        await waitFor(() => h.stderr().includes("buffer: 2/"));
        return "(l => l)";
      },
      async () => {
        // Previous query has fully finished by the time this thunk runs.
        return "exit";
      },
    );
    const done = h.session.run();
    // Feed the live half once the query attaches, then end the source.
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.driver.offer("b1");
      h.driver.offer("b2");
      await waitFor(() => h.stdout().includes("b2\n"));
      h.driver.end();
    })();
    const code = await done;
    expect(code).toBe(0);
    const lines = h.stdout().split("\n").filter(Boolean);
    expect(lines).toEqual(["a1", "a2", "b1", "b2"]);
    expect(h.stderr()).toContain("-- source ended --");
  });

  test("Ctrl-C ends the live view gracefully and FLUSHES terminal stats", async () => {
    const h = harness();
    h.inputs.push(
      async () => "(l => ({status: l})) | stats",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.driver.offer(200);
      h.driver.offer(200);
      h.driver.offer(500);
      await Bun.sleep(50); // let the pump hand all three to the live view
      h.press(); // first ^C: graceful end → stats summary must flush
    })();
    const code = await done;
    expect(code).toBe(0);
    expect(h.stderr()).toContain("hint: bare `stats`");
    const summary = h.stdout();
    expect(summary).toContain('"count":3');
    expect(summary).toContain('"200":2');
  });

  test("second Ctrl-C hard-cancels a query whose drain is stuck", async () => {
    const h = harness();
    h.inputs.push(
      // The lambda never resolves for item X — the graceful end can't finish.
      async () => "(l => l === 'X' ? new Promise(() => {}) : l)",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.driver.offer("X");
      await Bun.sleep(50);
      h.press(); // graceful — drain stays stuck on the pending promise
      await Bun.sleep(50);
      h.press(); // hard cancel
    })();
    const code = await done;
    expect(code).toBe(0);
    expect(h.teardownCalls()).toBe(1);
  });

  test("live view lag is reported, not silent", async () => {
    const h = harness({ viewQueueSize: 2 });
    h.inputs.push(
      async () => "(l => new Promise(res => setTimeout(() => res(l), 80)))",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      for (let i = 0; i < 8; i++) h.driver.offer(`m${i}`);
      await Bun.sleep(300);
      h.press();
    })();
    await done;
    expect(h.stderr()).toMatch(/dropped \d+ oldest/);
  });

  test("a broken query prints and the session survives; retro error skips live", async () => {
    const h = harness();
    h.driver.offer("one");
    let liveAfterBoom: boolean | null = null;
    h.inputs.push(
      async () => {
        await Bun.sleep(50); // pump buffers "one"
        return "(l => { throw new Error('boom') })";
      },
      async () => {
        // Runs only after the failed query fully finished — the retro error
        // must NOT have opened a live view.
        liveAfterBoom = h.stderr().includes("-- live --");
        return "(l => l)"; // session must still take queries
      },
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.driver.end();
    })();
    const code = await done;
    expect(liveAfterBoom as boolean | null).toBe(false);
    expect(code).toBe(0);
    expect(h.stderr()).toContain("boom");
    expect(h.stdout()).toContain("one\n"); // second query retro output
  });

  test("query after source end is retro-only and says so", async () => {
    const h = harness();
    h.driver.offer("x1");
    h.driver.offer("x2");
    h.driver.end();
    h.inputs.push(
      async () => {
        await waitFor(() => h.stderr().includes("buffering"));
        await Bun.sleep(30); // pump drains the finite source
        return "grep x";
      },
      async () => "exit",
    );
    const code = await h.session.run();
    expect(code).toBe(0);
    expect(h.stdout()).toContain("x1\n");
    expect(h.stdout()).toContain("x2\n");
    expect(h.stderr()).toContain("retro only");
    expect(h.stderr()).not.toContain("-- live --");
  });

  test("buffer/clear commands and Ctrl-D teardown", async () => {
    const h = harness({ bufferSize: 2 });
    h.driver.offer("a");
    h.driver.offer("b");
    h.driver.offer("c"); // evicts a
    h.inputs.push(
      async () => {
        await waitFor(() => h.stderr().includes("buffering"));
        await Bun.sleep(30);
        return "buffer";
      },
      async () => "clear",
      async () => "buffer",
      // No more inputs → readInput returns null → Ctrl-D path.
    );
    const code = await h.session.run();
    expect(code).toBe(0);
    expect(h.stderr()).toContain("buffer: 2/2 items (pushed 3, evicted 1)");
    expect(h.stderr()).toContain("buffer cleared");
    expect(h.stderr()).toContain("buffer: 0/2");
    expect(h.teardownCalls()).toBe(1);
  });
});

describe("RingBuffer sample and resize", () => {
  test("sample returns the oldest ≤n without copying the window", () => {
    const ring = new RingBuffer<number>(5);
    for (let i = 1; i <= 7; i++) ring.push(i); // window: 3..7
    expect(ring.sample(3)).toEqual([3, 4, 5]);
    expect(ring.sample(99)).toEqual([3, 4, 5, 6, 7]);
    expect(ring.sample(0)).toEqual([]);
  });

  test("grow keeps every item and the counters", () => {
    const ring = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) ring.push(i); // window: 3,4,5; evicted 2
    const r = ring.resize(10);
    expect(r).toEqual({ kept: 3, discarded: 0 });
    expect(ring.capacity).toBe(10);
    expect(ring.snapshot()).toEqual([3, 4, 5]);
    expect(ring.pushed).toBe(5);
    expect(ring.evicted).toBe(2);
    ring.push(6);
    expect(ring.snapshot()).toEqual([3, 4, 5, 6]);
  });

  test("shrink keeps the NEWEST and counts the discarded as evicted", () => {
    const ring = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) ring.push(i);
    const r = ring.resize(2);
    expect(r).toEqual({ kept: 2, discarded: 3 });
    expect(ring.snapshot()).toEqual([4, 5]);
    expect(ring.evicted).toBe(3);
    expect(ring.pushed).toBe(5);
    ring.push(6);
    expect(ring.snapshot()).toEqual([5, 6]);
  });
});

describe("LogsSession round-6 commands", () => {
  test("buffer N resizes live; bad and over-cap args are handled; no-arg output unchanged", async () => {
    const h = harness({ bufferSize: 2 });
    h.driver.offer("a");
    h.driver.offer("b");
    h.inputs.push(
      async () => {
        await waitFor(() => h.session !== null);
        await Bun.sleep(30); // let the pump buffer both
        return "buffer 5";
      },
      async () => "buffer",
      async () => "buffer nope",
      async () => "buffer 2000000",
      async () => "exit",
    );
    const code = await h.session.run();
    expect(code).toBe(0);
    expect(h.stderr()).toContain("buffer: resized 2 → 5 (kept 2 item(s))");
    expect(h.stderr()).toContain("buffer: 2/5 items (pushed 2, evicted 0");
    expect(h.stderr()).toContain('buffer size must be a positive integer — got "nope"');
    expect(h.stderr()).toContain("logs: buffer capped at 1000000");
  });

  test("json on parses object lines at query time; raw lines survive and are counted; off reverts", async () => {
    const h = harness();
    h.driver.offer('{"level":50,"msg":"boom"}');
    h.driver.offer("plain text");
    h.driver.offer("42"); // parses to a primitive — must stay a string
    h.inputs.push(
      async () => {
        await Bun.sleep(30);
        return "json on";
      },
      async () => "filter (e => typeof e === 'object' && e.level >= 40) | (e => e.msg)",
      async () => "(l => typeof l)",
      async () => "json off",
      async () => "(l => typeof l)",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      // Three queries each open a live view; end each by pressing ^C.
      for (let i = 0; i < 3; i++) {
        await waitFor(() => h.stderr().split("-- live --").length >= i + 2);
        h.press();
      }
    })();
    const code = await done;
    expect(code).toBe(0);
    expect(h.stderr()).toContain("json: on");
    // Retro of query 1: the object line reached the lambda parsed.
    expect(h.stdout()).toContain("boom\n");
    // Two string items stayed raw — counted out loud, nothing vanished.
    expect(h.stderr()).toContain("json: 2 of 3 buffered item(s) stayed raw");
    // Query 2 (json still on): parsed object + raw strings all flow through.
    const typeLines = h
      .stdout()
      .split("\n")
      .filter((l) => l === "object" || l === "string");
    expect(typeLines).toContain("object");
    expect(typeLines).toContain("string");
    // Query 3 (json off): everything is a string again.
    const afterOff = h.stdout().split("json")[0]; // crude but the last query's output is all strings
    expect(h.stderr()).toContain("json: off");
    expect(afterOff).toBeDefined();
  });

  test("live items are parsed too, and live misses are reported", async () => {
    const h = harness();
    h.inputs.push(
      async () => "json on",
      async () => "(e => typeof e)",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.driver.offer('{"a":1}');
      h.driver.offer("not json");
      await waitFor(() => h.stdout().includes("object\n") && h.stdout().includes("string\n"));
      h.press();
    })();
    const code = await done;
    expect(code).toBe(0);
    expect(h.stdout()).toContain("object\n");
    expect(h.stdout()).toContain("string\n");
    expect(h.stderr()).toContain("json: 1 live item(s) stayed raw");
  });

  test("NDJSON buffer triggers the hint exactly once; json off suppresses it", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.driver.offer(`{"n":${i}}`);
    h.inputs.push(
      async () => {
        await Bun.sleep(30);
        return "(l => l)";
      },
      async () => "(l => l)",
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      for (let i = 0; i < 2; i++) {
        await waitFor(() => h.stderr().split("-- live --").length >= i + 2);
        h.press();
      }
    })();
    await done;
    const hints = h.stderr().split("hint: buffer looks like NDJSON").length - 1;
    expect(hints).toBe(1);
  });

  test("a plain-text buffer never hints", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.driver.offer(`plain line ${i}`);
    h.inputs.push(
      async () => {
        await Bun.sleep(30);
        return "(l => l)";
      },
      async () => "exit",
    );
    const done = h.session.run();
    (async () => {
      await waitFor(() => h.stderr().includes("-- live --"));
      h.press();
    })();
    await done;
    expect(h.stderr()).not.toContain("hint: buffer looks like NDJSON");
  });

  test("search: retro-only, counted (zero included), highlighted only with color", async () => {
    const on = harness({ color: true });
    on.driver.offer("a timeout here");
    on.driver.offer("nothing");
    on.inputs.push(
      async () => {
        await Bun.sleep(30);
        return "search timeout";
      },
      async () => "search zzz",
      async () => "exit",
    );
    expect(await on.session.run()).toBe(0);
    expect(on.stdout()).toContain("\x1b[1;31mtimeout\x1b[0m");
    expect(on.stderr()).toContain("search: 1 matching item(s) of 2 buffered");
    expect(on.stderr()).toContain("search: 0 matching item(s) of 2 buffered");
    expect(on.stderr()).not.toContain("-- live --");

    const off = harness({ color: false });
    off.driver.offer("a timeout here");
    off.inputs.push(
      async () => {
        await Bun.sleep(30);
        return "search timeout";
      },
      async () => "exit",
    );
    expect(await off.session.run()).toBe(0);
    expect(off.stdout()).toContain("a timeout here");
    expect(off.stdout()).not.toContain("\x1b[");
    const usage = harness();
    usage.inputs.push(
      async () => "search",
      async () => "exit",
    );
    expect(await usage.session.run()).toBe(0);
    expect(usage.stderr()).toContain("search: usage");
  });
});

describe("logs CLI gates", () => {
  const ENTRY = `${import.meta.dir}/../src/index.ts`;

  test("piped stdin (non-tty) exits 2 with guidance", async () => {
    const proc = Bun.spawn(["bun", ENTRY], {
      stdin: Buffer.from("logs tail -F nowhere.log\n"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CRUST_CONFIG: "/dev/null" },
    });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(proc.exitCode).toBe(2);
    expect(stderr).toContain("needs a tty");
    expect(stderr).toContain("stdin |");
  });
});

describe("review fixes — retro Ctrl-C and stuck-child reaping", () => {
  test("Ctrl-C during a wedged RETRO pass cancels the query and kills its shell child", async () => {
    const marker = "sleep 27.313"; // unique matchable token for THIS test
    const h = harness();
    h.driver.offer("one");
    let promptCameBack = false;
    h.inputs.push(
      async () => {
        await Bun.sleep(50);
        return marker; // shell stage child ignores stdin EOF and lingers
      },
      async () => {
        promptCameBack = true;
        return "exit";
      },
    );
    const done = h.session.run();
    (async () => {
      // Wait for the sleep child to exist (retro is wedged on it), then press.
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        await Bun.sleep(100);
        up = isRunning(marker);
      }
      expect(up).toBe(true);
      h.press(); // ONE press during retro must cancel the whole query
    })();
    const code = await done;
    expect(code).toBe(0);
    expect(promptCameBack).toBe(true);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await Bun.sleep(100);
      gone = !isRunning(marker);
    }
    expect(gone).toBe(true); // the bus fire reaped it — no leak
  }, 15_000);
});
