import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, rmSync } from "node:fs";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(
  args: string[],
  stdin?: string,
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: opts.cwd,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-cli-test-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("crust CLI", () => {
  test("--version prints version, exit 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+/);
  });

  test("--help prints usage, exit 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage:");
    expect(r.stdout).toContain("-c");
  });

  test("--help lists the builtins", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("builtins");
    expect(r.stdout).toContain("verify-web-links");
    expect(r.stdout).toContain("mock-server");
    expect(r.stdout).toContain("test-fixture");
  });

  test("-c with no arg errors and exits 2", async () => {
    const r = await runCli(["-c"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("-c");
  });

  test("unsupported argument exits 2", async () => {
    const r = await runCli(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unsupported");
  });

  test("-c '' exits 0 with no output", async () => {
    const r = await runCli(["-c", ""]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("-c runs a range pipeline", async () => {
    const r = await runCli(["-c", "range(0,2)"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0\n1\n2\n");
  });

  test("-c runs a range + lambda pipeline", async () => {
    const r = await runCli(["-c", "range(0,2) | (n => n*10)"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0\n10\n20\n");
  });

  test("-c 'exit 7' exits 7", async () => {
    const r = await runCli(["-c", "exit 7"]);
    expect(r.code).toBe(7);
  });

  test("-c propagates shell exit code", async () => {
    const r = await runCli(["-c", "false"]);
    expect(r.code).not.toBe(0);
  });

  test("-c with multiple lines exits with last line status", async () => {
    const r = await runCli(["-c", "true\nexit 4"]);
    expect(r.code).toBe(4);
  });

  test("-c skips # comments and runs filter stages", async () => {
    const r = await runCli(["-c", "# a comment\nrange(1,6) | filter (n => n % 2 === 0)"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\n4\n6\n");
  });

  test("-c 'tail <path>' streams the last N lines through the pipeline", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-tail-"));
    try {
      const log = join(dir, "app.log");
      await writeFile(log, "INFO ok\nERROR boom\nINFO ok\nERROR oops\n");
      const r = await runCli(["-c", `tail -n 100 ${log} | grep ERROR`]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("ERROR boom\nERROR oops\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("-c 'tail logs/*.log' glob-expands across multiple files", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-multitail-"));
    try {
      await writeFile(join(dir, "alpha.log"), "A1\nA2\n");
      await writeFile(join(dir, "beta.log"), "B1\nB2\n");
      const r = await runCli(["-c", `tail -n 100 ${dir}/*.log | grep -E "A|B"`]);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(new Set(lines)).toEqual(new Set(["A1", "A2", "B1", "B2"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("-c 'tail a.log b.log' tails multiple files explicitly", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "crust-cli-multitail-explicit-"));
    try {
      const a = join(dir, "a.log");
      const b = join(dir, "b.log");
      await writeFile(a, "X1\nX2\n");
      await writeFile(b, "Y1\nY2\n");
      const r = await runCli(["-c", `tail -n 100 ${a} ${b}`]);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      expect(new Set(lines)).toEqual(new Set(["X1", "X2", "Y1", "Y2"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("script files and piped stdin", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "crust-cli-script-"));
  const script = join(dir, "demo.crust");
  writeFileSync(
    script,
    "#!/usr/bin/env crust\n# comment line\n\nrange(1,6) | filter (n => n % 2 === 0)\necho done\n",
  );
  const failing = join(dir, "failing.crust");
  writeFileSync(failing, "true\nexit 4\necho never\n");
  const session = join(dir, "session.crust");
  writeFileSync(session, "export CRUST_SRC_TEST=hello\n");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs a script file: shebang and comments skipped, fail-fast exit 0", async () => {
    const r = await runCli([script]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\n4\n6\ndone\n");
  });

  test("script fail-fast: exits with the failing line's code, later lines skipped", async () => {
    const r = await runCli([failing]);
    expect(r.code).toBe(4);
    expect(r.stdout).not.toContain("never");
  });

  test("nonexistent script exits 127 naming the path", async () => {
    const r = await runCli([join(dir, "nope.crust")]);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("nope.crust");
  });

  test("script arguments are rejected with exit 2", async () => {
    const r = await runCli([script, "prod"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not supported");
  });

  test("piped stdin runs lines and exits 0 — no prompt bytes on stdout", async () => {
    const r = await runCli([], "range(1,3) | filter (n => n > 1)\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\n3\n");
  });

  test("piped stdin fail-fast propagates the exit code", async () => {
    const r = await runCli([], "false\necho never\n");
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("never");
  });

  test("empty piped stdin exits 0 with no output — the cron/CI case", async () => {
    const r = await runCli([], "");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("source runs a .crust file in the shared session", async () => {
    const r = await runCli(["-c", `source ${session}\necho $CRUST_SRC_TEST`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello\n");
  });
});

test("items larger than the pipe buffer are not truncated on exit", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "crust-flush-"));
  try {
    const big = join(dir, "one-line.txt");
    await Bun.write(big, "x".repeat(1_000_000)); // single line, no newline
    const r = await runCli(["-c", `read ${big}`]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(1_000_001); // content + trailing \n
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("--env-file", () => {
  const { mkdtemp, rm, writeFile } =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  test("loads vars before the line runs; the loaded note goes to stderr, not stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-envfile-"));
    try {
      const envPath = join(dir, ".env.test");
      await writeFile(envPath, "SMOKE_VAR=from-env-file\n# comment\nOTHER=2\n");
      const r = await runCli(["--env-file", envPath, "-c", "echo $SMOKE_VAR"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("from-env-file");
      expect(r.stdout).not.toContain("dotenv:");
      expect(r.stderr).toContain("dotenv: loaded 2 var(s)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--env-file=<path> form works too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-envfile-"));
    try {
      const envPath = join(dir, ".env");
      await writeFile(envPath, "EQ_FORM=yes\n");
      const r = await runCli([`--env-file=${envPath}`, "-c", "echo $EQ_FORM"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("yes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing file exits 2 loudly — never a silent no-op", async () => {
    const r = await runCli(["--env-file", "/definitely/not/here.env", "-c", "echo hi"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not found");
    expect(r.stdout).not.toContain("hi");
  });

  test("a missing path argument exits 2", async () => {
    const r = await runCli(["--env-file"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--env-file requires a path");
  });

  test("refuses to combine with --check (parse-only contract)", async () => {
    const r = await runCli(["--env-file", "/tmp/x.env", "--check", "range(1,2)"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("does not combine with --check");
  });
});

describe("trailing # comments on builtin lines", () => {
  // Shell stages always tolerated `# comments` (sh strips them); builtin lines
  // handed the "#" to parseFlags as an unexpected argument. Now both accept them.
  test("-c builtin line with a trailing comment parses past the #", async () => {
    const r = await runCli(["-c", "test-fixture /nonexistent-crust-e2e/*.crust.ts # matrix"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no files matched");
    expect(r.stderr).not.toContain('"#"');
  });

  test("--check accepts a commented builtin line and still rejects bogus flags", async () => {
    const ok = await runCli(["--check", "test-fixture t.crust.ts -j8 # concurrency matrix"]);
    expect(ok.code).toBe(0);
    const bad = await runCli(["--check", "test-fixture t.crust.ts --bogus x # comment"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--bogus");
  });

  test("a quoted # is an argument, not a comment", async () => {
    const r = await runCli(["--check", 'test-fixture "fixtures/t #1.crust.ts"']);
    expect(r.code).toBe(0);
  });

  test("dotenv status: comment stripped, real junk rejected", async () => {
    const ok = await runCli(["-c", "dotenv status # note"]);
    expect(ok.code).toBe(0);
    const bad = await runCli(["-c", "dotenv status --nonsense"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unexpected argument "--nonsense"');
    const check = await runCli(["--check", "dotenv status --nonsense"]);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('unexpected argument "--nonsense"');
  });
});

describe("registered fn --help (F42)", () => {
  // The six registered fns had no flag parsing at all: `sql --help` reported
  // a SQL-syntax complaint (rc 1) and `base64 --help` on 0.2.4 ENCODED the
  // flag (`LS1oZWxw`, rc 0 — a false pass for a request for help). They now
  // answer at parse time: usage on stdout, exit 0, no connection, no stage
  // run — the same contract the tool builtins have had through parseFlags.

  test("base64 --help: usage on stdout, nothing on stderr, exit 0", async () => {
    const r = await runCli(["-c", "base64 --help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: base64");
    expect(r.stderr).toBe("");
  });

  test("sql --help answers with no database configured", async () => {
    const proc = Bun.spawn(["bun", ENTRY, "-c", "sql --help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CRUST_CONFIG: "/dev/null",
        CRUST_GLOBAL_PREFIX: "/tmp/crust-cli-test-no-globals",
        DATABASE_URL: "",
      },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: sql");
    expect(stderr).toBe("");
  });

  test("a --help piped in is still encoded — the item is never in an option slot", async () => {
    const r = await runCli(["-c", "stdin | base64"], "--help");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("LS1oZWxw");
  });

  test("--help after -- is encoded, not answered as usage", async () => {
    const r = await runCli(["-c", "base64 -- --help"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("LS1oZWxw");
  });

  test("--check accepts fn --help: it is a valid line, answered when it runs", async () => {
    const r = await runCli(["--check", "sql --help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok:");
  });

  test("the help line runs no stage: an upstream touch never happens", async () => {
    const marker = `${import.meta.dir}/f42-marker-${process.pid}`;
    const r = await runCli(["-c", `touch ${marker} | sql --help`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: sql");
    expect(existsSync(marker)).toBe(false); // never created (size can't tell: touch makes a 0-byte file)
  });
});

describe("shell syntax preflight on the exec path (F19)", () => {
  // A MIXED line runs each shell stage as its own `sh -c` child. Without a
  // preflight a syntax error in stage N surfaces only when that child exits —
  // after stages 1..N-1 have run (measured on tree 2ca3952:
  // `touch f | base64 | head -(` exited 2 and f existed). The preflight asks
  // sh in NOEXEC mode about every shell stage before anything runs: exit 2,
  // the stage named, zero side effects. A pure-shell line is one `sh -c` that
  // parses the whole line first, so it is untouched (sh's own stderr is the
  // answer), and 127 is a runtime error the preflight must not swallow.
  test("a bad stage in a mixed line exits 2, named, and runs nothing", async () => {
    const marker = `${import.meta.dir}/f19-marker-${process.pid}`;
    const r = await runCli(["-c", `touch ${marker} | base64 | head -(`]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("crust: shell stage does not parse");
    expect(r.stderr).toContain("(stage: head -()");
    expect(existsSync(marker)).toBe(false); // never created (size can't tell: touch makes a 0-byte file)
  });

  test("the control: a valid mixed line with the same shape still runs", async () => {
    const marker = `${import.meta.dir}/f19-control-${process.pid}`;
    const r = await runCli(["-c", `touch ${marker} | base64`]);
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
  });

  // Assert what crust controls, never how a shell words its complaints. crust
  // runs whatever `/bin/sh` is, and the two dialects in play do not agree:
  //   dash  (the CI runner)  `sh: 1: Syntax error: "(" unexpected`
  //   bash  (this repo's host) `sh: -c: line 1: syntax error near unexpected token '('`
  // and for a missing command `sh: 1: NAME: not found` vs `sh: line 1: NAME:
  // command not found`. The first two assertions this test replaces were pinned
  // to bash and failed on the runner at 95a1bbe (see the ledger: 1078/1/2 there,
  // 1080/1/0 here). What is true in both dialects — and what F19 is actually
  // about — is the exit code, that sh's own bytes are what the user sees, and
  // that crust added nothing of its own.
  test("a pure-shell line keeps sh's own diagnostic, no preflight line", async () => {
    const r = await runCli(["-c", "head -("]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/syntax error/i); // dash: "Syntax error"; bash: "syntax error"
    expect(r.stderr).not.toContain("crust: shell stage does not parse");
    expect(r.stderr).not.toMatch(/^crust:/m); // crust stayed out of the way entirely
  });

  test("the pure-shell line is atomic without the preflight: sh parses it all first", async () => {
    // Why the preflight is only needed for MIXED lines. Here the whole line is
    // one `sh -c`, so sh parses the syntax error before it executes anything and
    // the upstream `touch` never happens — the same nothing-ran guarantee the
    // preflight gives a mixed line, for free. Side-effect fact, dialect-neutral:
    // dash and bash both parse `sh -c` input before running it.
    const marker = `${import.meta.dir}/f19-pure-${process.pid}`;
    const r = await runCli(["-c", `touch ${marker} | head -(`]);
    expect(r.code).toBe(2);
    expect(existsSync(marker)).toBe(false); // never created (size can't tell: touch makes a 0-byte file)
    expect(r.stderr).not.toContain("crust: shell stage does not parse");
  });

  test("127 is a runtime error: the preflight passes, the missing command reports", async () => {
    // The preflight asks sh in NOEXEC mode, so it cannot see a command that is
    // merely absent — `sh -n` parses it fine and the stages before it run. That
    // is the guarantee this test exists for: 127 is not swallowed and not
    // relabelled as a syntax error, and the stages that did run are proof the
    // preflight passed rather than silently skipped the line.
    const marker = `${import.meta.dir}/f19-127-${process.pid}`;
    const r = await runCli(["-c", `touch ${marker} | base64 | definitely-not-a-cmd-xyz99`]);
    expect(r.code).toBe(127);
    expect(existsSync(marker)).toBe(true); // stages before the missing command ran
    rmSync(marker);
    expect(r.stderr).toContain("definitely-not-a-cmd-xyz99"); // both dialects name it
    expect(r.stderr).not.toContain("crust: shell stage does not parse");
    expect(r.stderr).not.toMatch(/^crust:/m);
  });
});

describe("crust CLI: a tool builtin as argv[0]", () => {
  // Why this exists: every positional was read as a script path, so the verbs the
  // docs and the published README lead with were unreachable from a shell.
  // `crust skills install` exited 2 (`script arguments are not supported`) and a
  // bare `crust verify-web-links` exited 127 (`cannot read verify-web-links`) — a
  // code that reads as "the binary is not installed" while the binary was the
  // thing printing it.
  let dir: string;
  let join: typeof import("node:path").join;

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    join = (await import("node:path")).join;
    dir = await mkdtemp(join(tmpdir(), "crust-standalone-"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Canonical location is the cross-client one; `.claude/skills` gets a link per
  // skill, so Claude Code and Codex read the same file rather than two copies.
  const skillsDir = () => join(dir, ".agents/skills");
  const claudeDir = () => join(dir, ".claude/skills");

  test("skills install runs as a command and writes the skills", async () => {
    const r = await runCli(["skills", "install", "--all"], undefined, { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✔ installed");
    expect(r.stdout).toContain("for Claude Code");
    expect(existsSync(join(skillsDir(), "crust-cli/SKILL.md"))).toBe(true);
    expect(lstatSync(join(claudeDir(), "crust-cli")).isSymbolicLink()).toBe(true);
  });

  test("--select installs only the named skills", async () => {
    rmSync(skillsDir(), { recursive: true, force: true });
    rmSync(claudeDir(), { recursive: true, force: true });
    const r = await runCli(["skills", "install", "--select", "crust-cli"], undefined, { cwd: dir });
    expect(r.code).toBe(0);
    expect(existsSync(join(skillsDir(), "crust-cli/SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir(), "crust-logs/SKILL.md"))).toBe(false);
  });

  test("an unknown skill name is exit 2, not a silent no-op", async () => {
    const r = await runCli(["skills", "install", "--select", "nope"], undefined, { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown skill nope");
  });

  test("a tool with no arguments answers with its own usage, never 127", async () => {
    const r = await runCli(["verify-web-links"], undefined, { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("a sitemap URL or a base URL is required");
    expect(r.stderr).not.toContain("cannot read");
  });

  test("a session builtin named at argv[0] is refused BY NAME, not as a missing file", async () => {
    // The other half of the rule. `cd`, `export`, `source` change state a
    // one-shot process does not have, so they are not reachable this way — but
    // letting script mode answer said `cannot read export` (exit 127) or
    // `script arguments are not supported — got "/tmp"` (exit 2), and in a
    // binary printing its own name both read as a broken installation.
    for (const argv of [
      ["cd", "/tmp"],
      ["export", "FOO=1"],
      ["source", "x.crust"],
    ]) {
      const r = await runCli(argv, undefined, { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("running crust session");
      expect(r.stderr).toContain(`\`${argv[0]}\``);
      expect(r.stderr).not.toContain("cannot read");
      expect(r.stderr).not.toContain("script arguments are not supported");
    }
  });

  test("`crust logs` is refused too, for its own reason", async () => {
    // Not a session-state problem: its argument IS the rest of the line (a
    // `procs({...})` literal), so argv would have to re-lex it to mean anything.
    const r = await runCli(["logs", "tail", "app.log"], undefined, { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("verbatim");
    expect(r.stderr).not.toContain("cannot read");
  });

  test("`crust help` points at --help instead of the REPL-only verb", async () => {
    const r = await runCli(["help"], undefined, { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--help");
  });

  test("an unknown word is still a missing script at 127 (refusal is not a catch-all)", async () => {
    const r = await runCli(["no-such-tool-here"], undefined, { cwd: dir });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("cannot read");
  });

  test("a script FILE named after a tool still runs as a script", async () => {
    // The one ambiguity in the rule, resolved toward the file: what the user
    // pointed at exists, so it runs. Only with extra arguments — which script
    // mode could never accept — is the tool reading the only possible one.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "skills"), "range(1,2)\n");
    const r = await runCli(["skills"], undefined, { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2");
    expect(r.stdout).not.toContain("agent skills");
    rmSync(join(dir, "skills"), { force: true });
  });

  test("--check lints the skills flags the docs tell people to run", async () => {
    const ok = await runCli(["--check", "skills install --global --force"]);
    expect(ok.code).toBe(0);
    const okVerb = await runCli(["--check", "skills list"]);
    expect(okVerb.code).toBe(0);
    const bad = await runCli(["--check", "skills install --bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--bogus");
    const badVerb = await runCli(["--check", "skills install-skills"]);
    expect(badVerb.code).toBe(1);
    expect(badVerb.stderr).toContain("install-skills");
  });
});
