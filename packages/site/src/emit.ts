// Staging, deterministic emitted files, and publication orchestration.
// Disk paths retain native roots; URL paths are handled by routes.ts.
//
// Publishing and startup recovery run under the SAME atomic output lock.
// publication.ts records backup/copy/commit state before destructive operations:
// incomplete copies never count as a committed output, and failed restores
// retain their last-good backup for another attempt. Legacy unjournaled backups
// remain recoverable too. All custodial trees are siblings of the output.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { acquireOutputLock, pidAlive } from "./build-lock";
import type { RoutedPage } from "./content";
import { BuildError, compareStrings } from "./diagnostics";
import { isWindowsPath, pathContains, filesystemPath as posix, toPosix } from "./fs-path";
import { html } from "./html";
import {
  adoptLegacyBackup,
  type PublishFs,
  publishOutput,
  recoverTransactions,
  TRANSACTION_RE,
} from "./publication";
import { canonicalUrl } from "./routes";
import type { RobotsConfig } from "./types";

export type { PublishFs } from "./publication";

function nonce(): string {
  return randomBytes(6).toString("hex");
}

/** A fresh production staging directory on the output's filesystem. */
export function stagingDirFor(outputDir: string): string {
  const out = posix.resolve(toPosix(outputDir));
  return posix.join(posix.dirname(out), `.crust-staging-${process.pid}-${nonce()}`);
}

/**
 * Dev staging has its own family: it is served in place, never published or
 * restored over production. Dead dev staging is removable; live staging isn't.
 */
export function devStagingDirFor(outputDir: string): string {
  const out = posix.resolve(toPosix(outputDir));
  return posix.join(posix.dirname(out), `.crust-dev-staging-${process.pid}-${nonce()}`);
}

