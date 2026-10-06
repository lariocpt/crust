// Every crust example in the shipped docs must parse against the live grammar.
//
// AGENTS.md: "never document behavior you haven't run through `bun src/index.ts
// -c`" — and this repo once advertised a load pipeline that didn't parse.
// tests/skills.test.ts already enforces that for the embedded agent skills;
// this extends the same guarantee to docs/USAGE.md and README.md, which are the
// copies a user actually reads.
//
// Lines are parsed, never drained: building a pipeline opens no file and spawns
// nothing, so an example referencing fixtures/*.json or :3000 checks clean here.
import { describe, expect, test } from "bun:test";
import { splitArgs } from "../src/args";
import { registerBuiltinFns } from "../src/builtinFns";
import { isBuiltin } from "../src/builtins";
import { checkBuiltinLine } from "../src/checkBuiltin";
import { classify, tokenize } from "../src/lexer";
import { parse } from "../src/parser";
import type { Context } from "../src/types";

interface OpenState {
  q: string | null;
  depth: number;
}

// Strip an UNQUOTED, top-level `#` comment and report whether the line leaves
// quotes or brackets open (so `procs({` and a multi-line `-c '…'` are joined
// with their continuation rather than parsed as fragments). crust itself has no
// inline-comment syntax, so trailing `#` text in a doc block is prose.
export function scanLine(line: string, open: OpenState): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (open.q) {
      out += c;
      if (open.q === '"' && c === "\\" && i + 1 < line.length) {
        out += line[++i]!;
        continue;
      }
      if (c === open.q) open.q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      open.q = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      open.depth++;
      out += c;
      continue;
    }
    if (c === ")" || c === "}" || c === "]") {
      open.depth--;
      out += c;
      continue;
    }
    if (c === "#" && open.depth === 0) break;
    out += c;
  }
  return out;
}

/**
 * The one thing `parse()` cannot see: a stage that falls through to `shell` is
 * opaque to crust's grammar, so ask sh in NOEXEC mode. `-n` parses and reports
 * syntax errors without executing anything (verified while adding it to
 * `--check`: `cat > f` under `-n` does not create `f`, `echo $(cmd)` does not
 * run `cmd`). This is the same scan `crust --check` runs (src/index.ts:194-208)
 * and the website's linter inherits it by shelling out to the binary — without
 * it here, flushing a truncated example would only *count* it.
 *
 * Builtin heads must stay on the flag-spec path above instead: sh rejects
 * `logs procs({web: "echo hi"})` while crust's builtin holds that stream fine
 * (measured — `--check` rc 0, and it runs in a pty). Four such lines are
 * documented on purpose.
 */
export async function shStageProblem(stageText: string): Promise<string | null> {
  const proc = Bun.spawn(["sh", "-n", "-c", stageText], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if ((proc.exitCode ?? 0) === 0) return null;
  return err.trim().split("\n")[0] || "syntax error";
}

function crustLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const m of markdown.matchAll(/```(?:bash|crust)\n([\s\S]*?)```/g)) {
    const body = m[1]!;
    // Heredocs are shell payloads, not crust lines.
    if (body.includes("<<")) continue;
    const open: OpenState = { q: null, depth: 0 };
    let buf = "";
    for (const raw of body.replace(/\\\n\s*/g, " ").split("\n")) {
      const trimmed = raw.trim();
      if (!buf && (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("$"))) continue;
      buf += (buf ? " " : "") + scanLine(raw, open).trim();
      if (open.q || open.depth > 0) continue;
      const line = buf.trim();
      buf = "";
      // A synopsis is documentation shape, not a command: `test-fixture <glob>
      // [-j N]`. `<word>` and `[-flag]` are unambiguous placeholder syntax,
      // and neither appears in a real crust line.
      if (line && !/<[a-z][a-z|_-]*>|\[-{1,2}[a-z]/i.test(line)) lines.push(line);
    }
    // A buffer still open at the end of the fence is not a formatting quirk to
    // forgive: it is an example whose brackets never close, which is what a
    // truncated example looks like and what crust rejects at run time. It used
    // to be discarded here — unchecked and uncounted — so the lint could not
    // fail on it at all. Found by mutating this scanner's copy in crust-website,
    // where `range(1,` in a fresh fence printed "0 failed".
    if (buf.trim()) lines.push(buf.trim());
  }
  return lines;
}

