// G09 unit B — Ctrl-R (0x12) incremental reverse history search in the editor
// (red-first: docs/audit/gaps/G09-ctrl-r-history.md).
//
// Layout (mirrors tests/repl-multiline.test.ts):
//   1. Search mode, driven byte-by-byte through the editor's single data seam
//      (handleStdinData pre-queued, then ONE readLine per test). RED against
//      the pre-change editor: 0x12 is swallowed there, so the query bytes land
//      in the buffer and CR submits the query as if it had been typed.
//   2. Guards: the search prompt / no-match marker are display-only (never in
//      the resolved text) and search never mutates the history array.
//   3. Controls that must pass in both states: plain ↑ history walk, normal
//      editing without a search.
//
// Piped stdin is not tested here because it cannot reach this code: index.ts
// takes the non-TTY branch (src/index.ts:271) before the REPL loop that calls
// readLine (src/index.ts:290), so 0x12 in a script or a pipe stays ordinary
// text. Unit C measures that claim through the compiled binary.
//
// Accept/cancel semantics pinned here (zsh's, per the gap file — unit C
// documents them verbatim):
//   - In search, `Enter` ACCEPTS: the match (or, with no match, the query as
//     typed text) goes into the buffer, the search line goes away, the line
//     stays EDITABLE — the NEXT Enter submits it. This is what makes search at
//     the `…` continuation prompt (G08) safe: accepting never resolves
//     readLine, so the pending physical lines survive.
//   - Cursor keys (`←`/`→`, Home/End) also accept, cursor at end of the match.
//   - `Ctrl-G` / `Esc` / `Ctrl-C` CANCEL: the pre-search draft is restored
//     byte-exact (a Ctrl-C during a search does NOT clear the line — the
//     normal-prompt Ctrl-C rule only applies once search is out of the way).
//   - No match: ` -- no match --` is painted; Enter inserts the query as text
//     (never runs nothing silently — the AGENTS.md honest-failure guardrail).
//
// Exact display strings pinned here (unit C documents them verbatim):
//   search prompt:   "\x1b[35m(crust-search): \x1b[0m"  (magenta)
//   no-match marker: " -- no match --"
// Repaint layout in search mode: the draft line stays on its own line; the
// search line is written BELOW it as "<search-prompt><query><match-or-marker>"
// with the cursor at the end; leaving search clears the search line and
// re-paints the draft line.
//
// Typeahead hygiene (G08 pattern): the editor's module-level queue is shared
// by every test in this file. Every test feeds EXACTLY the bytes its single
// readLine consumes — the last feed is the submitting CR — and afterEach
// probes the queue is empty.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as editor from "../src/editor";
import * as interrupt from "../src/interrupt";

const CTRC = "\x03";
const CTRG = "\x07";
const CTRLR = "\x12";
const CR = "\r";
const BS = "\x7f";
const ESC = "\x1b";
const CSI = "\x1b[";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
// Exact strings the implementation must paint (pinned, unit C documents them).
const SEARCH_PROMPT = "\x1b[35m(crust-search): \x1b[0m";
const NO_MATCH = " -- no match --";
const SP_VISUAL = 16; // "(crust-search): " without the colour escapes
// The secondary prompt G08 introduced — search mode has to leave it (and the
// pending physical line above it) alone.
const CONT_PROMPT = "\x1b[36m…\x1b[0m ";
const DEFAULT_WIDTH = 80; // what the editor falls back to when stdout has none
// Every REPLACER (a search-line repaint, and the draft repaint that leaves
// search) counts back to column 0 with CSI n P — n is the column the PREVIOUS
// paint ended at — then CR, then CSI J: erase to the bottom of the screen. CSI
// K alone reaches only the cursor's own row, and a wrapped paint is several
// rows, so the below-screen erase is what keeps the round-5 long-line drift
// from coming back.
const replaceAt = (prevVisual: number, width = DEFAULT_WIDTH): string =>
  `${CSI}${((prevVisual - 1) % width) + 1}P\r${CSI}J`;
const REPLACE = "\r" + CSI + "J";
// Leaving search mode also CLIMBS back to the row the draft line ends on, so
// the draft is re-painted where it belongs instead of being left on screen
// twice (measured in a real pty — the bug this pin exists for).
const climb = (rows: number): string => CSI + rows + "A";

