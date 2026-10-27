import { complete } from "./completion";
import { searchHistory } from "./history";

const CSI = "\x1b[";

// Single global stdin reader: one listener, a queue of chunks, a waker for
// the active readLine. Replaces the unshift-and-detach dance that races
// when piped input arrives as one big chunk.
const queue: string[] = [];
let pendingResolve: ((s: string | null) => void) | null = null;
let stdinClosed = false;
let listening = false;
let interruptWatcher: (() => void) | null = null;
let dataWatcher: ((chunk: string) => void) | null = null;

// Exported for tests — the raw-mode data path with no tty attached.
export function handleStdinData(chunk: Buffer | string): void {
  const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    r(str);
    return;
  }
  // No readLine pending — a line is RUNNING. Raw mode stays on, so Ctrl-C
  // arrives here as byte 0x03 instead of a SIGINT. With a watcher armed
  // that byte means "cancel": drop the typeahead queue AND this chunk (the
  // user is cancelling, not typing) and fire once per chunk.
  if (dataWatcher) {
    // A running line is holding the keyboard itself (the skills picker). Keys
    // are NOT queued as typeahead while it does, so the picker sees them and
    // the prompt after it does not inherit arrow-key escape sequences.
    dataWatcher(str);
    return;
  }
  if (interruptWatcher && str.includes("\x03")) {
    queue.length = 0;
    interruptWatcher();
    return;
  }
  queue.push(str);
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  process.stdin.on("data", handleStdinData);
  process.stdin.on("end", () => {
    stdinClosed = true;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(null);
    }
  });
}

// Watch for Ctrl-C while a line runs. Single slot — the REPL is sequential,
// so the latest register wins (the logs session deliberately overrides
// runLine's watcher this way). Returns a dispose that only clears the slot
// if it still holds THIS callback.
export function onInterrupt(cb: () => void): () => void {
  ensureListening();
  const prev = interruptWatcher;
  interruptWatcher = cb;
  return () => {
    if (interruptWatcher === cb) interruptWatcher = prev;
  };
}

/**
 * Take the keyboard for the duration of a RUNNING line — the skills picker,
 * which is a full-screen menu rather than a prompt.
 *
 * Single slot, same discipline as `onInterrupt`: the REPL is sequential, so only
 * one thing can hold the keys at a time, and nesting (a picker inside a picker)
 * is a bug this makes impossible to hide. The returned dispose also drops the
 * typeahead queue: the keystrokes the menu consumed — and any that arrived while
 * it was drawing — must not be replayed into the next prompt, where `\x1b[A`
 * would show up as literal characters.
 */
export function onData(cb: (chunk: string) => void): () => void {
  ensureListening();
  const prev = dataWatcher;
  dataWatcher = cb;
  return () => {
    if (dataWatcher === cb) dataWatcher = prev;
    queue.length = 0;
  };
}

// Hand the terminal to an inherit-stdio child: cooked mode + paused editor
// so the child sees line-buffered input and the tty delivers real signals
// (Ctrl-C → SIGINT to the foreground process group). Returns the restore.
export function suspendEditor(): () => void {
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  return () => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  };
}

function getChunk(): Promise<string | null> {
  if (queue.length > 0) return Promise.resolve(queue.shift()!);
  if (stdinClosed) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve;
  });
}

interface EditorOpts {
  prompt: string;
  history: string[];
}

// Secondary prompt for a pending multi-line buffer (G08): the primary prompt
// recoloured with the continuation ellipsis. It is only DISPLAY — the
// assembled entry is one history item (zsh behaviour), so the prompt is never
// persisted and a recall shows the whole entry on the primary prompt.
const CONT_PROMPT = "\x1b[36m…\x1b[0m ";

// Ctrl-R incremental reverse history search (G09). Both strings are the
// DISPLAY contract — docs/USAGE.md, the skills file and the website quote them
// verbatim, so they change only together with those.
const SEARCH_PROMPT = "\x1b[35m(crust-search): \x1b[0m";
const NO_MATCH = " -- no match --";

