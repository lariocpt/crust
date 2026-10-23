// G08 — no multi-line input / heredocs at the REPL (red-first: docs/audit/gaps/G08-repl-multiline.md)
//
// Layout:
//   1. Assembler units over the NEW `src/editor.ts` exports
//      (`needsContinuation` / `joinContinued`). They do not exist yet, so every
//      case here is RED until G08 lands. The module is read through a STATIC
//      import + property access on purpose: a static *named* import of a missing
//      export fails at load and would turn the green controls red too. Property
//      access yields undefined → the assertion fails, red confined to section 1.
//   2. REPL integration: the emulated loop drives the editor through the same
//      seam index.ts uses (readLine({prompt, history}) → appendHistory →
//      runLine(line, ctx, tty), src/index.ts:284-305) and feeds keystrokes with
//      handleStdinData. Contract pinned: readLine itself returns the ASSEMBLED
//      multi-line entry (one history item), not the first physical line.
//   3. Ctrl-C at the secondary prompt clears the pending buffer, runs nothing.
//   4. Heredocs through a shell stage.
//   5. Controls that must PASS today (script / multi-line -c / empty-stage).
//
// Typeahead hygiene: the editor's module-level queue is shared by every test in
// this file (Bun isolates files, not tests). Every REPL test below feeds chunks
// that its readLine(s) consume EXACTLY — the last feed in each test ends with
// the byte that resolves that test's final readLine, and afterEach verifies the
// queue is empty by a probe readLine that must block (not resolve from a
// leftover) — a probe that resolves means a leak, and the test fails.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";
import { type ReplTty, runLine, runLines } from "../src/runLine";
import type { Context } from "../src/types";

// ---------- harness ----------

const editorAny = editor as unknown as Record<string, unknown>;
// The new assembler (G08): a predicate over the accumulated buffer and a
// joiner for the lines it accepts. Property access keeps this file loadable
// while the exports are still missing (a named import would not load).
const needsContinuation = editorAny.needsContinuation as ((buf: string) => boolean) | undefined;
const joinContinued = editorAny.joinContinued as ((lines: string[]) => string) | undefined;

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

// A fake REPL terminal (pattern: tests/interrupt.test.ts). suspend() is a
// counting no-op so the pure-shell tty path (runLine.ts:238-254) can balance
// its suspend/restore around an inherit-stdio child.
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

// JS-level capture of the streams runLine and the editor write to
// (writeStdout, `crust: …` error lines, prompt repaints). NOTE: a spawned
// child's fd 2 goes straight to the tty, not here — sh's own warning is NOT
// capturable this way, so the heredoc refusal is pinned by the exit code and
// by sh's stderr in the process output, per the no-false-pass rule.
function captureStreams() {
  const realOut = process.stdout;
  const realErr = process.stderr;
  const out: string[] = [];
  const err: string[] = [];
  process.stdout = {
    write: (s: string) => {
      out.push(s);
      return true;
    },
    once: () => {},
  } as unknown as typeof process.stdout;
  process.stderr = {
    write: (s: string) => {
      err.push(s);
      return true;
    },
    once: () => {},
  } as unknown as typeof process.stderr;
  return {
    end(): { out: string; err: string } {
      process.stdout = realOut;
      process.stderr = realErr;
      return { out: out.join(""), err: err.join("") };
    },
  };
}

// One step of the REPL loop, mirroring src/index.ts:284-305:
//   readLine → null = exit, blank = skip, else appendHistory + runLine(tty).
// `history` is the SAME array the editor's history navigation reads.
async function replStep(
  history: string[],
  ctx: Context,
  tty: ReplTty,
): Promise<{ line: string | null; code: number | null }> {
  const line = await editor.readLine({ prompt: "crust>", history });
  if (line === null) return { line: null, code: null };
  if (line.trim() === "") return { line, code: null };
  history.push(line); // appendHistory
  const code = await runLine(line, ctx, tty);
  return { line, code };
}

const CTRC = "\x03";
const CR = "\r";

