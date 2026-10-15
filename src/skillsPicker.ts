// The interactive picker `skills install` opens on a terminal, so "install the
// skills" stops meaning "write all nine of them into your repo".
//
// Split deliberately: `parseKeys`, `moveCursor`, `toggleAll`, `defaultChoice`
// and `renderPicker` are pure, and `pickSkills` is the only thing that touches a
// tty. That is not decoration — an input loop is the part that hangs a test
// suite, while the toggle and cursor arithmetic is the part that silently
// installs the wrong files, and only the second one is worth exercising
// headlessly.
import { onData } from "./editor";
import type { SkillStatus, SkillStatuses } from "./skillsData";

const CSI = "\x1b[";
const NAME_WIDTH = 24;
const DESCRIPTOR_WIDTH = 44;

export interface PickerEntry {
  name: string;
  description: string;
  /** Both scopes, read once up front — see `skillStatuses`. */
  statuses: SkillStatuses;
}

export interface PickerState {
  entries: PickerEntry[];
  chosen: Set<string>;
  cursor: number;
  /** true = ~/.claude/skills, false = ./.claude/skills of the current project */
  global: boolean;
  /** overwrite copies the user has edited locally */
  force: boolean;
}

export interface PickerResult {
  chosen: string[];
  global: boolean;
  force: boolean;
  cancelled: boolean;
}

/** Named keys the picker acts on. Anything else is "other". */
export type KeyName =
  | "up"
  | "down"
  | "space"
  | "enter"
  | "cancel"
  | "toggle-all"
  | "target"
  | "overwrite"
  | "quit"
  | "other";

/**
 * A raw-mode chunk to a list of keys.
 *
 * A chunk is NOT one keypress: a pasted burst or a fast key repeat arrives as
 * several sequences glued together, and reading one byte at a time is how a
 * terminal eats the `[A` of an arrow key and prints it. So every byte is
 * accounted for, and an `ESC` with nothing after it is a bare Escape rather than
 * a truncated sequence.
 */
export function parseKeys(chunk: string): KeyName[] {
  const keys: KeyName[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\x03") {
      keys.push("cancel");
      continue;
    }
    if (ch === "\x1b") {
      if (chunk[i + 1] === "[") {
        // A CSI sequence runs to its final byte (0x40–0x7E). Swallowing the WHOLE
        // thing is load-bearing, not tidiness: leaving the tail behind would let
        // an unbound arrow key feed `f` to the overwrite toggle or `a` to
        // all/none. A sequence cut in half by a chunk boundary resolves to
        // "other" plus inert characters — a dropped keypress, never a wrong one.
        let j = i + 2;
        while (j < chunk.length && chunk[j]! >= "@" && chunk[j]! <= "~") j++;
        const final = chunk.slice(i + 2, j);
        if (final === "A") keys.push("up");
        else if (final === "B") keys.push("down");
        else keys.push("other");
        // `- 1` because the for-loop's own ++ lands on `j`, the byte AFTER the
        // sequence — otherwise the ESC of the very next key in the same chunk is
        // skipped and a repeated arrow key arrives as one press plus two junk.
        i = j - 1;
        continue;
      }
      keys.push("other"); // bare ESC, or a sequence we do not bind
      continue;
    }
    if (ch === " " || ch === "x" || ch === "X") keys.push("space");
    else if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "k") keys.push("up");
    else if (ch === "j") keys.push("down");
    else if (ch === "a") keys.push("toggle-all");
    else if (ch === "g") keys.push("target");
    else if (ch === "f") keys.push("overwrite");
    else if (ch === "q" || ch === "n") keys.push("quit");
    else keys.push("other");
  }
  return keys;
}

/** The cursor never leaves the list — including when the list is empty. */
export function moveCursor(len: number, cursor: number, delta: number): number {
  return len === 0 ? 0 : (cursor + delta + len) % len;
}

/** All on if anything was off, all off if everything was already on. */
export function toggleAll(entries: PickerEntry[], chosen: Set<string>): Set<string> {
  const names = entries.map((e) => e.name);
  const allOn = names.length > 0 && names.every((n) => chosen.has(n));
  return new Set(allOn ? [] : names);
}

export function toggleOne(entries: PickerEntry[], chosen: Set<string>, index: number): Set<string> {
  const entry = entries[index];
  if (!entry) return chosen;
  const next = new Set(chosen);
  if (next.has(entry.name)) next.delete(entry.name);
  else next.add(entry.name);
  return next;
}

/** The status that matters is the one for the target currently selected. */
export function statusOf(entry: PickerEntry, global: boolean): SkillStatus {
  return global ? entry.statuses.global : entry.statuses.project;
}

/**
 * Pre-selected when the menu opens: everything not already installed and
 * current. Someone who just wants "the skills, please" reads the default and
 * presses enter; someone who wants a subset starts from a sensible place.
 * Pre-selecting ALL nine instead would offer to rewrite files that are already
 * right and bury the ones that are actually stale.
 */
