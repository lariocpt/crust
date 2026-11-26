// The CLI e2e (plan §5, chunk 9), spawned as the shipped entry point
// (`bun <package>/src/cli.ts ...`) — the contract is tested the way an
// installer would hit it:
//
//   build — exit 0 with ONE summary line on stdout (nothing else; stderr is
//           empty on success), exit 1 with every diagnostic formatted as
//           `severity[code]: message` + ` --> sourcePath:line:col` on stderr
//           (stdout stays empty on failure), the previous output untouched;
//   dev   — the wrapper/worker loop: the serving URL line on stdout (the
//           only stdout), rebuild lines on stderr after a content edit, a
//           worker RESTART (re-exec) on a config change, SIGINT forwarded →
//           exit 130 with the port really closed and no staging litter, and
//           EADDRINUSE → exit 1 with the `dev.port-in-use` diagnostic;
//   argument errors exit 2 with the usage, --help exits 0 (the same pins
//           live in scaffold.test.ts — the contract, from the user's side).
//
// Ports: the dev tests use an EPHEMERAL port (no `dev` key in the config)
// and parse the bound port from the worker's stdout URL line; the
// EADDRINUSE case keeps an ephemeral IPv4 socket open and configures that
// exact address (the dev server itself never auto-increments).

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SRC_INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SITE = "https://example.dev";

const created: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

/** The shipped CLI, collected to the end (for commands that terminate). */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

/**
 * The shipped CLI, LIVE: both streams are pumped into buffers as they
 * arrive, so a test can wait for a line on either stream while the process
 * is still running (the dev wrapper never terminates on its own).
 */
function cliLive(args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sinks: Record<"out" | "err", Uint8Array[]> = { out: [], err: [] };
  const pump = (stream: ReadableStream<Uint8Array>, key: "out" | "err"): void => {
    const reader = stream.getReader();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sinks[key].push(value);
      }
    })();
  };
  pump(proc.stdout, "out");
  pump(proc.stderr, "err");
  const text = (key: "out" | "err"): string => new TextDecoder().decode(Buffer.concat(sinks[key]));
  /**
   * Wait for `re` in either stream. With `offsets`, only text arriving AFTER
   * the recorded buffer length is searched — without it, a regex that already
   * matched (e.g. the first serving line) would match again on the same
   * bytes, and a wait for a SECOND occurrence would never actually wait.
   */
  const waitUntil = async (
    re: RegExp,
    timeoutMs: number,
    offsets?: { out?: number; err?: number },
  ): Promise<RegExpMatchArray> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = text("out");
      const outFrom = offsets?.out ?? 0;
      if (out.length > outFrom) {
        const m = out.slice(outFrom).match(re);
        if (m !== null) return m;
      }
      const err = text("err");
      const errFrom = offsets?.err ?? 0;
      if (err.length > errFrom) {
        const m = err.slice(errFrom).match(re);
        if (m !== null) return m;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out (${timeoutMs} ms) waiting for ${re}; stderr so far:\n${text("err")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return {
    proc,
    text,
    waitUntil,
    kill: (signal: "SIGINT" | "SIGTERM"): void => {
      proc.kill(signal);
    },
  };
}

/**
 * Windows cannot emulate Ctrl-C: `proc.kill("SIGINT")` there is a plain
 * TerminateProcess — the wrapper's JS handler never runs, so it neither
 * forwards to the worker nor exits 130 (the observed code is 0xC000013A),
 * and the worker survives as an orphan. A real console Ctrl-C on Windows
 * reaches both processes natively, which no test can reproduce, so the
 * signal-exit contract is asserted on POSIX only.
 */
const SIGNAL_EXIT = process.platform !== "win32";

/**
 * Kill a dev session for good. On Windows TerminateProcess does not reap
 * children, so the whole process tree goes down via taskkill — otherwise an
 * orphaned worker outlives the test holding its port and its staging tree.
 */
function killSession(proc: Bun.Subprocess): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"]);
    } catch {
      // already gone
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // already dead
  }
}

