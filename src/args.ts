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

// ---------------------------------------------------------------------------
// Shared flag parsing for the tool builtins.
//
// Every sub-CLI used to hand-roll its own loop, which is why they disagreed:
// only mock-server's --state/--seed guarded against swallowing the NEXT flag
// (so `--host --stateful` set host="--stateful" and failed with a misleading
// "port in use?"), only some supported --flag=value, `dotenv --help` was an
// "unknown arg", and none accepted its primary argument positionally — the
// single biggest source of typing in the whole toolkit.
// ---------------------------------------------------------------------------

export interface FlagDef {
  /** single letter, no dash: "t" for -t */
  short?: string;
  type: "string" | "number" | "boolean";
  /** also accepted as the Nth bare argument, so --target G can be just G */
  positional?: number;
  /** repeatable (--exclude a --exclude b); collects into string[] */
  repeat?: boolean;
}

export type FlagSpec = Record<string, FlagDef>;

export interface ParsedFlags {
  values: Record<string, string | number | boolean | string[] | undefined>;
  /** bare arguments left over after the positional slots were filled */
  rest: string[];
  help: boolean;
}

export class FlagError extends Error {}

function flagLabel(long: string, def: FlagDef): string {
  return def.short ? `-${def.short}/--${long}` : `--${long}`;
}

function coerce(long: string, def: FlagDef, raw: string): string | number {
  if (def.type !== "number") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new FlagError(`${flagLabel(long, def)} expects a number — got "${raw}"`);
  }
  return n;
}

export function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const byShort = new Map<string, string>();
  for (const [long, def] of Object.entries(spec)) {
    if (def.short) byShort.set(def.short, long);
  }
  const values: ParsedFlags["values"] = {};
  const rest: string[] = [];
  const bare: string[] = [];
  const seen = new Set<string>();

  const set = (long: string, def: FlagDef, raw: string): void => {
    if (def.repeat) {
      const list = (values[long] as string[] | undefined) ?? [];
      list.push(raw);
      values[long] = list;
      return;
    }
    values[long] = coerce(long, def, raw);
  };

  // Take the value for a flag: attached (--x=v, -xv) or the next argv entry.
  // A next entry that looks like a long flag is REFUSED rather than consumed —
  // that is the swallow guard, and it turns a typo into an error instead of a
  // bogus value.
  const takeValue = (long: string, def: FlagDef, attached: string | null, i: number): number => {
    if (attached !== null) {
      set(long, def, attached);
      return i;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new FlagError(`${flagLabel(long, def)} needs a value`);
    }
    set(long, def, next);
    return i + 1;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return { values, rest, help: true };

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const long = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const attached = eq === -1 ? null : a.slice(eq + 1);
      const def = spec[long];
      if (!def) {
        throw new FlagError(
          `unknown argument ${a} (valid: ${Object.keys(spec)
            .sort()
            .map((k) => `--${k}`)
            .join(", ")})`,
        );
      }
      if (def.type === "boolean") {
        if (attached !== null) throw new FlagError(`--${long} is a flag and takes no value`);
        values[long] = true;
      } else {
        i = takeValue(long, def, attached, i);
      }
      seen.add(long);
      continue;
    }

    if (a.startsWith("-") && a.length > 1) {
      const letter = a[1]!;
      const long = byShort.get(letter);
      if (!long) throw new FlagError(`unknown argument ${a}`);
      const def = spec[long]!;
      const attached = a.length > 2 ? a.slice(2) : null;
      if (def.type === "boolean") {
        if (attached !== null) throw new FlagError(`-${letter} is a flag and takes no value`);
        values[long] = true;
      } else {
        i = takeValue(long, def, attached, i);
      }
      seen.add(long);
      continue;
    }

    bare.push(a);
  }

  // Fill declared positional slots in order, then keep the remainder. A slot
  // whose flag was ALSO given explicitly is an error, not a silent overwrite.
  const slots = Object.entries(spec)
    .filter(([, d]) => d.positional !== undefined)
    .sort((x, y) => x[1].positional! - y[1].positional!);
  for (const b of bare) {
    const slot = slots.shift();
    if (!slot) {
      rest.push(b);
      continue;
    }
    const [long, def] = slot;
    if (seen.has(long)) {
      throw new FlagError(`${flagLabel(long, def)} was given twice — as a flag and as "${b}"`);
    }
    set(long, def, b);
  }

  return { values, rest, help: false };
}

