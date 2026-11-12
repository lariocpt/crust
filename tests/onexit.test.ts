// crust.onExit is the guaranteed-teardown half of script cleanup: a LATER
// line is only happy-path cleanup (fail-fast skips it on an earlier failure),
// while onExit runs from the centralized shutdown() on every exit through
// it. This file pins those guarantees through the real entry point — the
// spawn-and-assert style of tests/config-load.test.ts, with the bounded
// evidence polling of tests/lifecycle.test.ts.
//
// Measured 2026-11-12/13 on Bun 1.3.14 and 1.4.3 (identical results on both):
//   · `-c`, script file, and piped stdin all fail-fast on the first failing
//     line and fire onExit WITH that line's code; later lines never run.
//   · An onExit that throws prints `crust: onExit error: …` and the ORIGINAL
//     line's exit code and message survive — cleanup failure does not mask
//     the real failure.
//   · A SIGINT/SIGTERM with no `crust.onSignal` handler for it keeps the
//     signal's DEFAULT disposition: the process dies by the signal and onExit
//     never runs (there is no default handler in -c/script/stdin modes by
//     design — REPL Ctrl-C semantics are separate). That is a limitation,
//     pinned here honestly rather than asserted as coverage.
//   · A `crust.onSignal` handler that RETURNS lets the run continue to its
//     natural end, and onExit fires then, as usual. A handler that calls
//     process.exit() exits directly — process.exit bypasses shutdown(), so
//     onExit does NOT fire in that shape.
//   · kill -9 cannot run onExit (nothing can), but the process tree it leaves
//     is not a zombie pile: a detached shell stage's group is orphaned, runs
//     to its own end, and is reaped by init.
//
// Evidence is written to FILES (synchronous writeFileSync) by the hooks, not
// to stdout: a process that dies by a signal can lose buffered pipe bytes,
// but a sync file write always lands.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "crust-onexit-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Evidence file a config's onExit appends `onExit <code>` to. */
const ev = (name: string) => join(tmp, `${name}.ev`);

async function readEv(name: string): Promise<string> {
  try {
    return await readFile(ev(name), "utf8");
  } catch {
    return "";
  }
}

/**
 * Write an init.ts that registers onExit (appending to its own evidence file)
 * plus any extra hook registrations, and prints `hooks-ready` on stdout once
 * the config has been evaluated — the signal tests poll for that marker
 * instead of sleeping.
 */
async function writeCfg(name: string, extra = ""): Promise<string> {
  const path = join(tmp, `${name}.ts`);
  await writeFile(
    path,
    `import { writeFileSync } from "node:fs";
crust.onExit = (code) => {
  writeFileSync(${JSON.stringify(ev(name))}, "onExit " + code + "\\n", { flag: "a" });
};
${extra}
process.stdout.write("hooks-ready\\n");
`,
  );
  return path;
}

interface Run {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: { text: string };
  stderr: { text: string };
}

async function spawnCrust(args: string[], cfg: string, stdin?: string): Promise<Run> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    cwd: tmp,
    env: {
      ...process.env,
      CRUST_CONFIG: cfg,
      CRUST_GLOBAL_PREFIX: join(tmp, "no-globals"),
    },
  });
  const stdout = { text: "" };
  const stderr = { text: "" };
  (async () => {
    const d = new TextDecoder();
    for await (const c of proc.stdout as ReadableStream<Uint8Array>)
      stdout.text += d.decode(c, { stream: true });
  })();
  (async () => {
    const d = new TextDecoder();
    for await (const c of proc.stderr as ReadableStream<Uint8Array>)
      stderr.text += d.decode(c, { stream: true });
  })();
  return { proc, stdout, stderr };
}

