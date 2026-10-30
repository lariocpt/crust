// G31 — a prompt + draft wider than the terminal smears on EVERY keystroke.
// Red-first against `render()`, which was one line:
//     stdout.write("\r" + prompt + buf + CSI + "K");
// `\r` is column 0 of the CURRENT row, and after a wrapped paint the cursor sits
// on the line's LAST row, so each repaint re-emitted the whole draft from there
// and the wrap pushed another row down (measured in tmux at 30 columns with a
// 35-character git-aware prompt: three repaints and the prompt's first row is
// gone). Display-only — Enter still runs the right line — which is why it lived.
//
// Harness pattern (capture + pre-queued typeahead + one readLine per test) is
// tests/history-ctrl-r.test.ts's, including the drain rule learned there: the
// sentinel CR may only be fed to a readLine that is PROVABLY parked, or the drain
// injects a keystroke into the next case.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";

const CSI = "\x1b[";
const climb = (rows: number): string => CSI + rows + "A";
const eraseBelow = "\r" + CSI + "J";

/**
 * Does the stream contain a cursor-up? Splitting on the CSI constant keeps the
 * escape byte out of the regex (biome flags control characters there) and says
 * the same thing: whatever follows an introducer starts with its parameters and
 * then the final byte, so `…A` right after `CSI` is a move-up.
 */
const cursorMovesUp = (s: string): boolean => s.split(CSI).some((c) => /^\d*A/.test(c));

/** 33 cells — wider than the 30-column window below, so the PROMPT alone wraps. */
const WRAPPING_PROMPT = "~/Projects/personal/crust (main) $ "; // 33 chars, all BMP
/** 4 pairs of `日本` = 8 characters but 16 cells: the climb must be counted in CELLS. */
const WIDE_PROMPT = "日本日本日本日本";

function captureStreams(columns?: number) {
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
    columns,
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

async function drive(opts: { feeds: string[]; columns: number; prompt?: string }): Promise<string> {
  const c = captureStreams(opts.columns);
  for (const f of opts.feeds) editor.handleStdinData(f);
  await editor.readLine({ prompt: opts.prompt ?? WRAPPING_PROMPT, history: [] });
  return c.end().out;
}

beforeEach(() => {
  interrupt.endRun();
});

afterEach(async () => {
  await drainTypeahead();
});

async function drainTypeahead(): Promise<void> {
  const c = captureStreams();
  try {
    for (let i = 0; i < 16; i++) {
      const pending = editor.readLine({ prompt: "", history: [] });
      const raced = await Promise.race([pending, Bun.sleep(40).then(() => "timeout" as const)]);
      if (raced !== "timeout") continue;
      editor.handleStdinData("\r"); // sentinel — only for a provably parked read
      await pending;
      return;
    }
  } finally {
    c.end();
  }
}

describe("a wrapped prompt line is repainted from its first row (G31)", () => {
  test("the repaint climbs to the line's first row and erases to the bottom", async () => {
    // 33-cell prompt in 30 columns: the cursor ends the paint on row 2, so the
    // next keystroke's repaint has to climb ONE row and then erase below — CSI K
    // alone reaches only the cursor's own row, which is the whole bug.
    const out = await drive({ feeds: ["e", "c", "h", "o", "\r"], columns: 30 });
    expect(out).toContain(climb(1));
    expect(out).toContain(eraseBelow);
  });

  test("the climb is counted in CELLS, not characters", async () => {
    // 16 cells / 8 characters in a 10-column window. The FIRST repaint reads the
    // initial record, so one keystroke proves nothing about `paintDraft`'s own
    // bookkeeping — three keystrokes do: each wrapped repaint must climb one row,
    // and counting the caret in characters (8+1 = 9 → row 1 → no climb) drops the
    // second and third climbs. G32 shipped cells() for the measure; this is the
    // same unit on the motion side, so the two cannot drift apart.
    const out = await drive({ feeds: ["a", "b", "c", "\r"], columns: 10, prompt: WIDE_PROMPT });
    const climbs = out.split(climb(1)).length - 1;
    expect(climbs).toBe(3);
  });

  test("control: a one-row draft keeps today's minimal repaint", async () => {
    // The fix must not start moving the cursor on a line that fits: no climb, no
    // erase-to-bottom, and CSI K stays the whole erase.
    const out = await drive({ feeds: ["e", "c", "h", "o", "\r"], columns: 80 });
    expect(cursorMovesUp(out)).toBe(false);
    expect(out).not.toContain(CSI + "J");
    expect(out).toContain(CSI + "K");
  });

  test("the repair never opens a line with a newline (that is how a prompt eats scrollback)", async () => {
    // Everything up to the FIRST erase must be newline-free: the erase is what
    // replaces the wrapped rows, so a newline before it would scroll instead.
    const out = await drive({
      feeds: ["e", "c", "h", "o", "space", "t", "e", "x", "t", "\r"],
      columns: 30,
    });
    expect(out.split("\n")[0]).toContain(CSI + "J");
  });

  test("a prompt of exactly N×width is known to be flush, so search entry adds no newline", async () => {
    // `draftWrapped` used to start as `false`, i.e. "a newline is safe". With the
    // prompt filling the window exactly, the terminal is ALREADY on the next row,
    // and that newline scrolls the screen instead of opening a line. The only
    // newline in this stream is the one the submit writes.
    const out = await drive({ feeds: ["\x12", "\x07", "\r"], columns: 30, prompt: "x".repeat(30) });
    expect(out.split("\n").length - 1).toBe(1);
  });
});
