import { splitArgs } from "./args";
import type { StageKind, Token } from "./types";

export function tokenize(line: string): Token[] {
  const stages: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;

    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }

    if (c === "(") {
      depth++;
      buf += c;
      continue;
    }

    if (c === ")") {
      depth--;
      buf += c;
      continue;
    }

    if (c === "|" && depth === 0) {
      stages.push(buf);
      buf = "";
      continue;
    }

    buf += c;
  }
  stages.push(buf);

  return stages.map((s) => ({ kind: "stage" as const, text: s.trim() }));
}

export function classify(text: string): StageKind {
  const t = text.trim();

  if (t.startsWith('"') || t.startsWith("'")) {
    return { kind: "shell", text: t };
  }

  const timeMatch = t.match(/^time\s+(?:"([^"]*)"|'([^']*)')\s*$/);
  if (timeMatch) {
    return { kind: "time", label: (timeMatch[1] ?? timeMatch[2])! };
  }

  const httpMatch = t.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/);
  if (httpMatch) {
    // Tail is `<url> [-H "Key: value"]...` — split quote-aware so header
    // values may contain spaces and colons.
    const parts = splitArgs(httpMatch[2]!);
    const url = parts[0] ?? "";
    const headers: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === "-H" && i + 1 < parts.length) {
        headers.push(parts[++i]!);
      }
    }
    return {
      kind: "http",
      verb: httpMatch[1] as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url,
      headers,
    };
  }

  // JSON-literal source: the whole stage is a JSON object/array — the request
  // body in shorthand fixtures. Never falls back to shell (a typo'd JSON
  // stage exec'ing as a command would be baffling).
  if (t.startsWith("{") || t.startsWith("[")) {
    return { kind: "json", source: t };
  }

  const assertMatch = t.match(/^assert\s+(\(.+)$/);
  if (assertMatch) {
    return { kind: "assert", source: assertMatch[1]! };
  }

  const readMatch = t.match(/^read\s+(.+)$/);
  if (readMatch) {
    return { kind: "readsrc", pattern: readMatch[1]!.trim() };
  }

  if (t.startsWith("(") && t.includes("=>")) {
    return { kind: "lambda", source: t };
  }

  if (/^procs\s*\(/.test(t)) {
    return { kind: "procs", source: t };
  }

  const parallelMatch = t.match(/^parallel\s+(\d+)$/);
  if (parallelMatch) {
    return { kind: "parallel", n: parseInt(parallelMatch[1]!, 10) };
  }

  const expectMatch = t.match(/^expect\s+(\d{3})$/);
  if (expectMatch) {
    return { kind: "expect", status: parseInt(expectMatch[1]!, 10) };
  }

  if (t === "stats") {
    return { kind: "stats" };
  }

  const rangeMatch = t.match(/^range\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/);
  if (rangeMatch) {
    return {
      kind: "range",
      start: parseInt(rangeMatch[1]!, 10),
      end: parseInt(rangeMatch[2]!, 10),
    };
  }

  const firstToken = t.split(/\s+/)[0]!;
  if (/[*?]/.test(firstToken) || /\[[^\]]+\]/.test(firstToken)) {
    return { kind: "glob", pattern: firstToken };
  }

  const tailKind = classifyTail(t);
  if (tailKind) return tailKind;

  return { kind: "shell", text: t };
}

// Recognize the common shapes of `tail` — path, `-F`/`-f`, `-n N`,
// `--lines N`, `--lines=N` — and route them to the native source. Any
// other flag (`-c`, `--pid`, etc.) falls back to the system `tail` via
// shell. Bare `tail` (no args) is also shell, so `tail --help` still
// hits the system binary.
function classifyTail(
  t: string,
): { kind: "tail"; paths: string[]; lines: number; follow: boolean } | null {
  const m = t.match(/^tail(?:\s+(.+))?$/);
  if (!m || !m[1]) return null;

  const parts = m[1].trim().split(/\s+/);
  let lines = 10;
  let follow = false;
  const paths: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "-F" || p === "-f") {
      follow = true;
    } else if (p === "-n" || p === "--lines") {
      const next = parts[++i];
      if (!next || !/^\d+$/.test(next)) return null;
      lines = parseInt(next, 10);
    } else if (p.startsWith("--lines=")) {
      const v = p.slice("--lines=".length);
      if (!/^\d+$/.test(v)) return null;
      lines = parseInt(v, 10);
    } else if (p.startsWith("-")) {
      return null;
    } else {
      paths.push(p);
    }
  }

  if (paths.length === 0) return null;
  return { kind: "tail", paths, lines, follow };
}
