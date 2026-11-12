import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The npm launcher's install manifest (`npm/install-manifest.json`, gitignored)
 * records which binary was verified, and `readManifest` used to check only the
 * plane. A package version bump (0.3.0 -> 0.3.1) left the stale manifest
 * shadowing the new release until a human deleted the file by hand. The
 * manifest now records the package version it was written for
 * (`packageVersion`); any mismatch — version or plane, malformed or not — is a
 * cache miss: re-resolve, re-verify sha256, rewrite.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmRoot = join(repoRoot, "npm");
// The launcher's manifest path is fixed relative to its own location — in the
// repo that is npm/install-manifest.json (gitignored), so the tests drive it
// in place and clean up after themselves.
const MANIFEST = join(npmRoot, "install-manifest.json");

const OLD_BIN = "#!/bin/sh\necho FAKE-CRUST-OLD\n";
const LATEST_VERSION = "0.3.0+cafe123";
// What the fake release binary answers for `--build-info`. The version and the
// short sha it records mirror LATEST_VERSION the way a real apps-plane build's
// provenance mirrors its own version string (`0.3.0+cafe123` ≡ sha cafe123).
const BUILD_INFO_JSON =
  '{"version":"0.3.0+cafe123","gitCommit":"cafe123","bun":"1.3.14","platform":"linux-x64"}';
// Besides answering `--version`, the fake binary answers `--build-info`, so the
// shim-layer tests can pin the real entry point against the bytes a binary emits.
const NEW_BIN = `#!/bin/sh
if [ "$1" = "--build-info" ]; then
  echo '${BUILD_INFO_JSON}'
  exit 0
fi
echo FAKE-CRUST-NEW
`;

let dir: string;
let savedEnv: { XDG_CACHE_HOME?: string; CRUST_APPS_URL?: string; CRUST_SOURCE?: string };
let server: ReturnType<typeof Bun.serve>;
let binaryFetches = 0;
let mod: typeof import("../npm/lib/install.mjs");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function manifestJson(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

async function writeManifest(fields: Record<string, unknown> | string): Promise<void> {
  await writeFile(MANIFEST, typeof fields === "string" ? fields : manifestJson(fields));
}

/** A fake binary at <dir>/<rel>, parents created (node writeFile makes no dirs). */
async function makeBin(rel: string, content: string): Promise<string> {
  const bin = join(dir, rel);
  await mkdir(dirname(bin), { recursive: true });
  await writeFile(bin, content);
  return bin;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-manifest-"));

  // install.mjs snapshots APPS_URL / CACHE_ROOT from process.env at IMPORT time,
  // so the environment must point at the throwaway plane before the first import.
  savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    CRUST_APPS_URL: process.env.CRUST_APPS_URL,
    CRUST_SOURCE: process.env.CRUST_SOURCE,
  };
  // Row shape mirrors the real index.tsv: RELATIVE path (the launcher builds
  // ${APPS_URL}/${path}), bare file name, and a /latest/ alias row.
  const indexTsv =
    "# kind\tname\tversion\tfile\tsha256\tbytes\tpath\n" +
    `tool\tcrust\t${LATEST_VERSION}\tcrust\t${sha256(NEW_BIN)}\t` +
    `${Buffer.byteLength(NEW_BIN)}\ttools/crust/latest/crust\n`;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/index.tsv") return new Response(indexTsv);
      if (url.pathname.includes("/latest/")) {
        binaryFetches += 1;
        return new Response(NEW_BIN);
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  process.env.CRUST_APPS_URL = `http://127.0.0.1:${server.port}`;
  process.env.CRUST_SOURCE = "apps";

  mod = await import("../npm/lib/install.mjs");
});

