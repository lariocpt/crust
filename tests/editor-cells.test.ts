// G32 — the caret drifts on double-width glyphs (red-first: docs/audit/gaps/G32-wide-glyph-caret-drift.md)
//
// The bug is one unit mistake: `place(n)` emitted `CSI n D` from `buf.length -
// cursor`, a CHARACTER count, while a terminal's back-tab moves COLUMNS. Every
// double-width glyph to the right of the caret left the visible caret a column too
// far right (`echo 日本` +2, `echo a✅b` +1, `echo 日本語日本x` +5 — measured 8/8 with
// tmux `#{cursor_x}`), while the buffer and the paint were always right.
//
// Two layers here, matching how the bug hid:
//   1. `cells()` — the measure itself, pinned against widths MEASURED in a real
//      pty (so the table is not a theory), plus the table's shape.
//   2. The editor's escape counts — byte pins on the draft line and the search
//      line, because a correct `cells()` that is never consulted fixes nothing.
// ASCII is the control everywhere: exact before, exact after.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";
import { cells } from "../src/width";
import { WIDE_RANGES } from "../src/widthTable";

const CSI = "\x1b[";
const CR = "\r";
const HOME = "\x01"; // Ctrl-A
const CTRL_R = "\x12";
const CTRL_G = "\x07";
const PROMPT = "crust>"; // 6 cols, no escapes — the arithmetic below depends on that

// ---------- harness (pattern: tests/history-ctrl-r.test.ts) ----------

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
    out: () => out.join(""),
    end(): { out: string; err: string } {
      process.stdout = realOut;
      process.stderr = realErr;
      return { out: out.join(""), err: err.join("") };
    },
  };
}

async function drive(opts: {
  history: string[];
  feeds: string[];
  columns?: number;
}): Promise<{ line: string | null; out: string; err: string }> {
  const c = captureStreams(opts.columns);
  for (const f of opts.feeds) editor.handleStdinData(f);
  const line = await editor.readLine({ prompt: PROMPT, history: opts.history });
  return { line, out: c.end().out, err: c.end().err };
}

// The editor's typeahead queue is module state, shared by every test in this file.
// Drain it so a leftover byte cannot steer the next test.
async function drainTypeahead(): Promise<void> {
  const c = captureStreams();
  try {
    for (let i = 0; i < 16; i++) {
      const pending = editor.readLine({ prompt: "", history: [] });
      const raced = await Promise.race([pending, Bun.sleep(40).then(() => "timeout" as const)]);
      if (raced !== "timeout") continue;
      editor.handleStdinData(CR);
      await pending;
      return;
    }
  } finally {
    c.end();
  }
}

beforeEach(() => {
  interrupt.endRun();
});

afterEach(async () => {
  await drainTypeahead();
});

// ---------- 1. the measure ----------

describe("cells() — the terminal's unit", () => {
  test("ASCII is exact — the control every other row is measured against", () => {
    expect(cells("")).toBe(0);
    expect(cells("echo aaaaaa")).toBe(11);
    expect(cells("echo ab")).toBe(7);
  });

  test("CJK, kana, Hangul, Jamo, fullwidth and emoji occupy two cells", () => {
    // Each row is the pty measurement in the gap file, not a model's opinion.
    expect(cells("echo 日本")).toBe(9);
    expect(cells("echo 日本語日本x")).toBe(16);
    expect(cells("echo a✅b")).toBe(9);
    expect(cells("echo a✅b✅c✅")).toBe(14);
    expect(cells("가＄")).toBe(4); // Hangul syllable + fullwidth dollar
    expect(cells("\u{1f600}")).toBe(2); // grinning face
    expect(cells("\u{1f193}")).toBe(2); // squared symbol, EAW W
  });

  test("AMBIGUOUS width renders NARROW here — a choice, pinned rather than assumed", () => {
    // Code points are written as escapes: whether "é" in source is U+00E9 or
    // U+0065 U+0301 decides what the row measures, and no editor should be able to
    // change that quietly.
    expect(cells("echo \u2500\u2500\u2500\u2500\u2500")).toBe(10); // box drawing: 1 cell each
    expect(cells("\u00e9x")).toBe(2); // precomposed Latin (A) + x
    expect(cells("\u00b1")).toBe(1); // plus-minus (A)
    expect(cells("\u2318")).toBe(1); // place-of-interest (N)
    expect(cells("\u2764")).toBe(1); // heavy black heart, NO VS16: measured 1
  });

  test("marks are zero-width; VS16 promotes its base; ZWJ and a flag pair are ONE glyph", () => {
    expect(cells("e\u0301")).toBe(1); // e + combining acute → measured 1
    expect(cells("\u65e5\u0301")).toBe(2); // CJK base + combining mark → measured 2
    expect(cells("\u2764\ufe0f")).toBe(2); // heart + VS16 → measured 2
    expect(cells("\u231a\ufe0e")).toBe(2); // VS15 does NOT narrow an emoji here → measured 2
    expect(cells("\u2764\ufe0e")).toBe(1); // a narrow base stays narrow under VS15 → measured 1
    expect(cells("\u{1f468}\u200d\u{1f469}")).toBe(2); // 3 code points, one glyph → measured 2
    expect(cells("\u{1f1e6}\u{1f1e7}")).toBe(2); // two regional indicators, one flag
  });

  test("the wide table is generated data: sorted, disjoint, and the measured points are in it", () => {
    let prevEnd = -1;
    for (const [start, end] of WIDE_RANGES) {
      expect(start, "a range starts inside the previous one").toBeGreaterThan(prevEnd);
      expect(end, "a range ends before it starts").toBeGreaterThanOrEqual(start);
      prevEnd = end;
    }
    // Measured wide (2 cells in the pty) and measured narrow (1).
    for (const cp of [0x4e00, 0xac00, 0x1100, 0xff04, 0x1f600, 0x2705, 0x231b]) {
      expect(cells(String.fromCodePoint(cp)), `U+${cp.toString(16)} must be wide`).toBe(2);
    }
    for (const cp of [0x41, 0x2500, 0xb1, 0xe9, 0x2764, 0x2318]) {
      expect(cells(String.fromCodePoint(cp)), `U+${cp.toString(16)} must be narrow`).toBe(1);
    }
  });
});

