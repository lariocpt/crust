import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

let pathCache: Set<string> | null = null;

function getPathCommands(): Set<string> {
  if (pathCache) return pathCache;
  const out = new Set<string>();
  const dirs = (process.env.PATH ?? "").split(":");
  for (const d of dirs) {
    if (!d) continue;
    try {
      for (const entry of readdirSync(d)) out.add(entry);
    } catch {
      /* dir doesn't exist or unreadable */
    }
  }
  pathCache = out;
  return out;
}

export interface CompletionReplace {
  replace: [number, number];
  with: string;
}

export type CompletionResult = CompletionReplace | string[];

export function complete(buf: string, cursor: number): CompletionResult {
  let start = cursor;
  while (start > 0 && !/[\s|]/.test(buf[start - 1]!)) start--;
  const token = buf.slice(start, cursor);

  let i = start - 1;
  while (i >= 0 && buf[i] === " ") i--;
  const atStartOfStage = i < 0 || buf[i] === "|" || buf[i] === ";";

  const candidates = atStartOfStage ? completeCommand(token) : completePath(token);

  if (candidates.length === 0) return { replace: [start, cursor], with: token };
  if (candidates.length === 1) {
    const isDir = !atStartOfStage && existsSync(candidates[0]!) && safeIsDir(candidates[0]!);
    return { replace: [start, cursor], with: candidates[0]! + (isDir ? "/" : "") };
  }
  const cp = commonPrefix(candidates);
  if (cp.length > token.length) return { replace: [start, cursor], with: cp };
  return candidates;
}

function completeCommand(token: string): string[] {
  const cmds = getPathCommands();
  const matches: string[] = [];
  for (const c of cmds) if (c.startsWith(token)) matches.push(c);
  matches.sort();
  return matches;
}

function completePath(token: string): string[] {
  let dir: string;
  let prefix: string;
  if (token.endsWith("/")) {
    dir = token.replace(/\/$/, "") || "/";
    prefix = "";
  } else if (token.includes("/")) {
    dir = dirname(token);
    prefix = basename(token);
  } else {
    dir = ".";
    prefix = token;
  }
  try {
    const entries = readdirSync(dir).filter((e) => e.startsWith(prefix));
    entries.sort();
    return entries.map((e) => (token.includes("/") ? join(dir, e) : e));
  } catch {
    return [];
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let p = strs[0]!;
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i]!.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}
