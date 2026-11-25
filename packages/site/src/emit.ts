// Emit + publish (plan §4.1, §4.6): staging writes, the byte-pinned
// sitemap/robots bodies, the generated 404 page, the rename contract that
// swaps staging into place, and the per-output build lock that keeps
// concurrent builds from interleaving their renames.
//
// The publish contract (measured against Bun 1.4.4, plan §4.1):
//   - `rename(staging → existing non-empty dir)` is ENOTEMPTY, so an existing
//     output is moved ASIDE first: `out → .crust-out-old-<hash>-<pid>-<nonce>`,
//     then `staging → out`, then best-effort cleanup of the old tree. The
//     hash is the output's identity (buildLockHash): crash recovery and the
//     lock both need to know which output an orphaned tree belongs to.
//   - staging and the old tree are SIBLINGS of the output directory (inside
//     its parent), never inside it — `rename(out → out/anything)` is EINVAL
//     (a directory cannot move into itself), and never /tmp — a cross-device
//     rename is EXDEV. Same filesystem as the output is the whole point.
//   - On EPERM/EXDEV (Windows locked files, cross-device) the rename falls
//     back to a recursive COPY; on ANY failure after the output was moved
//     aside, the output is restored from the old tree and the error rethrown
//     — a failed build must leave the previous output exactly as it was.
//   - A build KILLED between the two renames leaves the previous output in
//     the out-old tree with the output path missing. The next build's
//     cleanupStale RESTORES that orphan to the output path before claiming
//     the lock (crash recovery), so the kill loses nothing permanent — only
//     a temporary output unavailability remains for readers during the live
//     publish window (v1 accepts it; the alternative — copy-into-place —
//     cannot be made atomic at all). The window is two local renames, not
//     any I/O over the tree contents, so it is measured in milliseconds
//     even for large sites.
//   - The build takes a per-output lock (acquireBuildLock): a file sibling
//     of the output named `.crust-out-lock-<hash>-<pid>-<nonce>` (the name
//     IS the holder's identity — the file is empty). A concurrent build of
//     the same output is refused with `build.busy` rather than interleaving
//     its renames with the holder's — a measured false-pass race: a second
//     build publishing into the first's rename window got rolled back by the
//     first's restore while the second reported success. Dead holders' locks
//     are reclaimed automatically, so a killed build never blocks the output
//     forever.