// JS-level capture of the editor's prompt repaints (writeStdout). `columns`
// drives the width the editor consults for its soft-wrap arithmetic — the
// object-captured streams have no real size of their own.
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

const PROMPT = "crust>";

// Feed EVERY byte of the test into the editor's queue BEFORE readLine starts
// (the G08 feed-first pattern): the test-stdin is already at EOF, and the
// first resume() emits "end" — after which any getChunk with an EMPTY queue
// resolves null and ends the read. Pre-queueing makes the drive consume
// purely from the queue (queue is always checked before the EOF bit), so the
// whole sequence plays out; the last feed is the submitting CR. The paint
// stream is append-only, so every repaint (entry, per-keystroke, walk-back,
// no-match marker, exit) stays in `out`, in the order it was painted.
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

beforeEach(() => {
  // Quiet interrupt bus (pattern: repl-multiline.test.ts).
  interrupt.endRun();
});

afterEach(async () => {
  await drainTypeahead();
});

// The editor's module-level typeahead queue is shared by every test in this
// file (Bun isolates files, not tests). Draining works in both editor states:
// call readLine repeatedly — each call consumes one queued chunk up to its CR
// — and when the queue is empty the call BLOCKS (timeout), so it is resolved
// with a sentinel CR. No pending readLine is left to steal the next test's
// keystrokes.
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

// Paint assertions: a search paint is "<SEARCH_PROMPT><query><body>" (body =
// the match or the no-match marker). The paint stream is append-only and
// repaints are in-place ("\r" + line-clear, no "\n"), so a paint is a plain
// substring of `out` and paints appear in the order they were made.
function painted(out: string, query: string, body: string): boolean {
  return out.includes(SEARCH_PROMPT + query + body);
}

function paintedBefore(out: string, earlier: string, later: string): boolean {
  const a = out.indexOf(earlier);
  const b = out.indexOf(later);
  return a !== -1 && b !== -1 && a < b;
}

// ---------- 1. Search mode (RED before the editor change) ----------

