import type { Token, StageKind } from "./types";

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

  const httpMatch = t.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/);
  if (httpMatch) {
    return {
      kind: "http",
      verb: httpMatch[1] as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: httpMatch[2]!,
      flags: [],
    };
  }

  if (t.startsWith("(") && t.includes("=>")) {
    return { kind: "lambda", source: t };
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

  return { kind: "shell", text: t };
}
