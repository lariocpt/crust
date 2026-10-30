import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G35. `bin/crust` is the launcher npm ships (`npm/package.json`: `bin: {crust:
 * "./bin/crust"}`, `files` includes `bin`), and it took `SCRIPT_DIR` from
 * `${BASH_SOURCE[0]}` — the path **as invoked**, not the file's own location.
 * Package managers install bins as symlinks into `node_modules/.bin`, so both of
 * its branches missed: no sibling `crust-bin`, and no `../src/index.ts` beside a
 * `.bin` directory. Measured before the fix, through exactly that shape:
 * `error: Module not found "…/node_modules/.bin/../src/index.ts"`.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(repoRoot, "bin", "crust");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-launcher-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(command: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

async function link(from: string, to: string): Promise<void> {
  await mkdir(dirname(from), { recursive: true });
  await symlink(to, from);
}

describe("the published launcher survives a symlinked bin (G35)", () => {
  test("the installed shape: node_modules/.bin/crust → bin/crust → crust-bin", async () => {
    // The exact shape bun/npm produce, reproduced from the bug report.
    const prefix = join(dir, "installed");
    await link(join(prefix, "node_modules/.bin/crust"), launcher);
    const r = await run(`${join(prefix, "node_modules/.bin/crust")} --version`);
    expect(r.stderr).not.toContain("Module not found");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+/);
  });

  test("control: invoking by real path keeps working (the case that always passed)", async () => {
    const r = await run(`${launcher} --version`);
    expect(r.stderr).not.toContain("Module not found");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+/);
  });

  test("a symlink CHAIN resolves too, not just one hop", async () => {
    const prefix = join(dir, "chain");
    await link(join(prefix, "staged/crust"), launcher);
    await link(join(prefix, "node_modules/.bin/crust"), join(prefix, "staged/crust"));
    const r = await run(`${join(prefix, "node_modules/.bin/crust")} --version`);
    expect(r.stderr).not.toContain("Module not found");
    expect(r.code).toBe(0);
  });

  test("the dev branch (../src/index.ts) is reached through a symlink as well", async () => {
    // A layout with no crust-bin beside the launcher: the fallback must find the
    // source next to the REAL script, not next to the .bin directory.
    const dev = join(dir, "devtree");
    await mkdir(join(dev, "bin"), { recursive: true });
    await mkdir(join(dev, "src"), { recursive: true });
    await writeFile(join(dev, "src", "index.ts"), 'console.log("FALLBACK-RAN");\n');
    const script = join(dev, "bin", "crust");
    await writeFile(script, await Bun.file(launcher).text());
    await chmod(script, 0o755);
    await link(join(dev, "node_modules/.bin/crust"), script);
    const r = await run(`${join(dev, "node_modules/.bin/crust")} anything`);
    expect(r.stderr).not.toContain("Module not found");
    expect(r.stdout).toContain("FALLBACK-RAN");
  });

  test("works on a BSD `readlink` that has no -f (the darwin builds)", async () => {
    // macOS readlink rejects -f. Shim one on PATH: plain readlink (which BSD does
    // have) passes through, -f fails the way darwin's does.
    const shim = join(dir, "bsd-shim");
    await mkdir(shim, { recursive: true });
    const readlink = join(shim, "readlink");
    await writeFile(
      readlink,
      [
        "#!/usr/bin/env bash",
        'for a in "$@"; do case "$a" in -f|-e|--canonicalize*) ',
        '  echo "readlink: illegal option -- f" >&2; exit 1;; esac; done',
        'exec /usr/bin/readlink "$@"',
        "",
      ].join("\n"),
    );
    await chmod(readlink, 0o755);
    const prefix = join(dir, "bsd");
    await link(join(prefix, "node_modules/.bin/crust"), launcher);
    const r = await run(`${join(prefix, "node_modules/.bin/crust")} --version`, {
      PATH: `${shim}:${process.env.PATH ?? ""}`,
    });
    expect(r.stderr).not.toContain("Module not found");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d+\.\d+/);
  });
});
