// The crust `site` stub — a redirect, shaped after the clean-binary mongo
// hint (tests/mongo.test.ts for the tone, honest-failure.test.ts for the
// never-127 discipline).
//
// The contract is honesty at both ends:
//   - a valid invocation NEVER exits 0 — this process does not build sites,
//     so a success exit would be the false pass the redirect exists to
//     prevent (mongo's hint uses the same exit code: loud message, exit 1);
//   - the name NEVER falls through to sh — an unregistered name would exit
//     127 and read as "the binary is not installed" while the binary is the
//     thing that knows the answer;
//   - argument errors are exit 2 with the usage, and `--help` is exit 0 with
//     usage on stdout — the parseFlags convention every tool builtin keeps.
// The one-shot (`crust site …`) and session (`-c 'site …'`) spellings must
// answer identically, because both land on the same runner.
import { describe, expect, test } from "bun:test";
import { SITE_REDIRECT_HINT } from "../src/builtinFns/site";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CRUST_CONFIG: "/dev/null",
      CRUST_GLOBAL_PREFIX: "/tmp/crust-site-stub-no-globals",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("site stub: the redirect is honest", () => {
  test("a bare `site` exits nonzero and prints the redirect (never 0, never 127)", async () => {
    const r = await runCli(["site"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SITE_REDIRECT_HINT);
    expect(r.stderr).toContain("bunx @crust/site build");
  });

  test("`site build` exits nonzero and prints the redirect (never 0, never 127)", async () => {
    const r = await runCli(["site", "build"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SITE_REDIRECT_HINT);
  });

  test("`site dev` redirects to the dev server the same way", async () => {
    const r = await runCli(["site", "dev"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bunx @crust/site dev");
  });

  test("the session dispatch answers identically to the one-shot form", async () => {
    // `crust -c 'site build'` goes through the session-builtin path (builtins
    // registry), not the standalone one — both must land on the same answer.
    const r = await runCli(["-c", "site build"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SITE_REDIRECT_HINT);
  });

  test("control: a name crust does NOT own still falls through to sh with 127", async () => {
    // The 127 guard, stated as a control: crust's own script-mode diagnostic
    // (`crust: cannot read <name>`) is the answer for unknown names; `site`
    // must never produce it.
    const r = await runCli(["nosuchcmd_xyz_zz"]);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("cannot read");
  });
});

describe("site stub: the flag surface", () => {
  test("site --help: usage on stdout, exit 0, nothing on stderr", async () => {
    const r = await runCli(["site", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: site");
    expect(r.stderr).toBe("");
  });

  test("site -h answers the same way", async () => {
    const r = await runCli(["site", "-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: site");
  });

  test("site --bogus is rejected as an unknown argument, exit 2", async () => {
    const r = await runCli(["site", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument --bogus");
    expect(r.stderr).toContain("usage: site");
  });

  test("a valid invocation with a config file is accepted, then redirects", async () => {
    const r = await runCli(["site", "build", "./site.config.ts"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(SITE_REDIRECT_HINT);
    expect(r.stderr).not.toContain("unexpected argument");
  });

  test("an unknown subcommand is exit 2 naming the valid ones", async () => {
    const r = await runCli(["site", "deploy"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command "deploy" \(valid: build, dev\)/);
    expect(r.stderr).toContain("usage: site");
  });

  test("a third argument is refused, not silently dropped", async () => {
    const r = await runCli(["site", "build", "a.ts", "b.ts"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unexpected argument "b\.ts"/);
  });

  test("a redirect on the invocation is refused like every tool builtin", async () => {
    // Tools run in-process; a `>` on the line cannot wrap them. The refusal
    // names the builtin instead of letting sh answer 127.
    const r = await runCli(["-c", "site build > out.log"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("site");
    expect(r.stderr).toContain("cannot redirect");
  });
});
