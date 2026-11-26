import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { BuildError } from "./diagnostics";
import { isWindowsPath, filesystemPath as path } from "./fs-path";

interface Owner {
  readonly pid: number;
  readonly token: string;
}

const heldHashes = new Set<string>();
const MAX_ATTEMPTS = 25;
const LEGACY_LOCK = /^\.crust-out-lock-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;
const RECLAIM_SLOT = /^\.crust-out-reclaim-[0-9a-f]{16}-[0-9a-f]{24}$/;

/** Only ESRCH proves death. Permission/unknown probe failures are not a lease. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function busy(output: string, pid?: number): BuildError {
  return new BuildError([
    {
      code: "build.busy",
      severity: "error",
      message:
        `another build holds the lock for output ${JSON.stringify(output)} ` +
        (pid === undefined
          ? "(owner metadata is unreadable or initializing)"
          : `(pid ${pid} is still alive)`) +
        "; wait for it to finish — dead owners are reclaimed automatically",
    },
  ]);
}

function sameOwner(a: Owner | null | undefined, b: Owner): boolean {
  return a?.pid === b.pid && a.token === b.token;
}

/** null = absent; undefined = not demonstrably a dead, fully initialized owner. */
async function readOwner(slot: string): Promise<Owner | null | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(slot, "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<Owner>;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string" ||
      !/^[0-9a-f]{24}$/.test(owner.token)
    ) {
      return undefined;
    }
    return owner as Owner;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

function reclaimSlot(slot: string, owner: Owner): string {
  // Fixed-length names even if a reclaimer itself dies and needs recovery.
  const identity = isWindowsPath(slot) ? slot.toLowerCase() : slot;
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(path.dirname(slot), `.crust-out-reclaim-${key}-${owner.token}`);
}

function releaseSlot(slot: string, owner: Owner): () => Promise<void> {
  let releasing: Promise<void> | undefined;
  return () => {
    releasing ??= (async () => {
      // Live owners are never evicted by this protocol. A successor's token
      // cannot be removed by a delayed/double release from its predecessor.
      if (sameOwner(await readOwner(slot), owner)) await rm(slot, { force: true });
    })();
    return releasing;
  };
}

async function claimSlot(
  slot: string,
  candidate: string,
  owner: Owner,
  output: string,
  depth = 0,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      // link is an atomic create-if-absent of one SHARED name, not a scan +
      // election among private names. Metadata is complete before it appears.
      await link(candidate, slot);
      return releaseSlot(slot, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const previous = await readOwner(slot);
    if (previous === null) continue;
    if (previous === undefined || pidAlive(previous.pid)) throw busy(output, previous?.pid);
    if (depth >= MAX_ATTEMPTS) break;

    // Serialize reclaimers of this EXACT dead identity. Without this gate,
    // a delayed check-then-unlink could delete a new, already-held claim.
    // Gates use the same protocol, so a killed reclaimer is recoverable too.
    const releaseGate = await claimSlot(
      reclaimSlot(slot, previous),
      candidate,
      owner,
      output,
      depth + 1,
    );
    try {
      if (sameOwner(await readOwner(slot), previous) && !pidAlive(previous.pid)) {
        await rm(slot, { force: true });
      }
    } finally {
      await releaseGate();
    }
  }
  throw new Error(
    `could not acquire the build lock for ${JSON.stringify(output)} after bounded recovery`,
  );
}

async function sweepDeadGates(
  parent: string,
  candidate: string,
  owner: Owner,
  output: string,
): Promise<void> {
  // A kill after unlinking a slot can detach its gate from the recovery chain.
  // Scan the whole parent: nested gates have opaque keys, and their immediate
  // parent gate may already be gone. Never sweep canonical output slots here.
  for (const name of await readdir(parent)) {
    if (!RECLAIM_SLOT.test(name)) continue;
    const slot = path.join(parent, name);
    const previous = await readOwner(slot);
    if (!previous || pidAlive(previous.pid)) continue;
    let release: () => Promise<void>;
    try {
      // A check-then-unlink could delete a replacement live gate. Claim it
      // through the SAME protocol, including recovery of dead nested gates.
      release = await claimSlot(slot, candidate, owner, output);
    } catch (error) {
      // Another reclaimer may have replaced the dead owner since our read.
      // Its live gate must not block a build for an unrelated output.
      if (error instanceof BuildError && error.diagnostics[0]?.code === "build.busy") continue;
      throw error;
    }
    await release();
  }
}

/** One claim per output; caller supplies the already-normalized output identity. */
export async function acquireOutputLock(
  output: string,
  hash: string,
): Promise<() => Promise<void>> {
  if (heldHashes.has(hash)) throw busy(output, process.pid);
  heldHashes.add(hash);
  const parent = path.dirname(output);
  const owner: Owner = { pid: process.pid, token: randomBytes(12).toString("hex") };
  const candidate = path.join(parent, `.crust-out-owner-${hash}-${owner.pid}-${owner.token}`);
  try {
    await mkdir(parent, { recursive: true });
    // Respect older on-disk live claims and reclaim their unique dead files.
    for (const name of await readdir(parent)) {
      const match = LEGACY_LOCK.exec(name);
      if (match?.[1] !== hash) continue;
      const pid = Number(match[2]);
      if (pidAlive(pid)) throw busy(output, pid);
      await rm(path.join(parent, name), { force: true });
    }
    await writeFile(candidate, JSON.stringify(owner), { flag: "wx" });
    const release = await claimSlot(
      path.join(parent, `.crust-out-lock-${hash}`),
      candidate,
      owner,
      output,
    );
    try {
      await sweepDeadGates(parent, candidate, owner, output);
    } catch (error) {
      await release();
      throw error;
    }
    let releasing: Promise<void> | undefined;
    return () => {
      releasing ??= (async () => {
        try {
          await release();
        } finally {
          try {
            await rm(candidate, { force: true });
          } finally {
            heldHashes.delete(hash);
          }
        }
      })();
      return releasing;
    };
  } catch (error) {
    try {
      await rm(candidate, { force: true });
    } finally {
      heldHashes.delete(hash);
    }
    throw error;
  }
}
