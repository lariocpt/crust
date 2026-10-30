import { tmpdir } from "node:os";
import {
  type AssignError,
  assignEnv,
  expandEnv,
  FlagError,
  type FlagSpec,
  parseAssignWords,
  parseFlags,
  splitArgs,
} from "./args";
import {
  contJob,
  currentJob,
  formatJobLine,
  getJob,
  type Job,
  latestJob,
  listJobs,
  settleJobs,
  waitJobForeground,
} from "./jobs";
import { classify, shellSyntaxPreflight, tokenize } from "./lexer";
import { parse } from "./parser";
import { withPositionals } from "./positionals";
import type { Context } from "./types";

export type Builtin = (rawArgs: string, ctx: Context) => Promise<number> | number;

const cdBuiltin: Builtin = (rawArgs, _ctx) => {
  const arg = rawArgs.trim();
  let target: string | undefined;
  if (arg === "" || arg === "~") {
    target = process.env.HOME;
  } else if (arg === "-") {
    target = process.env.OLDPWD;
    if (target) process.stdout.write(target + "\n");
  } else if (arg.startsWith("~/")) {
    target = (process.env.HOME ?? "") + arg.slice(1);
  } else {
    target = arg;
  }
  if (!target) {
    process.stderr.write("cd: no target\n");
    return 1;
  }
  const oldPwd = process.cwd();
  try {
    process.chdir(target);
    process.env.OLDPWD = oldPwd;
    process.env.PWD = process.cwd();
    return 0;
  } catch (err) {
    process.stderr.write(`cd: ${(err as Error).message}\n`);
    return 1;
  }
};

/**
 * Why an assignment word was refused, in terms of what to type instead. Shared
 * by `export FOO=…` and a bare `FOO=…` line so both spellings say the same
 * thing the same way.
 */
function assignErrorText(err: AssignError): string {
  if (err.reason === "command-substitution") {
    return (
      `\`${err.word}\`: an assignment sets the session environment in-process, so its value ` +
      `cannot come from a command — that output would have to cross back out of a child ` +
      `process. Run the command as a pipeline stage and capture it instead: ` +
      `<command> | capture ${err.name}`
    );
  }
  if (err.reason === "unterminated-quote") {
    return `\`${err.word}\`: unterminated quote in an assignment value.`;
  }
  return `'${err.word}' is not a NAME=value assignment`;
}

/**
 * A bare assignment line — `FOO=x`, `FOO+=x`, `A=1 B=2` — applied to the
 * session, through the same code `export FOO=x` goes through.
 *
 * Returns null when the line is not ours: `FOO=x cmd` is sh's *transient*
 * prefix (the variable lives for that command only) and `FOO` on its own is a
 * command name, and silently persisting either would be a lie of the opposite
 * sign.
 *
 * `persistable` is false when the line carries a shell metacharacter and so
 * belongs to sh. That decides what crust *applies*, not what it refuses: a
 * value that would have to come from a command is a mistake wherever it shows
 * up, and `FOO=$(date | head -1)` — a word list crust cannot assign — used to
 * reach `sh -c`, where it set a variable in a shell that exited immediately.
 * Exit 0, nothing set, the false pass this whole path exists to close.
 */
export function applyBareAssignmentLine(text: string, persistable = true): number | null {
  const parsed = parseAssignWords(text);
  if ("reason" in parsed) {
    // A command substitution or an unbalanced quote is a mistake worth naming;
    // anything else that isn't assignment-shaped is simply not our line.
    if (parsed.reason === "not-assignment") return null;
    process.stderr.write(`crust: ${assignErrorText(parsed)}\n`);
    return 1;
  }
  if (!persistable) return null;
  // A mark-only word (`FOO cmd args`, or a bare `FOO`) means the line is a
  // command with a prefix, not a line of assignments.
  if (parsed.some((w) => w.value === null)) return null;
  for (const word of parsed) assignEnv(word);
  return 0;
}

