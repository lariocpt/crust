import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStdinData, onInterrupt } from "../src/editor";
import * as interrupt from "../src/interrupt";
import { type ReplTty, runLine } from "../src/runLine";
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

// A fake REPL terminal: captures the armed watcher so tests can press ^C.
function fakeTty(): ReplTty & {
  press(): void;
  armed: number;
  disposed: number;
  suspended: number;
  restored: number;
} {
  const t = {
    armed: 0,
    disposed: 0,
    suspended: 0,
    restored: 0,
    cb: null as (() => void) | null,
    press() {
      t.cb?.();
    },
    onInterrupt(cb: () => void) {
      t.armed++;
      t.cb = cb;
      return () => {
        t.disposed++;
        if (t.cb === cb) t.cb = null;
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

beforeEach(() => {
  // Each test starts with a quiet bus.
  interrupt.endRun();
});

describe("interrupt bus", () => {
  test("fire before beginRun is a no-op; after, it latches", () => {
    interrupt.fire();
    expect(interrupt.isInterrupted()).toBe(false);
    interrupt.beginRun();
    expect(interrupt.isInterrupted()).toBe(false);
    interrupt.fire();
    expect(interrupt.isInterrupted()).toBe(true);
    interrupt.endRun();
    expect(interrupt.isInterrupted()).toBe(false);
  });

  test("interruptPromise resolves on fire, and immediately when already fired", async () => {
    interrupt.beginRun();
    let resolved = false;
    const p = interrupt.interruptPromise().then(() => {
      resolved = true;
    });
    await Bun.sleep(10);
    expect(resolved).toBe(false);
    interrupt.fire();
    await p;
    expect(resolved).toBe(true);
    await interrupt.interruptPromise(); // already fired — must not hang
    interrupt.endRun();
  });

  test("registered children are killed once on fire; late registration kills immediately", () => {
    interrupt.beginRun();
    let kills = 0;
    interrupt.registerChild(() => kills++);
    const unreg = interrupt.registerChild(() => kills++);
    unreg(); // unregistered before fire — must not be killed
    interrupt.fire();
    expect(kills).toBe(1);
    interrupt.fire(); // idempotent
    expect(kills).toBe(1);
    interrupt.registerChild(() => kills++); // spawn raced the cancel
    expect(kills).toBe(2);
    interrupt.endRun();
  });
});

describe("editor interrupt watcher (handleStdinData)", () => {
  test("0x03 fires the armed watcher once per chunk", () => {
    let fired = 0;
    const dispose = onInterrupt(() => fired++);
    handleStdinData("\x03\x03"); // two presses in one chunk = one cancel
    expect(fired).toBe(1);
    handleStdinData("\x03");
    expect(fired).toBe(2);
    dispose();
    handleStdinData("\x03"); // disarmed — byte is typeahead again
    expect(fired).toBe(2);
  });

  test("chunks without 0x03 do not fire", () => {
    let fired = 0;
    const dispose = onInterrupt(() => fired++);
    handleStdinData("abc");
    handleStdinData("\x1b[A");
    expect(fired).toBe(0);
    dispose();
  });

  test("nested watchers: latest wins, dispose restores the outer one", () => {
    const fires: string[] = [];
    const outer = onInterrupt(() => fires.push("outer"));
    const inner = onInterrupt(() => fires.push("inner"));
    handleStdinData("\x03");
    expect(fires).toEqual(["inner"]);
    inner();
    handleStdinData("\x03");
    expect(fires).toEqual(["inner", "outer"]);
    outer();
  });
});

describe("runLine + fake tty — Ctrl-C job control", () => {
  test("quiet tail -F is cancelled promptly and returns 130", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-int-"));
    try {
      const log = join(dir, "quiet.log");
      await Bun.write(log, "old line\n");
      const tty = fakeTty();
      const run = runLine(`tail -n 0 -F ${log} | grep nothing`, ctx(), tty);
      await Bun.sleep(120); // let the follow loop park on its poll sleep
      const pressedAt = Date.now();
      tty.press();
      const code = await run;
      expect(code).toBe(130);
      // The prompt must come back without waiting for the drain to unwind.
      expect(Date.now() - pressedAt).toBeLessThan(150);
      expect(tty.disposed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("procs source is torn down on Ctrl-C (sleep child reaped)", async () => {
    const marker = "sleep 28.653"; // unique matchable token for THIS test
    const tty = fakeTty();
    const run = runLine(`procs({slow: "${marker}"})`, ctx(), tty);
    // Wait for the child to actually exist before pressing.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await Bun.sleep(100);
      up = isRunning(marker);
    }
    expect(up).toBe(true);
    tty.press();
    const code = await run;
    expect(code).toBe(130);
    // procs escalates SIGTERM→SIGKILL; give it a moment, then verify reaped.
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await Bun.sleep(100);
      gone = !isRunning(marker);
    }
    expect(gone).toBe(true);
  }, 15_000);

  test("mid-pipeline shell child is killed through the bus", async () => {
    const marker = "sleep 26.317"; // unique matchable token for THIS test
    const tty = fakeTty();
    const run = runLine(`range(1, 3) | ${marker}`, ctx(), tty);
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await Bun.sleep(100);
      up = isRunning(marker);
    }
    expect(up).toBe(true);
    tty.press();
    const code = await run;
    expect(code).toBe(130);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await Bun.sleep(100);
      gone = !isRunning(marker);
    }
    expect(gone).toBe(true);
  }, 15_000);

  test("pure shell lines suspend the editor and restore it", async () => {
    const tty = fakeTty();
    const before = process.listenerCount("SIGINT");
    const code = await runLine("true", ctx(), tty);
    expect(code).toBe(0);
    expect(tty.suspended).toBe(1);
    expect(tty.restored).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("pipelines that finish normally return 0 and disarm", async () => {
    const tty = fakeTty();
    const code = await runLine("range(1, 3) | (n => n * 2)", ctx(), tty);
    expect(code).toBe(0);
    expect(tty.armed).toBe(1);
    expect(tty.disposed).toBe(1);
    expect((tty as unknown as { cb: unknown }).cb).toBe(null);
  });

  test("without a tty nothing arms (script mode untouched)", async () => {
    const code = await runLine("range(1, 2)", ctx());
    expect(code).toBe(0);
  });
});

describe("review fixes — bus hygiene and shellTransform errors", () => {
  test("endRun clears the resolved promise (no post-Ctrl-C busy spin)", async () => {
    interrupt.beginRun();
    void interrupt.interruptPromise();
    interrupt.fire();
    interrupt.endRun();
    // A fresh caller (a tail at the idle prompt) must get a PENDING promise.
    const winner = await Promise.race([
      interrupt.interruptPromise().then(() => "stale-resolved"),
      Bun.sleep(30).then(() => "pending"),
    ]);
    expect(winner).toBe("pending");
  });

  test("upstream errors through a shell stage fail fast instead of hanging", async () => {
    const t0 = Date.now();
    const code = await runLine("read /nonexistent-crust-xyz | wc -l", ctx());
    expect(code).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3000);
    const code2 = await runLine("range(1, 3) | assert (x => x > 5) | wc -l", ctx());
    expect(code2).toBe(1);
  });

  test("a child that exits early (head) is still success", async () => {
    const code = await runLine("range(1, 5000) | head -1", ctx());
    expect(code).toBe(0);
  });
});