import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import type { RoutedPage } from "./content";
import { BuildError, compareStrings } from "./diagnostics";
import { html } from "./html";
import { canonicalUrl } from "./routes";
import type { RobotsConfig } from "./types";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function nonce(): string {
  return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

/**
 * A fresh staging directory as a SIBLING of the output directory (plan §4.1:
 * same filesystem, never /tmp). The pid keeps concurrent builds apart and the
 * nonce keeps retries of the same process apart.
 */
export function stagingDirFor(outputDir: string): string {
  const out = posix.resolve(toPosix(outputDir));
  return posix.join(posix.dirname(out), `.crust-staging-${process.pid}-${nonce()}`);
}

/**
 * The DEV SERVER's staging directory (plan §4.4, chunk 9): a sibling of the
 * output directory — same filesystem as the output, never /tmp — but with a
 * DISTINCT name family (`.crust-dev-staging-`, never `.crust-staging-`).
 *
 * Why a distinct family (the "no collision with build lock semantics" rule):
 *   - the dev server never renames its staging INTO the output (it serves it
 *     in place and deletes it on swap/stop), so it takes NO build lock — the
 *     lock's naming space (`.crust-out-lock-*`) stays exclusive to builds
 *     that publish, and a dev process can neither claim nor be claimed by it;
 *   - a dev tree must never be mistaken for a production staging or an
 *     out-old tree: `cleanupStale`'s crash-recovery RESTORES out-old orphans
 *     into the output, and the dev server must never be the tree a recovery
 *     rename moves over the user's real output;
 *   - orphans of a KILLED dev process ARE still swept: `cleanupStale`
 *     extends to the dev family (dead pid → delete), so a kill leaves no
 *     litter behind either.
 */
export function devStagingDirFor(outputDir: string): string {
  const out = posix.resolve(toPosix(outputDir));
  return posix.join(posix.dirname(out), `.crust-dev-staging-${process.pid}-${nonce()}`);
}

/**
 * The output directory's identity: sha256 of the resolved posix path, first
 * 16 hex chars. It tags the out-old trees and the lock file, so a killed
 * build's orphans are matchable by the next build of the SAME output — and
 * only that one (another output's orphans stay untouched).
 */
export function buildLockHash(outputDir: string): string {
  const resolved = posix.resolve(toPosix(outputDir));
  return createHash("sha256").update(resolved).digest("hex").slice(0, 16);
}

/** Staging dir left by a killed build: `.crust-staging-<pid>-<nonce>`. */
const STAGING_RE = /^\.crust-staging-(\d+)-([0-9a-f]+)$/;
/** Staging dir left by a killed DEV process (never published, own family). */
const DEV_STAGING_RE = /^\.crust-dev-staging-(\d+)-([0-9a-f]+)$/;
/** Moved-aside output: `.crust-out-old-<hash>-<pid>-<nonce>`. */
const OUT_OLD_RE = /^\.crust-out-old-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;
/** Build-lock file: `.crust-out-lock-<hash>-<pid>-<nonce>` (empty file). */
const LOCK_RE = /^\.crust-out-lock-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;

/**
 * Is `name` one of the package's own custodial siblings (production staging,
 * dev staging, out-old tree, lock file)? The dev server's watcher uses this
 * to IGNORE them: they are created by builds of the SAME output (including
 * the dev process itself), and reacting to them would turn the package's own
 * file traffic into spurious rebuilds or worker restarts.
 */
export function isCustodianSibling(name: string): boolean {
  return (
    STAGING_RE.test(name) ||
    DEV_STAGING_RE.test(name) ||
    OUT_OLD_RE.test(name) ||
    LOCK_RE.test(name)
  );
}

/**
 * Is `pid` a live process? `kill(pid, 0)` probes without a signal: no throw
 * means alive, EPERM means alive-but-owned-by-another-user, any other errno
 * (ESRCH, …) means dead.
 *
 * Windows caveat: `process.kill` is signal-simulated there; if Bun degrades
 * it to always throw, every lock would read as dead and be reclaimed as
 * stale, silently weakening the lock (concurrent builds could interleave
 * again). The site package is plain-Bun-on-Windows only (the crust binary
 * stays linux/darwin); such a degradation would show up as spurious double
 * builds — that is how it is to be recognized, not "fixed" away.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One lock file for `hash`, parsed from its name (the identity lives in it). */
interface LockHolder {
  readonly name: string;
  readonly lock: string;
  readonly pid: number;
}

/** Every `.crust-out-lock-<hash>-*` file in the parent, sorted by name. */
async function lockHolders(parent: string, hash: string): Promise<LockHolder[]> {
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return [];
  }
  const holders: LockHolder[] = [];
  for (const name of entries) {
    const m = LOCK_RE.exec(name);
    if (m !== null && m[1] === hash) {
      holders.push({ name, lock: posix.join(parent, name), pid: Number(m[2]) });
    }
  }
  holders.sort((a, b) => compareStrings(a.name, b.name));
  return holders;
}

/**
 * Startup cleanup + CRASH RECOVERY: sweep the output parent's stale
 * `.crust-staging-*` / `.crust-out-lock-*` / `.crust-out-old-*` siblings
 * left behind by KILLED builds. Liveness rules:
 *   - staging and lock files: a LIVE pid's trees are kept (that build is
 *     still running — deleting them would clobber it); a dead pid's are
 *     deleted (the owner output's own cleanup would delete them too; doing
 *     it here only changes WHEN, not WHETHER).
 *   - out-old trees: only the ones tagged with THIS output's hash are ever
 *     touched — restoring or deleting another output's orphans here would
 *     corrupt or lose ITS output (its recovery belongs to its own builds).
 *     Of this output's orphans: a live pid's is always kept; a dead pid's
 *     is restored when the output path is MISSING (the kill landed between
 *     the publish's two renames — the first in sort order goes back to the
 *     output, the rest are deleted) and deleted outright when the output
 *     exists (a dead build's leftovers, superseded by a live output).
 * Best effort: a tree we cannot delete (permissions) must not block a build
 * whose own staging is fine — the next startup retries.
 */