const exportBuiltin: Builtin = (rawArgs, _ctx) => {
  const arg = rawArgs.trim();
  if (arg === "" || arg === "-p" || arg === "--print") {
    for (const [k, v] of Object.entries(process.env)) {
      process.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  }
  const parsed = parseAssignWords(arg);
  if ("reason" in parsed) {
    // sh's own wording is quieter here, but a silently-ignored word was the
    // false pass: `export FOO=1 -p` set FOO, printed nothing, and exited 0.
    process.stderr.write(
      `export: ${assignErrorText(parsed)}${
        parsed.reason === "not-assignment" && /^-/.test(parsed.word)
          ? " (crust has no export flags beyond -p)"
          : ""
      }\n`,
    );
    return 1;
  }
  for (const word of parsed) {
    if (word.value === null && !(word.name in process.env)) {
      // sh marks a name for export without giving it a value; crust's children
      // inherit process.env, so there is nothing to mark and nothing set.
      process.stderr.write(
        `export: '${word.name}' is not set — crust exports by assigning: ${word.name}=value\n`,
      );
      return 1;
    }
    assignEnv(word);
  }
  return 0;
};

const aliasBuiltin: Builtin = (rawArgs, ctx) => {
  const arg = rawArgs.trim();
  if (arg === "") {
    for (const [k, v] of ctx.aliases) {
      process.stdout.write(`alias ${k}='${v}'\n`);
    }
    return 0;
  }
  const eq = arg.indexOf("=");
  if (eq === -1) {
    process.stderr.write(`alias: missing '=' in '${arg}'\n`);
    return 1;
  }
  const name = arg.slice(0, eq).trim();
  let value = arg.slice(eq + 1).trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  ctx.aliases.set(name, value);
  return 0;
};

const unaliasBuiltin: Builtin = (rawArgs, ctx) => {
  ctx.aliases.delete(rawArgs.trim());
  return 0;
};

// `source`'s shape detection for extensionless and unmarked files. A line
// STARTING with an opener (`if`/`for`/`while`/`case`) that doesn't close on
// the SAME line, or a line starting with a bare closer (`do`/`done`/`fi`/
// `esac` — its opener is an earlier line), is a multi-line shell construct:
// fed to line-by-line crust it dies in sh (the measured G06 failure). A
// construct that opens AND closes on one line is safe line-by-line, so it
// must NOT flag, or every one-liner in a crust file becomes "ambiguous".
const BASH_OPENERS: Record<string, RegExp> = {
  if: /\bfi\b/,
  for: /\bdone\b/,
  while: /\bdone\b/,
  case: /\besac\b/,
};

function sniffMultiLineShell(text: string): boolean {
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const first = t.split(/\s+/)[0]!;
    if (first in BASH_OPENERS) {
      if (!BASH_OPENERS[first]!.test(t)) return true;
    } else if (first === "do" || first === "done" || first === "fi" || first === "esac") {
      return true;
    }
  }
  return false;
}

// The `#!` first line, when it names a shell: `#!/bin/bash`,
// `#!/usr/bin/env bash`, `#!/bin/sh`… Non-shell shebangs (node, python)
// return null — a crust file may well carry none of the markers at all.
function shebangShell(text: string): string | null {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return null;
  const parts = first.slice(2).trimStart().split(/\s+/);
  const tok0 = parts[0] ?? "";
  const base0 = tok0.split("/").pop() ?? tok0;
  if (base0 === "env") {
    const base = (parts[1] ?? "").split("/").pop() ?? "";
    return /^(bash|zsh|dash|ksh|sh)$/.test(base) ? base : null;
  }
  return /^(bash|zsh|dash|ksh|sh)$/.test(base0) ? base0 : null;
}

// bash/zsh resolved by well-known paths — Bun.spawn THROWS on a missing
// executable, and source's contract is `source: …`, not a stack trace.
// `sh` itself is never resolved: it is the interpreter crust already runs
// every shell stage with.
async function resolveShellBin(wanted: string | null): Promise<string> {
  if (!wanted || wanted === "sh") return "sh";
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const p = `${dir}/${wanted}`;
    if (await Bun.file(p).exists()) return p;
  }
  return "sh";
}