beforeEach(() => {
  // Quiet interrupt bus: the mixed-pipeline tty path beginRun/endRuns around
  // each run, and a stale fired bus would win the drain race.
  interrupt.endRun();
});

afterEach(async () => {
  await drainTypeahead();
});

// The editor's module-level typeahead queue is shared by every test in this
// file (Bun isolates files, not tests). In the current (red) editor, a feed
// of N chunks resolves the first readLine at the FIRST CR and leaves N-1
// chunks queued; the green assembler holds the buffer across chunks and the
// test's readLine consumes them all. The drain works in both states: call
// readLine repeatedly — each call consumes one queued chunk up to its CR —
// and when the queue is empty the call BLOCKS (detected by the timeout), so
// it is resolved with a sentinel CR and returned cleanly. No pending readLine
// is left that could steal the next test's keystrokes.
async function drainTypeahead(): Promise<void> {
  const c = captureStreams();
  try {
    for (let i = 0; i < 16; i++) {
      const pending = editor.readLine({ prompt: "", history: [] });
      const raced = await Promise.race([pending, Bun.sleep(40).then(() => "timeout" as const)]);
      if (raced !== "timeout") continue; // consumed a chunk; keep draining
      editor.handleStdinData("\r"); // sentinel: resolve the straggler readLine
      await pending;
      return;
    }
  } finally {
    c.end();
  }
}

// ---------- 1. Assembler units (RED until G08) ----------

describe("assembler units — needsContinuation / joinContinued (src/editor.ts)", () => {
  test("module exports the assembler functions", () => {
    expect(typeof needsContinuation, "needsContinuation not exported from src/editor.ts").toBe(
      "function",
    );
    expect(typeof joinContinued, "joinContinued not exported from src/editor.ts").toBe("function");
  });

  test("trailing backslash continues", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    expect(fn!("range(1,3) \\")).toBe(true);
    expect(fn!("range(1,3) \\\n| wc -l")).toBe(false);
  });

  test("an escaped backslash (\\\\) does NOT continue", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    // Two backslashes at end of line = one escaped backslash: a complete line.
    expect(fn!("echo \\\\\\")).toBe(false);
  });

  test("unbalanced double quote continues", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    expect(fn!('echo "abc')).toBe(true);
    expect(fn!('echo "abc"')).toBe(false);
  });

  test("unbalanced ( continues", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    expect(fn!("range(1,")).toBe(true);
    expect(fn!("range(1,3)")).toBe(false);
  });

  test("balanced-but-mismatched (backtick closed by ') does NOT continue", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    // ` opens, ' closes: the counts balance but the pair does not — a mistyped
    // line must still error immediately, not hang waiting for a match.
    expect(fn!("echo `abc'")).toBe(false);
  });

  test("a JSON-literal paste continues (and finishes balanced)", () => {
    const fn = needsContinuation;
    expect(typeof fn).toBe("function");
    const line1 = `sh -c 'echo {"name":`;
    const full = `sh -c 'echo {"name":\n"crust"}'`;
    expect(fn!(line1), "line 1 ends mid-quote — the paste must continue").toBe(true);
    expect(fn!(full), "the whole paste is balanced — submit it").toBe(false);
  });

  test("joinContinued strips then joins, preserving newlines inside stages", () => {
    const fn = joinContinued;
    expect(typeof fn).toBe("function");
    // Backslash line: strip-then-join, mirroring splitLines.
    expect(fn!(["range(1,3) \\", "| wc -l"])).toBe("range(1,3) | wc -l");
    // Quote-continued heredoc: the sh stage NEEDS the real newline, so a
    // space-join here would turn a terminated heredoc into an unterminated one.
    expect(fn!(['sh -c "cat <<EOF', "hi", 'EOF" | (x => x)'])).toBe(
      'sh -c "cat <<EOF\nhi\nEOF" | (x => x)',
    );
  });
});

// ---------- 2. REPL integration ----------