export async function readLine(opts: EditorOpts): Promise<string | null> {
  ensureListening();
  const { history } = opts;
  let prompt = opts.prompt;
  let buf = "";
  let cursor = 0;
  let histIdx = history.length;
  let savedBuf = "";
  // Physical lines of the pending multi-line buffer (G08). Empty while the
  // line is a plain one; the submitted entry is joinContinued of these plus
  // the current line, so history stores ONE item for the whole entry.
  let lines: string[] = [];
  // Ctrl-R incremental search state (G09). `sq` is the query — DISPLAY ONLY,
  // like CONT_PROMPT, never part of the resolved line. `sskip` is how far back
  // successive 0x12 presses have walked (searchHistory steps it), `smatch` is
  // what query+skip resolve to right now. The pre-search buffer is parked in
  // `draft`/`draftCursor` so a cancel restores it byte-exact.
  let searching = false;
  let sq = "";
  let sskip = 0;
  let smatch: string | null = null;
  let draft = "";
  let draftCursor = 0;
  // Terminal geometry for the search line (G09): how wide the last paint was
  // (`searchVisual`), how far left the next replace must count (`searchBack`),
  // and how many rows the paint spilled below the row it started on
  // (`searchRows`). The exit path needs all three to walk back to the draft's
  // row without touching the rows above it — scrolling the screen by painting a
  // newline at the bottom row is not an option; that is how a prompt eats
  // scrollback.
  let searchBack = 0;
  let searchVisual = 0;
  let searchRows = 0;
  // True when the draft line's LAST painted character landed in the terminal's
  // last column, so the terminal has already moved to the next row (its wrap
  // flag is set, nothing is written there yet). Measured in `render`, which is
  // the only thing that paints the draft line.
  let draftWrapped = false;

  const stdin = process.stdin;
  const stdout = process.stdout;
  let promptLen = stripAnsi(prompt).length;

  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write(prompt);

  // Put the cursor `n` columns left of where the last paint ENDED. Every paint
  // ends at the visual end of its own text, so this is the one cursor rule the
  // draft line and the search line share.
  const place = (n: number): void => {
    if (n > 0) stdout.write(CSI + n + "D");
  };

  const termWidth = (): number => (stdout.columns && stdout.columns > 0 ? stdout.columns : 80);

  // How far left the NEXT replace must count to reach column 0 after `n`
  // columns were painted from column 0: `n - 1` is the last column that HOLDS a
  // glyph, so the cursor sits one further on — and when a paint landed exactly
  // on the width, the terminal is one row down with its wrap still pending,
  // where counting the full width is exactly what lands back on column 0 of the
  // row that holds the text. The editor measures its OWN paints instead of
  // asking the terminal where the cursor is, because that question has no
  // portable answer (double-width glyphs, tabs, the pending-wrap flag).
  const backToCol0 = (n: number, width: number): number => {
    if (n === 0) return 0;
    return ((n - 1) % width) + 1;
  };

  // Replace an in-place paint (a search-line repaint, and the draft repaint that
  // leaves search mode): count back to column 0, then erase to the bottom of the
  // screen. CSI J with no argument is deliberate — CSI K reaches only the row
  // the cursor is on, and a wrapped paint is several rows (round 5's long-line
  // drift, one layer up). Nothing ABOVE the cursor is touched, so the screen
  // cannot scroll.
  const replacePaint = (from: number): void => {
    if (from > 0) stdout.write(CSI + from + "P");
    stdout.write("\r" + CSI + "J");
  };

  const render = (): void => {
    stdout.write("\r" + prompt + buf + CSI + "K");
    place(buf.length - cursor);
    // Did this paint end flush with the width? `render` is the only writer of
    // the draft line, so this is the wrap state that entering search mode
    // trusts: at the flush point the terminal has already moved to the next row,
    // and a newline there would SCROLL the screen rather than open a line.
    draftWrapped = (promptLen + buf.length) % termWidth() === 0;
  };

  // Paint the editor's own line at the cursor's row, from column 0. The caller
  // is responsible for getting the cursor there and erasing what was there
  // before (see leaveSearch).
  const paintDraft = (): void => {
    stdout.write(prompt + buf + CSI + "K");
    place(buf.length - cursor);
  };

  // The search line, painted from column 0: "<prompt><query><match-or-marker>",
  // cursor left at the end of what was painted. The FIRST paint lands on the
  // line the entry just opened; every later paint REPLACES the previous one,
  // wrapped rows and all.
  const paintSearch = (fresh: boolean): void => {
    if (!fresh) replacePaint(searchBack);
    const text = SEARCH_PROMPT + sq + (smatch ?? NO_MATCH);
    searchVisual = stripAnsi(text).length;
    searchBack = backToCol0(searchVisual, termWidth());
    searchRows = searchVisual === 0 ? 0 : Math.floor((searchVisual - 1) / termWidth());
    stdout.write(text);
  };

  const handleEscape = (which: string): void => {
    switch (which) {
      case "A": // up
        if (history.length > 0 && histIdx > 0) {
          if (histIdx === history.length) savedBuf = buf;
          histIdx--;
          buf = history[histIdx] ?? "";
          cursor = buf.length;
          render();
        }
        break;
      case "B": // down
        if (histIdx < history.length) {
          histIdx++;
          buf = histIdx === history.length ? savedBuf : (history[histIdx] ?? "");
          cursor = buf.length;
          render();
        }
        break;
      case "C":
        if (cursor < buf.length) {
          cursor++;
          render();
        }
        break;
      case "D":
        if (cursor > 0) {
          cursor--;
          render();
        }
        break;
      case "H":
      case "1":
        cursor = 0;
        render();
        break;
      case "F":
      case "4":
        cursor = buf.length;
        render();
        break;
      case "3":
        if (cursor < buf.length) {
          buf = buf.slice(0, cursor) + buf.slice(cursor + 1);
          render();
        }
        break;
    }
  };

  // Switch the prompt (primary ↔ the `…` continuation). Also resets the draft
  // wrap flag: a fresh prompt line starts at column 0 with nothing painted.
  const setPrompt = (p: string): void => {
    prompt = p;
    promptLen = stripAnsi(p).length;
    draftWrapped = false;
  };

  // ---------- Ctrl-R incremental reverse search (G09) ----------

  const searchRepaint = (fresh: boolean): void => {
    smatch = searchHistory(history, sq, sskip);
    paintSearch(fresh);
  };

  // 0x12: enter search, or step one match further back when already in it.
  // The draft line is NEVER rewritten while search is live — the search line
  // opens BELOW it. Reaching that row without disturbing the draft is the whole
  // subtlety of this feature:
  //   - a newline, because writing the search text itself would overwrite the
  //     draft (and would only erase the draft's own row, leaving its wrapped
  //     rows stranded below);
  //   - NO newline when the draft's last character landed in the terminal's
  //     LAST column — the terminal already moved to the next row there, so a
  //     newline would scroll everything up. That case is detected from what the
  //     editor itself painted (`draftWrapped`, set in `render`), never from a
  //     guess at where the wrap falls: that would need terminal knowledge the
  //     editor does not have (double-width glyphs, tabs, and the difference
  //     between the cursor's column and the last column that holds a glyph).
  // `searchBack`/`searchRows` record where the last search paint ended and how
  // far it spilled, so the exit path can walk back to the draft's row without
  // touching any row above it.
  const enterSearch = (): void => {
    const fresh = !searching;
    if (fresh) {
      draft = buf;
      draftCursor = cursor;
      sq = "";
      sskip = 0;
      searchVisual = 0;
      searchRows = 0;
      // The entry paint lands on a line of its own — nothing to replace.
      searchBack = 0;
      if (!draftWrapped) stdout.write("\n");
    } else {
      sskip++;
    }
    searching = true;
    // Only the ENTRY paint lands on a virgin line; every step REPLACES the
    // search line that is already there.
    searchRepaint(fresh);
  };

  // Leave search mode. `keep` takes the match into the buffer — or, when the
  // query matched nothing, the QUERY ITSELF (zsh's rule, and the AGENTS.md
  // honest-failure guardrail: Enter after a failed search must put something
  // visible on the line, never run nothing silently). `!keep` restores the
  // pre-search draft byte-exact. Either way the search line is erased and the
  // draft line is re-painted ON ITS OWN ROW — which means walking back up the
  // rows the search line spilled over first; painting the draft where the
  // search line was would leave the draft on screen TWICE (measured in a real
  // pty). And the line stays EDITABLE: leaving search never resolves readLine,
  // which is what makes search safe at the `…` continuation prompt, where a
  // pending physical line has to survive it.
  const leaveSearch = (keep: boolean): void => {
    // Rows the cursor must climb to get from the last row of the last search
    // paint back to the row the draft line ENDS on: the rows the search paint
    // spilled, plus the one its first row sits below the draft — which is true
    // BOTH ways the search line was opened (a newline we wrote, or the
    // terminal's own wrap at the draft's last column).
    const up = searchRows + 1;
    if (up > 0) stdout.write(CSI + up + "A");
    // After the climb a plain CR is enough: the column-counting back that
    // `replacePaint` needs exists only for a cursor parked at a pending wrap on
    // the SAME row, and moving up clears that state.
    stdout.write("\r" + CSI + "J");
    searching = false;
    if (keep) {
      buf = smatch ?? sq;
      cursor = buf.length;
    } else {
      buf = draft;
      cursor = draftCursor;
    }
    sq = "";
    smatch = null;
    searchVisual = 0;
    searchRows = 0;
    searchBack = 0;
    paintDraft();
  };

  // Keys while search is live. Returns the char-loop index to continue from
  // (advanced past a consumed escape sequence). Only these leave the search
  // line: Enter / cursor keys / Home / End ACCEPT, Ctrl-G and a lone Esc
  // cancel, Ctrl-C cancels first, Backspace / Delete / printable bytes edit
  // the query. Everything else is swallowed — the search line owns the
  // keyboard.
  const handleSearchKey = (chunk: string, i: number, c: string, code: number): number => {
    // A lone Esc is a cancel; Esc-[ starts a CSI sequence (checked for the
    // sequences that accept or edit).
    if (code === 0x1b) {
      if (chunk[i + 1] !== "[") {
        leaveSearch(false);
        return i;
      }
      const m = chunk.slice(i + 2).match(/^([ABCDHF3])|^(\d+)~/);
      if (m) {
        if (m[1] === "3") {
          // Delete edits the query, like Backspace.
          sq = sq.slice(0, -1);
          sskip = 0;
          searchRepaint(false);
        } else {
          // The regex only matches the arrows (ABCD), Home/End (HF, and the
          // `1~`/`4~` variants) — cursor-moving keys, which ACCEPT the match
          // with the cursor at its end.
          leaveSearch(true);
        }
      }
      return i + 1 + (m ? m[0].length : 0);
    }

    switch (code) {
      case 0x0d: // Enter — ACCEPT, and stay put for the next Enter to submit
      case 0x0a:
        leaveSearch(true);
        return i;
      case 0x07: // Ctrl-G
        leaveSearch(false);
        return i;
      case 0x03:
        // Ctrl-C cancels the SEARCH only — the "^C" / clear-the-line rule
        // belongs to the normal prompt, and applying it here would silently
        // throw away what the user typed before they searched (G09).
        leaveSearch(false);
        return i;
      case 0x04: // Ctrl-D with an empty query exits, as at the normal prompt;
        // with a query it erases the last query char instead of killing the
        // search out from under a half-typed line.
        if (sq.length === 0) {
          stdout.write("\n");
          return -2;
        }
        sq = sq.slice(0, -1);
        sskip = 0;
        searchRepaint(false);
        return i;
      case 0x7f: // Backspace
      case 0x08:
        sq = sq.slice(0, -1);
        sskip = 0;
        searchRepaint(false);
        return i;
      case 0x12: // 0x12 steps one match further back
        enterSearch();
        return i;
      default:
        if (code >= 0x20) {
          // Consume the whole printable RUN (a paste) and repaint once.
          let run = c;
          while (i + 1 < chunk.length) {
            const nc = chunk.charCodeAt(i + 1);
            if (nc < 0x20) break;
            run += chunk[i + 1]!;
            i++;
          }
          sq += run;
          sskip = 0;
          searchRepaint(false);
        }
        return i;
    }
  };

  while (true) {
    const chunk = await getChunk();
    if (chunk === null) {
      // EOF (Ctrl-D on a tty, or piped input that ends without a newline). A
      // live search line is DISPLAY ONLY — drop it and resolve the draft, so a
      // search interrupted by EOF can never put its query on the command line
      // instead of what the user was typing (G09).
      searching = false;
      stdout.write("\n");
      return buf.length > 0 ? buf : null;
    }

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      const code = c.charCodeAt(0);

      // The search line owns every key while it is live (G09). The handler
      // returns the index to continue from (past a consumed escape sequence);
      // -2 is the Ctrl-D-with-empty-query exit, which ends the read mid-chunk.
      if (searching) {
        const next = handleSearchKey(chunk, i, c, code);
        if (next === -2) return null;
        i = next;
        continue;
      }

      // CSI escape
      if (code === 0x1b && chunk[i + 1] === "[") {
        const tail = chunk.slice(i + 2);
        const m = tail.match(/^([ABCDHF])|^(\d+)~/);
        if (m) {
          handleEscape(m[1] ?? m[2]!);
          i += 1 + m[0].length;
          continue;
        }
        continue;
      }

      if (code === 0x03) {
        // (Search mode never gets here — handleSearchKey cancels the search
        // and restores the draft, G09.)
        // At the secondary prompt this aborts the WHOLE pending buffer
        // (G08): nothing is appended to history and nothing is run.
        stdout.write("^C\n");
        buf = "";
        cursor = 0;
        histIdx = history.length;
        savedBuf = "";
        lines = [];
        setPrompt(opts.prompt);
        stdout.write(prompt);
        continue;
      }

      if (code === 0x04) {
        if (buf.length === 0 && lines.length === 0) {
          stdout.write("\n");
          return null;
        }
        continue;
      }

      if (code === 0x12) {
        // Ctrl-R opens the incremental reverse search (G09).
        enterSearch();
        continue;
      }

      if (code === 0x0d || code === 0x0a) {
        const remaining = chunk.slice(i + 1);
        // G08: a line that is genuinely incomplete (a single trailing `\`, or
        // an unbalanced quote/paren — needsContinuation is conservative, so a
        // mistyped line still errors immediately) does not run: the physical
        // line stays pending and the editor drops to the secondary prompt.
        // No history write — the entry is not complete until it is submitted
        // whole. The check runs over the ACCUMULATED buffer, the same text
        // joinContinued folds, so the decision matches what gets submitted.
        const acc = lines.length === 0 ? buf : lines.join("\n") + "\n" + buf;
        if (needsContinuation(acc)) {
          lines.push(buf);
          buf = "";
          cursor = 0;
          histIdx = history.length;
          savedBuf = "";
          setPrompt(CONT_PROMPT);
          stdout.write("\n" + prompt);
          // The while loop's next getChunk() re-reads the remainder as its own
          // chunk — BREAK the char loop so those bytes are not also typed
          // here (the return path exits outright, so only this path leaks).
          if (remaining.length > 0) queue.unshift(remaining);
          break;
        }
        stdout.write("\n");
        if (remaining.length > 0) queue.unshift(remaining);
        return lines.length === 0 ? buf : joinContinued([...lines, buf]);
      }

      if (code === 0x7f || code === 0x08) {
        if (cursor > 0) {
          buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
          cursor--;
          render();
        }
        continue;
      }

      if (code === 0x01) {
        cursor = 0;
        render();
        continue;
      }
      if (code === 0x05) {
        cursor = buf.length;
        render();
        continue;
      }
      if (code === 0x0b) {
        buf = buf.slice(0, cursor);
        render();
        continue;
      }
      if (code === 0x15) {
        buf = buf.slice(cursor);
        cursor = 0;
        render();
        continue;
      }
      if (code === 0x17) {
        let j = cursor;
        while (j > 0 && buf[j - 1] === " ") j--;
        while (j > 0 && buf[j - 1] !== " ") j--;
        buf = buf.slice(0, j) + buf.slice(cursor);
        cursor = j;
        render();
        continue;
      }
      if (code === 0x0c) {
        stdout.write(CSI + "2J" + CSI + "H");
        render();
        continue;
      }
      if (code === 0x09) {
        const res = complete(buf, cursor);
        if (Array.isArray(res)) {
          stdout.write("\n" + res.join("  ") + "\n");
          render();
        } else {
          buf = buf.slice(0, res.replace[0]) + res.with + buf.slice(res.replace[1]);
          cursor = res.replace[0] + res.with.length;
          render();
        }
        continue;
      }

      if (code >= 0x20 && code !== 0x7f) {
        // Consume the whole RUN of printable characters and repaint once.
        // A paste arrives as a single chunk, and repainting per character made
        // it O(n²): a 5,000-char paste emitted 5,002 writes and 12.5MB of
        // terminal traffic (2,507x amplification), which a real emulator then
        // has to parse and re-lay-out — the visible "pasting stutters" bug.
        let run = c;
        while (i + 1 < chunk.length) {
          const next = chunk[i + 1]!;
          const nextCode = next.charCodeAt(0);
          if (nextCode < 0x20 || nextCode === 0x7f) break;
          run += next;
          i++;
        }
        buf = buf.slice(0, cursor) + run + buf.slice(cursor);
        cursor += run.length;
        render();
      }
    }
  }
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this strips ANSI sequences
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ---------- Multi-line line assembly (G08) ----------
//
// The REPL loop must decide, while a line is still being typed, whether the
// buffer is complete. `needsContinuation` makes that call over the whole
// accumulated buffer; `joinContinued` folds the physical lines the loop
// accepted into one logical line with `splitLines`' strip-then-join semantics
// (src/runLine.ts), so whatever the REPL submits is what the same text
// produced as a script or piped stdin — with the two pinned deviations below.
//
// The rules are conservative — the buffer continues only while it is
// genuinely incomplete, so a mistyped line still errors immediately:
//   - the final physical line ends in a SINGLE trailing backslash (a lone
//     `\` line is never one). splitLines would ALSO continue on any longer
//     ODD run — a deliberate, pinned deviation: `…\\\` is complete here, so
//     a mistype errors immediately rather than hanging at a third prompt;
//   - the quote/paren scan ends in an OPEN state: some quote char (`"`, `'`,
//     `` ` ``) was opened and never closed by its OWN kind, or an unclosed `(`.
// A quote span ends only at its OWN kind — a `'` inside a `` `…` `` span is a
// literal (and vice versa), which is what lets a paste of a multi-line JSON
// literal keep counting until the span genuinely closes. The one exception is
// a span left open at the end of the buffer whose LAST significant character
// is a quote of the WRONG kind (`` ` `` … `'`): that pair is
// balanced-but-mismatched — a mistype that must fail immediately on submit,
// not hang waiting for a match. A backslash inside a span escapes the next
// char, so a trailing `\\` in a span is one literal backslash, not an escape
// of the quote.
function quoteState(s: string): { open: string | null; paren: number } {
  let open: string | null = null; // the currently open span's quote char
  let paren = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (open !== null) {
      if (c === "\\") i++;
      else if (c === open) open = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") open = c;
    else if (c === "(") paren++;
    else if (c === ")") paren--;
  }
  // Still open: continue UNLESS the buffer's last significant char is a quote
  // of a different kind — then the span's own kind was never closed but the
  // buffer's final quote is a mistyped close (`` ` `` … `'`), and more input
  // cannot fix it, so the line is complete (and will error on submit).
  if (open !== null) {
    let last: string | null = null;
    for (let i = s.length - 1; i >= 0; i--) {
      const d = s[i]!;
      if (d === '"' || d === "'" || d === "`") {
        last = d;
        break;
      }
      if (d !== " " && d !== "\t" && d !== "\n" && d !== "\r") break;
    }
    if (last !== null && last !== open) return { open: null, paren };
  }
  return { open, paren };
}