// Wrap for a sh -c command string: single quotes, embedded ones escaped.
// The FILE itself is read from disk by the dot-source, so its contents keep
// their quoting — this only quotes the PATH, which argv parsing already
// unquoted, so it needs no further expansion.
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// The "whole file parses" gate for ambiguous shapes: every non-blank,
// non-comment line must survive the lexer (parse() — unbalanced stages and
// quotes throw) and, for shell lines, `sh -n` (noexec: nothing runs). This
// is what separates "runs fine line-by-line" from "would be mangled", so
// the ambiguous case can pick a path without ever running half a file.
async function crustFileParses(text: string): Promise<boolean> {
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue;
    const head = t.split(/\s+/)[0]!;
    // Builtin lines execute in-process, one line each — nothing spans lines
    // through them, so they can't be mangled line-by-line.
    if (isBuiltin(head)) continue;
    try {
      parse(t);
    } catch {
      return false;
    }
    if (classify(t).kind === "shell") {
      const problem = await shellSyntaxPreflight(tokenize(t));
      if (problem) return false;
    }
  }
  return true;
}

// Runs a marked shell script ONCE in a child shell and brings the exported
// environment back — the only thing a real `source` means across a process
// boundary. Honesty rules: the script executes for real (side effects are
// real), stdout/stderr are inherited, and the script's exit code is the
// line's code, so a failing source stops the chain exactly like runLines'
// fail-fast does.
//
// The child DOT-sources the path (`sh -c '. <path>'` — argv form, the file
// is read from disk, quoting survives) and then dumps its env NUL-separated
// via `env -0`, so values containing spaces or NEWLINES round-trip intact.
// The diff is against process.env: added/changed keys are applied, keys the
// script unset stay (crust never unsets on a source). A dump record without
// an `=` cannot be split — that is refused loudly, never truncated.
async function sourceShellScript(path: string, text: string): Promise<number> {
  const shebang = shebangShell(text);
  const wanted = shebang ?? (/\.(bash|zsh)$/.test(path) ? path.match(/\.([a-z]+)$/)![1] : null);
  const bin = await resolveShellBin(wanted);
  if (wanted && bin === "sh" && wanted !== "sh") {
    process.stderr.write(
      `source: ${path} asks for ${wanted}, but no ${wanted} was found — running with sh\n`,
    );
  }
  const dump = `${tmpdir()}/crust-source-${process.pid}-${Date.now()}`;
  try {
    // `;` separates the steps, never `&&`: a dot-source that is the left
    // operand of `&&` makes the shell IGNORE `set -e` inside the script, and
    // a set -e failure would sail through with exit 0. With `;`, a set -e or
    // `exit N` inside the script terminates the child with the script's own
    // code before the dump runs; otherwise the script's code lands in $ec
    // and is restored by the final `exit`, so the code we read is always the
    // script's, and a dump present at code 0 is the script's.
    const proc = Bun.spawn(
      [bin, "-c", `. ${shQuote(path)}; ec=$?; env -0 > ${shQuote(dump)}; exit $ec`],
      // Bun does not forward runtime process.env mutations to children unless
      // env is passed, so snapshot it — the script must see the session's env
      // (e.g. SB_OUT in the G06 tests), not a stale launch-time copy.
      { stdout: "inherit", stderr: "inherit", stdin: "ignore", env: { ...process.env } },
    );
    const code = (await proc.exited) ?? 1;
    if (code !== 0) return code;
    const raw = await Bun.file(dump).text();
    for (const record of raw.split("\0")) {
      if (record === "") continue;
      const eq = record.indexOf("=");
      if (eq <= 0) {
        // Undecidable: the record has no `=`, so its value cannot be told
        // from its key. Refuse the whole capture rather than guess.
        process.stderr.write(
          `source: ${path}: refusing env capture — the script left an environment record without an '=' (value: ${record.slice(0, 40)}); nothing was applied\n`,
        );
        return 1;
      }
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (process.env[key] !== value) process.env[key] = value;
    }
    return code;
  } finally {
    try {
      await Bun.file(dump).delete();
    } catch {
      // The child never created it (it died before the dump) — fine.
    }
  }
}