afterAll(async () => {
  server.stop(true);
  for (const key of ["XDG_CACHE_HOME", "CRUST_APPS_URL", "CRUST_SOURCE"] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(MANIFEST, { force: true });
  await rm(dir, { recursive: true, force: true });
});

describe("readManifest: a matching manifest is a cache hit", () => {
  test("written for this package version, on this plane", async () => {
    const bin = await makeBin("unit/bin-hit", OLD_BIN);
    await writeManifest({
      source: "github",
      version: "1.2.3",
      packageVersion: "1.2.3",
      bin,
      sha256: "aa".repeat(32),
      from: "github.com/lariocpt/crust@v1.2.3",
    });
    expect(mod.readManifest({ version: "1.2.3" }, "github")?.bin).toBe(bin);
  });

  test("legacy manifest (no packageVersion): the binary version matches", async () => {
    // What every install on disk looks like until the launcher is upgraded.
    const bin = await makeBin("unit/bin-legacy", OLD_BIN);
    await writeManifest({
      source: "github",
      version: "1.2.3",
      bin,
      sha256: "aa".repeat(32),
      from: "github.com/lariocpt/crust@v1.2.3",
    });
    expect(mod.readManifest({ version: "1.2.3" }, "github")?.bin).toBe(bin);
  });

  test("legacy manifest across the two LAN planes: same build, two spellings", async () => {
    // npm-plane package 1.2.3-ci.7.abc1234, apps-plane binary 1.2.3+abc1234 —
    // the core version is what ties them, so a pre-upgrade manifest stays a hit.
    const bin = await makeBin("unit/bin-planes", OLD_BIN);
    await writeManifest({
      source: "apps",
      version: "1.2.3+abc1234",
      bin,
      sha256: "bb".repeat(32),
      from: "apps.in.drlario.org",
    });
    expect(mod.readManifest({ version: "1.2.3-ci.7.abc1234" }, "apps")?.bin).toBe(bin);
  });
});

describe("readManifest: a version-mismatched manifest is a miss", () => {
  test("recorded packageVersion is behind the bumped package", async () => {
    const bin = await makeBin("unit/bin-bump", OLD_BIN);
    await writeManifest({
      source: "github",
      version: "0.3.0",
      packageVersion: "0.3.0",
      bin,
      sha256: "cc".repeat(32),
      from: "github.com/lariocpt/crust@v0.3.0",
    });
    expect(mod.readManifest({ version: "0.3.1" }, "github")).toBeNull();
  });

  test("legacy manifest: recorded binary version is behind the package", async () => {
    const bin = await makeBin("unit/bin-legacy-bump", OLD_BIN);
    await writeManifest({
      source: "github",
      version: "0.3.0",
      bin,
      sha256: "cc".repeat(32),
      from: "github.com/lariocpt/crust@v0.3.0",
    });
    expect(mod.readManifest({ version: "0.3.1" }, "github")).toBeNull();
  });

  test("legacy manifest across the LAN planes: a base bump is still a miss", async () => {
    const bin = await makeBin("unit/bin-planes-bump", OLD_BIN);
    await writeManifest({
      source: "apps",
      version: "0.3.0+deadbee",
      bin,
      sha256: "dd".repeat(32),
      from: "apps.in.drlario.org",
    });
    expect(mod.readManifest({ version: "0.3.1-ci.9.abc1234" }, "apps")).toBeNull();
  });

  test("the plane-mismatch guard still stands on its own", async () => {
    const bin = await makeBin("unit/bin-plane", OLD_BIN);
    await writeManifest({
      source: "apps",
      version: "1.2.3",
      packageVersion: "1.2.3",
      bin,
      sha256: "ee".repeat(32),
      from: "apps.in.drlario.org",
    });
    expect(mod.readManifest({ version: "1.2.3" }, "github")).toBeNull();
  });
});

describe("readManifest: a malformed manifest is a miss", () => {
  const noBin = JSON.stringify({ source: "github", version: "1.2.3", packageVersion: "1.2.3" });
  const malformed: Array<[string, string]> = [
    ["unparseable JSON", "{ this is not json"],
    ["an empty file", ""],
    ["JSON null", "null"],
    ["a non-object", "[1, 2, 3]"],
    ["a missing bin field", noBin],
  ];
  for (const [name, text] of malformed) {
    test(name, async () => {
      await writeManifest(text);
      expect(mod.readManifest({ version: "1.2.3" }, "github")).toBeNull();
    });
  }

  test("a bin that no longer exists on disk", async () => {
    await writeManifest({
      source: "github",
      version: "1.2.3",
      packageVersion: "1.2.3",
      bin: join(dir, "vanished/crust"),
      sha256: "ff".repeat(32),
      from: "github.com/lariocpt/crust@v1.2.3",
    });
    expect(mod.readManifest({ version: "1.2.3" }, "github")).toBeNull();
  });

  test("no manifest at all", async () => {
    await rm(MANIFEST, { force: true });
    expect(mod.readManifest({ version: "1.2.3" }, "github")).toBeNull();
  });
});

describe("ensureBinary: a stale manifest self-heals end to end", () => {
  let staleBin: string;
  let pkgVersion: string;

  beforeAll(async () => {
    // The stale binary exists on disk on purpose: the ONLY thing that must reject
    // the manifest below is its version, so a fix cannot win by making every
    // manifest malformed.
    staleBin = join(dir, "e2e/stale/crust");
    await mkdir(dirname(staleBin), { recursive: true });
    await writeFile(staleBin, OLD_BIN);
    pkgVersion = JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8")).version;
    await writeManifest({
      source: "apps",
      version: "0.2.0+deadbee",
      packageVersion: "0.2.0",
      bin: staleBin,
      sha256: sha256(OLD_BIN),
      from: "apps.in.drlario.org",
    });
  });

  test("a manifest written for another package version is re-resolved and rewritten", async () => {
    binaryFetches = 0;
    const logs: string[] = [];
    const m = await mod.ensureBinary({ log: (line: string) => logs.push(line) });
    expect(logs.join("\n")).toContain(`downloading crust ${LATEST_VERSION}`);
    expect(m.bin).not.toBe(staleBin);
    expect(await readFile(m.bin, "utf8")).toBe(NEW_BIN);
    // The only bytes that reached disk came from the plane, hash-verified.
    expect(binaryFetches).toBe(1);
    expect(m.version).toBe(LATEST_VERSION);
    expect(m.packageVersion).toBe(pkgVersion);
    // The rewrite lands on disk: the next run validates against the new version.
    const onDisk = JSON.parse(await readFile(MANIFEST, "utf8"));
    expect(onDisk.packageVersion).toBe(pkgVersion);
    expect(onDisk.version).toBe(LATEST_VERSION);
    expect(onDisk.bin).toBe(m.bin);
    // The stale binary is left alone: the cache is never a trash can.
    expect(await readFile(staleBin, "utf8")).toBe(OLD_BIN);
  });

  test("the rewritten manifest is a hit on the next run", async () => {
    binaryFetches = 0;
    const before = await readFile(MANIFEST, "utf8");
    const m = await mod.ensureBinary({});
    expect(binaryFetches).toBe(0);
    expect(m.bin).toBe(JSON.parse(before).bin);
    expect(await readFile(MANIFEST, "utf8")).toBe(before);
  });

  test("a matching manifest is a cache hit with no network at all", async () => {
    const bin = join(dir, "e2e/hit", LATEST_VERSION, "crust");
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, NEW_BIN);
    await writeManifest({
      source: "apps",
      version: LATEST_VERSION,
      packageVersion: pkgVersion,
      bin,
      sha256: sha256(NEW_BIN),
      from: "apps.in.drlario.org",
    });
    binaryFetches = 0;
    const m = await mod.ensureBinary({});
    expect(binaryFetches).toBe(0);
    expect(m.bin).toBe(bin);
  });
});

