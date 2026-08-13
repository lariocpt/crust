import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { shellEnv } from "../src/shellPath";

let dir: string;
let cwd: string;

beforeAll(async () => {
  cwd = process.cwd();
  dir = await realpath(await mkdtemp(join(tmpdir(), "crust-shellpath-")));
  // nested/node_modules/.bin AND dir/node_modules/.bin — nearest must win.
  await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(dir, "nested", "node_modules", ".bin"), { recursive: true });
  const tool = join(dir, "nested", "node_modules", ".bin", "crust-fake-tool");
  await Bun.write(tool, "#!/bin/sh\necho fake-tool-ran\n");
  await chmod(tool, 0o755);
});

afterAll(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("shellEnv — npm-run-style PATH", () => {
  test("prepends every ancestor node_modules/.bin, nearest first", () => {
    process.chdir(join(dir, "nested"));
    const path = shellEnv().PATH!;
    const parts = path.split(delimiter);
    const near = parts.indexOf(join(dir, "nested", "node_modules", ".bin"));
    const far = parts.indexOf(join(dir, "node_modules", ".bin"));
    expect(near).toBe(0);
    expect(far).toBe(1);
    expect(path.endsWith(process.env.PATH ?? "")).toBe(true);
  });

  test("no node_modules anywhere → env unchanged", () => {
    process.chdir("/tmp");
    // /tmp's ancestors normally carry no node_modules/.bin; if the machine
    // has one at /, skip rather than assert a falsehood.
    const path = shellEnv().PATH!;
    if (!path.includes(`${delimiter}/node_modules/.bin`) && !path.startsWith("/node_modules")) {
      expect(path).toBe(process.env.PATH ?? "");
    }
  });

  test("e2e: a bare local binary resolves in a shell stage", async () => {
    const ENTRY = `${import.meta.dir}/../src/index.ts`;
    const proc = Bun.spawn(["bun", ENTRY, "-c", "range(1, 1) | crust-fake-tool"], {
      cwd: join(dir, "nested"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CRUST_CONFIG: "/dev/null" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("fake-tool-ran");
  });
});