const sourceBuiltin: Builtin = async (rawArgs, ctx) => {
  // The spec is the rest of the line; the FIRST word is the file, the rest
  // are that file's positional arguments — `source deploy.crust prod` gives
  // the sourced file $0 = its path and $1 = prod, and the caller's
  // positionals are restored when the file ends.
  const words = splitArgs(rawArgs.trim());
  const path = words[0];
  if (!path) {
    process.stderr.write("source: missing file\n");
    return 1;
  }
  try {
    if (/\.(ts|js|mjs)$/.test(path)) {
      const resolved = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
      await import(resolved);
      return 0;
    }
    const text = await Bun.file(path).text();
    const { runLines } = await import("./runLine");
    const marked = /\.(sh|bash|zsh)$/.test(path) || shebangShell(text) !== null;
    if (marked) {
      return await withPositionals(path, words.slice(1), () => sourceShellScript(path, text));
    }
    if (sniffMultiLineShell(text) || !(await crustFileParses(text))) {
      // The shape says "multi-line shell" (or the file doesn't parse as
      // crust at all), but it carries no shell marker — running it either
      // way would be a guess, and a wrong guess runs HALF a file. Refuse
      // with both options named instead.
      process.stderr.write(
        `source: '${path}' is ambiguous — no .sh/.bash/.zsh extension, no shell shebang, and it does not parse as a crust file, ` +
          `so crust will not run it partially. Two options: name it as a shell script (e.g. '${path}.sh', or give it a #!/usr/bin/env bash shebang) ` +
          `to run it once as a bash script, or make every line parse as crust (keep each if/fi on one line) to run it line-by-line.\n`,
      );
      return 1;
    }
    // A crust file: line-by-line through the crust parser with the SHARED
    // ctx — aliases, exports, and captures persist in this session, which
    // is what `source` means.
    return await withPositionals(path, words.slice(1), async () => runLines(text, ctx));
  } catch (err) {
    process.stderr.write(`source: ${(err as Error).message}\n`);
    return 1;
  }
};

const exitBuiltin: Builtin = async (rawArgs, ctx) => {
  const parsed = parseInt(rawArgs.trim() || "0", 10);
  await ctx.exit(isNaN(parsed) ? 0 : parsed);
  return 0;
};

const historyBuiltin: Builtin = (_rawArgs, ctx) => {
  const width = Math.max(String(ctx.history.length).length, 1);
  for (let i = 0; i < ctx.history.length; i++) {
    const n = String(i + 1).padStart(width, " ");
    process.stdout.write(`${n}  ${ctx.history[i]}\n`);
  }
  return 0;
};

// ---- job control (G10) -----------------------------------------------------
// The table is src/jobs.ts and the Ctrl-Z bus is src/suspend.ts; these are the
// CLI halves. `&` itself is NOT here — it is a line shape, handled where the
// shell child is spawned (src/runLine.ts), because that is the only place that
// knows the line is one pure `sh -c`.

function noJob(spec: string): number {
  process.stderr.write(`crust: no job ${spec}\n`);
  return 1;
}

const jobsBuiltin: Builtin = async (rawArgs) => {
  // `jobs [-l] [%N…]`. An unrecognised word is REFUSED: `jobs` in every shell has
  // flags whose whole effect is what the listing shows, so ignoring `-x` would
  // hand back a listing that looks like the one the user asked for.
  const words = rawArgs.trim() ? splitArgs(rawArgs.trim()) : [];
  let long = false;
  const specs: string[] = [];
  for (const word of words) {
    if (word === "-l" || word === "--long") long = true;
    // The same operand shapes `fg`/`bg`/`wait` take — `%1`, `%`, `%+`, or a bare
    // job number — and NOT a pattern (`%?vim`) or a pid, which is sh's business.
    else if (/^%(\+|\d*)$/.test(word) || /^\d+$/.test(word)) specs.push(word);
    else {
      process.stderr.write(`crust: jobs: ${word} is not an option (jobs [-l] [%N])\n`);
      return 1;
    }
  }
  // A job that died a line ago must not still print `Running`.
  await settleJobs();
  const current = latestJob();
  let code = 0;
  const missing = specs.filter((spec) => getJob(spec) === null);
  for (const spec of missing) {
    process.stderr.write(`crust: no job ${spec}\n`);
    code = 1;
  }
  const chosen: Job[] =
    specs.length === 0
      ? listJobs()
      : specs.map((spec) => getJob(spec)).filter((j): j is Job => j !== null);
  for (const job of chosen) {
    process.stdout.write(`${formatJobLine(job, job === current, long)}\n`);
  }
  return code;
};

