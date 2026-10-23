import { complete } from "./completion";

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

  const stdin = process.stdin;
  const stdout = process.stdout;
  let promptLen = stripAnsi(prompt).length;

  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write(prompt);

  const render = (): void => {
    stdout.write("\r" + prompt + buf + CSI + "K");
    const visualLen = promptLen + buf.length;
    const target = promptLen + cursor;
    if (target < visualLen) {
      stdout.write(CSI + (visualLen - target) + "D");
    }
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

  while (true) {
    const chunk = await getChunk();
    if (chunk === null) {
      stdout.write("\n");
      return buf.length > 0 ? buf : null;
    }

    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      const code = c.charCodeAt(0);

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
        // At the secondary prompt this aborts the WHOLE pending buffer
        // (G08): nothing is appended to history and nothing is run.
        stdout.write("^C\n");
        buf = "";
        cursor = 0;
        histIdx = history.length;
        savedBuf = "";
        lines = [];
        prompt = opts.prompt;
        promptLen = stripAnsi(prompt).length;
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
          prompt = CONT_PROMPT;
          promptLen = stripAnsi(prompt).length;
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
