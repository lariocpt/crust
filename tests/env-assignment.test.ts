// `FOO=x` at a crust prompt is a statement about the SESSION, and until now it
// was a subprocess that forgot: the line ran as `sh -c 'FOO=x'`, exited **0**,
// and the next line expanded `$FOO` to nothing. Writing `export FOO=x` worked,
// so every case here is that same claim minus the word "export".
//
// The controls matter as much as the fixes. `FOO=x cmd` is sh's *transient*
// prefix — the variable lives for that one command — and persisting it would be
// a lie of the opposite sign, so those lines still belong to sh.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssignWord, assignEnv, parseAssignWords } from "../src/args";
import { applyBareAssignmentLine } from "../src/builtins";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-env-assign-test-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

const run = (program: string) => runCli(["-c", program]);

/** Unique names: these tests mutate a shared process.env, like the session does. */
let seq = 0;
const v = () => `G04_VAR_${seq++}`;

describe("a bare assignment line is session state", () => {
  test("FOO=bar persists to the next line — it used to exit 0 and set nothing", async () => {
    const N = v();
    const r = await run(`${N}=bar\necho "[${N}=$${N}]"`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`[${N}=bar]`);
  });

  test("several assignments on one line all apply", async () => {
    const [A, B] = [v(), v()];
    const r = await run(`${A}=1 ${B}=2\necho "[${A}${B}=$${A}$${B}]"`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`[${A}${B}=12]`);
  });

  test("a quoted space stays one value", async () => {
    const N = v();
    const r = await run(`${N}="a b"\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=a b]`);
  });

  test("an escaped space is one word here too — sh reads it that way", async () => {
    const N = v();
    const r = await run(`${N}=a\\ b\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=a b]`);
  });

  test("a shell stage inherits the value (live env at spawn)", async () => {
    const N = v();
    const r = await run(`${N}=from-crust\nprintenv ${N}`);
    expect(r.stdout.trim()).toBe("from-crust");
  });

  test("+= appends, and appends to nothing like sh does", async () => {
    const [A, B] = [v(), v()];
    const r = await run(`${A}=a\n${A}+=b\necho "[${A}=$${A}]"\n${B}+=z\necho "[${B}=$${B}]"`);
    expect(r.stdout).toContain(`[${A}=ab]`);
    expect(r.stdout).toContain(`[${B}=z]`);
  });

  test("the PATH-prepend idiom works, which is why the quoting rules matter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-g04-path-"));
    const [BASE, P] = [v(), v()];
    const r = await run(`${BASE}=/bin\n${P}=$${BASE}:${dir}\necho "$${P}"`);
    expect(r.stdout.trim()).toBe(`/bin:${dir}`);
    await rm(dir, { recursive: true, force: true });
  });

  test("a trailing comment does not become part of the value", async () => {
    const N = v();
    const r = await run(`${N}=bar # the host to hit\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=bar]`);
  });

  test("a script file persists assignments across its lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-g04-script-"));
    const N = v();
    const file = join(dir, "main.crust");
    await writeFile(file, `${N}=from-script\necho "[${N}=$${N}]"\n`);
    const r = await runCli([file]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`[${N}=from-script]`);
    await rm(dir, { recursive: true, force: true });
  });

  test("export and the bare spelling agree on one value", async () => {
    const [A, B] = [v(), v()];
    const r = await run(`export ${A}=same\n${B}=same\necho "[${A}=$${A}][${B}=$${B}]"`);
    expect(r.stdout.trim()).toBe(`[${A}=same][${B}=same]`);
  });
});

