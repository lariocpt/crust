// Shared argument helpers for shell-line parsing.

// Split a string on whitespace, honoring single/double quotes and STRIPPING
// them — `sql "SELECT count(*) FROM x" 42` → ['sql', 'SELECT count(*) FROM x', '42'].
// Backslash escapes the next character inside double quotes.
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"' && ch === "\\" && i + 1 < text.length) {
      cur += text[++i]!;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur.length > 0) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur.length > 0) out.push(cur);
  return out;
}

// Expand $NAME / ${NAME} from process.env. Missing vars become the empty
// string. Applied ONLY where crust explicitly opts in (URLs, -H values,
// JSON-literal sources) — shell stages keep sh's own expansion.
export function expandEnv(s: string): string {
  return s.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_m, braced, bare) => process.env[(braced ?? bare) as string] ?? "",
  );
}