/** Stable output identity, including slash/case equivalence on Windows. */
export function buildLockHash(outputDir: string): string {
  const resolved = posix.resolve(toPosix(outputDir));
  const identity = isWindowsPath(resolved) ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

const STAGING_RE = /^\.crust-staging-(\d+)-([0-9a-f]+)$/;
const DEV_STAGING_RE = /^\.crust-dev-staging-(\d+)-([0-9a-f]+)$/;
const OUT_OLD_RE = /^\.crust-out-old-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;
/** Legacy private claims are respected for on-disk compatibility. */
const LOCK_RE = /^\.crust-out-lock-([0-9a-f]{16})-(\d+)-([0-9a-f]+)$/;
const ATOMIC_LOCK_RE = /^\.crust-out-lock-[0-9a-f]{16}$/;
const OWNER_RE = /^\.crust-out-owner-[0-9a-f]{16}-(\d+)-[0-9a-f]{24}$/;
const RECLAIM_RE = /^\.crust-out-reclaim-[0-9a-f]{16}-[0-9a-f]{24}$/;

/** Watchers must ignore ALL of the builder's own filesystem traffic. */
export function isCustodianSibling(name: string): boolean {
  return (
    STAGING_RE.test(name) ||
    DEV_STAGING_RE.test(name) ||
    OUT_OLD_RE.test(name) ||
    LOCK_RE.test(name) ||
    ATOMIC_LOCK_RE.test(name) ||
    OWNER_RE.test(name) ||
    RECLAIM_RE.test(name) ||
    TRANSACTION_RE.test(name)
  );
}

/** Public cleanup acquires the output lock before inspecting recovery state. */
export async function cleanupStale(outputDir: string, fsDeps?: Partial<PublishFs>): Promise<void> {
  const output = posix.resolve(toPosix(outputDir));
  try {
    await stat(posix.dirname(output));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const release = await acquireBuildLock(output);
  try {
    await cleanupStaleLocked(output, fsDeps);
  } finally {
    await release();
  }
}

/** Internal entry: caller MUST already hold this output's build lock. */
export async function cleanupStaleLocked(
  outputDir: string,
  fsDeps?: Partial<PublishFs>,
): Promise<void> {
  const output = posix.resolve(toPosix(outputDir));
  const hash = buildLockHash(output);
  const parent = posix.dirname(output);
  const paired = await recoverTransactions(output, hash, fsDeps);
  const orphans: { name: string; file: string; pid: number }[] = [];
  for (const name of await readdir(parent)) {
    const staging = STAGING_RE.exec(name) ?? DEV_STAGING_RE.exec(name) ?? OWNER_RE.exec(name);
    const legacyLock = LOCK_RE.exec(name);
    const pid = staging ? Number(staging[1]) : legacyLock ? Number(legacyLock[2]) : undefined;
    if (pid !== undefined) {
      if (!pidAlive(pid)) {
        await rm(posix.join(parent, name), { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }
    const old = OUT_OLD_RE.exec(name);
    if (old?.[1] === hash && !paired.has(name)) {
      orphans.push({ name, file: posix.join(parent, name), pid: Number(old[2]) });
    }
    // Shared claim/reclamation slots are removed ONLY by the lock protocol.
  }
  const dead = orphans
    .filter((orphan) => !pidAlive(orphan.pid))
    .sort((a, b) => compareStrings(a.name, b.name));
  let outputExists: boolean;
  try {
    await stat(output);
    outputExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    outputExists = false;
  }
  if (!outputExists && dead.length > 0) {
    // Adopt before a fallback copy can become partial. Only prune alternative
    // legacy backups AFTER recovery succeeds; a failure must keep every copy.
    await adoptLegacyBackup(dead[0].file, output, fsDeps);
    dead.shift();
  }
  for (const orphan of dead) {
    await rm(orphan.file, { recursive: true, force: true }).catch(() => {});
  }
}

/** Dev cleanup never touches production output, backups, journals, or locks. */
export async function sweepDeadDevStaging(outputDir: string): Promise<void> {
  const parent = posix.dirname(posix.resolve(toPosix(outputDir)));
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = DEV_STAGING_RE.exec(name);
    if (match !== null && !pidAlive(Number(match[1]))) {
      await rm(posix.join(parent, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Atomically claim one shared output slot; always release in a finally. */
export async function acquireBuildLock(outputDir: string): Promise<() => Promise<void>> {
  const output = posix.resolve(toPosix(outputDir));
  return acquireOutputLock(output, buildLockHash(output));
}

export interface EmitFile {
  readonly route: string;
  readonly file: string;
  readonly html: string;
}

/** Recheck containment on the resolved disk path before every staging write. */
export async function writePages(stagingDir: string, items: readonly EmitFile[]): Promise<void> {
  const staging = posix.resolve(toPosix(stagingDir));
  for (const item of items) {
    const target = posix.resolve(staging, item.file);
    if (!pathContains(staging, target)) {
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

/** XML text escaping for <loc>: `&` FIRST, so inserted escapes aren't escaped. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Byte-pinned, sorted, canonical URLs; drafts and the generated 404 excluded. */
export function sitemapXml(pages: readonly RoutedPage[]): string {
  const urls = pages
    .filter((page) => !page.draft && page.route !== "/404")
    .map((page) => page.canonicalUrl)
    .sort(compareStrings);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `<url><loc>${xmlEscape(url)}</loc></url>`),
    "</urlset>",
  ];
  return `${lines.join("\n")}\n`;
}

/** Absent robots config means no robots.txt, not an empty emitted file. */
export function robotsTxt(
  site: string,
  robots: RobotsConfig | undefined,
  sitemapEnabled: boolean,
): string | null {
  if (robots === undefined) return null;
  if (!robots.indexable) return "User-agent: *\nDisallow: /\n";
  const lines = ["User-agent: *", "Allow: /"];
  if (sitemapEnabled) lines.push(`Sitemap: ${site}/sitemap.xml`);
  return lines.map((line) => `${line}\n`).join("");
}

/** A synthetic page rendered through the site's default layout. */
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

/** Lock required: swap staging into output or preserve the previous output. */
export async function publish(
  stagingDir: string,
  outputDir: string,
  fsDeps?: Partial<PublishFs>,
): Promise<void> {
  const output = posix.resolve(toPosix(outputDir));
  await publishOutput(posix.resolve(toPosix(stagingDir)), output, buildLockHash(output), fsDeps);
}