// ---------- 2. the editor consults it ----------

describe("the draft caret counts back in cells", () => {
  test("Home after a CJK buffer emits the CELL count", async () => {
    // Buffer `echo 日本`: 7 characters, 9 columns. With the caret at 0 the paint
    // ends 9 columns ahead, so the back-tab must be 9. It emitted 7 — the drift.
    const r = await drive({ history: [], feeds: ["echo 日本", HOME, CR] });
    expect(r.line, "the buffer was always correct — this is a display bug").toBe("echo 日本");
    expect(r.out, "place() must count cells").toContain(`${CSI}9D`);
    expect(r.out, "the character count is the bug").not.toContain(`${CSI}7D`);
  });

  test("Home after an emoji buffer emits the CELL count", async () => {
    const r = await drive({ history: [], feeds: ["echo a✅b", HOME, CR] });
    expect(r.line).toBe("echo a✅b");
    expect(r.out).toContain(`${CSI}9D`);
    expect(r.out, "8 characters is what the terminal was NOT moved by").not.toContain(`${CSI}8D`);
  });

  test("ASCII emits exactly what it emitted before (control)", async () => {
    const r = await drive({ history: [], feeds: ["echo ab", HOME, CR] });
    expect(r.line).toBe("echo ab");
    expect(r.out).toContain(`${CSI}7D`);
  });

  test("one keystroke at a time keeps the caret on the right column", async () => {
    // Type a wide glyph then a space then Home: the caret must count back the
    // cells of what is on its right (`echo 日 ` → 1 + 2 + 5 = 8), not its chars (7).
    const r = await drive({ history: [], feeds: ["echo 日", " ", HOME, CR] });
    expect(r.line).toBe("echo 日 ");
    expect(r.out).toContain(`${CSI}8D`);
    expect(r.out).not.toContain(`${CSI}7D`);
  });

  test("the search line replaces using cells", async () => {
    // Ctrl-R paints `<search-prompt><query><match>`. With history `echo 日本` the
    // first paint is 16 + 0 + 9 = 25 COLUMNS, so the next paint counts back 25 to
    // reach column 0. Characters would say 23 and leave the previous paint's tail
    // (two columns of the match) on screen. Cancel does not replace — it climbs
    // (`CSI 1A`) and erases, which is why the count is asserted on the repaint.
    const r = await drive({ history: ["echo 日本"], feeds: [CTRL_R, "日", CTRL_G, CR] });
    expect(r.out).toContain(`${CSI}25P`);
    expect(r.out, "23 is the CHARACTER count for 16 + 0 + `echo 日本`").not.toContain(`${CSI}23P`);
  });

  test("a typed wide query keeps the replace count in cells", async () => {
    // Paint #1 visual 25 → paint #2 replaces with 25 and becomes 16 + 2 (`日`) + 9
    // = 27 → paint #3 replaces with 27 and becomes 16 + 4 (`日本`) + 9 = 29; cancel
    // then climbs without replacing. Cells therefore emits {25, 27}. Characters
    // would emit {23, 24} — those two are what must be absent.
    const r = await drive({ history: ["echo 日本"], feeds: [CTRL_R, "日", "本", CTRL_G, CR] });
    expect(r.out).toContain(`${CSI}25P`);
    expect(r.out).toContain(`${CSI}27P`);
    expect(r.out, "23/24 are the CHARACTER counts for this sequence").not.toContain(`${CSI}23P`);
    expect(r.out).not.toContain(`${CSI}24P`);
  });

  test("an ASCII search replace is unchanged (control)", async () => {
    const r = await drive({ history: ["echo ab"], feeds: [CTRL_R, "a", "b", CTRL_G, CR] });
    expect(r.out).toContain(`${CSI}23P`); // 16 + 0 + 7
    expect(r.out).toContain(`${CSI}24P`); // 16 + 1 + 7
  });

  test("a draft flush with the width is detected in CELLS, not characters", async () => {
    // Width 10, prompt 6 → the draft line is flush at 4 columns. `abcd` reaches it
    // with 4 characters; `日ab` reaches it with THREE (2 + 1 + 1 cells). Opening
    // the search line must behave identically for both — and at a flush point it
    // must not write a newline, because there the terminal has already moved down
    // and a newline SCROLLS (the geometry G09 measured).
    const newlines = async (buf: string): Promise<number> => {
      const r = await drive({ history: [], feeds: [buf, CTRL_R, CTRL_G, CR], columns: 10 });
      expect(r.line).toBe(buf);
      return (r.out.match(/\n/g) ?? []).length;
    };
    const ascii = await newlines("abcd"); // the control: flush under both models
    const wide = await newlines("日ab"); // flush by cells only
    const shortOf = await newlines("abc"); // one column short: opens a line
    expect(wide, "the wide draft must be treated as flush, like the ASCII one").toBe(ascii);
    expect(shortOf, "and a draft that is NOT flush must differ from a flush one").toBeGreaterThan(
      ascii,
    );
  });
});