describe("Ctrl-R search mode — basic walk", () => {
  test("0x12 + GET finds the newest match; Enter accepts it, next Enter runs it", async () => {
    const history = ["grep GET /etc/hosts", "ls -la", "curl GET /api"];
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", CR, CR],
    });
    // The search line was painted "<query><match>" — 0x12 never reached the
    // buffer, and the query is display-only. Entry opens the line with a
    // newline and shows the newest entry for the still-empty query; each
    // keystroke then REPLACES that line. The count-back argument is the
    // previous paint's own width (29 = 16 prompt + 13 match; 31 after the two
    // chars typed since), so the arithmetic is pinned, not just the shape.
    expect(r.out, "entry opens the search line with the newest entry").toContain(
      "\n" + SEARCH_PROMPT + "curl GET /api",
    );
    expect(
      r.out.includes(replaceAt(SP_VISUAL + "curl GET /api".length) + SEARCH_PROMPT + "G"),
      "the first keystroke replaces the entry paint, counting back its width",
    ).toBe(true);
    expect(painted(r.out, "GET", "curl GET /api"), "search line: query + newest match").toBe(true);
    expect(
      r.out.includes(
        replaceAt(SP_VISUAL + "GE".length + "curl GET /api".length) +
          SEARCH_PROMPT +
          "GET" +
          "curl GET /api",
      ),
      "each keystroke repaint REPLACES the search line",
    ).toBe(true);
    expect(r.line, "the accepted match submits on the second Enter").toBe("curl GET /api");
    expect(
      r.out.includes(climb(1) + REPLACE + PROMPT + "curl GET /api"),
      "accepting puts the match on the PROMPT's row, not the search line's",
    ).toBe(true);
    // Search never mutates the history array.
    expect(history).toEqual(["grep GET /etc/hosts", "ls -la", "curl GET /api"]);
  });

  test("second 0x12 walks further back with the same query", async () => {
    const history = ["grep GET /etc/hosts", "ls -la", "curl GET /api"];
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", CTRLR, CR, CR],
    });
    expect(
      paintedBefore(
        r.out,
        SEARCH_PROMPT + "GET" + "curl GET /api",
        replaceAt(SP_VISUAL + "GET".length + "curl GET /api".length) +
          SEARCH_PROMPT +
          "GET" +
          "grep GET /etc/hosts",
      ),
      "the second 0x12 replaced the search line with the next-older match",
    ).toBe(true);
    expect(r.line).toBe("grep GET /etc/hosts");
  });

  test("walking past the LAST match fails honestly: the marker shows, Enter inserts the query", async () => {
    // Only two entries contain "GET". The third 0x12 has nowhere older to go —
    // zsh's `search failed` state. crust shows the SAME no-match marker (never
    // a silent replay of the last match) and Enter inserts the query as text,
    // per the AGENTS.md honest-failure guardrail.
    const history = ["grep GET /etc/hosts", "ls -la", "curl GET /api"];
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", CTRLR, CTRLR, CR, CR],
    });
    expect(
      paintedBefore(
        r.out,
        replaceAt(SP_VISUAL + "GET".length + "curl GET /api".length) +
          SEARCH_PROMPT +
          "GET" +
          "grep GET /etc/hosts",
        replaceAt(SP_VISUAL + "GET".length + "grep GET /etc/hosts".length) +
          SEARCH_PROMPT +
          "GET" +
          NO_MATCH,
      ),
      "the third 0x12 painted the marker INSTEAD of the older match",
    ).toBe(true);
    expect(r.line, "a failed walk leaves the query as editable text (zsh)").toBe("GET");
  });

  test("Backspace narrows the query and re-matches", async () => {
    // newest: "curl GET /api"; older: "grep GET /etc/hosts". "GET" → newest;
    // Backspace → "GE" re-matches (both contain GE, still newest first).
    const history = ["grep GET /etc/hosts", "ls -la", "curl GET /api"];
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", BS, CR, CR],
    });
    expect(painted(r.out, "GET", "curl GET /api"), "the three-char query painted").toBe(true);
    // "GE" was painted TWICE — once on the way up to "GET", once after the
    // Backspace — so the pin is on the LAST paints: the shorter query must be
    // the final thing on screen, not the older keystroke.
    expect(
      r.out.lastIndexOf(SEARCH_PROMPT + "GE" + "curl GET /api"),
      "Backspace repainted the SHORTER query with its own newest match",
    ).toBeGreaterThan(r.out.lastIndexOf(SEARCH_PROMPT + "GET" + "curl GET /api"));
    expect(r.line).toBe("curl GET /api");
  });

  test("cursor-key accept keeps the match in the buffer, editable", async () => {
    const history = ["grep GET /etc/hosts", "curl GET /api"];
    // → accepts; a printable keystroke then lands INSIDE the match.
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", RIGHT, "!", CR],
    });
    expect(r.line).toBe("curl GET /api!");
  });
});

describe("Ctrl-R search mode — cancel restores the draft", () => {
  test("Ctrl-G restores the draft exactly (multi-width, ANSI-free chars)", async () => {
    const draft = "echo héllo wörld ☺";
    const history = ["grep GET /etc/hosts"];
    const r = await drive({
      history,
      feeds: [draft, CTRLR, "G", "E", "T", CTRG, "!", CR],
    });
    expect(r.line, "the cancelled search left the draft byte-exact").toBe(draft + "!");
    expect(
      r.out.includes(climb(1) + REPLACE + PROMPT + draft),
      "the draft is re-painted on ITS OWN row and the search line's row is erased",
    ).toBe(true);
  });

  test("Esc cancels the search and restores the draft", async () => {
    const draft = "echo hi";
    const history = ["echo hi there"];
    const r = await drive({
      history,
      feeds: [draft, CTRLR, "h", "i", ESC, "there", CR],
    });
    expect(r.line).toBe(draft + "there");
  });

  test("Ctrl-C during a search cancels the search FIRST (does not clear the draft)", async () => {
    const draft = "echo hi";
    const history = ["echo hi there"];
    const r = await drive({
      history,
      feeds: [draft, CTRLR, "h", "i", CTRC, "!", CR],
    });
    expect(r.line, "Ctrl-C in search mode must not clear the line").toBe(draft + "!");
    expect(
      r.out.includes(climb(1) + REPLACE + PROMPT + draft),
      "and it restores the draft the same way Ctrl-G does — no ^C, no lost typing",
    ).toBe(true);
  });

  test("Ctrl-C at the NORMAL prompt still clears the line (unchanged)", async () => {
    const history = ["echo hi there"];
    const r = await drive({
      history,
      feeds: ["echo hi", CTRC, CR],
    });
    expect(r.line).toBe("");
  });
});

