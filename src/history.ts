import { mkdir, readFile, appendFile } from "node:fs/promises";
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

export async function appendHistory(line: string, history: string[]): Promise<void> {
  if (!line.trim()) return;
  if (history[history.length - 1] === line) return;
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await appendFile(HISTORY_PATH, line + "\n");
  history.push(line);
}