describe("REPL integration — injected keystrokes through the editor", () => {
  test("range(1,3) \\ + | wc -l + Enter yields 3 with ONE history entry", async () => {
    const c = captureStreams();
    try {
      const history: string[] = [];
      const tty = fakeTty();
      editor.handleStdinData(`range(1,3) \\${CR}| wc -l${CR}`);
      const step = await replStep(history, ctx(), tty);
      // One assembled entry in history (zsh behaviour), one run, and the
      // pipeline printed the wc -l count of range(1,3).
      expect(history).toHaveLength(1);
      expect(step.code).toBe(0);
      const { out } = c.end();
      expect(out, "wc -l must print 3").toContain("3\n");
      expect(out.match(/3\n/g)).toHaveLength(1);
    } finally {
      c.end(); // restore streams even on assertion failure
    }
  });

  test("the assembled entry is one history item, recalled whole by ↑", async () => {
    const c = captureStreams();
    try {
      const history: string[] = ["seed entry"];
      const tty = fakeTty();
      editor.handleStdinData(`range(1,3) \\${CR}| wc -l${CR}`);
      const step = await replStep(history, ctx(), tty);
      expect(step.code).toBe(0);
      // Exactly two entries now: the seed + ONE assembled multi-line entry.
      expect(history).toHaveLength(2);
      expect(history[1]).toContain("range(1,3)");
      expect(history[1]).toContain("wc -l");
      // ↑ then Enter: the editor must fill the WHOLE assembled entry
      // (history[1]) — pin by submitting it and watching it run (code 0,
      // prints 3), proving recall restored the full line, not a fragment.
      editor.handleStdinData(`\x1b[A${CR}`);
      const step2 = await replStep(history, ctx(), tty);
      expect(step2.code).toBe(0);
      const { out } = c.end();
      expect(out.match(/3\n/g)).toHaveLength(2); // ran once per step
    } finally {
      c.end();
    }
  });
});

// ---------- 3. Ctrl-C during a pending buffer ----------

describe("Ctrl-C at the secondary prompt", () => {
  test("clears the pending buffer and runs nothing", async () => {
    const c = captureStreams();
    try {
      const history: string[] = [];
      const tty = fakeTty();
      // Open the pending buffer, then Ctrl-C while it is pending.
      editor.handleStdinData(`range(1,3) \\${CR}`);
      editor.handleStdinData(CTRC);
      // G08: the buffer is cleared, the primary prompt returns clean, and the
      // next Enter on the empty buffer yields a blank line: no history, no run.
      editor.handleStdinData(CR);
      const step = await replStep(history, ctx(), tty);
      expect(step.line, "clean primary prompt after ^C — empty buffer").toBe("");
      expect(step.code).toBeNull();
      expect(history).toHaveLength(0);
      const { err } = c.end();
      expect(err, "nothing ran, so no crust: error line").not.toContain("crust:");
    } finally {
      c.end();
    }
  });
});

// ---------- 4. Heredocs through a shell stage ----------