describe("Ctrl-R search mode — the no-match guardrail", () => {
  test("no match: the marker shows, and Enter puts the QUERY in the buffer", async () => {
    const history = ["grep GET /etc/hosts"];
    const r = await drive({
      history,
      feeds: [CTRLR, "z", "z", "z", CR, CR],
    });
    expect(painted(r.out, "zzz", NO_MATCH), "the no-match marker is painted").toBe(true);
    expect(
      r.line,
      "Enter with no match inserts the query as editable text (zsh) — it does not run nothing",
    ).toBe("zzz");
  });

  test("empty history: search shows no match and does not crash", async () => {
    const history: string[] = [];
    const r = await drive({
      history,
      feeds: [CTRLR, "g", "i", "t", CR, CR],
    });
    expect(painted(r.out, "git", NO_MATCH), "no match painted for an empty history").toBe(true);
    expect(r.line, "the query itself becomes the editable buffer").toBe("git");
  });
});

describe("Ctrl-R search mode — G08 continuation interplay", () => {
  test("search at the … prompt: accepting keeps the pending line intact", async () => {
    const history = ["GET"];
    // Open a continuation (pending line 1), search at the … prompt, accept
    // with Enter (match → current physical line), then submit: the pending
    // line must survive the search.
    const r = await drive({
      history,
      feeds: ["echo \\", CR, CTRLR, "G", "E", "T", CR, CR],
    });
    expect(r.line, "the entry joins the pending line with the matched line").toBe("echo GET");
    expect(
      r.out.includes(climb(1) + REPLACE + CONT_PROMPT + "GET"),
      "accept lands on the … row — the pending line above it is never re-painted",
    ).toBe(true);
    expect(r.out, "the pending physical line is still on screen").toContain("crust>echo \\");
  });

  test("search at the … prompt: cancelling keeps the pending line intact", async () => {
    const history = ["GET"];
    const r = await drive({
      history,
      feeds: ["echo \\", CR, CTRLR, "G", "E", "T", CTRG, "x", CR],
    });
    expect(r.line, "cancel restores the empty continuation buffer — typed x joins").toBe("echo x");
    expect(
      r.out.includes(climb(1) + REPLACE + CONT_PROMPT),
      "cancel re-paints the bare … row, erasing the search line under it",
    ).toBe(true);
  });
});