const fgBuiltin: Builtin = async (rawArgs) => {
  const spec = rawArgs.trim();
  const job = getJob(spec);
  if (!job) return noJob(spec || "%");
  return await waitJobForeground(job, true);
};

const bgBuiltin: Builtin = (rawArgs) => {
  const spec = rawArgs.trim();
  const job = getJob(spec);
  if (!job) return noJob(spec || "%");
  if (job.status !== "stopped") {
    process.stderr.write(`crust: job ${job.index} is not stopped\n`);
    return 1;
  }
  if (!contJob(job)) {
    process.stderr.write(`crust: job ${job.index} is already gone\n`);
    return 1;
  }
  // Print what it became, not just "ok": the line is the same one `jobs` shows,
  // so the user can see the job left `Stopped` rather than take that on faith.
  process.stdout.write(`${formatJobLine(job, job === currentJob())}\n`);
  return 0;
};

const helpBuiltin: Builtin = () => {
  process.stdout.write(renderBuiltinList());
  return 0;
};

const DOTENV_USAGE = `dotenv [<path>] [-a] | dotenv status | dotenv clear

  <path>            .env file to load (default: ./.env), or --config <path>
  -a, --append      keep values already set instead of overwriting
  status | list     show load history
  clear             restore the pre-first-load snapshot
`;

export const DOTENV_SPEC: FlagSpec = {
  config: { type: "string", positional: 0 },
  append: { short: "a", type: "boolean" },
};

const dotenvBuiltin: Builtin = async (rawArgs, ctx) => {
  const parts = splitArgs(rawArgs.trim());
  if (parts[0] === "status" || parts[0] === "list" || parts[0] === "clear") {
    // Subcommands take nothing. Trailing junk used to be silently ignored,
    // which made `dotenv status --nonsense` look like it did something.
    if (parts.length > 1) {
      process.stderr.write(`dotenv: unexpected argument "${parts[1]}"\n${DOTENV_USAGE}`);
      return 2;
    }
    return parts[0] === "clear" ? dotenvClear(ctx) : dotenvStatus(ctx);
  }

  try {
    const { values, rest, help } = parseFlags(parts, DOTENV_SPEC);
    if (help) {
      process.stdout.write(DOTENV_USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);
    const configPath = (values.config as string | undefined) ?? "./.env";
    return dotenvLoad(ctx, configPath, values.append === true ? "append" : "overwrite");
  } catch (err) {
    process.stderr.write(`dotenv: ${(err as Error).message}\n${DOTENV_USAGE}`);
    return 2;
  }
};

// Exported for the top-level --env-file flag (src/index.ts), which reuses
// this loader verbatim — one dotenv implementation, two entry points. The
// flag passes a stderr writer so the "loaded" note never pollutes a -c
// pipeline's stdout.
export async function dotenvLoad(
  ctx: Context,
  path: string,
  mode: "overwrite" | "append",
  log: (s: string) => void = (s) => void process.stdout.write(s),
): Promise<number> {
  const abs = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    process.stderr.write(`dotenv: ${abs}: not found\n`);
    return 1;
  }
  const text = await file.text();
  const pairs = parseDotenv(text);
  if (ctx.dotenv.snapshot === null) {
    ctx.dotenv.snapshot = { ...process.env };
  }
  const written: string[] = [];
  for (const [k, v] of pairs) {
    if (mode === "append" && process.env[k] !== undefined) continue;
    process.env[k] = v;
    written.push(k);
  }
  ctx.dotenv.history.push({ path: abs, mode, ts: Date.now(), keys: written });
  log(`dotenv: loaded ${written.length} var(s) from ${abs} (${mode})\n`);
  return 0;
}