describe("which $ in a value expands, and which does not", () => {
  test("$NAME expands, braced and plain", async () => {
    const N = v();
    const r = await run(`G04_SRC=inner\n${N}=$G04_SRC-${"${G04_SRC}"}\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=inner-inner]`);
  });

  test("single quotes protect the reference — the difference between set and looks set", async () => {
    const N = v();
    const r = await run(`${N}='$HOME'\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=$HOME]`);
  });

  test("double quotes expand", async () => {
    const N = v();
    const r = await run(`${N}="$HOME"\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).not.toBe(`[${N}=$HOME]`);
    expect(r.stdout.trim()).toBe(`[${N}=${process.env.HOME}]`);
  });

  test("a backslash protects one $ and nothing else", async () => {
    const [A, B] = [v(), v()];
    const r = await run(`${A}=\\$HOME\n${B}=C:\\temp\necho "[${A}=$${A}][${B}=$${B}]"`);
    expect(r.stdout.trim()).toBe(`[${A}=$HOME][${B}=C:\\temp]`);
  });

  test("an unset name expands to empty, like every other crust expansion", async () => {
    const N = v();
    const r = await run(`${N}=x$G04_NOT_SET_ANYWHERE\necho "[${N}=$${N}]"`);
    expect(r.stdout.trim()).toBe(`[${N}=x]`);
  });
});

describe("an assignment line refuses rather than half-applying", () => {
  test("$(...) is refused with the pipeline route named", async () => {
    const N = v();
    const r = await run(`${N}=$(date)\necho "[${N}=$${N}]"`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(N);
    expect(r.stderr).toMatch(/capture/);
    // The refusal stops the program: the line after it must not run.
    expect(r.stdout).toBe("");
  });

  test("a backtick is refused too", async () => {
    const N = v();
    const r = await run(`${N}=\`date\``);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/capture/);
  });

  // The metacharacter carve-out must decide what crust APPLIES, not what it
  // refuses. A pipe inside the substitution made the line "sh's", sh ran the
  // command, a variable landed in a shell that exited immediately — and the run
  // reported success with the value gone, which is the exact false pass the
  // assignment path exists to close.
  test("a pipe inside the substitution is refused as loudly as the plain one", async () => {
    const N = v();
    const r = await run(`${N}=$(date | head -1)\necho "[${N}=$${N}]"`);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // Refused whole, not cut at the space the substitution contains.
    expect(r.stderr).toContain(`${N}=$(date | head -1)\``);
    expect(r.stderr).toMatch(/capture/);
  });

  test("a backtick holding a pipe is refused too", async () => {
    const N = v();
    const r = await run(`${N}=\`echo one | wc -c\``);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${N}=\`echo one | wc -c\`\``);
  });

  // Controls: the refusal is about assignment heads, not about `$(` existing.
  test("a substitution in a shell stage is still sh's to run", async () => {
    const r = await run('echo "value: $(echo from-sh)"');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("value: from-sh");
  });

  test("a substitution in a later word of a prefixed command is not refused", async () => {
    // `A=1 sh -c '…'` is sh's transient prefix, and crust's parser stops at the
    // first non-assignment word — the substitution belongs to the inner shell.
    const N = v();
    const r = await run(`${N}=1 sh -c 'echo hi $(echo there)'`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi there");
  });

  test("an assignment piped somewhere is still sh's line, unanswered", async () => {
    const N = v();
    const r = await run(`${N}=x | cat`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("an unterminated quote is not a value", async () => {
    const N = v();
    const r = await run(`${N}="a`);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unterminated quote/);
  });

  test("export FOO of an unset name says so instead of exiting 0", async () => {
    const N = v();
    const r = await run(`export ${N}`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(N);
    expect(r.stderr).toMatch(/is not set/);
  });

  test("a word export does not understand is an error, not a silent skip", async () => {
    const N = v();
    const r = await run(`export ${N}=1 -p`);
    // Before: FOO was set, `-p` printed nothing, exit 0 — the shape of a pass.
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/-p/);
  });

  test("export -p prints the environment", async () => {
    const N = v();
    const r = await run(`${N}=shown\nexport -p`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${N}=shown`);
  });
});

describe("controls: lines that are NOT assignment lines", () => {
  test("FOO=x cmd keeps sh's transient semantics", async () => {
    const N = v();
    const r = await run(`${N}=1 printenv ${N}\necho "[${N}=$${N}]"`);
    const lines = r.stdout.split("\n");
    // The command sees it…
    expect(lines[0]).toBe("1");
    // …and the session does not, which is exactly what sh promises.
    expect(lines[1]).toBe(`[${N}=]`);
  });

  test("an assignment with an unquoted metacharacter still goes to sh", async () => {
    const N = v();
    const r = await run(`${N}=a; echo "in-sh=$${N}"`);
    // sh's own line, sh's own semantics: the var lives in that shell only.
    expect(r.stdout.trim()).toBe(`in-sh=a`);
  });

  test("a bare NAME is a command, not an assignment", async () => {
    const N = v();
    const r = await run(N);
    expect(r.code).not.toBe(0);
  });

  test("a word that is not NAME= keeps the line a command", async () => {
    // `-c` here is curl's flag, not crust's: the head has no `=`, so the gate
    // never looks at it, and the line is sh's to run (or fail to find).
    const r = await run("nonexistent-crust-g04-binary -x=y");
    expect(r.code).not.toBe(0);
  });

  test("a lambda stage with => in it is untouched", async () => {
    const r = await run("range(1,2) | (x => x * 10)");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["10", "20"]);
  });

  test("a query string with = in a later stage is untouched", async () => {
    const r = await run('echo "http://x/y?a=1"');
    expect(r.stdout.trim()).toBe("http://x/y?a=1");
  });
});

describe("parseAssignWords", () => {
  const words = (s: string) => parseAssignWords(s) as AssignWord[];

  test("parses names, values, and the append flag", () => {
    expect(words("A=1 B+=2")).toEqual([
      { name: "A", value: "1", append: false },
      { name: "B", value: "2", append: true },
    ]);
  });

  test("a value may contain =", () => {
    expect(words("A=b=c")[0]!.value).toBe("b=c");
  });

  test("a bare name parses as mark-for-export (value: null)", () => {
    expect(words("A")[0]).toEqual({ name: "A", value: null, append: false });
  });

  test.each(["curl -x=y", "--flag=1", "1FOO=x", "A=1 -n"])("not assignment-shaped: %s", (s) => {
    expect(parseAssignWords(s)).toMatchObject({ reason: "not-assignment" });
  });

  test("a line of bare names is sh's mark-for-export, and a bare line never persists it", () => {
    expect(parseAssignWords("A B")).toEqual([
      { name: "A", value: null, append: false },
      { name: "B", value: null, append: false },
    ]);
    // …but only `export` takes that spelling. `A B` on its own is a command,
    // and `A=1 env` is sh's transient prefix — neither is session state.
    expect(applyBareAssignmentLine("A B")).toBeNull();
    expect(applyBareAssignmentLine("A=1 env")).toBeNull();
    expect(applyBareAssignmentLine("G04_UNIT_A=1")).toBe(0);
    expect(process.env.G04_UNIT_A).toBe("1");
    delete process.env.G04_UNIT_A;
  });

  test("assignEnv writes process.env and appends", () => {
    assignEnv({ name: "G04_UNIT", value: "a", append: false });
    assignEnv({ name: "G04_UNIT", value: "b", append: true });
    expect(process.env.G04_UNIT).toBe("ab");
    delete process.env.G04_UNIT;
  });
});
