import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildError } from "../src/diagnostics";
import { acquireBuildLock, buildLockHash, cleanupStale, isCustodianSibling } from "../src/emit";
import { isWindowsPath, toPosix } from "../src/fs-path";

const emit = fileURLToPath(new URL("../src/emit.ts", import.meta.url));
const roots: string[] = [];
async function fixture(): Promise<{ root: string; output: string; slot: string }> {
  const root = await mkdtemp(join(tmpdir(), "crust-atomic-lock-"));
  roots.push(root);
  const output = join(root, "dist");
  return { root, output, slot: join(root, `.crust-out-lock-${buildLockHash(output)}`) };
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child barrier timed out")), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function contender(output: string, pause = "none") {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { mock } from "bun:test";
import * as originalFs from "node:fs/promises";
const fs = { ...originalFs };
const input = Bun.stdin.stream().getReader();
const go = () => input.read();
let paused = false;
async function barrier() {
  if (paused) return;
  paused = true;
  console.log("PAUSED");
  await go();
}
const mode = ${JSON.stringify(pause)};
mock.module("node:fs/promises", () => ({
  ...fs,
  link: async (from, to) => {
    if (mode === "claim" && /\\.crust-out-lock-[0-9a-f]{16}$/.test(to)) await barrier();
    if (mode === "reclaim" && to.includes(".crust-out-reclaim-")) await barrier();
    return fs.link(from, to);
  },
  rm: async (name, ...args) => {
    await fs.rm(name, ...args);
    if (mode === "reclaim-unlinked" && /\\.crust-out-lock-[0-9a-f]{16}$/.test(name)) await barrier();
    if (mode === "gate-unlinked" && name.includes(".crust-out-reclaim-")) await barrier();
  },
  readdir: async (name, ...args) => {
    const entries = await fs.readdir(name, ...args);
    if (mode === "sweep-error" && entries.some(entry => /\\.crust-out-lock-[0-9a-f]{16}$/.test(entry))) {
      throw Object.assign(new Error("forced gate scan failure"), { code: "EIO" });
    }
    return entries;
  },
  // Also reproduces the original private-file election's vulnerable window.
  writeFile: async (name, ...args) => {
    if (mode === "claim" && /\\.crust-out-lock-[0-9a-f]{16}-\\d+-[0-9a-f]+$/.test(name)) await barrier();
    return fs.writeFile(name, ...args);
  }
}));
const { acquireBuildLock } = await import(${JSON.stringify(emit)});
if (mode === "start") await barrier();
try {
  const release = await acquireBuildLock(${JSON.stringify(output)});
  console.log("HELD");
  await go();
  await release();
  console.log("RELEASED");
  process.exit(0);
} catch (error) {
  console.log("ERROR " + (error.diagnostics?.[0]?.code ?? error.message));
  process.exit(0);
}`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  let pending = "";
  async function line(): Promise<string> {
    return deadline(
      (async () => {
        for (;;) {
          const end = pending.indexOf("\n");
          if (end >= 0) {
            const value = pending.slice(0, end).trim();
            pending = pending.slice(end + 1);
            return value;
          }
          const { done, value } = await reader.read();
          if (done) throw new Error(`child exited before its barrier: ${pending}; ${await stderr}`);
          pending += new TextDecoder().decode(value);
        }
      })(),
    );
  }
  return {
    child,
    line,
    go: () => child.stdin.write("\n"),
    stop: async () => {
      child.kill();
      await child.exited;
      await reader.cancel();
      await stderr;
    },
  };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

function gateFor(slot: string, token: string): string {
  const normalized = toPosix(slot);
  const identity = isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(slot, "..", `.crust-out-reclaim-${key}-${token}`);
}

describe("atomic output lock", () => {
  test("a paused earlier contender cannot preempt an already-returned holder", async () => {
    const { root, output } = await fixture();
    const earlier = await contender(output, "claim");
    let later: Awaited<ReturnType<typeof contender>> | undefined;
    try {
      expect(await earlier.line()).toBe("PAUSED");
      later = await contender(output);
      expect(await later.line()).toBe("HELD");
      earlier.go();
      expect(await earlier.line()).toBe("ERROR build.busy");
      later.go();
      expect(await later.line()).toBe("RELEASED");
    } finally {
      await earlier.stop();
      await later?.stop();
    }
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("six simultaneous processes have exactly one holder", async () => {
    const { root, output } = await fixture();
    const children: Awaited<ReturnType<typeof contender>>[] = [];
    try {
      for (let i = 0; i < 6; i += 1) children.push(await contender(output, "start"));
      expect(await Promise.all(children.map((child) => child.line()))).toEqual(
        Array(6).fill("PAUSED"),
      );
      for (const child of children) child.go();
      const results = await Promise.all(children.map((child) => child.line()));
      expect(results.filter((line) => line === "HELD")).toHaveLength(1);
      expect(results.filter((line) => line === "ERROR build.busy")).toHaveLength(5);
      const winner = children[results.indexOf("HELD")];
      winner.go();
      expect(await winner.line()).toBe("RELEASED");
    } finally {
      await Promise.all(children.map((child) => child.stop()));
    }
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("a delayed stale-owner reclaimer cannot unlink a successor", async () => {
    const { output, slot } = await fixture();
    await writeFile(slot, JSON.stringify({ pid: await deadPid(), token: "a".repeat(24) }));
    const delayed = await contender(output, "reclaim");
    let winner: Awaited<ReturnType<typeof contender>> | undefined;
    try {
      expect(await delayed.line()).toBe("PAUSED");
      winner = await contender(output);
      expect(await winner.line()).toBe("HELD");
      const held = await readFile(slot, "utf8");
      delayed.go();
      expect(await delayed.line()).toBe("ERROR build.busy");
      expect(await readFile(slot, "utf8")).toBe(held);
      winner.go();
      expect(await winner.line()).toBe("RELEASED");
    } finally {
      await delayed.stop();
      await winner?.stop();
    }
  });

  test("recovers both a dead owner and its killed reclaimer", async () => {
    const { root, output, slot } = await fixture();
    const owner = { pid: await deadPid(), token: "b".repeat(24) };
    const reclaimer = { pid: await deadPid(), token: "c".repeat(24) };
    await writeFile(slot, JSON.stringify(owner));
    const identity = isWindowsPath(slot) ? toPosix(slot).toLowerCase() : toPosix(slot);
    const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    await writeFile(
      join(root, `.crust-out-reclaim-${key}-${owner.token}`),
      JSON.stringify(reclaimer),
    );
    const release = await acquireBuildLock(output);
    try {
      expect(JSON.parse(await readFile(slot, "utf8")).pid).toBe(process.pid);
    } finally {
      await release();
    }
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("cleans a detached gate after a post-unlink reclaimer kill", async () => {
    const { root, output, slot } = await fixture();
    const owner = { pid: await deadPid(), token: "a".repeat(24) };
    const gate = gateFor(slot, owner.token);
    await writeFile(slot, JSON.stringify(owner));
    const reclaimer = await contender(output, "reclaim-unlinked");
    try {
      expect(await reclaimer.line()).toBe("PAUSED");
      expect(await Bun.file(slot).exists()).toBe(false);
      expect(JSON.parse(await readFile(gate, "utf8")).pid).toBe(reclaimer.child.pid);
    } finally {
      await reclaimer.stop();
    }
    await cleanupStale(output);
    await cleanupStale(output);
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("cleans detached nested gates after a gate-sweeper kill", async () => {
    const { root, output, slot } = await fixture();
    const owner = { pid: await deadPid(), token: "b".repeat(24) };
    const gate = gateFor(slot, "a".repeat(24));
    const nested = gateFor(gate, owner.token);
    await writeFile(gate, JSON.stringify(owner));
    const sweeper = await contender(output, "gate-unlinked");
    try {
      expect(await sweeper.line()).toBe("PAUSED");
      expect(await Bun.file(gate).exists()).toBe(false);
      expect(JSON.parse(await readFile(nested, "utf8")).pid).toBe(sweeper.child.pid);
    } finally {
      await sweeper.stop();
    }
    await cleanupStale(output);
    await cleanupStale(output);
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("preserves detached live and unreadable gate metadata", async () => {
    const { root, output, slot } = await fixture();
    const gates = ["1", "2", "3", "4"].map((digit) => gateFor(slot, digit.repeat(24)));
    const live = JSON.stringify({ pid: process.pid, token: "c".repeat(24) });
    await writeFile(gates[0], live);
    await writeFile(gates[1], "");
    await writeFile(gates[2], '{"pid":0,"token":"bad"}');
    await mkdir(gates[3]);
    const release = await acquireBuildLock(output);
    try {
      expect(await readFile(gates[0], "utf8")).toBe(live);
      expect(await readFile(gates[1], "utf8")).toBe("");
      expect(await readFile(gates[2], "utf8")).toBe('{"pid":0,"token":"bad"}');
      expect(await readdir(gates[3])).toEqual([]);
    } finally {
      await release();
    }
    expect((await readdir(root)).filter(isCustodianSibling).sort()).toEqual(
      gates.map((gate) => basename(gate)).sort(),
    );
  });

  test("a detached-gate sweep cannot unlink a replacement live reclaimer", async () => {
    const { root, output } = await fixture();
    const otherOutput = join(root, "other-dist");
    const otherSlot = join(root, `.crust-out-lock-${buildLockHash(otherOutput)}`);
    const dead = await deadPid();
    const owner = { pid: dead, token: "a".repeat(24) };
    const gate = gateFor(otherSlot, owner.token);
    await writeFile(otherSlot, JSON.stringify(owner));
    await writeFile(gate, JSON.stringify({ pid: dead, token: "b".repeat(24) }));
    const delayed = await contender(output, "reclaim");
    let replacement: Awaited<ReturnType<typeof contender>> | undefined;
    try {
      expect(await delayed.line()).toBe("PAUSED");
      replacement = await contender(otherOutput, "reclaim-unlinked");
      expect(await replacement.line()).toBe("PAUSED");
      const held = await readFile(gate, "utf8");
      expect(JSON.parse(held).pid).toBe(replacement.child.pid);
      delayed.go();
      expect(await delayed.line()).toBe("HELD");
      expect(await readFile(gate, "utf8")).toBe(held);
      delayed.go();
      expect(await delayed.line()).toBe("RELEASED");
      replacement.go();
      expect(await replacement.line()).toBe("HELD");
      replacement.go();
      expect(await replacement.line()).toBe("RELEASED");
    } finally {
      await delayed.stop();
      await replacement?.stop();
    }
    await cleanupStale(output);
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
  });

  test("a detached-gate sweep failure releases its newly acquired output lock", async () => {
    const { root, output } = await fixture();
    const failing = await contender(output, "sweep-error");
    try {
      expect(await failing.line()).toBe("ERROR forced gate scan failure");
    } finally {
      await failing.stop();
    }
    expect((await readdir(root)).filter(isCustodianSibling)).toEqual([]);
    const release = await acquireBuildLock(output);
    await release();
  });

  test("reclaims a real killed holder, not only fabricated stale files", async () => {
    const { output } = await fixture();
    const holder = await contender(output);
    try {
      expect(await holder.line()).toBe("HELD");
    } finally {
      await holder.stop();
    }
    const release = await acquireBuildLock(output);
    await release();
  });

  test.each(["empty", "invalid", "directory"])(
    "never reclaims %s metadata as a dead owner",
    async (kind) => {
      const { output, slot } = await fixture();
      if (kind === "directory") await mkdir(slot);
      else await writeFile(slot, kind === "empty" ? "" : '{"pid":0,"token":"bad"}');
      await expect(acquireBuildLock(output)).rejects.toBeInstanceOf(BuildError);
      expect(
        (await readdir(join(slot, ".."))).some((name) => name === slot.split(/[/\\]/).pop()),
      ).toBe(true);
    },
  );

  test("double release neither removes nor unlocks the successor", async () => {
    const { output, slot } = await fixture();
    const oldRelease = await acquireBuildLock(output);
    await oldRelease();
    const release = await acquireBuildLock(output);
    try {
      const held = await readFile(slot, "utf8");
      await Promise.all([oldRelease(), oldRelease()]);
      expect(await readFile(slot, "utf8")).toBe(held);
      await expect(acquireBuildLock(output)).rejects.toBeInstanceOf(BuildError);
    } finally {
      await release();
    }
  });
});