/** Diagnostics and result paths are posix (docs, "Paths"); join() is native. */
const posixOf = (p: string): string => p.replace(/\\/g, "/");

async function exists(path: string): Promise<boolean> {
  return await stat(path)
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// fixtures (self-contained — the CLI package ships alone)
// ---------------------------------------------------------------------------

function configSource(port?: number): string {
  const dev = port === undefined ? "" : `  dev: { hostname: "127.0.0.1", port: ${port} },`;
  return [
    `import { defineSite, html } from ${JSON.stringify(SRC_INDEX)};`,
    "export default defineSite({",
    `  site: ${JSON.stringify(SITE)},`,
    "  content: {",
    '    directory: "content",',
    '    defaultLayout: "base",',
    '    route: ({ relativePath }) => (relativePath === "index" ? "/" : "/" + relativePath),',
    "  },",
    "  layouts: {",
    "    base: (ctx) => html`<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">${"$"}{ctx.head()}${"$"}{ctx.stylesheet("site")}${"$"}{ctx.script("app")}</head><body>${"$"}{ctx.content}</body></html>\`,`,
    "  },",
    '  assets: { scripts: { app: "src/app.ts" }, styles: { site: "src/site.css" }, publicDirectory: "public" },',
    '  output: { directory: "dist" },',
    "  sitemap: true,",
    "  robots: { indexable: true },",
    `${dev}`,
    "});",
    "",
  ].join("\n");
}

/** A complete site (default route map); returns the config path. */
async function makeSite(root: string, port?: number): Promise<string> {
  await mkdir(join(root, "content", "a"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  await writeFile(join(root, "site.config.ts"), configSource(port));
  await writeFile(
    join(root, "content", "index.md"),
    "---\ntitle: Home\ndescription: The home page\n---\n\n# Hello\n\nRebuild marker: V1.\n",
  );
  await writeFile(
    join(root, "content", "a", "b.md"),
    "---\ntitle: B\ndescription: Page B\n---\n\n# B\n\nDeep page.\n",
  );
  await writeFile(
    join(root, "content", "draft.md"),
    "---\ntitle: Draft\ndescription: Work in progress\ndraft: true\n---\n\n# Draft\n",
  );
  await writeFile(join(root, "src", "app.ts"), 'console.log("hi");\n');
  await writeFile(join(root, "src", "site.css"), "body { color: red; }\n");
  await writeFile(join(root, "public", "favicon.txt"), "icon\n");
  return join(root, "site.config.ts");
}

/** A content hash over a file map: the "previous output untouched" proof. */
async function treeHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const r = rel === "" ? name.name : `${rel}/${name.name}`;
      if (name.isDirectory()) await walk(join(d, name.name), r);
      else h.update(`${r}:${await readFile(join(d, name.name))}`);
    }
  };
  await walk(dir, "");
  return h.digest("hex");
}

