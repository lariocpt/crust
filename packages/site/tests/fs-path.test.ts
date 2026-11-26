import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as nativeResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bannerPathCandidates, stripMultiFileBanners } from "../src/assets";
import { checkOutputOverlap, defineSite, resolveConfigPaths } from "../src/config";
import { discoverContent } from "../src/content";
import { buildLockHash, publish, stagingDirFor, writePages } from "../src/emit";
import { isWindowsPath, filesystemPath as path, pathContains, toPosix } from "../src/fs-path";

const emit = fileURLToPath(new URL("../src/emit.ts", import.meta.url));
const paths = fileURLToPath(new URL("../src/fs-path.ts", import.meta.url));
const temporary: string[] = [];
afterAll(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function probe(script: string, cwd?: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`path probe exited ${code}: ${stderr}\n${stdout}`);
  return stdout;
}

describe("filesystem paths, not URL paths", () => {
  test.each([
    ["C:\\Users\\runner\\site\\dist", "C:/Users/runner/site/dist"],
    ["C:/Users/runner/site/../dist", "C:/Users/runner/dist"],
    ["\\\\server\\share\\site\\dist", "//server/share/site/dist"],
    ["//server/share/site/../dist", "//server/share/dist"],
    ["/srv/site/../dist", "/srv/dist"],
  ])("preserves absolute root %s", (input, expected) => {
    // resolve addresses the real host filesystem; normalize also supports
    // portable POSIX config fixtures on Windows without inventing a drive.
    const resolved =
      process.platform === "win32" && !isWindowsPath(input)
        ? toPosix(nativeResolve(input))
        : expected;
    expect(path.resolve(input)).toBe(resolved);
    expect(path.normalize(input)).toBe(expected);
    expect(path.isAbsolute(expected)).toBe(true);
  });

  test("config-relative paths retain drive and UNC roots independently of host", () => {
    const site = defineSite({
      site: "https://x.dev",
      content: { directory: "../content", defaultLayout: "base" },
      layouts: { base: () => "" },
      assets: { scripts: { app: "src/app.ts" }, publicDirectory: "public" },
      output: { directory: "dist" },
    });
    for (const root of ["C:/project/config", "//server/share/project/config"]) {
      const resolved = resolveConfigPaths(site, root);
      expect(resolved.output.directory).toBe(`${root}/dist`);
      expect(resolved.assets.scripts.app).toBe(`${root}/src/app.ts`);
      expect(resolved.assets.publicDirectory).toBe(`${root}/public`);
      expect(resolved.content.directory).toBe(path.resolve(root, "../content"));
      expect(path.dirname(stagingDirFor(resolved.output.directory))).toBe(root);
    }
    expect(buildLockHash("C:\\project\\dist")).toBe(buildLockHash("C:/project/dist"));
    expect(buildLockHash("C:/Project/Dist")).toBe(buildLockHash("c:/project/dist"));
    expect(buildLockHash("//SERVER/Share/Dist")).toBe(buildLockHash("//server/share/dist"));
  });

  test.each(["/site/dist", "\\site\\dist"])(
    "qualifies root-relative config path %s against its Windows drive or share",
    (directory) => {
      const site = defineSite({
        site: "https://x.dev",
        content: { directory: "/content", defaultLayout: "base" },
        layouts: { base: () => "" },
        assets: { scripts: { app: "/src/app.ts" }, publicDirectory: "/public" },
        output: { directory },
      });
      for (const [configDir, root] of [
        ["C:/project/config", "C:"],
        ["D:/project/config", "D:"],
        ["//server/share/project/config", "//server/share"],
      ]) {
        const resolved = resolveConfigPaths(site, configDir);
        expect(resolved.output.directory).toBe(`${root}/site/dist`);
        expect(resolved.content.directory).toBe(`${root}/content`);
        expect(resolved.assets.scripts.app).toBe(`${root}/src/app.ts`);
        expect(resolved.assets.publicDirectory).toBe(`${root}/public`);
        expect(buildLockHash(resolved.output.directory)).toBe(buildLockHash(`${root}/site/dist`));
        expect(path.dirname(stagingDirFor(resolved.output.directory))).toBe(`${root}/site`);
        expect(() => checkOutputOverlap(resolved)).not.toThrow();
      }
    },
  );

  test("root-relative output cannot bypass Windows config-overlap protection", () => {
    for (const configDir of ["C:/site/config", "//server/share/site/config"]) {
      const resolved = resolveConfigPaths(
        defineSite({
          site: "https://x.dev",
          content: { directory: "D:/external/content", defaultLayout: "base" },
          layouts: { base: () => "" },
          output: { directory: "\\site" },
        }),
        configDir,
      );
      expect(() => checkOutputOverlap(resolved)).toThrow();
      expect(resolved.output.directory).toBe(path.resolve(configDir, "/site"));
    }
  });

  test("disk entry points qualify root-relative paths with native Windows semantics", async () => {
    // Isolate the module mock in a child: exercise the native-path branch on
    // Linux too, without mocking disk I/O or contaminating other test files.
    const stdout = await probe(`
import { mock } from "bun:test";
import * as originalPath from "node:path";
const native = { ...originalPath };
mock.module("node:path", () => ({
  ...native,
  resolve: (...parts) => native.win32.resolve("C:/project", ...parts),
}));
const { buildLockHash, stagingDirFor, devStagingDirFor } = await import(${JSON.stringify(emit)});
const { filesystemPath } = await import(${JSON.stringify(paths)});
console.log(JSON.stringify(["/site/dist", "\\\\site\\\\dist", "C:/site/dist"].map(output => [
  buildLockHash(output),
  filesystemPath.dirname(stagingDirFor(output)),
  filesystemPath.dirname(devStagingDirFor(output)),
])));
`);
    expect(JSON.parse(stdout)).toEqual(
      Array.from({ length: 3 }, () => [buildLockHash("C:/site/dist"), "C:/site", "C:/site"]),
    );
  });

  test.skipIf(process.platform !== "win32")(
    "native Windows aliases share a lock and recover the same journal",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "crust-win-alias-"));
      temporary.push(root);
      const output = join(root, "dist");
      const suffix = `${buildLockHash(output)}-${process.pid}-abcdef`;
      const old = join(root, `.crust-out-old-${suffix}`);
      const journal = join(root, `.crust-out-txn-${suffix}`);
      await mkdir(old);
      await writeFile(join(old, "index.html"), "previous");
      await mkdir(journal);
      await writeFile(join(journal, "previous"), "");
      // Child cwd selects the fixture's drive, even if the CI checkout and
      // the temporary directory live on different drives.
      const stdout = await probe(
        `
const { acquireBuildLock, buildLockHash, cleanupStale } = await import(${JSON.stringify(emit)});
const output = ${JSON.stringify(output)};
const rooted = output.replace(/^[A-Za-z]:/, "");
if (rooted === output) throw new Error("expected a drive-qualified temporary directory");
if (buildLockHash(rooted) !== buildLockHash(output)) throw new Error("different alias hashes");
const release = await acquireBuildLock(output);
try {
  let busy = false;
  try {
    const unexpected = await acquireBuildLock(rooted);
    await unexpected();
  } catch (error) {
    if (error.diagnostics?.[0]?.code !== "build.busy") throw error;
    busy = true;
  }
  if (!busy) throw new Error("root-relative alias bypassed the held output lock");
} finally {
  await release();
}
await cleanupStale(rooted);
console.log("RECOVERED");
`,
        root,
      );
      expect(stdout.trim()).toBe("RECOVERED");
      expect(await readFile(join(output, "index.html"), "utf8")).toBe("previous");
      expect(await readdir(root)).toEqual(["dist"]);
    },
  );

  test("relative paths and containment respect components, drives, and shares", () => {
    expect(path.relative("C:/project", "c:/project/content/x.md")).toBe("content/x.md");
    expect(pathContains("C:/project", "c:/project/dist")).toBe(true);
    expect(pathContains("C:/project", "C:/project-other")).toBe(false);
    expect(pathContains("C:/project", "D:/project/dist")).toBe(false);
    expect(pathContains("//server/share", "//server/other/dist")).toBe(false);
    expect(pathContains("/", "/content")).toBe(true);
  });

  test("content discovery and emission operate on real native absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "crust-native-path-"));
    temporary.push(root);
    await mkdir(join(root, "content", "nested"), { recursive: true });
    await writeFile(join(root, "content", "nested", "page.md"), "# A page\n");
    const resolved = resolveConfigPaths(
      defineSite({
        site: "https://x.dev",
        content: { directory: "content", defaultLayout: "base" },
        layouts: { base: () => "" },
        output: { directory: "dist" },
      }),
      root,
    );
    expect(await discoverContent(resolved)).toEqual([
      {
        absolutePath: toPosix(join(root, "content", "nested", "page.md")),
        relativePath: "nested/page",
      },
    ]);
    const staging = stagingDirFor(resolved.output.directory);
    await writePages(staging, [{ route: "/nested/page", file: "nested/page.html", html: "ok" }]);
    await publish(staging, resolved.output.directory);
    expect(await readFile(join(root, "dist", "nested", "page.html"), "utf8")).toBe("ok");
  });

  test("Windows cross-drive Bun banners have an exact Loose-path candidate", async () => {
    const cwd = "D:/a/crust/crust";
    const entry = "C:/Users/runner/site/src/app.ts";
    const pretty = "../../../../C:/Users/runner/site/src/app.ts";
    expect(bannerPathCandidates(entry, cwd)).toContain(pretty);
    // Metafile keys supply the same exact banner on every host. Non-banner
    // string content is retained; there is no catch-all comment regexp.
    const input = new TextEncoder().encode(`// ${pretty}\nconsole.log("kept");\n// not a banner\n`);
    const stripped = await stripMultiFileBanners(input, entry, ".js", [pretty]);
    expect(new TextDecoder().decode(stripped)).toBe('\nconsole.log("kept");\n// not a banner\n');
  });
});
