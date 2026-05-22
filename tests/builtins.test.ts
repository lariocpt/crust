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
    dotenv: { history: [], snapshot: null },
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
    expect(isBuiltin("dotenv")).toBe(true);
    expect(isBuiltin("test-fixture")).toBe(true);
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

describe("dotenv", () => {
  let dir: string;
  let originalCwd: string;
  const touched = new Set<string>();
  function track(k: string) {
    touched.add(k);
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    dir = await realpath(await mkdtemp(join(tmpdir(), "crust-dotenv-")));
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const k of touched) delete process.env[k];
    touched.clear();
    await rm(dir, { recursive: true, force: true });
  });

  test("loads KEY=value pairs from ./.env by default", async () => {
    track("CRUST_DOTENV_A");
    track("CRUST_DOTENV_B");
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_A=hello\nCRUST_DOTENV_B=world\n");
    const ctx = mkCtx();
    const code = await builtins.dotenv!("", ctx);
    expect(code).toBe(0);
    expect(process.env.CRUST_DOTENV_A).toBe("hello");
    expect(process.env.CRUST_DOTENV_B).toBe("world");
    expect(ctx.dotenv.history).toHaveLength(1);
    expect(ctx.dotenv.history[0]!.mode).toBe("overwrite");
    expect(ctx.dotenv.history[0]!.keys).toEqual(["CRUST_DOTENV_A", "CRUST_DOTENV_B"]);
  });

  test("strips single, double quotes and 'export ' prefix", async () => {
    track("CRUST_DOTENV_Q1");
    track("CRUST_DOTENV_Q2");
    track("CRUST_DOTENV_Q3");
    await Bun.write(
      `${dir}/.env`,
      `CRUST_DOTENV_Q1="double quoted"\nCRUST_DOTENV_Q2='single quoted'\nexport CRUST_DOTENV_Q3=exported\n`,
    );
    await builtins.dotenv!("", mkCtx());
    expect(process.env.CRUST_DOTENV_Q1).toBe("double quoted");
    expect(process.env.CRUST_DOTENV_Q2).toBe("single quoted");
    expect(process.env.CRUST_DOTENV_Q3).toBe("exported");
  });

  test("skips blank lines, comments, and invalid keys", async () => {
    track("CRUST_DOTENV_VALID");
    await Bun.write(
      `${dir}/.env`,
      "\n# a comment\n  # indented comment\n1BAD=skip\nCRUST_DOTENV_VALID=ok\n",
    );
    const ctx = mkCtx();
    await builtins.dotenv!("", ctx);
    expect(process.env.CRUST_DOTENV_VALID).toBe("ok");
    expect(process.env["1BAD"]).toBeUndefined();
    expect(ctx.dotenv.history[0]!.keys).toEqual(["CRUST_DOTENV_VALID"]);
  });

  test("strips inline comments from unquoted values, keeps # inside quotes", async () => {
    track("CRUST_DOTENV_NOCOMMENT");
    track("CRUST_DOTENV_HASH");
    await Bun.write(
      `${dir}/.env`,
      `CRUST_DOTENV_NOCOMMENT=plain # trailing comment\nCRUST_DOTENV_HASH="value # not a comment"\n`,
    );
    await builtins.dotenv!("", mkCtx());
    expect(process.env.CRUST_DOTENV_NOCOMMENT).toBe("plain");
    expect(process.env.CRUST_DOTENV_HASH).toBe("value # not a comment");
  });

  test("default mode overwrites existing env var", async () => {
    track("CRUST_DOTENV_OVR");
    process.env.CRUST_DOTENV_OVR = "old";
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_OVR=new\n");
    await builtins.dotenv!("", mkCtx());
    expect(process.env.CRUST_DOTENV_OVR).toBe("new");
  });

  test("--append leaves existing values alone but writes missing ones", async () => {
    track("CRUST_DOTENV_KEEP");
    track("CRUST_DOTENV_NEW");
    process.env.CRUST_DOTENV_KEEP = "keep";
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_KEEP=other\nCRUST_DOTENV_NEW=fresh\n");
    const ctx = mkCtx();
    await builtins.dotenv!("--append", ctx);
    expect(process.env.CRUST_DOTENV_KEEP).toBe("keep");
    expect(process.env.CRUST_DOTENV_NEW).toBe("fresh");
    expect(ctx.dotenv.history[0]!.mode).toBe("append");
    expect(ctx.dotenv.history[0]!.keys).toEqual(["CRUST_DOTENV_NEW"]);
  });

  test("--config <path> reads custom file", async () => {
    track("CRUST_DOTENV_CFG");
    await Bun.write(`${dir}/custom.env`, "CRUST_DOTENV_CFG=zzz\n");
    const code = await builtins.dotenv!(`--config ./custom.env`, mkCtx());
    expect(code).toBe(0);
    expect(process.env.CRUST_DOTENV_CFG).toBe("zzz");
  });

  test("--config=<path> form also works", async () => {
    track("CRUST_DOTENV_EQ");
    await Bun.write(`${dir}/eq.env`, "CRUST_DOTENV_EQ=v\n");
    await builtins.dotenv!(`--config=./eq.env`, mkCtx());
    expect(process.env.CRUST_DOTENV_EQ).toBe("v");
  });

  test("missing file returns 1 without mutating state", async () => {
    const ctx = mkCtx();
    const code = await builtins.dotenv!("--config ./nope.env", ctx);
    expect(code).toBe(1);
    expect(ctx.dotenv.history).toHaveLength(0);
    expect(ctx.dotenv.snapshot).toBeNull();
  });

  test("unknown flag returns 2", async () => {
    const code = await builtins.dotenv!("--banana", mkCtx());
    expect(code).toBe(2);
  });

  test("status reports no loads when empty", async () => {
    const code = await builtins.dotenv!("status", mkCtx());
    expect(code).toBe(0);
  });

  test("clear restores pre-load env (deletes a key that did not exist)", async () => {
    track("CRUST_DOTENV_CLR1");
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_CLR1=x\n");
    const ctx = mkCtx();
    await builtins.dotenv!("", ctx);
    expect(process.env.CRUST_DOTENV_CLR1).toBe("x");
    await builtins.dotenv!("clear", ctx);
    expect(process.env.CRUST_DOTENV_CLR1).toBeUndefined();
    expect(ctx.dotenv.snapshot).toBeNull();
    expect(ctx.dotenv.history).toHaveLength(0);
  });

  test("clear restores a pre-existing value that was overwritten", async () => {
    track("CRUST_DOTENV_CLR2");
    process.env.CRUST_DOTENV_CLR2 = "orig";
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_CLR2=new\n");
    const ctx = mkCtx();
    await builtins.dotenv!("", ctx);
    expect(process.env.CRUST_DOTENV_CLR2).toBe("new");
    await builtins.dotenv!("clear", ctx);
    expect(process.env.CRUST_DOTENV_CLR2).toBe("orig");
  });

  test("snapshot is taken on first load, preserved across subsequent loads", async () => {
    track("CRUST_DOTENV_S");
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_S=first\n");
    const ctx = mkCtx();
    await builtins.dotenv!("", ctx);
    const firstSnap = ctx.dotenv.snapshot;
    await Bun.write(`${dir}/.env`, "CRUST_DOTENV_S=second\n");
    await builtins.dotenv!("", ctx);
    expect(ctx.dotenv.snapshot).toBe(firstSnap);
    expect(ctx.dotenv.history).toHaveLength(2);
  });
});

describe("defaultPrompt env marker", () => {
  test("[env: N] absent when no loads, present when N > 0", async () => {
    const { defaultPrompt } = await import("../src/prompt");
    const ctx = mkCtx();
    expect(defaultPrompt(ctx)).not.toContain("[env:");
    ctx.dotenv.history.push({ path: "/x", mode: "overwrite", ts: 0, keys: [] });
    ctx.dotenv.history.push({ path: "/y", mode: "append", ts: 0, keys: [] });
    expect(defaultPrompt(ctx)).toContain("[env: 2]");
  });
});