function dotenvStatus(ctx: Context): number {
  if (ctx.dotenv.history.length === 0) {
    process.stdout.write("dotenv: no loads\n");
    return 0;
  }
  const totalKeys = new Set(ctx.dotenv.history.flatMap((r) => r.keys)).size;
  process.stdout.write(
    `dotenv: ${ctx.dotenv.history.length} load(s), ${totalKeys} unique var(s) touched\n`,
  );
  const idxWidth = String(ctx.dotenv.history.length).length;
  for (let i = 0; i < ctx.dotenv.history.length; i++) {
    const r = ctx.dotenv.history[i]!;
    const idx = String(i + 1).padStart(idxWidth, " ");
    const iso = new Date(r.ts).toISOString();
    const shown = r.keys.slice(0, 6).join(", ");
    const more = r.keys.length > 6 ? `, +${r.keys.length - 6} more` : "";
    const keyList = r.keys.length === 0 ? "(no vars)" : `(${r.keys.length} vars: ${shown}${more})`;
    process.stdout.write(`  ${idx}  ${iso}  ${r.mode.padEnd(9)}  ${r.path}  ${keyList}\n`);
  }
  return 0;
}

function dotenvClear(ctx: Context): number {
  if (ctx.dotenv.snapshot === null) {
    process.stdout.write("dotenv: nothing to clear\n");
    return 0;
  }
  const snap = ctx.dotenv.snapshot;
  for (const k of Object.keys(process.env)) {
    if (!(k in snap)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  ctx.dotenv.snapshot = null;
  ctx.dotenv.history = [];
  process.stdout.write("dotenv: cleared\n");
  return 0;
}

function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const quoted =
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2);
    if (!quoted) {
      const hash = val.indexOf(" #");
      if (hash !== -1) val = val.slice(0, hash).trimEnd();
    } else {
      val = val.slice(1, -1);
    }
    out.push([key, val]);
  }
  return out;
}

// One runner per tool, taking the argument ARRAY. The builtin wrapper feeds it
// `splitArgs(rawArgs)` exactly as before; `standaloneTools` below feeds it real
// argv. Both paths land in the same function, so `crust -c 'mock-server x'` and
// `crust mock-server x` cannot drift apart.
//
// In-process like every other tool builtin. A standalone AOT runner
// (~/.crust/bin/crust-test-fixture) used to be probed here, but no install
// route ever put a file at that path, and measurement showed the exec path
// 1.6x SLOWER than this import once the main binary itself was
// bytecode-compiled — the probe's only real effect was letting a stale
// binary silently shadow the current runner.
const runTestFixtureTool = async (argv: string[]): Promise<number> => {
  const { runCli } = await import("./testFixture/cli");
  return await runCli(argv.map(expandEnv));
};

const testFixtureBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runTestFixtureTool(splitArgs(rawArgs));

const runTestPipesTool = async (argv: string[]): Promise<number> => {
  const { runCli } = await import("./testPipes/cli");
  return await runCli(argv.map(expandEnv));
};

const testPipesBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runTestPipesTool(splitArgs(rawArgs));

const runGenFixturesTool = async (argv: string[]): Promise<number> => {
  const { runCli } = await import("./genFixtures/cli");
  return await runCli(argv.map(expandEnv));
};

const genFixturesBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runGenFixturesTool(splitArgs(rawArgs));

const runMockServerTool = async (argv: string[]): Promise<number> => {
  const { runCli } = await import("./mockServer/cli");
  return await runCli(argv.map(expandEnv));
};

const mockServerBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runMockServerTool(splitArgs(rawArgs));

const runVerifyWebLinksTool = async (argv: string[]): Promise<number> => {
  const { runCli } = await import("./verifyWebLinks/cli");
  return await runCli(argv.map(expandEnv));
};

const verifyWebLinksBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runVerifyWebLinksTool(splitArgs(rawArgs));

