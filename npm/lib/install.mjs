// crust — resolve and install the prebuilt binary for this package.
//
// WHY THIS PACKAGE IS A LAUNCHER RATHER THAN THE BINARY
// `bun build --compile` produces a ~91 MB self-contained executable. Shipping that inside the
// npm tarball would put ~91 MB into the registry per published version and hard-lock the
// package to one platform. Instead the binary is published ONCE per build to an artifact
// plane, and every install route resolves that one artifact — same file, same sha256.
//
// TWO PLANES, ONE RESOLVER. The public release publishes binaries to GitHub Releases; the
// LAN build publishes to apps.in.drlario.org. Which one this copy of the package uses is
// stamped into package.json as `crust.source` at publish time ("github" or "apps") and can be
// overridden with CRUST_SOURCE. The verify-then-rename download path below is shared, because
// "did the bytes we ran match the bytes that were published" must not depend on the plane.
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
const DEFAULT_REPO = "lariocpt/crust";

function readPkg() {
  return JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
}

// Env beats the stamp so someone on the LAN can point a public install at the internal plane
// (and vice versa) without editing an installed package.
export function resolveSource(pkg = readPkg()) {
  const raw = (process.env.CRUST_SOURCE || pkg.crust?.source || "apps").toLowerCase();
  if (raw !== "apps" && raw !== "github") {
    throw new Error(`unknown CRUST_SOURCE '${raw}' — expected 'github' or 'apps'`);
  }
  return raw;
}

// `crust-linux-x64`, `crust-darwin-arm64`, … — the names the release workflow uploads.
export function assetName(platform = process.platform, arch = process.arch) {
  return `crust-${platform}-${arch}`;
}

function ghRepo(pkg) {
  if (process.env.CRUST_GITHUB_REPO) return process.env.CRUST_GITHUB_REPO;
  if (pkg.crust?.repo) return pkg.crust.repo;
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url || "");
  return m ? m[1] : DEFAULT_REPO;
}

// The two LAN planes version the same build differently, and that is deliberate — see the
// header of publish/bin/apps-publish:
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

// SHA256SUMS is the plain `sha256sum` format: "<hex>  <filename>" per line.
function parseSums(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
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

// Both resolvers return the same shape: { version, url, sha256, bytes, from, note }.
// `note` is a non-fatal warning for the caller to surface.
async function resolveFromApps(pkg) {
  const wantSha = shaFromNpmVersion(pkg.version);

  const res = await get(`${APPS_URL}/index.tsv`);
  const rows = parseIndex(await res.text());
  if (!rows.length) throw new Error(`no 'crust' rows in ${APPS_URL}/index.tsv — has the crust binary job run yet?`);

  const picked = pickRow(rows, wantSha);
  if (!picked) throw new Error("index.tsv has crust rows but none resolvable");
  const { row, exact } = picked;

  return {
    version: row.version,
    url: `${APPS_URL}/${row.path}`,
    sha256: row.sha256,
    bytes: Number(row.bytes) || 0,
    from: APPS_URL,
    note: wantSha && !exact
      ? `binary for ${pkg.version} (sha ${wantSha}) is no longer published — falling back to latest (${row.version})`
      : null,
  };
}

async function resolveFromGithub(pkg) {
  const repo = ghRepo(pkg);
  const tag = `v${pkg.version}`;
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const asset = assetName();

  // The checksums file is the source of truth for what this release actually contains, so an
  // unsupported platform fails here with the real list rather than as a 404 on the binary.
  const sums = parseSums(await (await get(`${base}/SHA256SUMS`)).text());
  const sha256 = sums.get(asset);
  if (!sha256) {
    const have = [...sums.keys()].filter((k) => k.startsWith("crust-")).join(", ") || "(none)";
    throw new Error(
      `release ${tag} has no ${asset}\n  platforms in this release: ${have}\n` +
      `  build from source instead: https://github.com/${repo}#build-from-source`,
    );
  }

  return { version: pkg.version, url: `${base}/${asset}`, sha256, bytes: 0, from: `github.com/${repo}@${tag}`, note: null };
}

export function readManifest(source = null) {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    if (!m || !m.bin || !existsSync(m.bin)) return null;
    // A manifest written under a different plane describes a binary this run did not ask for
    // (someone set CRUST_SOURCE between runs). Re-resolve rather than launch it.
    if (source && m.source && m.source !== source) return null;
    return m;
  } catch {
    return null;
  }
}

// Resolve, download if needed, record what was verified, return the manifest.
// `log` is a sink so the shim can stay quiet on the happy path while the postinstall talks.
export async function ensureBinary({ log = () => {}, warn = () => {} } = {}) {
  const pkg = readPkg();
  const source = resolveSource(pkg);

  const cached = readManifest(source);
  if (cached) return cached;

  const r = source === "github" ? await resolveFromGithub(pkg) : await resolveFromApps(pkg);
  if (r.note) warn(r.note);

  // The cache key carries the platform because a home directory can be shared across machines
  // of different architectures; two hosts must not race for one path holding one arch's ELF.
  const dir = path.join(CACHE_ROOT, `${r.version}-${process.platform}-${process.arch}`);
  const bin = path.join(dir, "crust");
  mkdirSync(dir, { recursive: true });

  if (existsSync(bin) && (await sha256OfFile(bin)) === r.sha256) {
    log(`already cached: ${r.version}`);
  } else {
    const size = r.bytes ? ` (${(r.bytes / 1048576).toFixed(0)} MB)` : "";
    log(`downloading crust ${r.version}${size} from ${r.from}`);
    await downloadVerified(r.url, bin, r.sha256);
    log(`installed -> ${bin}`);
  }

  const manifest = { source, version: r.version, bin, sha256: r.sha256, from: r.from };
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

// What to tell a user whose download just failed — the recovery differs per plane, and a LAN
// URL printed at someone on the public internet is worse than no hint at all.
export function installHint() {
  let pkg;
  try {
    pkg = readPkg();
  } catch {
    return [];
  }
  if (resolveSource(pkg) === "github") {
    const repo = ghRepo(pkg);
    return [
      `Binaries for v${pkg.version} come from https://github.com/${repo}/releases.`,
      "If that host is unreachable, install directly with:",
      `  curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | bash`,
    ];
  }
  return [
    `The binary is hosted on the LAN at ${APPS_URL}, so this needs to run on that network.`,
    "Override the host with CRUST_APPS_URL, or install directly with:",
    `  curl -fsSL ${APPS_URL}/install.sh | bash -s -- crust`,
  ];
}
