// The shared flag parser, and the per-CLI surface it gives every tool builtin.
//
// Before this, each sub-CLI hand-rolled its own loop and they disagreed: only
// mock-server's --state/--seed refused to swallow a following flag, `dotenv
// --help` was an "unknown arg", and none took its primary argument
// positionally. These tests pin the shared behaviour and the back-compat
// promise that every legacy long flag still works.
import { describe, expect, test } from "bun:test";
import { FlagError, type FlagSpec, parseFlags } from "../src/args";

const SPEC: FlagSpec = {
  target: { type: "string", positional: 0 },
  out: { short: "o", type: "string" },
  threads: { short: "j", type: "number" },
  bail: { short: "b", type: "boolean" },
  exclude: { type: "string", repeat: true },
};

describe("parseFlags", () => {
  test("takes the primary argument positionally", () => {
    expect(parseFlags(["fixtures/*.crust.ts"], SPEC).values.target).toBe("fixtures/*.crust.ts");
  });

  test("still takes it as the legacy long flag", () => {
    expect(parseFlags(["--target", "a.ts"], SPEC).values.target).toBe("a.ts");
    expect(parseFlags(["--target=a.ts"], SPEC).values.target).toBe("a.ts");
  });

  test("short flags work attached and detached", () => {
    expect(parseFlags(["-j8"], SPEC).values.threads).toBe(8);
    expect(parseFlags(["-j", "8"], SPEC).values.threads).toBe(8);
    expect(parseFlags(["-b"], SPEC).values.bail).toBe(true);
  });

  test("numbers are validated, not silently NaN", () => {
    expect(() => parseFlags(["-j", "abc"], SPEC)).toThrow(/expects a number/);
  });

  test("a value flag refuses to swallow the next flag", () => {
    // The mock-server bug: `--host --stateful` set host="--stateful" and then
    // failed with a misleading "is port N in use?".
    expect(() => parseFlags(["--out", "--bail"], SPEC)).toThrow(/needs a value/);
    expect(() => parseFlags(["--out"], SPEC)).toThrow(/needs a value/);
  });

  test("booleans reject an attached value", () => {
    expect(() => parseFlags(["--bail=yes"], SPEC)).toThrow(/takes no value/);
  });

  test("unknown flags list the valid ones", () => {
    expect(() => parseFlags(["--bogus"], SPEC)).toThrow(/unknown argument --bogus \(valid: /);
  });

  test("repeatable flags collect", () => {
    const r = parseFlags(["--exclude", "/a/", "--exclude", "/b/"], SPEC);
    expect(r.values.exclude).toEqual(["/a/", "/b/"]);
  });

  test("giving the primary argument twice is an error, not a silent overwrite", () => {
    expect(() => parseFlags(["a.ts", "--target", "b.ts"], SPEC)).toThrow(/given twice/);
  });

  test("extra bare arguments land in rest so callers can reject them", () => {
    expect(parseFlags(["a.ts", "b.ts"], SPEC).rest).toEqual(["b.ts"]);
  });

  test("-h/--help short-circuits", () => {
    expect(parseFlags(["--help"], SPEC).help).toBe(true);
    expect(parseFlags(["-h"], SPEC).help).toBe(true);
  });

  test("FlagError is what callers catch to return exit 2", () => {
    try {
      parseFlags(["--bogus"], SPEC);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FlagError);
    }
  });
});

const ENTRY = `${import.meta.dir}/../src/index.ts`;
async function cli(argLine: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", ENTRY, "-c", argLine], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-flags-none",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: stdout + stderr };
}

describe("every tool builtin answers --help the same way", () => {
  // `dotenv --help` used to be "unknown arg '--help'".
  test.each([
    "test-fixture",
    "test-pipes",
    "gen-fixtures",
    "mock-server",
    "verify-web-links",
    "dotenv",
  ])("%s --help exits 0 with usage", async (name) => {
    const r = await cli(`${name} --help`);
    expect(r.code).toBe(0);
    expect(r.out).toContain(name);
  });
});

describe("missing primary argument is exit 2 everywhere", () => {
  test.each([
    ["test-fixture", /target file or glob is required/],
    ["test-pipes", /target file or glob is required/],
    ["gen-fixtures", /OpenAPI spec path is required/],
    ["mock-server", /OpenAPI spec \(path or URL\) is required/],
    ["verify-web-links", /sitemap URL or a base URL is required/],
  ])("%s", async (name, pattern) => {
    const r = await cli(name);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(pattern);
  });
});