/** Does this accumulated REPL buffer need one more line? */
export function needsContinuation(buf: string): boolean {
  const last = buf.slice(buf.lastIndexOf("\n") + 1);
  const body = last.trimEnd();
  let slashes = 0;
  while (body.length > slashes && body[body.length - 1 - slashes] === "\\") slashes++;
  if (slashes === 1 && body.length > 1) return true;
  const { open, paren } = quoteState(buf);
  return open !== null || paren > 0;
}

/**
 * Fold physical lines into one logical line: strip-then-join, mirroring
 * splitLines — a line that continues loses exactly one trailing backslash,
 * the next line is trimmed, the pair joins on a single space. Lines that
 * continue for another reason (an open quote/paren, no backslash) keep their
 * newlines when joined, because the sh stage needs the real line breaks
 * (heredoc bodies, etc.).
 */
export function joinContinued(lines: string[]): string {
  const out: string[] = [];
  let pending: string | null = null;
  for (const raw of lines) {
    const line: string = pending === null ? raw : `${pending} ${raw.trim()}`;
    pending = null;
    const body = line.trimEnd();
    let slashes = 0;
    while (body.length > slashes && body[body.length - 1 - slashes] === "\\") slashes++;
    if (slashes === 1 && body.length > 1) {
      // Exactly one backslash, and the joiner's space is the ONLY separator:
      // splitLines' `body.slice(0, -1)` keeps the char before the backslash
      // (often a space), which would double it. The pinned contract wants
      // `…(1,3) | wc -l` — one space.
      pending = body.slice(0, -1).trimEnd();
      continue;
    }
    out.push(line);
  }
  if (pending !== null) out.push(pending);
  return out.join("\n");
}
