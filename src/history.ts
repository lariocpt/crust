import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const XDG_DATA = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;
export const HISTORY_PATH = join(XDG_DATA, "crust", "history");

export async function loadHistory(): Promise<string[]> {
  try {
    const text = await readFile(HISTORY_PATH, "utf8");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Pure reverse-incremental history search — the Ctrl-R core (G09).
 *
 * Substring, case-insensitive, most-recent-first over `history` (the last
 * element is the newest entry). `skip` steps further back: 0 is the newest
 * match, 1 the next-older, and so on, for successive Ctrl-R presses. Returns
 * the matched line, or null when there is no match — empty history, nothing
 * contains the query, or `skip` past the last match (a negative `skip` also
 * matches nothing). An empty query matches every entry. Duplicates are
 * stepped one by one. Never mutates `history`, never does I/O — the editor
 * (G09 unit B) owns repaint, cursor, and the "no match → insert query" rule.
 */
export function searchHistory(history: string[], query: string, skip: number): string | null {
  const needle = query.toLowerCase();
  let matches = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toLowerCase().includes(needle)) {
      if (matches === skip) return history[i];
      matches++;
    }
  }
  return null;
}

export async function appendHistory(line: string, history: string[]): Promise<void> {
  if (!line.trim()) return;
  if (history[history.length - 1] === line) return;
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await appendFile(HISTORY_PATH, line + "\n");
  history.push(line);
}