describe("Ctrl-R search mode — editing after a search", () => {
  test("normal editing keys work after leaving search (accept path)", async () => {
    const history = ["echo hi there"];
    const r = await drive({
      history,
      feeds: ["echo ", CTRLR, "h", "i", ESC, "there", CR],
    });
    expect(r.line).toBe("echo there");
  });

  test("the long match repaints without corrupting the prompt (round-5 trap)", async () => {
    const long = `echo ${"x".repeat(200)}`;
    const history = [long];
    const r = await drive({
      history,
      feeds: [CTRLR, "e", "c", "h", "o", CR, CR],
    });
    expect(r.line).toBe(long);
    // The prompt line is re-painted on exit, so it is still intact in the
    // stream, and the search line is painted after the draft line.
    expect(r.out, "the prompt line survives the search").toContain(PROMPT + long);
    expect(r.out, "the search line is painted after the draft line").toContain(
      "\n" + SEARCH_PROMPT,
    );
    // The match is longer than any terminal width: it is painted WHOLE (the
    // line wraps, nothing is truncated), and the repaint that replaces it
    // counts back to the row the wrapped paint ENDED on — 16 + 205 columns at
    // width 80 leaves the cursor on the third row at column 61, so the replace
    // counts 61, not the full length and not the width.
    expect(r.out, "the full 200-char match is painted").toContain(SEARCH_PROMPT + "echo" + long);
    expect(
      r.out.includes(replaceAt(SP_VISUAL + long.length) + SEARCH_PROMPT + "e"),
      "the repaint after a wrapped paint counts back to its own end column",
    ).toBe(true);
    // And leaving a search line that covered three rows climbs all three back
    // before re-painting the prompt row — otherwise the match is left on screen
    // twice (the real-pty bug this replaces).
    expect(
      r.out.includes(climb(3) + REPLACE + PROMPT + long),
      "leaving a three-row search line climbs back to the prompt row",
    ).toBe(true);
    expect(r.out.startsWith(PROMPT), "repaint starts at column 0").toBe(true);
  });

  test("a draft ending in the terminal's last column enters search on the wrap — no newline, no scroll", async () => {
    // Width 15, prompt "crust>" (6): a 9-char draft ends flush with the last
    // column, so the terminal has ALREADY moved to the next row. Entering search
    // must not write "\n" there — a newline at the bottom of the screen scrolls
    // the user's history up. The search line simply starts on the row the wrap
    // opened, and leaving it climbs back.
    const draft = "abcdefghi";
    const history = ["needle"];
    const r = await drive({
      history,
      feeds: [draft, CTRLR, "n", CTRG, "!", CR],
      columns: 15,
    });
    expect(r.out, "the search paint follows the draft's own repaint, no newline").toContain(
      PROMPT + draft + CSI + "K" + SEARCH_PROMPT,
    );
    expect(r.out, "no newline opens the search line (the terminal's wrap did)").not.toContain(
      PROMPT + draft + "\n",
    );
    // The entry paint is "(crust-search): needle" = 22 columns at width 15 = two
    // rows, so leaving climbs both.
    expect(
      r.out.includes(climb(2) + REPLACE + PROMPT + draft),
      "cancel climbs back off the wrap and re-paints the draft on its own row",
    ).toBe(true);
    expect(r.line, "the cancelled search left the draft, then the typed key landed in it").toBe(
      draft + "!",
    );
  });

  test("the search line is on its OWN line, cursor at match end", async () => {
    const draft = "abc";
    const history = ["abc match"];
    const r = await drive({
      history,
      feeds: [draft, CTRLR, "m", "a", "t", CR, CR],
    });
    expect(r.out, "the search line opens on a NEW line below the draft").toContain(
      "\n" + SEARCH_PROMPT,
    );
    const paint = SEARCH_PROMPT + "mat" + "abc match";
    const at = r.out.lastIndexOf(paint);
    expect(at, "search line: prompt + query + match").toBeGreaterThan(-1);
    expect(
      r.out.slice(at + paint.length),
      "nothing is painted after the match — the cursor sits at its end, and the next Enter only walks back up to the draft row",
    ).toStartWith(climb(1) + REPLACE);
    expect(r.out, "draft line stays on its own line").toContain(PROMPT + draft);
    expect(r.line).toBe("abc match");
  });
});

// ---------- 2. Guards — display-only, never persisted ----------

describe("Ctrl-R guards — display-only, never persisted", () => {
  test("the search prompt and marker are never in the resolved line", async () => {
    const history = ["grep GET /etc/hosts"];
    const r = await drive({
      history,
      feeds: [CTRLR, "G", "E", "T", CR, CR],
    });
    expect(r.line).toBe("grep GET /etc/hosts");
    expect(r.line).not.toContain("\x1b[35m");
    expect(r.line).not.toContain("crust-search");
    expect(r.line).not.toContain(NO_MATCH);
  });

  test("the no-match marker is never persisted either", async () => {
    const history = ["grep GET /etc/hosts"];
    const r = await drive({
      history,
      feeds: [CTRLR, "z", "z", "z", CR, CR],
    });
    expect(r.line).toBe("zzz");
    expect(r.line).not.toContain(NO_MATCH);
  });
});

// ---------- 3. Controls (pass today, unchanged by the search mode) ----------

describe("controls — unchanged by Ctrl-R", () => {
  test("plain ↑ history walk is unchanged", async () => {
    const history = ["ls -la", "git status"];
    const r = await drive({
      history,
      feeds: [UP, CR],
    });
    expect(r.line).toBe("git status");
  });

  test("normal editing without a search is unchanged", async () => {
    const history: string[] = [];
    const r = await drive({
      history,
      feeds: ["echo hi", CR],
    });
    expect(r.line).toBe("echo hi");
  });
});
