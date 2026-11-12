// A config that EXISTS but fails to load must never fail silently.
//
// loadConfig used to swallow every ERR_MODULE_NOT_FOUND — the code meant for
// "no config file, that's fine" — so an init.ts whose own import failed (a
// driver package that cannot resolve under the compiled binary, a typo'd
// path inside the config) loaded as nothing at all: no warning, exit 0, every
// crust.fn silently unregistered, and the user got `foo: command not found`.
// Measured 2026-11-12 through a real compiled binary: init.ts importing
// mongodb (a package with dependencies) fails resolution, and the session
// carried on as if the config were empty. The contract now: a MISSING config
// is silence; a config that exists and fails is a loud warning, and the
// session still continues (exit 0) — same established shape as any other
// init.ts throw.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-config-load-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runWith(config: string) {
  const proc = Bun.spawn(["bun", ENTRY, "-c", "echo ok"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CRUST_CONFIG: config },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, code: proc.exitCode };
}

describe("loadConfig honesty", () => {
  test("a missing config stays silent — the file is optional", async () => {
    const r = await runWith(join(dir, "nope-init.ts"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
    expect(r.stderr).not.toContain("failed to load");
  });

  test("/dev/null stays silent — the loader names the config itself", async () => {
    // The shape every other spawn-test in this repo relies on: /dev/null
    // EXISTS but is not a module, and the error quotes the config path —
    // "Cannot find module '/dev/null'" — so it reads as "no config", not
    // "config failed". A dependency failure quotes the PACKAGE instead.
    const r = await runWith("/dev/null");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
    expect(r.stderr).not.toContain("failed to load");
  });

  test("a config that throws is a loud warning, and the session continues", async () => {
    const p = join(dir, "throws.ts");
    await writeFile(p, 'throw new Error("boom-config");\n');
    const r = await runWith(p);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
    expect(r.stderr).toContain("failed to load");
    expect(r.stderr).toContain("boom-config");
  });

  test("a config importing an unresolvable package is a loud warning, not a shrug", async () => {
    // The regression this pins: ERR_MODULE_NOT_FOUND raised from INSIDE an
    // existing config used to match the "config missing" silence.
    const p = join(dir, "bad-import.ts");
    await writeFile(p, 'import "crust-no-such-pkg-xyz";\ncrust.fn("never", () => []);\n');
    const r = await runWith(p);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("failed to load");
    expect(r.stderr).toContain("crust-no-such-pkg-xyz");
  });
});