// Strip a trailing sh-style `# comment` from a BUILTIN line. Shell stages get
// this for free from `sh -c`; builtin lines used to hand the `#` to parseFlags
// as an `unexpected argument`. Quote handling matches splitArgs exactly
// (backslash escapes only inside double quotes), brackets () {} [] guard
// structured payloads like procs({...}), and only a `#` that STARTS a word
// (position 0 or after whitespace) counts — `file#1.log` and `http://h/p#frag`
// pass through untouched. Not applied to pipeline/shell lines: sh owns its own
// comments, and $()-nesting makes a global strip unsafe.
export function stripTrailingComment(text: string): string {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"' && ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      continue;
    }
    if (ch === "#" && depth === 0 && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

// True when the line contains a shell metacharacter OUTSIDE quotes.
//
// This is the builtin-dispatch gate. It used to be a bare /[|&;<>]/ against the
// raw line, which meant a QUOTED metacharacter — the normal way to write a
// connection string or a multi-stage alias — routed the line to `sh`, where the
// builtin does not exist. `export DB='postgres://h/d?a=1&b=2'` therefore set
// nothing and exited 0, and `alias two='a | b'` silently defined nothing.
// Quote handling matches splitArgs exactly (backslash escapes only inside
// double quotes), so the gate agrees with the splitter that parses the args.
export function hasUnquotedShellMeta(text: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === '"' && ch === "\\" && i + 1 < text.length) {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") return true;
  }
  return false;
}

// Expand $NAME / ${NAME} / ${NAME:-default} from process.env. Missing vars
// become the empty string; the `:-` form falls back to its default when the
// var is unset OR empty (POSIX semantics — package.json scripts lean on it,
// and before this the whole `${VAR:-…}` passed through verbatim and became
// a "valid-looking" broken URL). Applied ONLY where crust explicitly opts
// in (URLs, -H values, JSON-literal sources, tool-builtin args) — shell
// stages keep sh's own expansion.
export function expandEnv(s: string): string {
  return s.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_m, braced, def, bare) => {
      const val = process.env[(braced ?? bare) as string];
      if (def !== undefined && (val === undefined || val === "")) return def;
      return val ?? "";
    },
  );
}

// ---------------------------------------------------------------------------
// Assignment words: the shape shared by `export FOO=x`, `export FOO=x BAR=y`
// and a bare `FOO=x` line.
//
// The value is NOT run through splitArgs first. The quotes the user typed are
// the only remaining record of which `$` were protected, and `FOO='$BAR'`
// staying literal while `FOO="$BAR"` expands is exactly the difference between
// a value that is set and one that merely looks set.
// ---------------------------------------------------------------------------

/** One `NAME=value`, `NAME+=value` or bare `NAME` word. */
export interface AssignWord {
  name: string;
  /** null for a bare name — `export FOO`, mark-for-export, no value. */
  value: string | null;
  /** `NAME+=value`: append to whatever is already there. */
  append: boolean;
}

export type AssignError =
  /** The line has a word that is not `NAME=…` — a command, a flag, a prefix. */
  | { reason: "not-assignment"; word: string; name?: undefined }
  /** `FOO=$(date)` — the value would have to come from a child process. */
  | { reason: "command-substitution"; word: string; name: string }
  /** `FOO="a` — sh calls this a syntax error; crust must not call it a value. */
  | { reason: "unterminated-quote"; word: string; name: string };

/**
 * Scan assignment words, applying sh's quoting rules to each value: `'…'`
 * protects `$`, `"…"` expands it, `\$` escapes it, and `$NAME` / `${NAME}` /
 * `${NAME:-default}` come from process.env (the same reference grammar as
 * `expandEnv`).
 *
 * A bare `NAME` word (`export FOO`, sh's mark-for-export) parses with
 * `value: null`. Anything else that is not assignment-shaped comes back as
 * `reason: "not-assignment"`, which is how callers keep `FOO=x cmd` on sh's
 * transient path instead of persisting it by accident.
 */
