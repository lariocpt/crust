import { splitArgs } from "./args";
import { parseDuration } from "./readiness";
import type { StageKind, Token } from "./types";

export function tokenize(line: string): Token[] {
  const stages: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;

    if (quote) {
      // Inside double quotes a backslash escapes the next char, so JSON
      // bodies with embedded escaped quotes ({"size":"6\" nominal"}) stay
      // one stage. Single quotes stay sh-like: no escapes.
      if (quote === '"' && c === "\\" && i + 1 < line.length) {
        buf += c + line[i + 1]!;
        i++;
        continue;
      }
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
    // Tail is `<url> [-H "Key: value"]... [--timeout <dur>]` — split
    // quote-aware so header values may contain spaces and colons.
    const parts = splitArgs(httpMatch[2]!);
    const url = parts[0] ?? "";
    const headers: string[] = [];
    let timeoutMs: number | undefined;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!;
      if (p === "-H") {
        // A missing value used to fall off the end of the loop and vanish,
        // taking the header with it.
        const raw = parts[++i];
        if (raw === undefined) throw new Error('http: -H requires a "Key: value" header');
        headers.push(raw);
        continue;
      }
      if (p === "--timeout" || p.startsWith("--timeout=")) {
        const raw = p.startsWith("--timeout=") ? p.slice("--timeout=".length) : parts[++i];
        if (raw === undefined) throw new Error("http: --timeout requires a duration (e.g. 5s)");
        timeoutMs = parseDuration(raw); // throws on malformed values
        continue;
      }
      // An http stage can't fall back to shell (the verb regex already
      // committed), so a typo'd flag must be loud, not silently dropped.
      //
      // This tested `--` only, so every SINGLE-dash flag fell through the loop
      // and disappeared without a word: `-t 1ms` was ignored (the request ran
      // untimed and passed), and a curl-muscle-memory `-h "authorization: …"`
      // dropped the auth header, turning into a 401 blamed on the server.
      if (p.startsWith("-")) {
        throw new Error(`http: unknown flag "${p}" — supported: -H, --timeout`);
      }
    }
    return {
      kind: "http",
      verb: httpMatch[1] as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url,
      headers,
      timeoutMs,
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

  // `filter (l => ...)` — keeps items whose predicate is truthy. Without a
  // lambda it falls through to shell, so a real /usr/bin/filter still works.
  const filterMatch = t.match(/^filter\s+(\(.+)$/);
  if (filterMatch) {
    return { kind: "filter", source: filterMatch[1]! };
  }

  // `capture NAME (r => r.id)` — lambda optional; a name that isn't a valid
  // env identifier falls through to shell like any other word.
  const captureMatch = t.match(/^capture\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.+)?$/);
  if (captureMatch) {
    return { kind: "capture", name: captureMatch[1]!, source: captureMatch[2] ?? null };
  }

  const readMatch = t.match(/^read(?:\s+(.+))?$/);
  if (readMatch) {
    // Bare `read` used to fall through to POSIX `read`, which exits 1 with no
    // output whatsoever — the least helpful failure in the grammar. `lines`
    // already names what it needs; this matches it.
    return { kind: "readsrc", pattern: readMatch[1]?.trim() ?? "" };
  }

  // `lines <glob>` is the line-oriented file source; bare `lines` splits
  // whatever is upstream into one item per line. It is the answer to `read`
  // yielding whole-file items, which looks identical on a terminal but makes
  // `filter (l => …)` match against the entire file. No `lines` binary exists
  // on a normal system, so nothing is shadowed (`split` would have been).
  const linesMatch = t.match(/^lines(?:\s+(.+))?$/);
  if (linesMatch) {
    return { kind: "lines", pattern: linesMatch[1]?.trim() ?? null };
  }

  // `stdin` (or the tail/cat-style `-`) streams piped stdin line by line —
  // `docker logs -f app | crust -c 'stdin | grep ERROR'`. Bare words only;
  // `stdin foo` still shells out.
  if (t === "stdin" || t === "-") {
    return { kind: "stdin" };
  }

  if (t.startsWith("(") && t.includes("=>")) {
    return { kind: "lambda", source: t };
  }

  if (/^procs\s*\(/.test(t)) {
    return { kind: "procs", source: t };
  }

  const parallelMatch = t.match(/^parallel\s+(\d+)$/);
  if (parallelMatch) {
    const n = parseInt(parallelMatch[1]!, 10);
    if (n < 1) throw new Error(`parallel: N must be >= 1 — got ${n}`);
    return { kind: "parallel", n };
  }

  const expectMatch = t.match(/^expect\s+(\d{3}|[1-5]xx)$/);
  if (expectMatch) {
    const m = expectMatch[1]!;
    return { kind: "expect", matcher: /^\d{3}$/.test(m) ? parseInt(m, 10) : m };
  }

  if (t === "stats" || t.startsWith("stats ")) {
    const kind = classifyStats(t);
    if (kind) return kind;
    // Unknown flags fall through to shell, like any other unparsed word.
  }

  // `load <dur> <rate>[, <dur> <rate>…]` — e.g. `load 30s 100/s` or the ramp
  // `load 10s 50/s, 30s 200/s`. A malformed spec is a hard error (same stance
  // as JSON literals: a typo'd load exec'ing as a command would be baffling);
  // bare `load` still shells out.
  const loadMatch = t.match(/^load\s+(.+)$/);
  if (loadMatch) {
    const phases = loadMatch[1]!.split(",").map((s) => s.trim());
    const parsed: { durMs: number; rps: number }[] = [];
    for (const ph of phases) {
      const m = ph.match(/^(\d+(?:\.\d+)?)(ms|s|m)\s+(\d+(?:\.\d+)?)\/(s|m)$/);
      if (!m) {
        throw new Error(
          `load: expected "<dur> <rate>[, <dur> <rate>…]" e.g. \`load 30s 100/s\` — got "${ph}"`,
        );
      }
      const durMs = parseFloat(m[1]!) * (m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : 60_000);
      const rps = parseFloat(m[3]!) / (m[4] === "m" ? 60 : 1);
      if (durMs <= 0 || rps <= 0) {
        throw new Error(`load: duration and rate must be > 0 — got "${ph}"`);
      }
      parsed.push({ durMs, rps });
    }
    return { kind: "load", phases: parsed };
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

  const grepKind = classifyGrep(t);
  if (grepKind) return grepKind;

  return { kind: "shell", text: t };
}

// Recognize the safe subset of `grep` and route it to a native line-buffered
// stage — GNU grep block-buffers ~4KB when its stdout is a pipe, which stalls
// `tail -F | grep ERROR` follow streams indefinitely. Native = flags -i/-v/-F
// (-E is a no-op: JS regexes are ERE-shaped) and exactly ONE pattern arg.
// Everything else falls back to sh so file-grep, combined flags, env
// expansion ($PAT), BRE escapes, and POSIX classes keep their exact grep
// semantics. `raw` carries the untouched stage text for those fallbacks and
// for source position (a first-stage grep is a file grep — always shell).
function classifyGrep(t: string): StageKind | null {
  if (!/^grep\s+\S/.test(t)) return null;
  // sh expands $VARs in shell stages; the native stage doesn't. Any dollar
  // anywhere in the stage keeps it on the shell path.
  if (t.includes("$")) return null;

  const parts = splitArgs(t);
  let ignoreCase = false;
  let invert = false;
  let fixed = false;
  let ere = false;
  const positionals: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "-i") ignoreCase = true;
    else if (p === "-v") invert = true;
    else if (p === "-F") fixed = true;
    else if (p === "-E") ere = true;
    else if (p.startsWith("-"))
      return null; // unknown/combined flag → sh
    else positionals.push(p);
  }
  if (positionals.length !== 1) return null; // 2+ positionals = file grep
  if (fixed && ere) return null; // grep errors on -F -E; let it
  const pattern = positionals[0]!;
  if (!fixed) {
    // Regex dialects diverge exactly where escapes, POSIX classes, GNU open
    // intervals ("{,5}" — literal in JS), and JS-only groups ("(?=…)" — an
    // error in GNU grep) live. Don't reinterpret any of those, and never
    // native-compile what JS rejects.
    if (
      pattern.includes("\\") ||
      pattern.includes("[[:") ||
      pattern.includes("{,") ||
      pattern.includes("(?")
    ) {
      return null;
    }
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
  }
  return { kind: "grep", raw: t, pattern, ignoreCase, invert, fixed };
}

// `stats [--every N[s]] [--out file.json]` — null on any unknown flag so the
// caller can fall through to shell.
function classifyStats(t: string): StageKind | null {
  const parts = splitArgs(t);
  let everySec: number | undefined;
  let out: string | undefined;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    const everyEq = p.match(/^--every=(\d+)s?$/);
    if (everyEq) {
      everySec = parseInt(everyEq[1]!, 10);
      continue;
    }
    if (p === "--every") {
      const next = (parts[++i] ?? "").match(/^(\d+)s?$/);
      if (!next) return null;
      everySec = parseInt(next[1]!, 10);
      continue;
    }
    if (p.startsWith("--out=")) {
      out = p.slice("--out=".length);
      continue;
    }
    if (p === "--out") {
      const next = parts[++i];
      if (!next) return null;
      out = next;
      continue;
    }
    return null;
  }
  return { kind: "stats", everySec, out };
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
