// G33 — the cursor moves in UTF-16 CODE UNITS, so every edit can split a
// grapheme in half: astral characters (a surrogate PAIR), base+combining
// sequences, ZWJ families, regional-indicator flags. A half pair is not valid
// UTF-16, and the corruption is committed to the SUBMITTED line (measured:
// `echo 🚀` + Backspace submits `echo \ud83d`). Red-first per the dossier.
//
// The fix moves the caret by GRAPHEMES using the same Intl.Segmenter
// clustering `cells()` uses (src/width.ts), so the measure and the motion
// cannot drift. Controls pin what must NOT change: ASCII editing and the
// already-correct BMP-wide `日` behave byte-for-byte as today.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../src/completion";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";

const CSI = "\x1b[";
const LEFT = `${CSI}D`;
const RIGHT = `${CSI}C`;
// The CSI parser (editor.ts) accepts a single letter or a digit followed by
// `~`; xterm's Delete key is `CSI 3 ~`, not bare `CSI 3`.
const DELETE = `${CSI}3~`;
const BS = "\x7f";
const CR = "\r";
const HOME = "\x01"; // Ctrl-A
const CTRL_R = "\x12";
const CTRL_G = "\x07";
const PROMPT = "crust>"; // 6 cols, no escapes

// ---------- harness (pattern: tests/editor-cells.test.ts) ----------

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
  history?: string[];
  feeds: string[];
  columns?: number;
}): Promise<{ line: string | null; out: string; err: string }> {
  const c = captureStreams(opts.columns);
  for (const f of opts.feeds) editor.handleStdinData(f);
  const line = await editor.readLine({ prompt: PROMPT, history: opts.history ?? [] });
  return { line, out: c.end().out, err: c.end().err };
}

// The editor's typeahead queue is module state, shared by every test in this
// file. Drain it so a leftover byte cannot steer the next test.
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

/** True when the string holds a surrogate with no partner. */
function hasLoneSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xd800 && u <= 0xdbff) {
      // charCodeAt is NaN past the end — NaN compares false against
      // everything, so a TRAILING lone high would slip through without the
      // bound check (measured: it did).
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) return true;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      const p = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (p < 0xd800 || p > 0xdbff) return true;
    }
  }
  return false;
}

beforeEach(() => {
  interrupt.endRun();
});

afterEach(async () => {
  await drainTypeahead();
});

// First in the file on purpose: complete() caches the PATH walk in module
// state, and this test needs the cache populated from ITS PATH.
describe("completion never writes a half pair into the buffer (G33)", () => {
  test("commonPrefix snaps to a grapheme boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "crust-g33-"));
    // Two candidates whose longest common prefix ENDS IN A HIGH SURROGATE at
    // the code-unit level: `a` + half of 🚀/🚁.
    for (const name of ["a\ud83d\ude80x", "a\ud83d\ude81x"]) {
      writeFileSync(join(dir, name), "#!/bin/sh\n");
      chmodSync(join(dir, name), 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const res = complete("a", 1);
      // An ambiguous candidate list is fine; a single replacement must be
      // valid UTF-16 (today it is `a` + a lone high surrogate).
      if (!Array.isArray(res)) expect(hasLoneSurrogates(res.with)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("the draft cursor moves by graphemes (G33)", () => {
  test("Left steps over a whole astral character, so the insert cannot split it", async () => {
    // Measured pre-fix: `echo \ud83dx\ude80` — the `x` lands INSIDE the pair.
    const { line } = await drive({ feeds: ["echo ", "🚀", LEFT, "x", CR] });
    expect(line).toBe("echo x🚀");
  });

  test("Right steps over a whole astral character from the left (mirror of the Left case)", async () => {
    // From column 0 one Right must skip the WHOLE pair. Pre-fix it stepped one
    // unit — to the middle of the pair — and the insert split the glyph.
    const { line } = await drive({ feeds: ["🚀", "a", "b", HOME, RIGHT, "x", CR] });
    expect(line).toBe("🚀xab");
  });

  test("Backspace deletes the whole astral character (the control the dossier measured failing)", async () => {
    // Measured pre-fix: `echo \ud83d` — half a pair committed to the shell.
    const { line } = await drive({ feeds: ["echo ", "🚀", BS, CR] });
    expect(line).toBe("echo ");
  });

  test("Left keeps a combining mark attached to its base", async () => {
    // é is `e` + U+0301: one cell, two code units. Pre-fix the Left lands
    // between them and the `x` steals the accent: `ex` + U+0301.
    const { line } = await drive({ feeds: ["e\u0301", LEFT, "x", CR] });
    expect(line).toBe("xe\u0301");
  });

  test("Backspace deletes a ZWJ family as one glyph", async () => {
    // 👨‍👩 is five code units and ONE grapheme. Pre-fix the Backspace takes one
    // unit and leaves a dangling low surrogate plus a lone ZWJ.
    const { line } = await drive({ feeds: ["echo ", "👨‍👩", BS, CR] });
    expect(line).toBe("echo ");
  });

  test("Left steps over a regional-indicator flag as one glyph", async () => {
    // 🇦🇺 is two indicators (four code units) and ONE flag.
    const { line } = await drive({ feeds: ["🇦🇺", LEFT, "x", CR] });
    expect(line).toBe("x🇦🇺");
  });

  test("Delete removes the grapheme after the caret", async () => {
    const { line } = await drive({ feeds: ["echo ", "🚀", LEFT, DELETE, CR] });
    expect(line).toBe("echo ");
  });

  test("control: ASCII arrows, Backspace and Delete are unchanged", async () => {
    // The fix must not move a single-width cursor anywhere new.
    const left = await drive({ feeds: ["a", "b", LEFT, "x", CR] });
    expect(left.line).toBe("axb");
    const bs = await drive({ feeds: ["a", "b", "c", BS, CR] });
    expect(bs.line).toBe("ab");
    // Two Lefts land the caret between `a` and `b`; Delete removes `b`.
    const del = await drive({ feeds: ["a", "b", "c", LEFT, LEFT, DELETE, CR] });
    expect(del.line).toBe("ac");
  });

  test("control: BMP-wide 日 keeps its already-correct arrows", async () => {
    // One code unit, two cells — the dossier's case that is right BEFORE the
    // fix and must stay right after.
    const { line } = await drive({ feeds: ["日", LEFT, "x", CR] });
    expect(line).toBe("x日");
  });
});

describe("the search query cannot hold a half pair (G33)", () => {
  test("Backspace on a query ending in an emoji removes the whole glyph", async () => {
    // Pre-fix the query repaints `🚀`.slice(0,-1) — a LONE HIGH SURROGATE on
    // screen. Entering the search, typing, backspacing and cancelling must
    // leave no unpaired surrogate in the stream.
    const { out } = await drive({ feeds: [CTRL_R, "🚀", BS, CTRL_G, CR] });
    expect(hasLoneSurrogates(out)).toBe(false);
  });
});
