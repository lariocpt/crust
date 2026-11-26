import { afterAll, describe, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireBuildLock,
  buildLockHash,
  cleanupStale,
  isCustodianSibling,
  publish,
} from "../src/emit";
import { toPosix } from "../src/fs-path";

const roots: string[] = [];
const emit = fileURLToPath(new URL("../src/emit.ts", import.meta.url));
const previous = {
  "index.html": "OLD\n",
  "old-only.txt": "obsolete\n",
  "nested/data": "\0old bytes\n",
};
const next = { "index.html": "NEW\n", "new-only.txt": "new\n", "nested/data": "\0new bytes\n" };

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
}

async function tree(root: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await tree(root, name));
    else result[name] = (await readFile(join(root, name))).toString("base64");
  }
  return result;
}

async function fixture(first = false) {
  const root = await mkdtemp(join(tmpdir(), "crust-publication-"));
  roots.push(root);
  const output = toPosix(join(root, "dist"));
  const staging = toPosix(join(root, "staging"));
  await seed(staging, next);
  if (!first) await seed(output, previous);
  return { root, output, staging };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function partial(from: string, to: string): Promise<never> {
  await seed(to, {
    "index.html": `partial copy of ${from}`,
    "unexpected-partial.txt": "must not survive restoration",
  });
  throw new Error("partial copy failed");
}

async function copy(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
}

async function litter(root: string): Promise<string[]> {
  return (await readdir(root)).filter(isCustodianSibling).sort();
}

async function backup(root: string): Promise<string> {
  const names = (await readdir(root)).filter((name) => name.startsWith(".crust-out-old-"));
  expect(names).toHaveLength(1);
  return join(root, names[0]);
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("publication child barrier timed out")), 3500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Pause at a real mutation boundary, then kill and wait for the actual owner. */
async function interrupt(staging: string, output: string, mode: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { mock } from "bun:test";
import * as originalFs from "node:fs/promises";
import { join } from "node:path";
const fs = { ...originalFs };
const mode = ${JSON.stringify(mode)};
const staging = ${JSON.stringify(staging)};
const output = ${JSON.stringify(output)};
async function pause() {
  console.log("PAUSED");
  await Bun.stdin.stream().getReader().read();
}
mock.module("node:fs/promises", () => ({
  ...fs,
  rm: async (name, options) => {
    if ((mode === "committed" || mode === "restored") && name.includes(".crust-out-old-")) {
      // Simulate a kill AFTER part of a recursive backup deletion.
      await fs.rm(join(name, "index.html"), { force: true });
      await pause();
    }
    return fs.rm(name, options);
  }
}));
const { acquireBuildLock, publish } = await import(${JSON.stringify(emit)});
const release = await acquireBuildLock(output);
try {
  await publish(staging, output, {
    rename: async (from, to) => {
      if (mode === "backup" || mode === "restore" || mode === "restored" ||
          ((mode === "swap" || mode === "first") && from === staging)) {
        throw Object.assign(new Error("copy fallback"), { code: "EPERM" });
      }
      return fs.rename(from, to);
    },
    copyTree: async (from, to) => {
      const stop = (mode === "backup" && from === output) ||
        ((mode === "swap" || mode === "first") && from === staging) ||
        (mode === "restore" && from.includes(".crust-out-old-"));
      if (stop) {
        await fs.mkdir(to, { recursive: true });
        await fs.writeFile(join(to, "unexpected-partial.txt"), "partial");
        await pause();
      }
      if ((mode === "restore" || mode === "restored") && from === staging) {
        await fs.mkdir(to, { recursive: true });
        await fs.writeFile(join(to, "new-only.txt"), "partial new");
        throw new Error("swap copy failed");
      }
      return fs.cp(from, to, { recursive: true });
    }
  });
  console.log("UNEXPECTED COMPLETION");
} catch (error) {
  console.log("ERROR " + error.message);
} finally {
  await release();
}
process.exit(0);`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  try {
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await deadline(reader.read());
      if (done) throw new Error(`publication child exited early: ${text}; ${await stderr}`);
      text += new TextDecoder().decode(value);
    }
    expect(text.trim()).toBe("PAUSED");
    // Cleanup itself cannot enter the paused publisher's transaction.
    await expect(cleanupStale(output)).rejects.toThrow();
  } finally {
    child.kill();
    await child.exited;
    await reader.cancel();
    await stderr;
  }
}

describe("transactional publication", () => {
  test.each(["rename", "copy"])(
    "partial swap restores exact previous bytes via %s",
    async (restore) => {
      const { root, output, staging } = await fixture();
      const before = await tree(output);
      await expect(
        publish(staging, output, {
          rename: async (from, to) => {
            if (from === staging || (restore === "copy" && from.includes(".crust-out-old-"))) {
              throw errno("EXDEV");
            }
            await rename(from, to);
          },
          copyTree: (from, to) => (from === staging ? partial(from, to) : copy(from, to)),
        }),
      ).rejects.toThrow("partial copy failed");
      expect(await tree(output)).toEqual(before);
      expect(await litter(root)).toEqual([]);
    },
  );

  test("repeated failed restore copies retain the good backup and never merge targets", async () => {
    const { root, output, staging } = await fixture();
    const before = await tree(output);
    await expect(
      publish(staging, output, {
        rename: async (from, to) => {
          if (from === staging || from.includes(".crust-out-old-")) throw errno("EPERM");
          await rename(from, to);
        },
        copyTree: partial,
      }),
    ).rejects.toThrow("restoring the previous output failed");
    const old = await backup(root);
    expect(await tree(old)).toEqual(before);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await seed(output, { "leak-from-last-attempt": "remove before next copy" });
      await expect(
        cleanupStale(output, {
          rename: async () => {
            throw errno("EXDEV");
          },
          copyTree: async (from, to) => {
            await expect(stat(join(to, "leak-from-last-attempt"))).rejects.toThrow();
            return partial(from, to);
          },
        }),
      ).rejects.toThrow("retained backup");
      expect(await tree(old)).toEqual(before);
      expect((await litter(root)).some((name) => name.startsWith(".crust-out-txn-"))).toBe(true);
    }
    await cleanupStale(output);
    expect(await tree(output)).toEqual(before);
    expect(await litter(root)).toEqual([]);
  });

  test("failed backup copy leaves the original intact, not an 'intact copy' claim", async () => {
    const { root, output, staging } = await fixture();
    const before = await tree(output);
    await expect(
      publish(staging, output, {
        rename: async () => {
          throw errno("EPERM");
        },
        copyTree: partial,
      }),
    ).rejects.toThrow("partial copy failed");
    expect(await tree(output)).toEqual(before);
    expect(await litter(root)).toEqual([]);
    await cleanupStale(output);
    expect(await tree(output)).toEqual(before);
  });

  test("a failed first publication removes the incomplete output", async () => {
    const { root, output, staging } = await fixture(true);
    await expect(
      publish(staging, output, {
        rename: async () => {
          throw errno("EXDEV");
        },
        copyTree: partial,
      }),
    ).rejects.toThrow("partial copy failed");
    await expect(stat(output)).rejects.toThrow();
    expect(await litter(root)).toEqual([]);
  });

  test.each(["EPERM", "EXDEV"])("successful %s fallbacks replace wholesale", async (code) => {
    const { root, output, staging } = await fixture();
    const expected = await tree(staging);
    await publish(staging, output, {
      rename: async () => {
        throw errno(code);
      },
    });
    expect(await tree(output)).toEqual(expected);
    await expect(stat(staging)).rejects.toThrow();
    expect(await litter(root)).toEqual([]);
  });

  test("legacy partial recovery is journaled before it can hide the last-good tree", async () => {
    const { root, output } = await fixture();
    const before = await tree(output);
    const child = Bun.spawn([process.execPath, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    const prefix = `.crust-out-old-${buildLockHash(output)}-${child.pid}`;
    const old = join(root, `${prefix}-aaaa`);
    const other = join(root, `${prefix}-bbbb`);
    await rename(output, old);
    await seed(other, { "alternative.txt": "also retained on failure" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        cleanupStale(output, {
          rename: async () => {
            throw errno("EPERM");
          },
          copyTree: partial,
        }),
      ).rejects.toThrow();
      expect(await tree(old)).toEqual(before);
      expect(await readFile(join(other, "alternative.txt"), "utf8")).toContain("retained");
    }
    await cleanupStale(output);
    expect(await tree(output)).toEqual(before);
    expect(await litter(root)).toEqual([]);
  });

  test.each(["committed", "restored"])(
    "%s markers protect output from a partly deleted backup",
    async (state) => {
      const { root, output } = await fixture();
      const before = await tree(output);
      const suffix = `${buildLockHash(output)}-${process.pid}-abcdef`;
      await seed(join(root, `.crust-out-old-${suffix}`), { "leftover.txt": "half deleted" });
      await seed(join(root, `.crust-out-txn-${suffix}`), { previous: "", [state]: "" });
      await cleanupStale(output);
      expect(await tree(output)).toEqual(before);
      expect(await litter(root)).toEqual([]);
    },
  );

  test("an empty journal from terminal-marker removal preserves committed first output", async () => {
    const { root, output } = await fixture();
    const before = await tree(output);
    await mkdir(join(root, `.crust-out-txn-${buildLockHash(output)}-${process.pid}-abcdef`));
    await cleanupStale(output);
    expect(await tree(output)).toEqual(before);
    expect(await litter(root)).toEqual([]);
  });

  test("cleanup refuses the live holder before touching an abandoned transaction", async () => {
    const { root, output } = await fixture();
    const suffix = `${buildLockHash(output)}-${process.pid}-abcdef`;
    await seed(join(root, `.crust-out-old-${suffix}`), previous);
    await seed(join(root, `.crust-out-txn-${suffix}`), { previous: "" });
    const release = await acquireBuildLock(output);
    try {
      const before = await tree(root);
      await expect(cleanupStale(output)).rejects.toThrow();
      expect(await tree(root)).toEqual(before);
    } finally {
      await release();
    }
    await cleanupStale(output);
    expect(await litter(root)).toEqual([]);
  });

  test.each(["swap", "backup", "restore", "committed", "restored", "first"])(
    "recovers a real killed process at the %s boundary",
    async (mode) => {
      const { root, output, staging } = await fixture(mode === "first");
      const expected =
        mode === "committed" ? await tree(staging) : mode === "first" ? null : await tree(output);
      await interrupt(staging, output, mode);
      await cleanupStale(output);
      if (expected === null) await expect(stat(output)).rejects.toThrow();
      else expect(await tree(output)).toEqual(expected);
      expect(await litter(root)).toEqual([]);
      // A second startup must not reinterpret partial output or cleanup state.
      await cleanupStale(output);
      if (expected !== null) expect(await tree(output)).toEqual(expected);
      expect(await litter(root)).toEqual([]);
    },
  );
});