export function parseAssignWords(text: string): AssignWord[] | AssignError {
  const trimmed = text.trim();
  if (!trimmed) return { reason: "not-assignment", word: "" };
  const words: AssignWord[] = [];
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    if (i >= trimmed.length) break;
    const start = i;
    // Consume one whitespace-delimited word with its quotes still attached, so
    // a quoted space (`FOO="a b"`) is one word and its quoting survives. A
    // backslash escapes too — sh reads `FOO=a\ b` as ONE word, and splitting it
    // here would hand sh a line where `b` is a command and nothing persists.
    quote = null;
    let sub = 0;
    for (; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (ch === "\\") {
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      // `$( … )` holds spaces, and a refused value has to be quoted back to the
      // user whole: cutting `FOO=$(date | head -1)` at its first space would
      // report `FOO=$(date`. Only `$(` opens a run — a lone `(` stays a normal
      // character, so `FOO=a(b` is still split the way sh splits it.
      if (sub > 0) {
        if (ch === "(") sub++;
        else if (ch === ")") sub--;
        continue;
      }
      if (ch === "$" && trimmed[i + 1] === "(") {
        sub = 1;
        continue;
      }
      // The old backtick form likewise runs to its partner.
      if (ch === "`") {
        i++;
        while (i < trimmed.length && trimmed[i] !== "`") i++;
        continue;
      }
      if (/\s/.test(ch)) break;
    }
    if (quote) {
      return {
        reason: "unterminated-quote",
        word: trimmed.slice(start, i),
        name: trimmed.slice(start).split("=")[0]!,
      };
    }
    const raw = trimmed.slice(start, i);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(raw);
    if (m) {
      const scanned = scanAssignValue(m[3]!, raw, m[1]!);
      if ("error" in scanned) return scanned.error;
      words.push({ name: m[1]!, value: scanned.value, append: m[2] === "+" });
      continue;
    }
    // `export FOO` alone is sh for "mark FOO for export" — no value.
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
    if (bare) {
      words.push({ name: bare[1]!, value: null, append: false });
      continue;
    }
    return { reason: "not-assignment", word: raw };
  }
  return words.length ? words : { reason: "not-assignment", word: trimmed };
}

/**
 * Expand one assignment value with the user's quotes still on it. `$(` and a
 * backtick are refused, not silently dropped: the command would have to run in
 * a child process, and the honest answer is that its output comes from a
 * pipeline (`date | capture FOO`), not from an assignment.
 */
function scanAssignValue(
  raw: string,
  word: string,
  name: string,
): { value: string } | { error: AssignError } {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === "'") {
      // Single quotes protect everything — the only thing that ends them is
      // another single quote. `FOO='$BAR'` is the literal text.
      if (ch === "'") quote = null;
      else out += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length && "\\$`\"' \t\n".includes(raw[i + 1]!)) {
      // A backslash protects one character — the `$` of `FOO=\$BAR`, a quote
      // inside a value. Before anything else it stays literal, so a Windows
      // path (`FOO=C:\temp`) survives, exactly as it does in sh.
      out += raw[++i]!;
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      // Inside `"…"` a bare `'` is literal, so `FOO="it's $OK"` works.
      if (quote === '"') {
        quote = null;
        continue;
      }
      if (quote === null) {
        quote = '"';
        continue;
      }
    }
    if (ch === "`" || (ch === "$" && raw[i + 1] === "(")) {
      return { error: { reason: "command-substitution", word, name } };
    }
    if (ch === "$") {
      const ref = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(
        raw.slice(i),
      );
      if (!ref) {
        out += ch; // `$$`, `$1`, a lone `$` — not a name, left alone
        continue;
      }
      const val = process.env[(ref[1] ?? ref[3]) as string];
      out += ref[2] !== undefined && (val === undefined || val === "") ? ref[2] : (val ?? "");
      i += ref[0].length - 1;
      continue;
    }
    out += ch;
  }
  if (quote) return { error: { reason: "unterminated-quote", word, name } };
  return { value: out };
}

/**
 * Apply one assignment to the session environment. `export FOO=x` and a bare
 * `FOO=x` line share this so the two spellings can never drift.
 */
export function assignEnv(word: AssignWord): void {
  if (word.value === null) return;
  process.env[word.name] = word.append ? (process.env[word.name] ?? "") + word.value : word.value;
}