describe("the npm shim: a bumped package self-heals through the real entry point", () => {
  let pkgRoot: string;
  let cacheRoot: string;
  let staleBin: string;

  beforeAll(async () => {
    pkgRoot = join(dir, "shim/pkg");
    cacheRoot = join(dir, "shim/cache");
    await mkdir(pkgRoot, { recursive: true });
    // The installed package shape, with the version already bumped.
    const pkg = {
      name: "crust",
      version: "0.3.1",
      type: "module",
      bin: { crust: "./bin/crust" },
      crust: { source: "apps", repo: "lariocpt/crust" },
    };
    await writeFile(join(pkgRoot, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(join(pkgRoot, "bin"), { recursive: true });
    await writeFile(join(pkgRoot, "bin", "crust"), await readFile(join(npmRoot, "bin", "crust")));
    await mkdir(join(pkgRoot, "lib"), { recursive: true });
    const installLib = await readFile(join(npmRoot, "lib", "install.mjs"));
    await writeFile(join(pkgRoot, "lib", "install.mjs"), installLib);
    // The 0.3.0 manifest surviving the bump — the state that used to need a human.
    staleBin = join(cacheRoot, "0.3.0+deadbee", "crust");
    await mkdir(dirname(staleBin), { recursive: true });
    await writeFile(staleBin, OLD_BIN);
    await writeFile(
      join(pkgRoot, "install-manifest.json"),
      manifestJson({
        source: "apps",
        version: "0.3.0+deadbee",
        packageVersion: "0.3.0",
        bin: staleBin,
        sha256: sha256(OLD_BIN),
        from: "apps.in.drlario.org",
      }),
    );
  });

  function runShim(
    args: string[] = ["--version"],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["node", join(pkgRoot, "bin", "crust"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheRoot,
        CRUST_APPS_URL: `http://127.0.0.1:${server.port}`,
      },
    });
    return (async () => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { code: await proc.exited, stdout, stderr };
    })();
  }

  test("the stale manifest is replaced and the verified new binary runs", async () => {
    binaryFetches = 0;
    const r = await runShim();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FAKE-CRUST-NEW");
    expect(r.stdout).not.toContain("FAKE-CRUST-OLD");
    expect(binaryFetches).toBe(1);
    const m = JSON.parse(await readFile(join(pkgRoot, "install-manifest.json"), "utf8"));
    expect(m.packageVersion).toBe("0.3.1");
    expect(m.version).toBe(LATEST_VERSION);
    expect(m.bin).not.toBe(staleBin);
  });

  test("the rewritten manifest pins the binary: the next run is a hit", async () => {
    binaryFetches = 0;
    const r = await runShim();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FAKE-CRUST-NEW");
    expect(binaryFetches).toBe(0);
  });

  test("the real entry point passes --build-info through byte for byte", async () => {
    // The docs tell users to compare releases with `crust --build-info`, and
    // most installs invoke the binary THROUGH this shim — so the provenance
    // JSON must survive the launcher untouched: one stray log line on stdout
    // would corrupt the pipe a CI reader (or jq) consumes, and a mangled exit
    // code would read as a failed build.
    binaryFetches = 0;
    const r = await runShim(["--build-info"]);
    expect(r.code).toBe(0);
    expect(binaryFetches).toBe(0); // the pinned manifest is a hit — no re-download
    expect(r.stdout).toBe(`${BUILD_INFO_JSON}\n`);
    expect(r.stderr).toBe("");
  });
});

describe("assetName: the mongo variant resolves a distinct release asset", () => {
  test("clean builds keep the original name forever", () => {
    expect(mod.assetName("linux", "x64")).toBe("crust-linux-x64");
    expect(mod.assetName("linux", "x64", null)).toBe("crust-linux-x64");
  });
  test("the mongo variant appends its suffix", () => {
    expect(mod.assetName("linux", "x64", "mongo")).toBe("crust-linux-x64-mongo");
    expect(mod.assetName("darwin", "arm64", "mongo")).toBe("crust-darwin-arm64-mongo");
  });
});
