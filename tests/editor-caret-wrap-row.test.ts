// G37 — moving the caret LEFT across a wrap row of a wrapped draft lands it on
// the wrong row, and the next repaint smears.
// Red-first against `place()`, which is a single backtab:
//     if (n > 0) stdout.write(CSI + n + "D");
// A terminal's CUB stops at column 0 of the CURRENT row, so a crossing move
// clamps at column 0 of the line's END row — one or more rows too low — and the
// next repaint climbs from a cursor that is already too low (the G31 smear
// signature returns, and the disagreement compounds every keystroke). Measured
// in the dossier: 8 lefts in a 97-cell line, expected (x=29, row 2), got
// (x=0, row 3). Display-only — the buffer caret is always correct.
//
// The fix moves the caret by ROWS and columns: the caret's target and the
// paint's end position both fall out of the recorded cells with the same model
// as backToCol0 (offset o -> row floor(o/width), column o%width — an exact
// multiple sits at column 0 of the NEXT row). Same row keeps today's single
// backtab (control-pinned); a crossing move climbs first, then backtabs when
// the target column is left of the end column, moves RIGHT (CUF) when it is
// right of it — a backtab cannot move right, and CUF cannot scroll here
// because the target column is inside the row — and nothing when they are
// equal. A descend is impossible (the caret is never past the paint's end).
//
// Harness pattern (capture + pre-queued typeahead + one readLine per test) is
// tests/editor-wrapped-prompt.test.ts's, including the drain rule learned in
// tests/history-ctrl-r.test.ts: the sentinel CR may only be fed to a readLine
// that is PROVABLY parked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";

const CSI = "\x1b[";
const LEFT = CSI + "D";
const climb = (rows: number): string => CSI + rows + "A";
const backtab = (n: number): string => CSI + n + "D";
const right = (n: number): string => CSI + n + "C";

/** 2 cells — leaves 28 buffer cells per row in the 30-column window. */
const P_SHORT = "$ ";
/** Exactly one row — the flush/pending-wrap end cases below hinge on it. */
const P30 = "x".repeat(30);

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
  await editor.readLine({ prompt: opts.prompt ?? P_SHORT, history: [] });
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

/** The bytes the LAST draft paint spent repositioning the caret: between its
 *  trailing CSI K and the next newline (the submit). Each repaint is
 *  [climb?][CR][CSI J?][prompt+buf][CSI K][placement], so this isolates the
 *  placement from the G31 climb that precedes it. */
const lastPlacement = (out: string): string => {
  const i = out.lastIndexOf(CSI + "K");
  if (i < 0) return "";
  const rest = out.slice(i + CSI.length + 1);
  const j = rest.indexOf("\n");
  return j < 0 ? rest : rest.slice(0, j);
};

const hasMoveUp = (s: string): boolean => s.split(CSI).some((c) => /^\d*A/.test(c));
const hasMoveRight = (s: string): boolean => s.split(CSI).some((c) => /^\d*C/.test(c));

describe("the caret placement across a wrap row (G37)", () => {
  test("control: a same-row move stays a single backtab", async () => {
    // 6-cell line in a 30-column window: one left, no boundary in sight. The
    // fix must not start emitting row moves on a line that fits.
    const out = await drive({
      feeds: ["e", "c", "h", "o", LEFT, "\r"],
      columns: 30,
      prompt: P_SHORT,
    });
    expect(lastPlacement(out)).toBe(backtab(1));
    expect(hasMoveUp(out)).toBe(false);
    expect(hasMoveRight(out)).toBe(false);
  });

  test("control: a caret at the paint's end moves nothing", async () => {
    // The cursor already sits where the caret is; the placement must emit no
    // bytes at all (today's place(0) no-op is the behaviour to keep).
    const out = await drive({ feeds: ["a", "b", "c", "\r"], columns: 30, prompt: P_SHORT });
    expect(lastPlacement(out)).toBe("");
  });

  test("crossing left of the end column: climb, then backtab", async () => {
    // 35-cell line (end at row 1, col 5). 33 lefts take the caret from offset
    // 35 to 2: row 0, col 2 — ABOVE the end row, LEFT of its col 5.
    // Expected: CSI 1 A + CSI 3 D. Today: one CSI 33 D that the terminal
    // clamps at col 0 of the end row.
    const out = await drive({
      feeds: ["a".repeat(33), ...Array.from({ length: 33 }, () => LEFT), "\r"],
      columns: 30,
      prompt: P_SHORT,
    });
    expect(lastPlacement(out)).toBe(climb(1) + backtab(3));
  });

  test("crossing right of the end column: climb, then CUF — a backtab cannot move right", async () => {
    // 60-cell line ending exactly at the width: the terminal wrapped, so the
    // paint ends at col 0 of row 2 (pending wrap). One left puts the caret at
    // offset 59 — row 1, col 29: above the end row and RIGHT of its col 0,
    // where only CUF can go. This subcase is the one the dossier's recorded
    // direction (climb + backtab only) did not cover.
    // Expected: CSI 1 A + CSI 29 C. Today: CSI 1 D, clamped to the same spot
    // it started from.
    const out = await drive({
      feeds: ["a".repeat(30), LEFT, "\r"],
      columns: 30,
      prompt: P30,
    });
    expect(lastPlacement(out)).toBe(climb(1) + right(29));
  });

  test("crossing with equal columns: climb only", async () => {
    // 60-cell line (end at row 2, col 0 — flush). 30 lefts take the caret to
    // offset 30: an EXACT multiple of the width, which the shared position
    // model (backToCol0's) puts at col 0 of row 1 — not row 0. Both columns
    // are 0, so the placement is the climb alone: CSI 1 A. A model that keeps
    // an exact multiple on the lower row would emit CSI 2 A instead.
    // Today: CSI 30 D, clamped to the start.
    const out = await drive({
      feeds: ["a".repeat(30), ...Array.from({ length: 30 }, () => LEFT), "\r"],
      columns: 30,
      prompt: P30,
    });
    expect(lastPlacement(out)).toBe(climb(1));
  });

  test("the placement counts CELLS, not characters, at a wide prefix", async () => {
    // 10-column window, 2-cell prompt, buffer 日本aaaa: 8 cells, so the line
    // is exactly flush (10) and the paint ends at col 0 of row 1. 4 lefts put
    // the caret at offset 6 — AFTER the 4 cells of 日本, so row 0, col 6:
    // above the end row and right of its col 0. Counting the caret in
    // CHARACTERS (2 + 2 = 4) would aim at col 4.
    // Expected: CSI 1 A + CSI 6 C. Today: CSI 4 D (cell distance, one row too
    // low).
    const out = await drive({
      feeds: ["日", "本", "a", "a", "a", "a", ...Array.from({ length: 4 }, () => LEFT), "\r"],
      columns: 10,
      prompt: P_SHORT,
    });
    expect(lastPlacement(out)).toBe(climb(1) + right(6));
  });
});