const ctx = (): Context => {
  const c = { aliases: new Map(), functions: new Map(), history: [] } as unknown as Context;
  registerBuiltinFns(c);
  return c;
};

/**
 * The lint proper, over extracted lines: mirrors what `crust --check` decides
 * for each line, in-process, and returns the ones it rejects. Exported so the
 * gate itself can be tested — a check that is only ever run over content that
 * passes has no proven teeth (this file's own flush and shell-stage scan were
 * both invisible until mutated).
 */
export async function brokenExamples(lines: string[]): Promise<string[]> {
  const c = ctx();
  const broken: string[] = [];
  for (const line of lines) {
    // A builtin line is not a pipeline: the parser treats it as an opaque
    // shell stage and calls anything valid, which is how stale invocations
    // survived a green suite. Check it against the CLI's own flag spec.
    const head = line.split(/\s+/)[0] ?? "";
    if (isBuiltin(head)) {
      const problem = await checkBuiltinLine(head, splitArgs(line.slice(head.length).trim()));
      if (problem) broken.push(`${line}\n    ${problem}`);
      continue;
    }
    try {
      parse(line)(c);
    } catch (err) {
      broken.push(`${line}\n    ${(err as Error).message}`);
      continue;
    }
    // parse() proved crust's own grammar. A stage that fell through to `shell`
    // is opaque to it — that text is only ever read by sh — so ask sh, exactly
    // as `crust --check` does. Without this the flush in crustLines only makes a
    // truncated example *count*: `range(1,` classifies as shell (src/index.ts:
    // 184-193), so parse() calls it fine and only sh knows it is not a line.
    for (const t of tokenize(line)) {
      if (t.text === "" || classify(t.text).kind !== "shell") continue;
      const problem = await shStageProblem(t.text);
      if (problem) broken.push(`${line}\n    shell stage does not parse: ${problem}`);
    }
  }
  return broken;
}

describe("documented examples parse", () => {
  // The minimum is a canary: if a refactor of this scanner silently stops
  // finding examples, the test would otherwise pass by checking nothing.
  test.each([
    ["docs/USAGE.md", 100],
    ["README.md", 20],
    // The npm package page. It ships to npmjs.org byte-for-byte from release.yml
    // and was linted by nothing at all — a broken example there passed every gate
    // and reached every installer. Its examples are bare pipeline lines precisely
    // so this check is meaningful: a `crust -c '…'` wrapper would parse as an
    // opaque shell stage and the pipeline inside it would go unchecked.
    ["npm/README.md", 12],
    // The shipped agent skills are documentation too — they are embedded in the
    // binary and are what coding agents read to drive crust.
    ["skills/crust-pipelines/SKILL.md", 8],
    ["skills/crust-api-testing/SKILL.md", 5],
    ["skills/crust-load-testing/SKILL.md", 5],
    ["skills/crust-mock-server/SKILL.md", 3],
    ["skills/crust-procs/SKILL.md", 3],
    ["skills/crust-logs/SKILL.md", 4],
    ["skills/crust-verify-web-links/SKILL.md", 8],
    ["skills/crust-builtins/SKILL.md", 12],
    ["skills/crust-cli/SKILL.md", 8],
  ])("%s", async (rel, minLines) => {
    const text = await Bun.file(`${import.meta.dir}/../${rel}`).text();
    const lines = crustLines(text);
    expect(lines.length).toBeGreaterThanOrEqual(minLines);

    expect((await brokenExamples(lines)).join("\n")).toBe("");
  });
});

