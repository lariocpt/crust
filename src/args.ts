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
