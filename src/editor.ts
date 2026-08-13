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

export async function readLine(opts: EditorOpts): Promise<string | null> {
  ensureListening();
  const { prompt, history } = opts;
  let buf = "";
  let cursor = 0;
  let histIdx = history.length;
  let savedBuf = "";

  const stdin = process.stdin;
  const stdout = process.stdout;
  const promptLen = stripAnsi(prompt).length;

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
        stdout.write("^C\n");
        buf = "";
        cursor = 0;
        histIdx = history.length;
        savedBuf = "";
        stdout.write(prompt);
        continue;
      }

      if (code === 0x04) {
        if (buf.length === 0) {
          stdout.write("\n");
          return null;
        }
        continue;
      }

      if (code === 0x0d || code === 0x0a) {
        stdout.write("\n");
        const remaining = chunk.slice(i + 1);
        if (remaining.length > 0) queue.unshift(remaining);
        return buf;
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
        buf = buf.slice(0, cursor) + c + buf.slice(cursor);
        cursor++;
        render();
      }
    }
  }
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this strips ANSI sequences
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