describe("the lint can actually fail", () => {
  test("a stale example is caught", () => {
    const c = ctx();
    // `time` without quotes around its label — the exact shape that used to
    // slip through and surface as a confusing downstream error.
    expect(() => parse("time warmup | range(1,3)")(c)).toThrow(/label must be quoted/);
    expect(() => parse("range(0,3) | parallel 2 | expect 200")(c)).toThrow(/only applies to/);
  });

  test("a truncated example is checked, not dropped", () => {
    // An unclosed bracket holds the join buffer open, and at the end of the
    // fence the buffer used to be discarded — so `range(1,`, the exact shape of
    // a truncated doc example, was never linted and never even counted. Proven
    // on this scanner's copy in crust-website: appending that one fence printed
    // "304 crust example(s) checked, 0 failed" (`b024fb9` closed it there).
    expect(crustLines("```bash\nrange(1,\n```")).toEqual(["range(1,"]);
    // A real multi-line example still joins to one line, and still only that.
    expect(crustLines("```bash\ncrust -c 'procs({\n  web: \"dev\",\n})'\n```")).toEqual([
      `crust -c 'procs({ web: "dev", })'`,
    ]);
  });

  test("sh sees the syntax `parse()` cannot, in NOEXEC mode", async () => {
    // A stage that falls through to `shell` is opaque to crust's grammar, so
    // parse() calls anything ok. `crust --check` asks sh with `-n`; the docs
    // lint must too, or flushing the buffer above only counts the mistake.
    // `-n` parses and reports without executing (see src/index.ts:184-193).
    expect(await shStageProblem("range(1,")).toMatch(/syntax error/);
    expect(await shStageProblem("ls -1 *.json | wc -l")).toBeNull();
    // A builtin head must never be handed to sh, and this is why: sh rejects the
    // whole line, while crust dispatches `logs` before parsing and holds that
    // expression as the stream (`--check` rc 0; runs in a pty). parse() alone
    // refuses it — F16's refusal — because on its own it would be a shell stage.
    expect(isBuiltin("logs")).toBe(true);
    expect(await shStageProblem(`logs procs({web: "echo hi"})`)).toMatch(/syntax error/);
  });

  test("the gate rejects a truncated example end to end", async () => {
    // Through the same function the docs test runs, so both halves are proven:
    // the flush makes `range(1,` count, the shell scan makes it fail. Neither
    // half alone is enough — dropping either leaves this red.
    const broken = await brokenExamples(crustLines("```bash\nrange(1,\n```"));
    expect(broken.join("\n")).toMatch(/shell stage does not parse/);
    // And the false-positive guard: `(` inside a builtin line is the flag-spec
    // path, not sh. Four such lines are documented on purpose.
    expect(await brokenExamples([`logs procs({web: "bun run dev", api: "bun api.ts"})`])).toEqual(
      [],
    );
  });

  test("inline prose comments are stripped, not parsed", () => {
    const open: OpenState = { q: null, depth: 0 };
    expect(scanLine("range(0, 9)   # 0..9 inclusive", open).trim()).toBe("range(0, 9)");
  });

  test("a `#` inside quotes survives", () => {
    const open: OpenState = { q: null, depth: 0 };
    expect(scanLine(`grep "#tag"`, open).trim()).toBe(`grep "#tag"`);
  });

  test("a wrong BUILTIN invocation is caught, not waved through", async () => {
    // The parser classifies these as opaque shell stages and calls them fine,
    // which is exactly how stale flags survived in the docs and the skills.
    expect(await checkBuiltinLine("test-pipes", ["--bogus", "x"])).toMatch(/unknown argument/);
    expect(await checkBuiltinLine("mock-server", [])).toMatch(/missing its swagger/);
    expect(await checkBuiltinLine("test-fixture", [])).toMatch(/missing its target/);
    expect(await checkBuiltinLine("verify-web-links", [])).toMatch(/missing its target/);
    expect(await checkBuiltinLine("gen-fixtures", ["--swagger"])).toMatch(/needs a value/);
  });

  test("a correct builtin invocation passes, in both the new and legacy spellings", async () => {
    expect(await checkBuiltinLine("test-pipes", ["smoke.pipes", "-b"])).toBeNull();
    expect(await checkBuiltinLine("test-pipes", ["--target", "smoke.pipes", "--bail"])).toBeNull();
    expect(await checkBuiltinLine("gen-fixtures", ["./openapi.json"])).toBeNull();
    expect(await checkBuiltinLine("dotenv", ["status"])).toBeNull();
    // Builtins with no declarative spec are skipped rather than guessed at.
    expect(await checkBuiltinLine("cd", ["/tmp"])).toBeNull();
  });
});