// No expandEnv here, and that is the runtime's existing behaviour for `skills`:
// a skill name is never a variable. Keep it that way — `skills install
// '$FOO'` should fail as an unknown skill, not install something by expansion.
const runSkillsTool = async (argv: string[]): Promise<number> => {
  const { runSkills } = await import("./skillsCli");
  return await runSkills(argv);
};

const skillsBuiltin: Builtin = async (rawArgs, _ctx) =>
  await runSkillsTool(splitArgs(rawArgs.trim()));

const logsBuiltin: Builtin = async (rawArgs, ctx) => {
  // rawArgs stays UNSPLIT — the source spec is the rest of the line verbatim
  // (splitArgs would mangle procs({...}) literals and quoted commands).
  const { runLogs } = await import("./logs/cli");
  return await runLogs(rawArgs, ctx);
};

export const builtins: Record<string, Builtin> = {
  skills: skillsBuiltin,
  cd: cdBuiltin,
  export: exportBuiltin,
  alias: aliasBuiltin,
  unalias: unaliasBuiltin,
  source: sourceBuiltin,
  exit: exitBuiltin,
  history: historyBuiltin,
  jobs: jobsBuiltin,
  fg: fgBuiltin,
  bg: bgBuiltin,
  help: helpBuiltin,
  dotenv: dotenvBuiltin,
  "test-fixture": testFixtureBuiltin,
  "test-pipes": testPipesBuiltin,
  "gen-fixtures": genFixturesBuiltin,
  "mock-server": mockServerBuiltin,
  "verify-web-links": verifyWebLinksBuiltin,
  logs: logsBuiltin,
};

/**
 * The tool builtins that ALSO mean something as a one-shot command, so
 * `crust skills install` works from a shell instead of only at the REPL.
 *
 * WHY. Every positional was read as a script path, so the verbs the docs and
 * the published README lead with were unreachable: `crust skills install` died
 * with `script arguments are not supported` (exit 2) and a bare
 * `crust verify-web-links` with `cannot read verify-web-links` (exit 127) — a
 * code that reads as "the binary is not installed" when the binary was running
 * the whole time.
 *
 * The session builtins (`cd`, `export`, `alias`, `source`, `history`, `exit`,
 * `help`, `dotenv`) are deliberately absent: a one-shot process has no session
 * to mutate, so each would be a silent no-op, which is worse than the error it
 * replaces. `logs` is absent too — its source spec is the REST OF THE LINE
 * VERBATIM (a `procs({...})` literal, a quoted command) and argv cannot carry
 * that without re-lexing it.
 */
export const standaloneTools: Record<string, (argv: string[]) => Promise<number>> = {
  skills: runSkillsTool,
  "test-fixture": runTestFixtureTool,
  "test-pipes": runTestPipesTool,
  "gen-fixtures": runGenFixturesTool,
  "mock-server": runMockServerTool,
  "verify-web-links": runVerifyWebLinksTool,
};

/** A word that names a tool, whether or not it is reachable as a command. Used
 *  to decide when a "this is not an executable" complaint is really a misuse
 *  and has to say so. */
export function isStandaloneToolName(name: string): boolean {
  return Object.hasOwn(standaloneTools, name);
}

/** Why naming a builtin at argv[0] is refused rather than run — and why the
 *  answer is not "no such file". `null` for the tools that DO run this way.
 *
 *  Falling through to script mode produced `cannot read export` (exit 127) or
 *  `script arguments are not supported — got "/tmp"` (exit 2): both read as a
 *  broken installation, in a binary that prints its own name. A one-shot
 *  process has no session for `cd`/`export`/`alias` to change, and `logs` takes
 *  the rest of its line verbatim (a `procs({...})` literal), which argv cannot
 *  carry without re-lexing it. */