export function defaultChoice(entries: PickerEntry[], global: boolean): Set<string> {
  return new Set(entries.filter((e) => statusOf(e, global) !== "current").map((e) => e.name));
}

const STATUS_LABEL: Record<SkillStatus, string> = {
  missing: "not installed",
  current: "installed, current",
  edited: "installed, EDITED locally",
};

// Yellow for edited (the one state where pressing enter could destroy work),
// green for current, dim for missing (nothing at stake).
const STATUS_COLOR: Record<SkillStatus, string> = {
  missing: `${CSI}2m`,
  current: `${CSI}32m`,
  edited: `${CSI}33m`,
};

function ellipsize(text: string, width: number): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length <= width ? oneLine : `${oneLine.slice(0, width - 1)}…`;
}

/**
 * The whole screen as one string ending in a newline.
 *
 * The redraw finds its own top by counting the lines it wrote last time rather
 * than querying the terminal size, which a compiled binary cannot always answer
 * when stdout is redirected.
 */
export function renderPicker(state: PickerState): string {
  const target = state.global ? "~/.claude/skills (global)" : "./.claude/skills (this project)";
  const selected = state.entries.filter((e) => state.chosen.has(e.name)).length;
  const lines: string[] = [];
  lines.push(`${CSI}1mcrust skills${CSI}0m — pick which agent skills to install`);
  lines.push(
    `  target ${CSI}1m${target}${CSI}0m    overwrite edited ${state.force ? `${CSI}33mON${CSI}0m` : "off"}`,
  );
  lines.push(
    `${CSI}2m↑↓ move · space toggle · a all/none · g target · f overwrite · enter install · q quit${CSI}0m`,
  );
  if (state.entries.length === 0) {
    lines.push("  (this binary embeds no skills)");
  }
  state.entries.forEach((entry, i) => {
    const status = statusOf(entry, state.global);
    lines.push(
      ` ${i === state.cursor ? `${CSI}1m›${CSI}0m` : " "} ${state.chosen.has(entry.name) ? "[x]" : "[ ]"} ` +
        `${entry.name.padEnd(NAME_WIDTH)}${STATUS_COLOR[status]}${STATUS_LABEL[status]}${CSI}0m` +
        `  ${CSI}2m${ellipsize(entry.description, DESCRIPTOR_WIDTH)}${CSI}0m`,
    );
  });
  lines.push(`  ${selected} of ${state.entries.length} selected`);
  return `${lines.join("\n")}\n`;
}

/**
 * Run the menu; resolves on enter (install) or q / Ctrl-C (cancel).
 *
 * Raw mode is taken for the duration and dropped on the way out however we
 * leave, because a process that exits with the tty in raw mode leaves the
 * user's own shell echoing control characters. Keys arrive through `onData`
 * rather than a fresh stdin listener: the REPL's single reader is already
 * attached, and a second listener would steal its bytes.
 */
export async function pickSkills(state: PickerState): Promise<PickerResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let drawn = 0;
  let finished = false;
  let dispose: () => void = () => {};

  const stop = (): void => {
    dispose();
    stdin.setRawMode?.(false);
    stdout.write(`${CSI}?25h`);
  };

  const result = (cancelled: boolean): PickerResult => ({
    chosen: cancelled
      ? []
      : state.entries.filter((e) => state.chosen.has(e.name)).map((e) => e.name),
    global: state.global,
    force: state.force,
    cancelled,
  });

  const draw = (): void => {
    const screen = renderPicker(state);
    stdout.write(`${drawn > 0 ? `${CSI}${drawn}A` : ""}${CSI}J${screen}`);
    drawn = screen.split("\n").length - 1; // the trailing newline is not a line
  };

  return new Promise<PickerResult>((resolve) => {
    const finish = (cancelled: boolean): void => {
      if (finished) return;
      finished = true;
      stop();
      resolve(result(cancelled));
    };

    const onKey = (chunk: string): void => {
      for (const key of parseKeys(chunk)) {
        switch (key) {
          case "up":
            state.cursor = moveCursor(state.entries.length, state.cursor, -1);
            break;
          case "down":
            state.cursor = moveCursor(state.entries.length, state.cursor, 1);
            break;
          case "space":
            state.chosen = toggleOne(state.entries, state.chosen, state.cursor);
            break;
          case "toggle-all":
            state.chosen = toggleAll(state.entries, state.chosen);
            break;
          case "target":
            state.global = !state.global;
            break;
          case "overwrite":
            state.force = !state.force;
            break;
          case "enter":
            finish(false);
            return;
          case "cancel":
          case "quit":
            finish(true);
            return;
          case "other":
            break;
        }
      }
      draw();
    };

    dispose = onData(onKey);
    stdout.write(`${CSI}?25l`);
    draw();
    stdin.setRawMode?.(true);
    stdin.resume();
  });
}
