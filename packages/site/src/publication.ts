import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { compareStrings } from "./diagnostics";
import { filesystemPath as path } from "./fs-path";

/** Tests inject failures without intercepting transaction metadata operations. */
export interface PublishFs {
  rename: (from: string, to: string) => Promise<void>;
  copyTree: (from: string, to: string) => Promise<void>;
}

export const TRANSACTION_RE = /^\.crust-out-txn-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;

interface Transaction {
  readonly journal: string;
  readonly old: string;
  readonly output: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function copyFallback(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EXDEV";
}

/** Source trees contain only regular files and directories. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) =>
    compareStrings(a.name, b.name),
  );
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

function dependencies(overrides?: Partial<PublishFs>): PublishFs {
  return { rename, copyTree, ...overrides };
}

function transaction(output: string, suffix: string): Transaction {
  const parent = path.dirname(output);
  return {
    journal: path.join(parent, `.crust-out-txn-${suffix}`),
    old: path.join(parent, `.crust-out-old-${suffix}`),
    output,
  };
}

async function mark(tx: Transaction, state: string): Promise<void> {
  // Empty, immutable markers: process death cannot leave half a JSON record.
  await writeFile(path.join(tx.journal, state), "", { flag: "wx" });
}

async function prune(tx: Transaction): Promise<void> {
  // Keep the terminal marker until ALL backup removal has completed. If a
  // recursive rm dies halfway, recovery must not restore the remaining half.
  await rm(tx.old, { recursive: true, force: true });
  // Remove "first"/"previous" BEFORE terminal markers. A kill during removal
  // of a committed first-build journal must not turn it back into "first".
  for (const name of await readdir(tx.journal)) {
    if (name !== "committed" && name !== "restored") {
      await rm(path.join(tx.journal, name), { recursive: true, force: true });
    }
  }
  await rm(tx.journal, { recursive: true, force: true });
}

async function restore(tx: Transaction, fs: PublishFs): Promise<void> {
  // Never merge a backup into an incomplete publish/recovery target.
  await rm(tx.output, { recursive: true, force: true });
  try {
    await fs.rename(tx.old, tx.output);
  } catch (error) {
    if (!copyFallback(error)) throw error;
    await fs.copyTree(tx.old, tx.output);
  }
  await mark(tx, "restored");
  await prune(tx).catch(() => {});
}

async function recover(tx: Transaction, fs: PublishFs): Promise<void> {
  const states = new Set(await readdir(tx.journal));
  if (states.has("committed") || states.has("restored")) {
    await prune(tx);
    return;
  }
  const oldExists = await exists(tx.old);
  if (states.has("copying-backup") && !states.has("backup-ready")) {
    // The original output has not been touched until backup-ready is written.
    // This old tree is a PARTIAL backup, never a recovery source.
    await prune(tx);
    return;
  }
  if (states.has("first")) {
    if (states.has("previous") || oldExists) {
      throw new Error(`ambiguous publication transaction ${JSON.stringify(tx.journal)}`);
    }
    await rm(tx.output, { recursive: true, force: true });
    await prune(tx);
    return;
  }
  if (oldExists) {
    // Also covers a legacy backup adopted just before a kill, before its
    // "previous" marker was written. No backup copy starts before that marker.
    await restore(tx, fs);
    return;
  }
  if (states.has("previous") && !(await exists(tx.output))) {
    throw new Error(`previous output and backup are missing for ${JSON.stringify(tx.journal)}`);
  }
  // No backup: either nothing moved yet, or a restore rename completed just
  // before termination. In both cases the existing output must stay untouched.
  await rm(tx.journal, { recursive: true, force: true });
}

/**
 * Caller MUST hold the output lock. A transaction can belong to this same live
 * PID after a failed publish; the lock, not the journal PID, proves exclusivity.
 * Paired backups are excluded from legacy orphan cleanup even if pruning fails.
 */
export async function recoverTransactions(
  output: string,
  hash: string,
  overrides?: Partial<PublishFs>,
): Promise<Set<string>> {
  const paired = new Set<string>();
  const transactions: Transaction[] = [];
  for (const name of (await readdir(path.dirname(output))).sort(compareStrings)) {
    const match = TRANSACTION_RE.exec(name);
    if (match?.[1] !== hash) continue;
    const tx = transaction(output, name.slice(".crust-out-txn-".length));
    paired.add(path.basename(tx.old));
    transactions.push(tx);
  }
  for (const tx of transactions) {
    try {
      await recover(tx, dependencies(overrides));
    } catch (error) {
      throw new Error(
        `could not recover publication (${messageOf(error)}); retained backup at ${JSON.stringify(tx.old)}`,
        { cause: error },
      );
    }
  }
  return paired;
}

/** Journal legacy recovery BEFORE its first possible partial copy. Lock required. */
export async function adoptLegacyBackup(
  old: string,
  output: string,
  overrides?: Partial<PublishFs>,
): Promise<void> {
  const name = path.basename(old);
  const tx = transaction(output, name.slice(".crust-out-old-".length));
  await mkdir(tx.journal);
  await mark(tx, "previous");
  try {
    await restore(tx, dependencies(overrides));
  } catch (error) {
    throw new Error(
      `restoring the previous output failed (${messageOf(error)}); the previous output is at ${JSON.stringify(old)}`,
      { cause: error },
    );
  }
}

/**
 * Caller holds the output lock. Rename is preferred; EPERM/EXDEV copies are
 * journaled. Commit precedes cleanup, so a kill during backup deletion preserves
 * the new output. Failed recovery retains both its journal and intact backup.
 */
export async function publishOutput(
  staging: string,
  output: string,
  hash: string,
  overrides?: Partial<PublishFs>,
): Promise<void> {
  const fs = dependencies(overrides);
  const previous = await exists(output);
  const tx = transaction(output, `${hash}-${process.pid}-${randomBytes(6).toString("hex")}`);
  await mkdir(tx.journal);
  await mark(tx, previous ? "previous" : "first");
  let backupReady = false;
  try {
    if (previous) {
      try {
        await fs.rename(output, tx.old);
        backupReady = true;
      } catch (error) {
        if (!copyFallback(error)) throw error;
        await mark(tx, "copying-backup");
        await fs.copyTree(output, tx.old);
        await mark(tx, "backup-ready");
        backupReady = true;
        await rm(output, { recursive: true, force: true });
      }
    }
    try {
      await fs.rename(staging, output);
    } catch (error) {
      if (!copyFallback(error)) throw error;
      await fs.copyTree(staging, output);
    }
    await mark(tx, "committed");
  } catch (error) {
    if (backupReady) {
      try {
        await restore(tx, fs);
      } catch (restoreError) {
        throw new Error(
          `publish failed (${messageOf(error)}) AND restoring the previous output failed ` +
            `(${messageOf(restoreError)}); the previous output is at ${JSON.stringify(tx.old)}`,
          { cause: error },
        );
      }
    } else {
      // No destructive operation on an existing output preceded backup-ready.
      // A first publish can still have left an incomplete target, however.
      if (!previous) await rm(output, { recursive: true, force: true });
      await prune(tx).catch(() => {});
    }
    throw error;
  }
  // Nothing after commit can turn this into a rollback of the new output.
  await prune(tx).catch(() => {});
  await rm(staging, { recursive: true, force: true }).catch(() => {});
}
