// crust — resolve and install the prebuilt binary from the LAN artifact plane.
//
// WHY THIS PACKAGE IS A LAUNCHER RATHER THAN THE BINARY
// `bun build --compile` produces a ~91 MB self-contained ELF. Shipping that inside the npm
// tarball would put ~91 MB into /srv/npm per published version, against Verdaccio's 200 MB
// max_body_size, and hard-lock the package to linux-x64. Instead the binary is published
// ONCE to apps.in.drlario.org by the same Jenkins build, and both channels resolve that one
// artifact — same file, same sha256:
//
//   curl …/install.sh | bash -s -- crust     ->  /srv/apps/tools/crust/<v>/crust
//   npm i -g crust                           ->  this module, same file
//
// WHY THIS IS A LIBRARY AND NOT JUST A POSTINSTALL
// npm 12 blocks install scripts BY DEFAULT (`allowScripts`), so a postinstall-only design
// silently ships a package that cannot run — verified on npm 12.0.2 with no local config.
// So the binary is fetched lazily by bin/crust on first use, and the postinstall is only a
// fast path for environments that still permit it. Either entry point calls ensureBinary().
//
// Node stdlib only, deliberately: this runs before the package's own dependencies are
// guaranteed usable in every npm/pnpm/bun layout, so it must not have any.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, chmodSync, writeFileSync, createReadStream, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = path.join(PKG_ROOT, "install-manifest.json");

const APPS_URL = (process.env.CRUST_APPS_URL || "https://apps.in.drlario.org").replace(/\/+$/, "");
const CACHE_ROOT = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "crust");

// The two planes version the same build differently, and that is deliberate — see the header
// of publish/bin/apps-publish:
//
//   apps plane : <pkgversion>+<shortsha>      e.g. 0.1.0+78f2a43
//   npm plane  : <pkgversion>-ci.<n>.<sha>    e.g. 0.1.0-ci.42.78f2a43
//
// semver ignores build metadata after `+` when ordering, so the registry cannot use the apps
// form. The shared short sha is what ties one back to the other.
function shaFromNpmVersion(v) {
  const m = /-ci\.\d+\.([0-9a-f]{7,40})$/.exec(v);
  return m ? m[1] : null;
}

function parseIndex(tsv) {
  // Columns: kind name version file sha256 bytes path
  return tsv
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 7 && c[0] === "tool" && c[1] === "crust")
    .map(([kind, name, version, file, sha256, bytes, p]) => ({ kind, name, version, file, sha256, bytes, path: p }));
}

// Prefer the artifact this exact package was built alongside; fall back to whatever `latest`
// points at. The fallback matters because apps-publish prunes old versions (KEEP_VERSIONS),
// so an npm version can outlive its binary — a working newer crust with a warning beats a
// hard failure.
function pickRow(rows, wantSha) {
  if (wantSha) {
    const exact = rows.find((r) => r.version.endsWith(`+${wantSha}`) && !r.path.includes("/latest/"));
    if (exact) return { row: exact, exact: true };
  }
  const latest = rows.find((r) => r.path.includes("/latest/"));
  return latest ? { row: latest, exact: false } : null;
}

async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

function sha256OfFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function downloadVerified(url, dest, wantSha) {
  const res = await get(url);
  const tmp = `${dest}.part.${process.pid}`;
  const hash = createHash("sha256");
  // Stream rather than buffer: ~91 MB held in memory purely to hash it is waste on a machine
  // that is probably doing something else.
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (src) { for await (const chunk of src) { hash.update(chunk); yield chunk; } },
    createWriteStream(tmp, { mode: 0o755 }),
  );
  const got = hash.digest("hex");
  if (got !== wantSha) {
    unlinkSync(tmp);
    throw new Error(`checksum mismatch for ${url}\n  expected ${wantSha}\n  got      ${got}`);
  }
  // Verify BEFORE the file reaches its final name, never after: a truncated or tampered
  // download must not be executable on disk even briefly. The rename is atomic, and the
  // pid-suffixed temp name keeps two concurrent installs from fighting over one .part file.
  renameSync(tmp, dest);
  chmodSync(dest, 0o755);
  return dest;
}

export function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    return m && m.bin && existsSync(m.bin) ? m : null;
  } catch {
    return null;
  }
}

// Resolve, download if needed, record what was verified, return the manifest.
// `log` is a sink so the shim can stay quiet on the happy path while the postinstall talks.
export async function ensureBinary({ log = () => {}, warn = () => {} } = {}) {
  const cached = readManifest();
  if (cached) return cached;

  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  const wantSha = shaFromNpmVersion(pkg.version);

  const res = await get(`${APPS_URL}/index.tsv`);
  const rows = parseIndex(await res.text());
  if (!rows.length) throw new Error(`no 'crust' rows in ${APPS_URL}/index.tsv — has the crust binary job run yet?`);

  const picked = pickRow(rows, wantSha);
  if (!picked) throw new Error("index.tsv has crust rows but none resolvable");
  const { row, exact } = picked;
  if (wantSha && !exact) {
    warn(`binary for ${pkg.version} (sha ${wantSha}) is no longer published — falling back to latest (${row.version})`);
  }

  const dir = path.join(CACHE_ROOT, row.version);
  const bin = path.join(dir, "crust");
  mkdirSync(dir, { recursive: true });

  if (existsSync(bin) && (await sha256OfFile(bin)) === row.sha256) {
    log(`already cached: ${row.version}`);
  } else {
    log(`downloading crust ${row.version} (${(Number(row.bytes) / 1048576).toFixed(0)} MB) from ${APPS_URL}`);
    await downloadVerified(`${APPS_URL}/${row.path}`, bin, row.sha256);
    log(`installed -> ${bin}`);
  }

  const manifest = { appsVersion: row.version, bin, sha256: row.sha256, from: APPS_URL };
  // Recorded rather than re-derived: after a `latest` fallback the resolved version is no
  // longer derivable from this package's own version, and the shim must launch the binary
  // that was actually verified — not whatever latest points at next week.
  try {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    // A global install under a root-owned prefix is read-only for a normal user. The cache
    // write already succeeded, so this is recoverable — the next run just re-resolves.
    warn(`could not write install-manifest.json (${e.message}); will re-resolve on each run`);
  }
  return manifest;
}

export const APPS_URL_EFFECTIVE = APPS_URL;
