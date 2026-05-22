import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtins, isBuiltin } from "../src/builtins";
import type { Context } from "../src/types";

function mkCtx(): Context {
  return {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: () => {},
  };
}

describe("isBuiltin", () => {
  test("recognises known names", () => {
    expect(isBuiltin("cd")).toBe(true);
    expect(isBuiltin("alias")).toBe(true);
    expect(isBuiltin("export")).toBe(true);
    expect(isBuiltin("exit")).toBe(true);
    expect(isBuiltin("history")).toBe(true);
    expect(isBuiltin("unalias")).toBe(true);
    expect(isBuiltin("help")).toBe(true);
  });

  test("rejects unknown names", () => {
    expect(isBuiltin("ls")).toBe(false);
    expect(isBuiltin("git")).toBe(false);
  });
});

describe("cd", () => {
  let dir: string;
  let original: string;
  beforeEach(async () => {
    original = process.cwd();
    dir = await realpath(await mkdtemp(join(tmpdir(), "crust-cd-")));
  });
  afterEach(async () => {
    process.chdir(original);
    await rm(dir, { recursive: true, force: true });
  });

  test("changes directory to argument", async () => {
    const code = await builtins.cd!(dir, mkCtx());
    expect(code).toBe(0);
    expect(process.cwd()).toBe(dir);
  });

  test("cd - returns to OLDPWD", async () => {
    const ctx = mkCtx();
    const startCwd = process.cwd();
    await builtins.cd!(dir, ctx);
    await builtins.cd!("-", ctx);
    expect(process.cwd()).toBe(startCwd);
  });

  test("cd with no arg goes to $HOME", async () => {
    const code = await builtins.cd!("", mkCtx());
    expect(code).toBe(0);
    const home = await realpath(process.env.HOME!);
    expect(await realpath(process.cwd())).toBe(home);
  });

  test("returns nonzero for nonexistent target", async () => {
    const code = await builtins.cd!("/this/does/not/exist-xyz", mkCtx());
    expect(code).not.toBe(0);
  });
});

describe("alias", () => {
  test("sets alias from single-quoted value", async () => {
    const ctx = mkCtx();
    await builtins.alias!("ll='ls -la'", ctx);
    expect(ctx.aliases.get("ll")).toBe("ls -la");
  });

  test("sets alias from double-quoted value", async () => {
    const ctx = mkCtx();
    await builtins.alias!('g="git"', ctx);
    expect(ctx.aliases.get("g")).toBe("git");
  });

  test("sets alias from unquoted value", async () => {
    const ctx = mkCtx();
    await builtins.alias!("g=git", ctx);
    expect(ctx.aliases.get("g")).toBe("git");
  });
});

describe("unalias", () => {
  test("removes an existing alias", async () => {
    const ctx = mkCtx();
    ctx.aliases.set("ll", "ls -la");
    await builtins.unalias!("ll", ctx);
    expect(ctx.aliases.has("ll")).toBe(false);
  });
});

describe("export", () => {
  test("sets env var via KEY=value", async () => {
    const ctx = mkCtx();
    await builtins.export!("CRUST_TEST_EXPORT=hello", ctx);
    expect(process.env.CRUST_TEST_EXPORT).toBe("hello");
    delete process.env.CRUST_TEST_EXPORT;
  });

  test("sets multiple env vars in one call", async () => {
    const ctx = mkCtx();
    await builtins.export!("CRUST_A=1 CRUST_B=2", ctx);
    expect(process.env.CRUST_A).toBe("1");
    expect(process.env.CRUST_B).toBe("2");
    delete process.env.CRUST_A;
    delete process.env.CRUST_B;
  });
});

describe("exit", () => {
  test("calls ctx.exit with the parsed code", async () => {
    let captured: number | undefined;
    const ctx: Context = {
      ...mkCtx(),
      exit: (c) => {
        captured = c;
      },
    };
    await builtins.exit!("42", ctx);
    expect(captured).toBe(42);
  });

  test("defaults exit code to 0", async () => {
    let captured: number | undefined;
    const ctx: Context = {
      ...mkCtx(),
      exit: (c) => {
        captured = c;
      },
    };
    await builtins.exit!("", ctx);
    expect(captured).toBe(0);
  });
});
