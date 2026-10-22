import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtins } from "../src/builtins";
import { runLine } from "../src/runLine";
import type { Context } from "../src/types";

function mkCtx(): Context {
  return {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: (() => {}) as Context["exit"],
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
  };
}

/** Swap stdout.write for the duration of `fn`; returns [result, captured]. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const original = process.stdout.write.bind(process.stdout) as (c: unknown) => boolean;
  let buf = "";
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ): boolean => {
    buf += String(c);
    return true;
  };
  try {
    const result = await fn();
    return [result, buf];
  } finally {
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = original;
  }
}

/** Swap stderr.write for the duration of `fn`; returns [result, captured]. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const original = process.stderr.write.bind(process.stderr) as (c: unknown) => boolean;
  let buf = "";
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ): boolean => {
    buf += String(c);
    return true;
  };
  try {
    const result = await fn();
    return [result, buf];
  } finally {
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = original;
  }
}

describe("source: bash scripts (G06)", () => {
  let dir: string;
  let ctx: Context;

  const originalCwd = process.cwd();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-g06-"));
    process.chdir(dir);
    ctx = mkCtx();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SB_")) delete process.env[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("multi-line if/fi + for loop runs to completion, exit 0, echo output appears", async () => {
    const out = join(dir, "loops.out");
    await writeFile(
      join(dir, "loops.sh"),
      [
        'if [ -n "$HOME" ]; then',
        '  echo if-ok >> "$SB_OUT"',
        "fi",
        "for i in 1 2 3; do",
        '  echo "iter-$i" >> "$SB_OUT"',
        "done",
        "",
      ].join("\n"),
    );
    process.env.SB_OUT = out;
    const code = await builtins.source!("./loops.sh", ctx);
    expect(code).toBe(0);
    const text = await readFile(out, "utf8");
    expect(text).toContain("if-ok");
    expect(text).toContain("iter-1");
    expect(text).toContain("iter-2");
    expect(text).toContain("iter-3");
  });

  test("exported env is visible to the next crust line and to a later shell stage", async () => {
    await writeFile(join(dir, "env.sh"), "export SB_FOO=bar\n");
    const code = await builtins.source!("./env.sh", ctx);
    expect(code).toBe(0);

    // Next crust line: the `export` builtin (no args) lists the session env.
    const [, listed] = await captureStdout(async () => {
      await builtins.export!("", ctx);
    });
    expect(listed).toContain("SB_FOO=bar");

    // Later shell stage: a pure-shell line runs in a child that must see it.
    const file = join(dir, "stage.txt");
    const shellCode = await runLine(`printf %s "$SB_FOO" > "${file}"`, ctx);
    expect(shellCode).toBe(0);
    expect(await readFile(file, "utf8")).toBe("bar");
  });

  test("nonzero exit from the script is nonzero from source, and the following line does not run", async () => {
    const out = join(dir, "fail.out");
    await writeFile(
      join(dir, "fail.sh"),
      'echo before >> "$SB_OUT"\nexit 7\necho not-run >> "$SB_OUT"\n',
    );
    process.env.SB_OUT = out;
    const code = await builtins.source!("./fail.sh", ctx);
    expect(code).toBe(7);
    expect(await readFile(out, "utf8")).toContain("before");
    expect(await readFile(out, "utf8")).not.toContain("not-run");
  });

  test("a .sh with a set -e failure mid-script stops there", async () => {
    const out = join(dir, "sete.out");
    await writeFile(
      join(dir, "sete.sh"),
      'set -e\necho before >> "$SB_OUT"\nfalse\necho after >> "$SB_OUT"\n',
    );
    process.env.SB_OUT = out;
    const code = await builtins.source!("./sete.sh", ctx);
    expect(code).not.toBe(0);
    expect(await readFile(out, "utf8")).toContain("before");
    expect(await readFile(out, "utf8")).not.toContain("after");
  });

  test("env capture survives a value containing a space (or refuses loudly)", async () => {
    await writeFile(join(dir, "space.sh"), 'export SB_SPACE="a b c"\n');
    const [code, err] = await captureStderr(async () => builtins.source!("./space.sh", ctx));
    if (code === 0) {
      expect(process.env.SB_SPACE).toBe("a b c");
    } else {
      expect(err).toContain("SB_SPACE");
      expect(err).toContain("space.sh");
    }
  });

  test("env capture survives a value containing a newline (or refuses loudly)", async () => {
    await writeFile(join(dir, "newline.sh"), 'SB_NEW="line1\nline2"\nexport SB_NEW\n');
    const [code, err] = await captureStderr(async () => builtins.source!("./newline.sh", ctx));
    if (code === 0) {
      expect(process.env.SB_NEW).toBe("line1\nline2");
    } else {
      expect(err).toContain("SB_NEW");
      expect(err).toContain("newline.sh");
    }
  });

  test("control: a crust file sourced unchanged still works", async () => {
    const out = join(dir, "ctrl.out");
    await writeFile(join(dir, "ctrl.crust"), 'export SB_CTRL=1\necho ctrl-ok >> "$SB_OUT"\n');
    process.env.SB_OUT = out;
    const code = await builtins.source!("./ctrl.crust", ctx);
    expect(code).toBe(0);
    expect(process.env.SB_CTRL).toBe("1");
    expect(await readFile(out, "utf8")).toContain("ctrl-ok");
  });

  test("control: a .ts file still imports", async () => {
    await writeFile(
      join(dir, "mod.ts"),
      'process.env.SB_TS = "imported";\nexport const value = 42;\n',
    );
    const code = await builtins.source!("./mod.ts", ctx);
    expect(code).toBe(0);
    expect(process.env.SB_TS).toBe("imported");
  });

  test("control: source missing.sh fails with `source: …`, not a stack trace", async () => {
    const [code, err] = await captureStderr(async () => builtins.source!("./nope-missing.sh", ctx));
    expect(code).not.toBe(0);
    expect(err).toContain("source:");
    expect(err).not.toContain("at ");
    expect(err).not.toContain("stack");
  });

  test("ambiguous extensionless file: one defined outcome, never a partial run", async () => {
    const out = join(dir, "amb.out");
    await writeFile(join(dir, "ambig"), 'if [ -n "$HOME" ]; then\necho amb-ok >> "$SB_OUT"\nfi\n');
    process.env.SB_OUT = out;
    const [code, err] = await captureStderr(async () => builtins.source!("./ambig", ctx));
    if (code === 0) {
      // The defined outcome here is: it ran (as bash) to completion.
      expect(await readFile(out, "utf8")).toContain("amb-ok");
    } else {
      // Or it refused with BOTH options named.
      expect(err).toContain("crust");
      expect(err).toMatch(/sh|bash/);
    }
  });
});