export function notACommandReason(name: string): string | null {
  if (isStandaloneToolName(name)) return null;
  if (!isBuiltin(name)) return null;
  if (name === "logs") {
    return "`logs` takes the rest of its line verbatim — a `procs({...})` spec argv cannot carry. Run it at the `crust` prompt.";
  }
  if (name === "help") {
    return "`help` describes a running crust session. From a shell, `crust --help` lists the builtins and the tool commands.";
  }
  return `\`${name}\` is a builtin of a running crust session — a one-shot command has no session for it to change. Run it at the \`crust\` prompt instead.`;
}

// Keyed by registry name so `help` and `crust -h` can't drift from what is
// actually registered; renderBuiltinList shows an undescribed builtin with an
// empty summary rather than hiding it.
const builtinSummaries: Record<string, string> = {
  skills: "list/run installed crust skills",
  cd: "change directory (cd -, cd ~)",
  export: "set an environment variable",
  alias: "define or list command aliases",
  unalias: "remove a command alias",
  source: "run a .crust script in this session",
  exit: "leave the REPL",
  history: "print numbered command history",
  jobs: "list jobs — see also `cmd &`, fg/bg/wait/kill %N",
  fg: "wait for a job in the foreground (fg %1) — its exit code is the line's",
  bg: "resume a stopped job in the background (bg %1)",
  help: "show this builtin list",
  dotenv: "load .env into the session (status/clear/--append)",
  "test-fixture": "run .crust.ts fixture files against a server",
  "test-pipes": "run shorthand pipe fixtures from a file",
  "gen-fixtures": "generate fixture suites from an OpenAPI spec",
  "mock-server": "serve an OpenAPI spec's examples (optionally --stateful)",
  "verify-web-links": "crawl a site from its sitemap and verify every link",
  logs: "interactive search over a held live log stream",
};

export function renderBuiltinList(): string {
  const names = Object.keys(builtins).sort();
  const width = Math.max(...names.map((n) => n.length));
  const lines = names.map((n) => `  ${n.padEnd(width)}  ${builtinSummaries[n] ?? ""}`);
  return `builtins (run "<builtin> --help" for details):\n${lines.join("\n")}\n`;
}

export function isBuiltin(name: string): boolean {
  return name in builtins;
}

/**
 * The builtins crust implements as SHELL words — sh has its own version of each,
 * so `source .env > /dev/null` is a line where the redirect means what sh says
 * it means. The tools (`mock-server`, `test-fixture`, `logs`…) have no shell
 * counterpart, so a redirect on one of those can only be a mistake: it used to
 * reach sh and answer `mock-server: command not found`.
 */
const SHELL_WORD_BUILTINS = new Set([
  "cd",
  "export",
  "alias",
  "unalias",
  "source",
  "exit",
  "history",
  "help",
]);

export function isToolBuiltin(name: string): boolean {
  return isBuiltin(name) && !SHELL_WORD_BUILTINS.has(name);
}

/**
 * The stage head that would reach `sh -c` — a whole shell line, or one stage of
 * a mixed pipeline. A TOOL builtin landing there is a mistake crust used to let
 * sh report: `sh: line 1: mock-server: command not found`, exit 127, a message
 * that says the tool is missing when crust has it in-process. Naming the
 * builtin is the whole fix — the tools run in-process, so no shell operator can
 * wrap them. `Bun.which` keeps a user's real binary by one of these names theirs.
 */
export function builtinInShellRefusal(stageText: string): string | null {
  const text = stageText.trimStart();
  if (!text) return null;
  const sp = text.search(/\s/);
  const head = sp === -1 ? text : text.slice(0, sp);
  // `crust mcp` is a MODE the shell spawns, not a builtin a session runs —
  // sh's `command not found` (127) here would read as a broken installation.
  if (head === "mcp" && !Bun.which(head)) {
    return (
      "mcp is crust's Model Context Protocol server — start it from a shell " +
      "(`crust mcp`); it owns stdin/stdout, so it cannot run inside a session."
    );
  }
  if (!isToolBuiltin(head) || Bun.which(head)) return null;
  const where = head === "logs" ? " A `logs` session takes its filters at the `logs>` prompt." : "";
  return (
    `${head} is a crust builtin — it runs in-process, so sh cannot run it. ` +
    `Give it a line of its own.${where}`
  );
}