export async function cleanupStale(outputDir: string): Promise<void> {
  const output = posix.resolve(toPosix(outputDir));
  const hash = buildLockHash(output);
  const parent = posix.dirname(output);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return; // no parent yet — nothing can be stale
  }
  const removable: string[] = [];
  const orphans: LockHolder[] = [];
  for (const name of entries) {
    let m = STAGING_RE.exec(name);
    if (m !== null) {
      if (!pidAlive(Number(m[1]))) removable.push(name);
      continue;
    }
    // A KILLED dev process leaves its serving tree behind. It is never
    // published (so there is no recovery to run on it) — a dead pid's dev
    // tree is simply stale litter. A live pid's is the running dev server's
    // current or next tree and is kept, exactly like a live production
    // staging (deleting it would clobber the server's swap source).
    m = DEV_STAGING_RE.exec(name);
    if (m !== null) {
      if (!pidAlive(Number(m[1]))) removable.push(name);
      continue;
    }
    m = LOCK_RE.exec(name);
    if (m !== null) {
      if (!pidAlive(Number(m[2]))) removable.push(name);
      continue;
    }
    m = OUT_OLD_RE.exec(name);
    if (m !== null && m[1] === hash) {
      orphans.push({ name, lock: posix.join(parent, name), pid: Number(m[2]) });
    }
    // everything else (other hashes, other names) is left strictly alone
  }
  orphans.sort((a, b) => compareStrings(a.name, b.name));
  for (const name of removable) {
    await rm(posix.join(parent, name), { recursive: true, force: true }).catch(() => {});
  }
  const deadOrphans = orphans.filter((o) => !pidAlive(o.pid));
  const outputExists = await stat(output).then(
    () => true,
    () => false,
  );
  if (outputExists) {
    for (const o of deadOrphans) {
      await rm(o.lock, { recursive: true, force: true }).catch(() => {});
    }
  } else if (deadOrphans.length > 0) {
    // The output is missing and a dead holder's trees remain: that holder
    // died between its publish's two renames. The FIRST orphan in sort order
    // is restored to the output (deterministic: a double kill yields the
    // same survivor every time); the rest are deleted.
    await restoreOrphan(deadOrphans[0].lock, output);
    for (const o of deadOrphans.slice(1)) {
      await rm(o.lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Delete the dev staging trees left by KILLED dev processes in the output
 * directory's parent. The dev server's own startup calls this (a long dev
 * session accumulates one orphan per worker restart — each restart's old
 * tree belongs to a now-dead pid); a production `cleanupStale` runs the
 * same rule as part of its full sweep, so the litter is bounded either way.
 *
 * Touches ONLY the dev family — never production staging, locks, or out-old
 * trees: restoring an orphan into the output is a BUILD concern (crash
 * recovery), and a dev process must never rename into the output. A LIVE
 * pid's dev tree is always kept: it is a running dev server's current or
 * in-flight tree, and deleting it would clobber its swap source.
 */
export async function sweepDeadDevStaging(outputDir: string): Promise<void> {
  const parent = posix.dirname(posix.resolve(toPosix(outputDir)));
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return; // no parent yet — nothing can be stale
  }
  for (const name of entries) {
    const m = DEV_STAGING_RE.exec(name);
    if (m !== null && !pidAlive(Number(m[1]))) {
      await rm(posix.join(parent, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Move a crash-orphaned out-old tree back to the output path. A failed
 * rename (other than the EPERM/EXDEV copy case) leaves BOTH the orphan and
 * the output untouched — rename is atomic, so this is a clean failure and
 * the next startup re-evaluates (by then either the output exists, in which
 * case the dead orphan is genuinely stale and deleted, or it still doesn't,
 * in which case the restore is retried).
 */
async function restoreOrphan(old: string, output: string): Promise<void> {
  try {
    await rename(old, output);
  } catch (e) {
    if (!isCopyFallback(e)) return;
    try {
      await copyTree(old, output);
      await rm(old, { recursive: true, force: true });
    } catch {
      // copy failed partway: the orphan is still intact (only the copy
      // target may be partial); leave it for the next startup's re-evaluation
    }
  }
}

// ---------------------------------------------------------------------------
// the per-output build lock
// ---------------------------------------------------------------------------

/**
 * Output hashes this process currently holds the lock for. Claimed
 * SYNCHRONOUSLY (check-and-add, no await between) — that is what makes
 * same-process concurrency safe: two builds of the same output in one
 * process are serialized in memory before either touches the filesystem.
 */
const heldHashes = new Set<string>();

/** Bounded reclaim loop: dead holders that keep reappearing is an anomaly. */
const LOCK_MAX_ATTEMPTS = 25;

function busyError(output: string, holderPid: number): BuildError {
  return new BuildError([
    {
      code: "build.busy",
      severity: "error",
      message:
        `another build holds the lock for output ${JSON.stringify(output)} (pid ${holderPid} is ` +
        `still alive); wait for it to finish — a KILLED build's lock is reclaimed ` +
        `automatically, so this never blocks the output forever`,
    },
  ]);
}

function lockExhausted(output: string): Error {
  return new Error(
    `could not acquire the build lock for ${JSON.stringify(output)} after ` +
      `${LOCK_MAX_ATTEMPTS} attempts: dead holders keep reappearing (a process is ` +
      `recreating them, or pid liveness is unreliable on this platform)`,
  );
}

/**
 * Take the per-output build lock. Refuses with `build.busy` (naming the
 * live holder's pid) when another LIVE build holds the output; reclaims
 * DEAD holders' locks and proceeds. Returns the release function — call it
 * from a `finally` (it frees the in-process claim and removes the lock
 * file; the file may already be gone, which is fine).
 *
 * The protocol (each claim file is NAMED with its holder's pid+nonce, so
 * the name is the identity — the file itself is empty):
 *   1. any holder for this hash? a live one → `build.busy`; only dead ones
 *      → delete them and retry the claim (bounded — see LOCK_MAX_ATTEMPTS);
 *   2. create our own file with O_EXCL (our name carries a fresh random
 *      nonce, so a collision is a retry, not a failure);
 *   3. recheck: another process may have claimed between our step 1 and
 *      step 2. A live racer settles by NAME (deterministic tie-break: the
 *      lexicographically smallest live holder keeps its claim, the rest
 *      delete their own and report busy — both sides compute the same
 *      winner, so exactly one of any set of racers wins); dead racers are
 *      reclaimed.
 */
export async function acquireBuildLock(outputDir: string): Promise<() => Promise<void>> {
  const output = posix.resolve(toPosix(outputDir));
  const hash = buildLockHash(output);
  if (heldHashes.has(hash)) {
    throw new BuildError([
      {
        code: "build.busy",
        severity: "error",
        message:
          `a build for output ${JSON.stringify(output)} is already running in this process ` +
          `(pid ${process.pid}); same-process concurrent builds are refused`,
      },
    ]);
  }
  heldHashes.add(hash);
  try {
    const parent = posix.dirname(output);
    await mkdir(parent, { recursive: true });
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const holders = await lockHolders(parent, hash);
      if (holders.length > 0) {
        const live = holders.filter((h) => pidAlive(h.pid));
        if (live.length > 0) {
          throw busyError(output, live[0].pid);
        }
        if (attempt >= LOCK_MAX_ATTEMPTS) throw lockExhausted(output);
        // all dead: reclaim, then retry the claim
        await Promise.all(holders.map((h) => rm(h.lock, { force: true })));
        continue;
      }
      const name = `.crust-out-lock-${hash}-${process.pid}-${nonce()}`;
      const lock = posix.join(parent, name);
      try {
        await writeFile(lock, "", { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a real error, not contention
        if (attempt >= LOCK_MAX_ATTEMPTS) throw lockExhausted(output);
        continue;
      }
      const others = (await lockHolders(parent, hash)).filter((h) => h.lock !== lock);
      const liveOthers = others.filter((h) => pidAlive(h.pid));
      if (liveOthers.length > 0) {
        // A live racer claimed in our window. Smallest name wins (both
        // sides compute the same winner), so exactly one keeps its claim.
        const winner = liveOthers[0];
        if (compareStrings(name, winner.name) < 0) {
          return releaseLock(lock, hash);
        }
        await rm(lock, { force: true });
        throw busyError(output, winner.pid);
      }
      if (others.length > 0) {
        // dead racers from our window: reclaim. The check→rm window accepts
        // the standard name-based-lock caveat (pid reuse would delete at
        // most a stale lock file — never an output).
        await Promise.all(others.map((o) => rm(o.lock, { force: true })));
      }
      return releaseLock(lock, hash);
    }
  } catch (e) {
    heldHashes.delete(hash);
    throw e;
  }
}

function releaseLock(lock: string, hash: string): () => Promise<void> {
  return async () => {
    heldHashes.delete(hash);
    await rm(lock, { force: true });
  };
}

// ---------------------------------------------------------------------------
// writePages
// ---------------------------------------------------------------------------

/** One document to write: the route it came from, its output-relative file, bytes. */
export interface EmitFile {
  readonly route: string;
  readonly file: string;
  readonly html: string;
}

/**
 * Write rendered documents into staging. Routes are normalized at the route
 * table and `routeToFile` re-validates, so containment should already be
 * guaranteed — this re-verifies on the RESOLVED WRITE PATH anyway (plan §1:
 * "containment re-verified on the write path"). Defense in depth: a write that
 * escaped staging would land outside the atomic publish swap, so an escape is
 * a loud `output.escape` BuildError, never a partial write.
 */
export async function writePages(stagingDir: string, items: readonly EmitFile[]): Promise<void> {
  const staging = posix.resolve(toPosix(stagingDir));
  for (const item of items) {
    const target = posix.resolve(staging, item.file);
    if (target !== staging && !target.startsWith(`${staging}/`)) {
      throw new BuildError([
        {
          code: "output.escape",
          severity: "error",
          sourcePath: item.route,
          message:
            `refusing to write route ${JSON.stringify(item.route)}: the resolved path ` +
            `${JSON.stringify(target)} is outside the staging directory ${JSON.stringify(staging)}`,
        },
      ]);
    }
    await mkdir(posix.dirname(target), { recursive: true });
    await writeFile(target, item.html);
  }
}

// ---------------------------------------------------------------------------
// sitemap / robots (byte-pinned, plan §2 + §4.6)
// ---------------------------------------------------------------------------

/** XML text escaping for <loc>: `&` FIRST, or the later `&` insertions double-escape. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The sitemap: one `<url><loc>` per non-draft page, lexicographic URL order,
 * root as `site + "/"` (canonicalUrl's job), NO lastmod/changefreq/priority
 * (plan §4.6: a lastmod would make byte-identical rebuilds impossible). The
 * generated 404 page is excluded — it is not a page to index. Drafts are
 * filtered HERE, not only by the caller: the sitemap is a public artifact and
 * leaking a draft URL is exactly the false pass this package refuses.
 */
export function sitemapXml(pages: readonly RoutedPage[]): string {
  const urls = pages
    .filter((p) => !p.draft && p.route !== "/404")
    .map((p) => p.canonicalUrl)
    .sort(compareStrings);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `<url><loc>${xmlEscape(u)}</loc></url>`),
    "</urlset>",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The robots.txt body, pinned byte-for-byte (plan §2). Absent robots config →
 * null → no robots.txt emitted at all. The Sitemap line appears only when the
 * site is indexable AND the sitemap is enabled; the not-indexable body is the
 * bare Disallow (the sitemap FILE is still emitted — it is a link-checker
 * input for `crust verify-web-links`, not just a crawler hint).
 */
export function robotsTxt(
  site: string,
  robots: RobotsConfig | undefined,
  sitemapEnabled: boolean,
): string | null {
  if (robots === undefined) return null;
  if (!robots.indexable) return "User-agent: *\nDisallow: /\n";
  const lines = ["User-agent: *", "Allow: /"];
  if (sitemapEnabled) lines.push(`Sitemap: ${site}/sitemap.xml`);
  return lines.map((l) => `${l}\n`).join("");
}

// ---------------------------------------------------------------------------
// the generated 404 page
// ---------------------------------------------------------------------------

/**
 * The synthetic 404 page (plan, "Locked decisions" 2): rendered through
 * `content.defaultLayout` like any page, fixed title/route/sourcePath. It is
 * excluded from the sitemap (above) and from link-target validation (chunk 8 —
 * nothing may link TO /404); its own links are validated like any page's
 * (chunk 8). `links: []` here is the authored body's link list — the body is
 * static, so there are none; links a LAYOUT adds are collected by renderPage.
 */
export function notFoundPage(site: string, layout: string): RoutedPage {
  return {
    sourcePath: "<generated>",
    relativePath: "404",
    route: "/404",
    layout,
    title: "Not found",
    description: "The requested page does not exist.",
    headings: [],
    data: {},
    draft: false,
    body: html`<p>The page you are looking for does not exist.</p>`,
    links: [],
    warnings: [],
    diagnostics: [],
    canonicalUrl: canonicalUrl(site, "/404"),
  };
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

/** The fs seam (tests inject failing renames to exercise restore/fallback). */
export interface PublishFs {
  rename: (from: string, to: string) => Promise<void>;
  copyTree: (from: string, to: string) => Promise<void>;
}

/** EPERM: Windows locked files; EXDEV: cross-device. Both mean "copy instead". */
function isCopyFallback(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EXDEV";
}

/** Recursive copy (staging trees contain only regular files and dirs). */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) =>
    compareStrings(a.name, b.name),
  );
  for (const d of entries) {
    const src = posix.join(from, d.name);
    const dst = posix.join(to, d.name);
    if (d.isDirectory()) await copyTree(src, dst);
    else if (d.isFile()) await copyFile(src, dst);
  }
}

async function restore(old: string, output: string, fsDeps: PublishFs): Promise<void> {
  try {
    await fsDeps.rename(old, output);
  } catch (e) {
    if (!isCopyFallback(e)) throw e;
    await fsDeps.copyTree(old, output);
    await rm(old, { recursive: true, force: true });
  }
}

/**
 * Swap staging into the output directory (the contract is documented at the
 * module header — read it before touching this function). On success staging
 * no longer exists; on failure the previous output is exactly as it was and
 * staging may remain (build() deletes it).
 */
export async function publish(
  stagingDir: string,
  outputDir: string,
  fsDeps?: Partial<PublishFs>,
): Promise<void> {
  const fs: PublishFs = { rename, copyTree, ...fsDeps };
  const staging = posix.resolve(toPosix(stagingDir));
  const output = posix.resolve(toPosix(outputDir));
  const parent = posix.dirname(output);

  const exists = await stat(output).then(
    () => true,
    () => false,
  );
  if (!exists) {
    try {
      await fs.rename(staging, output);
      return;
    } catch (e) {
      if (!isCopyFallback(e)) throw e;
      await fs.copyTree(staging, output);
      await rm(staging, { recursive: true, force: true });
      return;
    }
  }

  // Move the previous output aside (a sibling — it cannot move INSIDE itself),
  // rename staging in, then best-effort delete the old tree. A failure of the
  // move-aside itself leaves the output untouched: plain rethrow. On
  // EPERM/EXDEV the move-aside itself copies (Windows locks can block even the
  // directory rename); if the original then cannot be deleted, the copy at
  // `old` is the only intact tree and is KEPT, named in the error. The name
  // carries the output hash and our pid: a kill mid-publish leaves this tree
  // behind, and the next build's cleanupStale uses both tags to restore it
  // (crash recovery) — an untagged name would be indistinguishable from
  // garbage and got DELETED (the data loss this naming exists to prevent).
  const old = posix.join(
    parent,
    `.crust-out-old-${buildLockHash(output)}-${process.pid}-${nonce()}`,
  );
  try {
    await fs.rename(output, old);
  } catch (e) {
    if (!isCopyFallback(e)) throw e;
    try {
      await fs.copyTree(output, old);
      await rm(output, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `could not move the previous output aside (${messageOf(cleanupError)}); ` +
          `an intact copy is at ${JSON.stringify(old)}`,
        { cause: cleanupError },
      );
    }
  }
  let swapError: unknown;
  try {
    await fs.rename(staging, output);
  } catch (e) {
    if (isCopyFallback(e)) {
      try {
        await fs.copyTree(staging, output);
        await rm(staging, { recursive: true, force: true });
      } catch (copyError) {
        swapError = copyError;
      }
    } else {
      swapError = e;
    }
    if (swapError !== undefined) {
      // ANY failure after the output was moved aside: put it back, then rethrow
      // the swap failure. If the restore ALSO fails, the combined message says
      // exactly where the previous output still is — never a silent loss.
      try {
        await restore(old, output, fs);
      } catch (restoreError) {
        throw new Error(
          `publish failed (${messageOf(swapError)}) AND restoring the previous output failed ` +
            `(${messageOf(restoreError)}); the previous output is at ${JSON.stringify(old)}`,
          { cause: swapError },
        );
      }
      throw swapError;
    }
  }
  await rm(old, { recursive: true, force: true }).catch(() => {});
}