describe("heredoc through a shell stage (runLine-level pin)", () => {
  // Pinned at runLine, not through the emulated REPL: the gap file's input is
  // `sh -c "cat <<EOF\nhi\nEOF"`-shaped, i.e. the text the G08 assembler WILL
  // hand runLine as one assembled line. Feeding the same keystrokes through
  // the red-state REPL submits only the FIRST CR-terminated chunk, and sh
  // dies with exit 2 on the unbalanced quote — trivially nonzero, which would
  // mask the real pin (sh exits 0 on a true unterminated heredoc).
  test("terminated heredoc writes hi", async () => {
    const c = captureStreams();
    try {
      // Mixed pipeline (`| (x => x)`) so the sh stage is piped and its stdout
      // reaches runLine's writeStdout (capturable); a pure-shell line inherits
      // stdio (runLine.ts:242-254) and would bypass this JS capture.
      const code = await runLine(
        `sh -c "cat <<EOF
hi
EOF" | (x => x)`,
        ctx(),
      );
      const { out } = c.end();
      expect(code, "cat wrote the body — the stage succeeds").toBe(0);
      expect(out, "the heredoc body reaches stdout").toContain("hi\n");
    } finally {
      c.end();
    }
  });

  test("unterminated heredoc exits nonzero (no false pass)", async () => {
    const c = captureStreams();
    try {
      // No EOF line: sh exits 0 TODAY and only warns on fd 2 (a spawned
      // child's fd 2 is inherited — not capturable in-process), so the zero
      // code is exactly the false pass crust must not report. The no-false-
      // pass rule pins the nonzero exit; G08 lands the crust-level refusal.
      const code = await runLine(
        `sh -c "cat <<EOF
hi
"`,
        ctx(),
      );
      const { out, err } = c.end();
      expect(code, "unterminated heredoc must not exit 0").not.toBe(0);
      expect(out, "the body must not leak to stdout").not.toContain("hi\n");
      // When crust refuses itself (green), that refusal line must name the
      // heredoc problem; sh's own fd-2 warning never reaches this capture.
      if (err.includes("crust:")) {
        expect(err).toMatch(/here-document|end-of-file|unterminated|EOF/i);
      }
    } finally {
      c.end();
    }
  });
});

// ---------- 4b. empty stage — mode-specific wording ----------
// The advice must name a mechanism that exists in the mode that produced
// the error (G08): at the REPL the EDITOR continues a line ending with `\`;
// in a script / -c / piped stdin it is splitLines that joins it.

describe("empty stage — the continuation advice names the mode's mechanism", () => {
  test("at the REPL: the REPL continues a line ending with \\", async () => {
    const c = captureStreams();
    try {
      const code = await runLine("| wc -l", ctx(), fakeTty());
      const { err } = c.end();
      expect(code, "a leading | is still refused").toBe(1);
      expect(err).toMatch(/empty stage/);
      expect(err, "REPL wording").toMatch(/this REPL continues a line ending with/);
    } finally {
      c.end();
    }
  });

  test("in scripts / -c / piped stdin: end the line above with a trailing \\", async () => {
    const c = captureStreams();
    try {
      const code = await runLine("| wc -l", ctx());
      const { err } = c.end();
      expect(code, "a leading | is still refused").toBe(1);
      expect(err).toMatch(/empty stage/);
      expect(err, "script wording").toMatch(/end that line with a trailing/);
    } finally {
      c.end();
    }
  });
});

// ---------- 5. Controls — must PASS today ----------

describe("controls (pass today, unchanged by G08)", () => {
  test("multi-line -c continuation behaves exactly as before", async () => {
    // The exact shape index.ts:148 feeds runLines for `-c`.
    const source = `range(1,3) \\
| wc -l`;
    const c = captureStreams();
    try {
      const code = await runLines(source, ctx());
      const { out } = c.end();
      expect(code).toBe(0);
      expect(out).toContain("3\n");
    } finally {
      c.end();
    }
  });

  test("a script file's continuation is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-g08-"));
    try {
      const script = join(dir, "cont.crust");
      // Exactly one real backslash at end of line (two would be an escaped
      // backslash and the continuation would not happen — the naive version
      // of this fixture is the trap).
      writeFileSync(script, "range(1,3) \\\n| wc -l\n");
      const source = await readFile(script, "utf8");
      const c = captureStreams();
      let code: number | null = null;
      let out = "";
      try {
        code = await runLines(source, ctx());
      } finally {
        out = c.end().out;
      }
      expect(code).toBe(0);
      expect(out).toContain("3\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty stage still fires for a genuinely leading |", async () => {
    const c = captureStreams();
    try {
      const code = await runLine("| wc -l", ctx());
      const { err } = c.end();
      expect(code, "a leading | is still refused").toBe(1);
      // Pin the stable prefix only — the trailing continuation advice is
      // rewritten by G08 for the REPL wording, so don't pin its tail.
      expect(err).toMatch(/empty stage/);
    } finally {
      c.end();
    }
  });
});