async function devStagingSiblings(root: string): Promise<string[]> {
  return (await readdir(root)).filter((n) => n.startsWith(".crust-dev-staging-"));
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

describe("crust-site build (e2e)", () => {
  test("a good build exits 0, prints ONE summary line on stdout, nothing on stderr", async () => {
    const root = await tmp("crust-site-cli-build-");
    const cfg = await makeSite(root);
    const dist = join(root, "dist");
    const r = await cli("build", cfg);
    expect(r.code).toBe(0);
    // stdout is EXACTLY the summary line (the machine-consumed channel)
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(
        `^crust-site: built 2 pages, 2 assets, \\d+ ms → ${dist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    );
    expect(r.stderr).toBe("");
    // and the output really is there
    for (const f of [
      "index.html",
      "a/b.html",
      "404.html",
      "sitemap.xml",
      "robots.txt",
      "favicon.txt",
    ]) {
      expect(await exists(join(dist, f))).toBe(true);
    }
    const assets = (await readdir(join(dist, "assets"))).length;
    expect(assets).toBe(2);
  });

  test("a broken build exits 1 with formatted diagnostics (file:line) on stderr, empty stdout; previous output untouched", async () => {
    const root = await tmp("crust-site-cli-buildfail-");
    const cfg = await makeSite(root);
    const dist = join(root, "dist");
    await cli("build", cfg); // a good build first
    const before = await treeHash(dist);

    // missing title on file line 1 (the frontmatter block opens there)
    await writeFile(
      join(root, "content", "index.md"),
      "---\ndescription: no title here\n---\n\n# Broken\n",
    );
    const r = await cli("build", cfg);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error[frontmatter.missing-title]");
    expect(r.stderr).toContain(" --> content/index.md:1:1");
    // ANSI is OFF when stderr is a pipe (spawned streams are never a TTY):
    // the Windows table row "diagnostics degrade gracefully without ANSI"
    // is pinned here through the real artifact, not a flag unit-test.
    expect(r.stderr).not.toContain("\x1b[");
    // the previous output is byte-identical — a failed build never touches it
    expect(await treeHash(dist)).toBe(before);
  });

  test("a MISSING config file exits 1 with a config.load diagnostic naming the path ( --> line)", async () => {
    const root = await tmp("crust-site-cli-nocfg-");
    await mkdir(root, { recursive: true });
    const missing = join(root, "missing-config.ts");
    const r = await cli("build", missing);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error[config.load]");
    expect(r.stderr).toContain(` --> ${posixOf(missing)}`);
  });

  test("a config that fails to LOAD exits 1 with config.load on stderr", async () => {
    const root = await tmp("crust-site-cli-cfgfail-");
    const cfg = join(root, "site.config.ts");
    await mkdir(root, { recursive: true });
    await writeFile(cfg, "export default defineSite({ this is not valid TypeScript\n");
    const r = await cli("build", cfg);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error[config.load]");
  });

  // The usage/README contract: `build` with NO configFile argument renders
  // ./site.config.ts in the process cwd. The child's cwd is the site root,
  // so the default is exercised exactly the way an installer hits it.
  test("a bare build (no configFile) defaults to ./site.config.ts in the cwd", async () => {
    const root = await tmp("crust-site-cli-builddefault-");
    await makeSite(root);
    const proc = Bun.spawn(["bun", CLI, "build"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode ?? -1).toBe(0);
    expect(stdout.split("\n").filter((l) => l !== "")).toHaveLength(1);
    // the summary line prints the posix path (the CLI resolves through
    // toPosix/posix.resolve), never the native backslash form
    expect(stdout).toContain(`→ ${posixOf(join(root, "dist"))}`);
    expect(stderr).toBe("");
    expect(await exists(join(root, "dist", "index.html"))).toBe(true);
  });

  // The default must still fail LOUDLY when the conventional file is absent —
  // a bare build in an empty directory must never read as a success.
  test("a bare build without ./site.config.ts exits 1 with config.load naming the resolved path", async () => {
    const root = await tmp("crust-site-cli-buildnodefault-");
    await mkdir(root, { recursive: true });
    const proc = Bun.spawn(["bun", CLI, "build"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode ?? -1).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("error[config.load]");
    expect(stderr).toContain(` --> ${posixOf(join(root, "site.config.ts"))}`);
  });
});

// ---------------------------------------------------------------------------
// argument errors + help (the user-side copy of the scaffold contract)
// ---------------------------------------------------------------------------

describe("crust-site argument errors (e2e)", () => {
  test("an unknown subcommand exits 2 with the usage", async () => {
    const r = await cli("deploy");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "deploy"');
    expect(r.stderr).toContain("usage:");
    expect(r.stdout).toBe("");
  });

  test("a bare invocation exits 2 with the usage", async () => {
    const r = await cli();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
    expect(r.stdout).toBe("");
  });

  test("two positionals and flag-shaped args are refused (exit 2), for build AND dev", async () => {
    for (const args of [
      ["build", "a.ts", "b.ts"],
      ["build", "--bogus"],
      ["dev", "a.ts", "b.ts"],
      ["dev", "--bogus"],
    ]) {
      const r = await cli(...args);
      // the stderr assertion carries the failing args into the failure message
      expect(r.stderr).toContain("at most one argument");
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
    }
  });

  test("--help exits 0 with the usage on stdout", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("crust-site");
    expect(r.stdout).toContain("usage:");
    expect(r.stderr).toBe("");
  });

  test("--help after a command is still help: exit 0 on BOTH commands (and -h)", async () => {
    for (const args of [
      ["build", "--help"],
      ["dev", "--help"],
      ["build", "-h"],
      ["dev", "-h"],
    ]) {
      const r = await cli(...args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("usage:");
      expect(r.stderr).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// dev: the wrapper/worker loop
// ---------------------------------------------------------------------------

describe("crust-site dev (e2e)", () => {
  test("spawn → serving URL on stdout → fetch → content edit rebuilds → SIGINT exits 130, port closed, no litter", async () => {
    const root = await tmp("crust-site-cli-dev-");
    const cfg = await makeSite(root);
    const live = cliLive(["dev", cfg]);
    try {
      // the serving URL line is the ONLY stdout; the port is parsed from it
      const m = await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000);
      expect(m).not.toBeNull();
      const port = Number(m[1]);
      expect(port).toBeGreaterThan(0);

      // the initial build is served
      let res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Home</title>");

      // a content edit → a rebuild line on stderr (and ONLY on stderr)
      await writeFile(
        join(root, "content", "index.md"),
        "---\ntitle: Home v2\ndescription: Changed\n---\n\n# Hello v2\n\nRebuild marker: V2.\n",
      );
      await live.waitUntil(/rebuilt in \d+ ms — \d+ pages, \d+ drafts?/, 8000);
      expect(live.text("out")).not.toContain("rebuilt");
      res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Rebuild marker: V2.");

      // Ctrl-C: forwarded to the worker, which stops cleanly and exits 130
      if (SIGNAL_EXIT) {
        live.kill("SIGINT");
        await live.proc.exited;
        expect(live.proc.exitCode).toBe(130);
        // the port is really closed
        await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
        // and no staging litter survives
        expect(await devStagingSiblings(root)).toEqual([]);
      }
    } finally {
      // belt and braces: if any assertion above died mid-session, kill the
      // session (the whole tree on Windows) so it cannot outlive the test
      killSession(live.proc);
    }
  });

  test("a config change restarts the worker (sentinel 75 → re-exec) and the new worker serves again", async () => {
    const root = await tmp("crust-site-cli-devrestart-");
    const cfg = await makeSite(root);
    const live = cliLive(["dev", cfg]);
    try {
      const m1 = await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000);
      expect(m1).not.toBeNull();
      const port1 = Number(m1[1]);
      expect(await (await fetch(`http://localhost:${port1}/`)).text()).toContain(
        "<title>Home</title>",
      );

      // a code/config change (the config file itself, under the config dir):
      // the worker must exit with the sentinel and the wrapper must re-exec it
      await writeFile(
        join(root, "site.config.ts"),
        `${await readFile(cfg)}// touched by the test\n`,
      );
      await live.waitUntil(/restarting the dev worker/, 10000);
      // the RE-EXECuted worker prints a SECOND serving line (a new ephemeral
      // port) — the old worker's port is gone, the new one serves
      const before = live.text("out").length;
      // search only NEW stdout bytes: the first serving line is already in
      // the buffer and would match again without the offset
      await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000, { out: before });
      const all = live.text("out").match(/serving http:\/\/localhost:(\d+)\//g) ?? [];
      expect(all).toHaveLength(2);
      expect(live.text("out").length).toBeGreaterThan(before);
      const serving = all[1]?.match(/:(\d+)/);
      if (!serving) throw new Error("missing restarted worker serving port");
      const port2 = Number(serving[1]);
      expect(port2).not.toBe(port1);
      await expect(fetch(`http://localhost:${port1}/`)).rejects.toThrow();
      const res = await fetch(`http://localhost:${port2}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Home</title>");

      // and a Ctrl-C still ends the whole session with 130
      if (SIGNAL_EXIT) {
        live.kill("SIGINT");
        await live.proc.exited;
        expect(live.proc.exitCode).toBe(130);
        expect(await devStagingSiblings(root)).toEqual([]);
      }
    } finally {
      killSession(live.proc);
    }
  });

  test("a burst of 5 content writes coalesces into exactly ONE rebuild", async () => {
    const root = await tmp("crust-site-cli-coalesce-");
    const cfg = await makeSite(root);
    const live = cliLive(["dev", cfg]);
    try {
      await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000);
      const errFrom = live.text("err").length;
      // five writes back-to-back: the debounce window restarts on every
      // event, so ONE rebuild covers the whole burst
      for (let i = 0; i < 5; i++) {
        await writeFile(
          join(root, "content", `burst${i}.md`),
          `---\ntitle: Burst ${i}\ndescription: burst page\n---\n\n# B${i}\n`,
        );
      }
      await live.waitUntil(/rebuilt in \d+ ms/, 8000, { err: errFrom });
      // a straggler watcher event would fire a SECOND rebuild; give it a
      // generous window (debounce is 100 ms) before pinning the count
      await new Promise((r) => setTimeout(r, 1500));
      const rebuilds =
        live
          .text("err")
          .slice(errFrom)
          .match(/rebuilt in \d+ ms/g) ?? [];
      expect(rebuilds).toHaveLength(1);
      if (SIGNAL_EXIT) {
        live.kill("SIGINT");
        await live.proc.exited;
      }
    } finally {
      killSession(live.proc);
    }
  });

  test("a CODE file edit (not the config) also restarts the worker via the sentinel", async () => {
    const root = await tmp("crust-site-cli-coderestart-");
    const cfg = await makeSite(root);
    const live = cliLive(["dev", cfg]);
    try {
      const m1 = await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000);
      const port1 = Number(m1[1]);
      // src/app.ts is under the config dir but not content: a code change
      await writeFile(join(root, "src", "app.ts"), 'console.log("changed");\n');
      await live.waitUntil(/restarting the dev worker/, 10000);
      const before = live.text("out").length;
      await live.waitUntil(/serving http:\/\/localhost:(\d+)\//, 10000, { out: before });
      const all = live.text("out").match(/serving http:\/\/localhost:(\d+)\//g) ?? [];
      expect(all).toHaveLength(2);
      const serving = all[1]?.match(/:(\d+)/);
      if (!serving) throw new Error("missing restarted worker serving port");
      const port2 = Number(serving[1]);
      expect(port2).not.toBe(port1);
      const res = await fetch(`http://localhost:${port2}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Home</title>");
      if (SIGNAL_EXIT) {
        live.kill("SIGINT");
        await live.proc.exited;
        expect(live.proc.exitCode).toBe(130);
        expect(await devStagingSiblings(root)).toEqual([]);
      }
    } finally {
      killSession(live.proc);
    }
  });

  // `dev` shares the CLI's configFile default with `build`: an empty
  // directory must fail with the SAME config.load naming the resolved path.
  test("a bare dev without ./site.config.ts exits 1 with config.load naming the resolved path", async () => {
    const root = await tmp("crust-site-cli-devdefault-");
    await mkdir(root, { recursive: true });
    const proc = Bun.spawn(["bun", CLI, "dev"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode ?? -1).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("error[config.load]");
    expect(stderr).toContain(` --> ${posixOf(join(root, "site.config.ts"))}`);
  });

  test("a configured port in use exits 1 with dev.port-in-use (no auto-increment, no stdout)", async () => {
    const root = await tmp("crust-site-cli-devport-");
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") });
    const port = holder.port;
    try {
      const cfg = await makeSite(root, port);
      const proc = Bun.spawn(["bun", CLI, "dev", cfg], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killSession(proc);
      }, 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(timedOut).toBe(false);
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("error[dev.port-in-use]");
        expect(stderr).toContain(String(port));
      } finally {
        clearTimeout(timer);
        killSession(proc);
        await proc.exited;
      }
      // the holder was never touched
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("held");
      // and no staging litter from the refused start
      expect(await devStagingSiblings(root)).toEqual([]);
    } finally {
      holder.stop(true);
    }
  }, 15_000);
});