/** Bounded wait on a predicate — returns false at the cap, never a fixed sleep. */
async function pollUntil(cond: () => boolean, capMs: number): Promise<boolean> {
  const deadline = Date.now() + capMs;
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

/** Bounded wait for a file to appear; returns its content, or "" at the cap. */
async function pollFile(path: string, capMs: number): Promise<string> {
  const deadline = Date.now() + capMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) return "";
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** Await the child's exit with a hard cap; the cap firing is a failure, not a pass. */
async function awaitExit(proc: ReturnType<typeof Bun.spawn>, capMs: number): Promise<void> {
  const r = await Promise.race([
    proc.exited.then(() => "exited" as const),
    new Promise<"cap">((r) => setTimeout(() => r("cap"), capMs)),
  ]);
  if (r === "cap")
    throw new Error("child did not exit within the cap — the signal/kill never took");
}

// A failing line: a lambda that throws. runLine reports it as
// `crust: kaboom-line` on stderr and the line exits 1 (src/runLine.ts).
const FAIL_LINE = "range(1,2) | (t => { throw new Error('kaboom-line') })";

// A line that visibly STARTS (first `load` slot is due immediately) and then
// keeps the process alive — the signal tests signal mid-line after seeing
// the tick, so they never need the full duration on the happy prediction.
const LONG_LINE = "load 3s 1/s | (t => { console.log('tick'); return t; })";
const SHORT_LINE = "load 1.5s 1/s | (t => { console.log('tick'); return t; })";

describe("onExit — fail-fast failure paths", () => {
  test("-c with a failing line: onExit ran with the failing code, crust exits with it", async () => {
    const cfg = await writeCfg("a");
    const r = await spawnCrust(["-c", FAIL_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    await awaitExit(r.proc, 10000);
    expect(r.proc.exitCode).toBe(1);
    expect(r.stderr.text).toContain("crust: kaboom-line");
    expect(await readEv("a")).toBe("onExit 1\n");
  });

  test("script file with a failing line: onExit ran with its code, later lines skipped", async () => {
    const cfg = await writeCfg("b");
    const script = join(tmp, "fail.crust");
    await writeFile(script, `${FAIL_LINE}\necho not-run\n`);
    const r = await spawnCrust(["fail.crust"], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    await awaitExit(r.proc, 10000);
    expect(r.proc.exitCode).toBe(1);
    expect(r.stderr.text).toContain("crust: kaboom-line");
    // fail-fast stopped at the first failure: the LATER cleanup line never
    // ran — that is exactly why it is not a teardown guarantee.
    expect(r.stdout.text).not.toContain("not-run");
    expect(await readEv("b")).toBe("onExit 1\n");
  });

  test("piped stdin with a failing line: onExit ran with its code, later lines skipped", async () => {
    const cfg = await writeCfg("c");
    const r = await spawnCrust([], cfg, `${FAIL_LINE}\necho not-run\n`);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    await awaitExit(r.proc, 10000);
    expect(r.proc.exitCode).toBe(1);
    expect(r.stderr.text).toContain("crust: kaboom-line");
    expect(r.stdout.text).not.toContain("not-run");
    expect(await readEv("c")).toBe("onExit 1\n");
  });

  test("an onExit that throws: original code preserved, original message survives", async () => {
    const cfg = await writeCfg(
      "d",
      `crust.onExit = (code) => {
  writeFileSync(${JSON.stringify(ev("d"))}, "onExit " + code + "\\n", { flag: "a" });
  throw new Error("kaboom-exit");
};`,
    );
    const r = await spawnCrust(["-c", FAIL_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    await awaitExit(r.proc, 10000);
    // The cleanup failure is reported, but the ORIGINAL failure — both its
    // exit code and its message — is what the run is still judged by.
    expect(r.proc.exitCode).toBe(1);
    expect(r.stderr.text).toContain("crust: kaboom-line");
    expect(r.stderr.text).toContain("crust: onExit error: kaboom-exit");
    // onExit WAS invoked (it wrote evidence before throwing).
    expect(await readEv("d")).toBe("onExit 1\n");
  });

  test("a clean -c run: onExit fires with code 0", async () => {
    const cfg = await writeCfg("e");
    const r = await spawnCrust(["-c", "range(0,1)"], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    await awaitExit(r.proc, 10000);
    expect(r.proc.exitCode).toBe(0);
    expect(await readEv("e")).toBe("onExit 0\n");
  });
});

describe("onExit — signal paths", () => {
  // No crust.onSignal handler for SIGINT: the main process has no listener in
  // -c mode, so SIGINT keeps its default disposition and kills the process.
  // Measured (Bun 1.3.14 and 1.4.3, identical): onExit did NOT run. That is
  // what the docs now say — a limitation, not coverage. The assertions below
  // pin the guarantee the docs claim (no onExit, no completed run) and hold
  // even if the child happens to die non-zero before the signal lands; only
  // a NORMAL completion (exit 0, onExit fired) would fail them.
  test("SIGINT with no onSignal handler: process dies by the signal, onExit does not run", async () => {
    const cfg = await writeCfg("f1");
    const r = await spawnCrust(["-c", LONG_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    // Evidence the line is RUNNING before signaling — never a blind sleep.
    const midLine = await pollUntil(() => r.stdout.text.includes("tick"), 5000);
    expect(midLine).toBe(true);
    try {
      process.kill(r.proc.pid, "SIGINT");
    } catch {
      // ESRCH: already dead — the assertions below still decide honesty.
    }
    await awaitExit(r.proc, 10000);
    const killed =
      (r.proc.exitCode ?? 0) !== 0 || (r.proc as { signalCode?: string | null }).signalCode != null;
    expect(killed).toBe(true);
    expect(await readEv("f1")).toBe("");
  });

  test("SIGTERM with no onSignal handler: process dies by the signal, onExit does not run", async () => {
    const cfg = await writeCfg("f2");
    const r = await spawnCrust(["-c", LONG_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    const midLine = await pollUntil(() => r.stdout.text.includes("tick"), 5000);
    expect(midLine).toBe(true);
    try {
      process.kill(r.proc.pid, "SIGTERM");
    } catch {
      // ESRCH: already dead — the assertions below still decide honesty.
    }
    await awaitExit(r.proc, 10000);
    const killed =
      (r.proc.exitCode ?? 0) !== 0 || (r.proc as { signalCode?: string | null }).signalCode != null;
    expect(killed).toBe(true);
    expect(await readEv("f2")).toBe("");
  });

  // The supported half: opt in with crust.onSignal. A handler that returns
  // does not kill the process — the run continues to its natural end and
  // onExit fires then, with the run's own code. Measured: handler ran, the
  // line completed, onExit 0.
  test("onSignal handler that returns: run continues, onExit fires at the end", async () => {
    const marker = join(tmp, "f3.marker");
    const cfg = await writeCfg(
      "f3",
      `crust.onSignal("SIGINT", () => {
  writeFileSync(${JSON.stringify(marker)}, "sigint-handler-ran\\n");
});`,
    );
    const r = await spawnCrust(["-c", SHORT_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    const midLine = await pollUntil(() => r.stdout.text.includes("tick"), 5000);
    expect(midLine).toBe(true);
    process.kill(r.proc.pid, "SIGINT");
    const sawMarker = await pollFile(marker, 5000);
    await awaitExit(r.proc, 10000);
    expect(sawMarker).toBe("sigint-handler-ran\n");
    expect(r.proc.exitCode).toBe(0);
    expect(await readEv("f3")).toBe("onExit 0\n");
  });

  // The trap: a signal handler that calls process.exit() exits DIRECTLY.
  // process.exit does not go through shutdown(), so onExit never fires —
  // measured: handler ran, exit 0, no onExit evidence. Pinning this is what
  // keeps the docs from promising teardown for this shape.
  test("onSignal handler that process.exits: onExit does not run", async () => {
    const marker = join(tmp, "f4.marker");
    const cfg = await writeCfg(
      "f4",
      `crust.onSignal("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "sigterm-handler-ran\\n");
  process.exit(0);
});`,
    );
    const r = await spawnCrust(["-c", SHORT_LINE], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    const midLine = await pollUntil(() => r.stdout.text.includes("tick"), 5000);
    expect(midLine).toBe(true);
    process.kill(r.proc.pid, "SIGTERM");
    const sawMarker = await pollFile(marker, 5000);
    await awaitExit(r.proc, 10000);
    expect(sawMarker).toBe("sigterm-handler-ran\n");
    expect(r.proc.exitCode).toBe(0);
    expect(await readEv("f4")).toBe("");
  });
});

describe("onExit — kill -9", () => {
  // SIGKILL cannot run any user code — onExit's absence there is by physics,
  // not a defect. What is testable (and what users lose): the process TREE.
  // The line's shell stage runs in its own process group (detached spawn,
  // src/parser.ts) so killing crust's pid orphans that group. Measured: the
  // orphan runs to its own end and init reaps it — /proc/<pid> disappears,
  // no state ever observed as zombie. The assertion below pins that: when
  // the entry is still present at the cap, its state is reported — a zombie
  // (state Z) and a still-running orphan both fail, with the reason named.
  test("kill -9: onExit cannot run, but the orphaned stage tree dies and is reaped", async () => {
    const pidfile = join(tmp, "g.pid");
    const cfg = await writeCfg("g");
    // Stage 1 (detached, its own group) records its own pid, then sleeps;
    // stage 2 is a lambda the stage never feeds — the line lives only as
    // long as the shell stage does.
    const line = `echo $$ > ${pidfile} ; sleep 1 | (l => l)`;
    const r = await spawnCrust(["-c", line], cfg);
    const started = await pollUntil(() => r.stdout.text.includes("hooks-ready"), 5000);
    expect(started).toBe(true);
    // Evidence-of-start: the stage has recorded its pid.
    const pidTxt = await pollFile(pidfile, 5000);
    expect(pidTxt.trim().length).toBeGreaterThan(0);
    const shpid = Number(pidTxt.trim());

    process.kill(r.proc.pid, "SIGKILL");
    await awaitExit(r.proc, 10000);
    // The test runner reaps crust itself: exit by signal, not a zombie.
    const killed =
      (r.proc.exitCode ?? 0) !== 0 || (r.proc as { signalCode?: string | null }).signalCode != null;
    expect(killed).toBe(true);
    expect(await readEv("g")).toBe("");

    // The ORPHANED group: poll /proc/<shpid> until reaped (init does it).
    const capMs = 15000;
    const deadline = Date.now() + capMs;
    let state: string | null = "";
    let gone = false;
    while (Date.now() < deadline) {
      try {
        const statTxt = await readFile(`/proc/${shpid}/stat`, "utf8");
        // Field 3 (state) is the character after the last ')' — the comm
        // field may itself contain spaces and parens.
        state = statTxt[statTxt.lastIndexOf(")") + 2] ?? null;
      } catch {
        state = null;
      }
      if (state === null) {
        gone = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    if (!gone) {
      throw new Error(
        `orphaned shell stage (pid ${shpid}) not reaped within ${capMs}ms — ` +
          `last state ${state} (${state === "Z" ? "zombie: init is not reaping" : "still running"})`,
      );
    }
  });
});
