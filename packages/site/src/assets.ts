// The asset pipeline (plan §4.2, §4.5, §4.6): one Bun.build per declared
// entrypoint, hashing owned by the SSG, and the publicDirectory copied
// byte-for-byte to the staging root.
//
// Measured facts this design exists for (Bun 1.4.4; pinned by
// tests/assets.test.ts — do not re-litigate, do not "optimize" away):
//  - `entrypoints` must be an ARRAY; a {name: path} map throws a TypeError.
//  - Output names carry NO content hash we may rely on, and `outdir` is NOT
//    cleared between builds — a stale file from an earlier build stays in the
//    directory and a naive "collect the outdir" leaks it. Therefore: ONE
//    Bun.build call per entrypoint into a FRESH mkdtemp directory, the SSG
//    computes `sha256` over the final emitted bytes itself (first 16 hex),
//    and every emitted name is hashed — a name is never copied from the
//    bundler and an unhashed asset name is never emitted.
//  - On success Bun.build RETURNS {success: true, outputs, logs}; on a
//    bundling failure it THROWS an AggregateError ("Bundle failed") whose
//    .errors are BuildMessage/ResolveMessage records. Both shapes are
//    handled, and a throw never escapes as a raw exception (crust rule 1:
//    the failure must be a located diagnostic, not a crash report).
//  - `target: "browser"` INLINES dynamic import() — Bun 1.4.4 emits no extra
//    chunk for it (pinned by a test). The multi-output guard is therefore
//    about any entrypoint that really does emit several files (an imported
//    asset like `import logo from "./x.svg"`, JS importing CSS, or real
//    code-splitting by a future Bun) — one guard covers all of them.
//  - The TRANSPILE drops EVERY source comment (leading, mid-file, trailing;
//    `//` and `/* */`; CSS included) before the banner is prepended — the
//    emitted code never contains a user comment line. It CAN, however,
//    contain lines that merely LOOK like one: template-literal content is
//    emitted verbatim, so a line of a backtick string starting with `// `
//    sits in the output as a plain line (measured, pinned by a test). The
//    banner strip below is therefore an EXACT match of the banner computed
//    for the entry, never a pattern.
//  - A file whose code is EMPTY after the transform (comments only, types
//    only) emits no banner and zero bytes.
//  - The output is PREFIXED with a path banner naming the bundled file
//    relative to process.cwd() (Bun's "pretty" path: relative when the file
//    is under the cwd, a `../`-prefixed path when it is not; never an
//    absolute path — measured on Bun 1.4.4). The banner is part of the bytes
//    Bun returns, so left alone it makes the hash cwd-dependent (measured:
//    the same entry built from two differently-structured cwds produces
//    different bytes; pinned by tests/assets.test.ts).
//  - For a bundle of a SINGLE source file the banner sits at the head of the
//    file (after a preserved hashbang + one blank line, when the entry starts
//    with `#!`) and names the entry itself, so the exact match is
//    unambiguous and it is stripped before hashing/writing — see
//    stripBundlerBanner. A MULTI-file bundle (the entry imports other files,
//    a CSS @imports, an npm package import) emits one such comment before
//    EVERY bundled file, and the leading one names the first file (a
//    dependency), not the entry. Those banners are stripped too (see
//    stripMultiFileBanners): with `metafile: true` every input file of the
//    build is enumerable, and each metafile key IS the cwd-relative path its
//    banner carries (measured byte-identical), so the exact banner line is
//    computable for EVERY bundled file — the strip removes any output line
//    that is byte-identical to a computed banner, gated on the file's first
//    line being one of them (a bannerless or changed-shape output is never
//    touched; a future Bun that changed the banner shape silently degrades
//    to the old cwd-sensitive behavior for that asset instead of
//    pattern-stripping and corrupting code). One honest caveat (documented in
//    docs/USAGE.md, Assets): a template-literal line that is byte-identical
//    to a computed banner is stripped with it — the transpile drops every
//    source comment, so a bare comment-shaped line in the output can only be
//    a banner or string content, and stripping a string line changes string
//    data, never parseability.
//
// Determinism (plan §4.6): entrypoints are iterated in sorted name order, the
// manifest is a Map in that insertion order, the public copy traverses sorted
// per directory, and all returned paths are posix (plan, Windows table).
// ALL assets — single-file and multi-file alike — have their per-file
// banners stripped before hashing, so emitted bytes are byte-identical
// across rebuilds from ANY working directory (the strip is an exact match of
// computed banners, never a pattern; see above).

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { compareStrings, type Diagnostic, sortDiagnostics } from "./diagnostics";
import type { ResolvedSite } from "./types";

const ASSETS_DIR = "assets";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Locale-free case folding (toLowerCase, never toLocaleLowerCase — ICU). */
function foldCase(p: string): string {
  return p.toLowerCase();
}

// ---------------------------------------------------------------------------
// buildAssets
// ---------------------------------------------------------------------------

/** One manifest row: where the asset landed (posix, output-root-relative). */
export interface AssetManifestEntry {
  /** `assets/<name>-<16 hex>.<ext>` — always hashed, never a bundler name. */
  readonly file: string;
  /** Byte length of the emitted file. */
  readonly bytes: number;
}

/** name → entry. Iteration order is the sorted declaration order. */
export type AssetManifest = ReadonlyMap<string, AssetManifestEntry>;

export interface AssetsBuildResult {
  /** Only successfully built assets; failed entrypoints are diagnostics. */
  readonly manifest: AssetManifest;
  readonly diagnostics: Diagnostic[];
}

interface DeclaredEntrypoint {
  readonly name: string;
  readonly key: string;
  readonly path: string;
}

/** scripts + styles share ONE namespace (config.ts rejects a name in both). */
function declaredEntrypoints(resolvedSite: ResolvedSite): DeclaredEntrypoint[] {
  const all: DeclaredEntrypoint[] = [
    ...Object.entries(resolvedSite.assets.scripts).map(([name, path]) => ({
      name,
      key: `assets.scripts.${name}`,
      path: toPosix(path),
    })),
    ...Object.entries(resolvedSite.assets.styles).map(([name, path]) => ({
      name,
      key: `assets.styles.${name}`,
      path: toPosix(path),
    })),
  ];
  return all.sort((a, b) => compareStrings(a.name, b.name));
}

/** A bundler message, reduced to what a Diagnostic can carry. */
interface BundlerMessage {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

function bundlerMessage(value: unknown): BundlerMessage {
  if (typeof value === "object" && value !== null) {
    const m = value as Record<string, unknown>;
    const position = (m.position ?? m.location ?? undefined) as Record<string, unknown> | undefined;
    if (typeof m.message === "string") {
      return {
        message: m.message,
        ...(typeof position?.file === "string" ? { file: toPosix(position.file) } : {}),
        ...(typeof position?.line === "number" ? { line: position.line } : {}),
        ...(typeof position?.column === "number" ? { column: position.column } : {}),
      };
    }
  }
  return { message: value instanceof Error ? value.message : String(value) };
}

/**
 * Flatten everything Bun.build can hand a failure into one honest list:
 * the thrown AggregateError (.errors), a returned failure result (.logs /
 * the legacy .messages), or any other thrown value.
 */
function bundlerMessages(error: unknown): BundlerMessage[] {
  const bag = error as { errors?: unknown; logs?: unknown; messages?: unknown };
  const raw = Array.isArray(bag?.errors)
    ? bag.errors
    : Array.isArray(bag?.logs)
      ? bag.logs
      : Array.isArray(bag?.messages)
        ? bag.messages
        : undefined;
  if (raw) return raw.map(bundlerMessage);
  return [bundlerMessage(error)];
}

function bundleFailed(
  entry: DeclaredEntrypoint,
  messages: readonly BundlerMessage[],
): Diagnostic[] {
  return messages.map((m) => ({
    code: "asset.bundle-failed" as const,
    severity: "error" as const,
    sourcePath: m.file ?? entry.path,
    ...(m.line !== undefined ? { line: m.line } : {}),
    ...(m.column !== undefined ? { column: m.column } : {}),
    message: `bundling ${entry.key} "${entry.name}" failed: ${m.message}${
      m.file !== undefined
        ? ` (at ${m.file}${m.line !== undefined ? `:${m.line}` : ""}${m.column !== undefined ? `:${m.column}` : ""})`
        : ""
    }`,
  }));
}

// ---------------------------------------------------------------------------
// Bundler banner strip (cross-cwd determinism)
// ---------------------------------------------------------------------------

/**
 * The path banner Bun's bundler prepends to each bundled source file,
 * measured through the real bundler on Bun 1.4.4 (pinned by
 * tests/assets.test.ts, "Bun banner strip" block — do not re-litigate):
 *
 *  - the path is the file's path RELATIVE TO PROCESS.CWD (Bun's "pretty"
 *    path), normalized with its platform-Loose rules: both `/` and `\`
 *    count as separators, output separators are always `/`, and the common
 *    prefix is compared byte-exact (even on Windows);
 *  - a JS chunk comments it `// <path>` on one line — but as a block
 *    comment when the path contains a newline or any byte > 0x7F; there,
 *    every star-slash pair (a `*` immediately followed by a `/`) is
 *    sanitized by replacing the `/` with `_`, looped until no star-slash
 *    remains, so the block comment cannot terminate early;
 *  - a CSS chunk always comments it as a block comment, escaping every
 *    star-slash pair by inserting a `\` before its `/` instead;
 *  - the banner for the FIRST file of a chunk sits at byte 0 — except that a
 *    hashbang on the entry's first source line (a leading BOM is dropped by
 *    Bun before hashbang detection, so BOM + hashbang still counts) is
 *    preserved first, followed by exactly one blank line, before the banner;
 *  - a file whose bundled code is empty gets NO banner at all, and a
 *    multi-file chunk gets one banner per file — in which case the LEADING
 *    banner names the first bundled file (a dependency), not the entry.
 */
function bundlerBannerLine(pretty: string, ext: string): string {
  if (ext === ".css") {
    return `/* ${cssEscapeStarSlash(pretty)} */\n`;
  }
  if (hasNewlineOrNonAscii(pretty)) {
    return `/* ${jsSanitizeStarSlash(pretty)} */\n`;
  }
  return `// ${pretty}\n`;
}

/** A newline (LF/CR) or a code point that encodes to bytes > 0x7F (UTF-8). */
function hasNewlineOrNonAscii(pretty: string): boolean {
  for (let i = 0; i < pretty.length; i++) {
    const cp = pretty.codePointAt(i) ?? 0; // unreachable for i < length; 0 matches no check below
    if (cp === 0x0a || cp === 0x0d || cp > 0x7f) return true;
    if (cp > 0xffff) i++; // consume the trailing surrogate of an astral pair
  }
  return false;
}

/** Bun's JS multiline sanitizer: every star-slash pair keeps its `*`, its `/` becomes `_`, looped. */
function jsSanitizeStarSlash(pretty: string): string {
  let out = pretty;
  let i = out.indexOf("*/");
  while (i !== -1) {
    out = `${out.slice(0, i + 1)}_${out.slice(i + 2)}`;
    i = out.indexOf("*/");
  }
  return out;
}

/** Bun's CSS escape: a `\` is inserted before every `/` that follows a `*`. */
function cssEscapeStarSlash(pretty: string): string {
  let out = "";
  for (let i = 0; i < pretty.length; i++) {
    if (pretty[i] === "/" && i > 0 && pretty[i - 1] === "*") out += "\\";
    out += pretty[i];
  }
  return out;
}

/**
 * The cwd-relative path forms the banner could carry, in match order. Bun's
 * Loose platform differs from Node's in two measured corners, so this
 * generates candidates instead of asserting one:
 *  - output separator: Loose always emits `/` (Node win32 emits `\`);
 *  - Windows drive-letter case: Node win32 uppercases drive letters while
 *    Bun preserves the case it was given, and the common-prefix compare is
 *    byte-exact (Node win32 is case-insensitive) — so same-drive paths whose
 *    drive letters disagree in case get their case folded per operand.
 * Off-Platforms win32, Node's posix relative IS Bun's algorithm (same
 * Node-derived relative, same separator) — one candidate. A candidate list
 * can never match real content by accident: a match means the bytes literally
 * are the banner we would have computed, and a NO-match (new Bun version,
 * exotic path) simply means "leave the bytes alone" — never a corrupted strip.
 */
function bannerPathCandidates(absPath: string): string[] {
  const cwd = process.cwd();
  const foldDrive = (p: string): string[] => {
    if (!/^[A-Za-z]:/.test(p)) return [p];
    const drive = p[0];
    const folded =
      (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + p.slice(1);
    return [p, folded];
  };
  const out: string[] = [];
  const push = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  if (process.platform === "win32") {
    for (const from of foldDrive(toPosix(cwd))) {
      for (const to of foldDrive(toPosix(absPath))) {
        try {
          push(win32.relative(from, to).replace(/\\/g, "/"));
        } catch {
          // mixed absolute/relative (should not happen: config paths are
          // resolved against the config dir, cwd is absolute) — no candidate
        }
      }
    }
  } else {
    if (!posix.isAbsolute(cwd) || !posix.isAbsolute(absPath)) return out;
    push(posix.relative(cwd, absPath));
  }
  return out;
}

/**
 * The byte offset of the banner when the entry's first source line is a
 * hashbang (Bun keeps the hashbang line, adds its newline, then ONE blank
 * line, then the banner), or -1 when the entry has no hashbang (or cannot be
 * read, in which case the banner is simply not stripped).
 */
async function hashbangBannerOffset(entryPath: string): Promise<number> {
  let head: Buffer;
  try {
    head = await readFile(entryPath);
  } catch {
    return -1;
  }
  const isBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  const line =
    head
      .subarray(isBom ? 3 : 0)
      .toString("utf8")
      .split("\n")[0] ?? "";
  if (!line.startsWith("#!")) return -1;
  return line.length + 1 /* the hashbang's own newline */ + 1 /* Bun's blank line */;
}

/**
 * Strip the LEADING path banner from the emitted bytes of a SINGLE-input
 * bundle (before hashing and before writing to staging), so the hash and the
 * file are independent of the working directory the build ran from (plan
 * §4.6, cross-cwd byte-identity). The strip is an EXACT match of the single
 * banner line we would compute for THIS entrypoint, at the head of the file
 * (or after a preserved hashbang + one blank line). It never pattern-matches:
 * the transpiled code is comment-free, but template-literal content is
 * emitted verbatim and can produce a line that merely looks like a banner —
 * only an exact match of the computed banner is safe to remove. Returns the
 * same bytes object unchanged when nothing matches (an entry whose code is
 * empty after the transform, which emits no banner; a future Bun that
 * changed the banner). Multi-file bundles route to stripMultiFileBanners.
 */
export async function stripBundlerBanner(
  bytes: Uint8Array,
  entryPath: string,
  ext: string,
): Promise<Uint8Array> {
  if (bytes.length === 0) return bytes;
  const rels = bannerPathCandidates(entryPath);
  if (rels.length === 0) return bytes;
  const offsets: number[] = [0];
  if (ext !== ".css") {
    const off = await hashbangBannerOffset(entryPath);
    if (off >= 0) offsets.push(off);
  }
  for (const rel of rels) {
    const banner = new TextEncoder().encode(bundlerBannerLine(rel, ext));
    for (const off of offsets) {
      if (bytes.length < off + banner.length) continue;
      let matches = true;
      for (let i = 0; i < banner.length; i++) {
        if (bytes[off + i] !== banner[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const out = new Uint8Array(bytes.length - banner.length);
      out.set(bytes.subarray(0, off), 0);
      out.set(bytes.subarray(off + banner.length), off);
      return out;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Multi-file banner strip (cross-cwd determinism for bundles > 1 input)
// ---------------------------------------------------------------------------

/**
 * Every exact banner line a multi-file bundle may carry (newline-stripped),
 * in match form. Sources of candidates:
 *  - the entry's own cwd-relative candidates (bannerPathCandidates, same
 *    platform-Loose rules and drive-case folds as the single-file path) —
 *    the leading banner is the entry's when the entry is the first bundled
 *    file, and a dependency's otherwise;
 *  - each build input key from the metafile TWICE: the key itself — the
 *    metafile keys and the banner paths are measured byte-identical (both
 *    are Bun's cwd-relative "pretty" path, including the `../` form for
 *    files outside the cwd) — and the key resolved to an absolute path and
 *    re-derived through bannerPathCandidates (covers the case where the
 *    pretty form Bun used for the banner and the one in the metafile key
 *    differ in a platform corner, e.g. Windows drive-letter case).
 * A candidate list can never match real content by accident: a match means
 * the bytes literally are the banner we would have computed, and a no-match
 * (new Bun version, exotic path) means "leave the bytes alone" — never a
 * corrupted strip.
 */
function multiFileBannerLines(
  entryPath: string,
  inputPaths: readonly string[],
  ext: string,
): Set<string> {
  const lines = new Set<string>();
  const add = (pretty: string): void => {
    lines.add(bundlerBannerLine(pretty, ext).slice(0, -1)); // drop the line break
  };
  for (const pretty of bannerPathCandidates(entryPath)) add(pretty);
  for (const key of inputPaths) {
    add(key);
    const abs =
      process.platform === "win32"
        ? win32.resolve(process.cwd(), toPosix(key))
        : posix.resolve(process.cwd(), key);
    for (const pretty of bannerPathCandidates(abs)) add(pretty);
  }
  return lines;
}

/** The line (as text) starting at byte offset `off`, or "" when off is at/past EOF. */
function lineAt(bytes: Uint8Array, off: number): string {
  if (off >= bytes.length) return "";
  let end = off;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(off, end));
}

/**
 * Strip EVERY per-file path banner from a MULTI-file bundle (before hashing
 * and before writing to staging), so the hash and the emitted file are
 * independent of the working directory the build ran from (plan §4.6).
 *
 * Bun emits one banner line before EVERY bundled file, and the leading one
 * names the first bundled file (a dependency), not the entry — so the
 * single-file head-strip cannot identify it, and a pattern strip would eat
 * template-literal lines that merely look like banners. The strip is
 * therefore a two-stage EXACT match:
 *
 *  1. GATE — the line at the first banner position (byte 0, or after a
 *     preserved hashbang + one blank line when the entry starts with `#!`)
 *     must be byte-identical to the banner computed for ONE of the build's
 *     input files (the entry plus every metafile-enumerated import; see
 *     multiFileBannerLines). This proves the output really is a bannered
 *     bundle of THIS build. A bannerless output (code empty after the
 *     transform, a future Bun with a changed shape) never matches and the
 *     bytes are returned UNTOUCHED — the honest degradation is the old
 *     cwd-sensitive hash, never a corrupted file.
 *  2. STRIP — once gated, every line in the output that is byte-identical to
 *     a computed banner is removed (in any position — the banners sit
 *     between the files' code, one per file). Blank lines are never removed:
 *     a stripped banner's line break stays, so a `code / blank / banner /
 *     code` seam becomes `code / blank / blank / code` — deterministic,
 *     and code whitespace is not part of the hash contract.
 *
 * Why the no-gate/no-pattern discipline is safe (measured, Bun 1.4.4): the
 * transpile drops EVERY source comment, so a line of emitted code that is a
 * bare comment-shaped line (`// …` or block-comment-shaped) can only be
 * (a) a real banner, or (b)
 * template-literal content emitted verbatim. Case (b) is the one honest
 * caveat: if a line of string content is byte-identical to a computed
 * banner, it is stripped with it — it changes one line of STRING DATA
 * (the backtick boundaries stay, the code still parses), never code
 * structure. Pinning both outcomes is the job of tests/assets.test.ts.
 */
export async function stripMultiFileBanners(
  bytes: Uint8Array,
  entryPath: string,
  ext: string,
  inputPaths: readonly string[],
): Promise<Uint8Array> {
  if (bytes.length === 0) return bytes;
  const lines = multiFileBannerLines(entryPath, inputPaths, ext);
  const gateOffsets: number[] = [0];
  if (ext !== ".css") {
    const off = await hashbangBannerOffset(entryPath);
    if (off >= 0) gateOffsets.push(off);
  }
  const gated = gateOffsets.some((off) => {
    const line = lineAt(bytes, off);
    return line !== "" && lines.has(line);
  });
  if (!gated) return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; ) {
    let end = i;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    const line = new TextDecoder("utf-8").decode(bytes.subarray(i, end));
    if (!lines.has(line)) {
      out.set(bytes.subarray(i, end), n);
      n += end - i;
    }
    if (end < bytes.length) out[n++] = 0x0a; // every original line break survives
    i = end + 1;
  }
  return out.subarray(0, n);
}

/**
 * Bundle every declared script/style entrypoint into `stagingDir` and return
 * the manifest (plan §4.2). One Bun.build per entrypoint into a fresh mkdtemp
 * dir (stale-leak guard, see header); the build must emit EXACTLY ONE file,
 * whose cwd-relative per-file path banners are stripped before hashing —
 * single-input bundles through stripBundlerBanner (one leading banner),
 * multi-input bundles through stripMultiFileBanners (one banner per bundled
 * file, every one of them, gated on the first line being a computed banner) —
 * then the final bytes are hashed (sha256, first 16 hex) and copied to
 * `assets/<name>-<hash>.<ext>`. A failing entrypoint produces diagnostics
 * and does NOT cancel its siblings — every problem is collected (config.ts
 * convention), so one run reports every broken asset. All tmpdirs are removed
 * in `finally`, on success and on failure alike.
 */
export async function buildAssets(
  resolvedSite: ResolvedSite,
  stagingDir: string,
): Promise<AssetsBuildResult> {
  const staging = toPosix(stagingDir);
  const manifest = new Map<string, AssetManifestEntry>();
  const diagnostics: Diagnostic[] = [];
  const tmpdirs: string[] = [];
  try {
    for (const entry of declaredEntrypoints(resolvedSite)) {
      const outdir = await mkdtemp(posix.join(toPosix(tmpdir()), "crust-site-asset-"));
      tmpdirs.push(outdir);
      let outputs: readonly Bun.BuildArtifact[];
      // The build's input files as the bundler reports them — metafile keys,
      // which are the cwd-relative "pretty" paths the per-file banners carry
      // (measured byte-identical, Bun 1.4.4). The multi-file strip matches
      // against them (stripMultiFileBanners). Absent metafile (a future Bun)
      // → empty → the single-file strip degrades exactly as before.
      let inputPaths: string[] = [];
      try {
        // entrypoints as an ARRAY (locked fact); outdir is fresh, so nothing
        // but this build's own outputs can be collected from it.
        // metafile: true — the input keys are the metafile's ONLY use here:
        // they feed the multi-file banner strip above. They are never
        // hashed or emitted, so they cannot leak into the output bytes.
        const result = await Bun.build({
          entrypoints: [entry.path],
          outdir,
          target: "browser",
          metafile: true,
        });
        if (!result.success) {
          diagnostics.push(...bundleFailed(entry, bundlerMessages(result)));
          continue;
        }
        outputs = result.outputs;
        inputPaths = Object.keys(result.metafile?.inputs ?? {});
      } catch (error) {
        diagnostics.push(...bundleFailed(entry, bundlerMessages(error)));
        continue;
      }
      if (outputs.length === 0) {
        diagnostics.push(
          ...bundleFailed(entry, [{ message: "the bundler emitted zero output files" }]),
        );
        continue;
      }
      if (outputs.length > 1) {
        const chunks = outputs.map((o) => posix.basename(toPosix(o.path))).sort(compareStrings);
        diagnostics.push({
          code: "asset.entrypoint-chunked",
          severity: "error",
          sourcePath: entry.path,
          message:
            `${entry.key} "${entry.name}" (${entry.path}) produced ${outputs.length} output files; ` +
            `v1 emits exactly one hashed file per asset — imported asset files and code-splitting are not supported. Files: ${chunks.join(", ")}`,
        });
        continue;
      }
      const primary = outputs[0];
      const emittedPath = toPosix(primary.path);
      // v1 assets are JS (<script>) or CSS (<link>); anything else (an .svg
      // declared as an entrypoint, say) has no honest ext and no honest tag.
      const ext = posix.extname(emittedPath).toLowerCase();
      if (ext !== ".js" && ext !== ".css") {
        diagnostics.push(
          ...bundleFailed(entry, [
            {
              message: `the bundler emitted "${posix.basename(emittedPath)}" (${primary.loader}); v1 assets must be JavaScript or CSS`,
            },
          ]),
        );
        continue;
      }
      const raw = await readFile(emittedPath);
      // Strip the bundler's cwd-relative per-file path banners BEFORE the
      // hash and before staging. A single-input bundle carries exactly one
      // banner (the entry's, at the head or after a preserved hashbang), so
      // its exact match is unambiguous — stripBundlerBanner. A multi-input
      // bundle carries one banner per bundled file and its LEADING banner
      // names a dependency, not the entry — stripMultiFileBanners removes
      // every line that is an exact match of the banner computed for ANY
      // build input (entry + metafile-enumerated imports), gated on the
      // first line being such a banner. When the gate fails (bannerless
      // output, a future Bun with a changed banner shape) the bytes are
      // returned untouched: the honest degradation is the old
      // cwd-sensitive hash, never a corrupted file.
      const bytes =
        inputPaths.length > 1
          ? await stripMultiFileBanners(raw, entry.path, ext, inputPaths)
          : await stripBundlerBanner(raw, entry.path, ext);
      // Hash contract (plan §1): first 16 hex (64 bits) of sha256 over the
      // FINAL emitted bytes (all per-file banners stripped —
      // post-transform, so any input change moves the hash and the cwd
      // never does). digest("hex") is lowercase by construction. Collision
      // safety: the manifest is keyed by the DECLARED name and the emitted
      // name embeds the hash, so two distinct assets can only overwrite
      // each other if they share both name (config rejects that) and hash;
      // a 64-bit preimage-free collision budget over a site's handful of
      // assets is unreachable, so identical name+hash honestly implies
      // identical content.
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const file = posix.join(ASSETS_DIR, `${entry.name}-${hash}.${ext.slice(1)}`);
      await mkdir(posix.join(staging, ASSETS_DIR), { recursive: true });
      await writeFile(posix.join(staging, file), bytes);
      manifest.set(entry.name, { file, bytes: bytes.length });
    }
  } finally {
    // Best effort, but ALWAYS: one build's tmpdirs must not linger, and a
    // cleanup failure never masks the real result. force:true swallows the
    // already-gone case; anything else (permissions) stays silent by design.
    for (const dir of tmpdirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { manifest, diagnostics: sortDiagnostics(diagnostics) };
}

export type ManifestLookup =
  | { readonly found: true; readonly entry: AssetManifestEntry }
  | { readonly found: false; readonly diagnostic: Diagnostic };

/**
 * The render-time lookup for script(name)/stylesheet(name) (chunk 6): the
 * entry, or an asset.unknown-entrypoint diagnostic naming every declared
 * name — a map-key typo is a build error, never a silently missing tag.
 */
export function manifestLookup(manifest: AssetManifest, name: string): ManifestLookup {
  const entry = manifest.get(name);
  if (entry !== undefined) return { found: true, entry };
  const known = [...manifest.keys()].sort(compareStrings);
  return {
    found: false,
    diagnostic: {
      code: "asset.unknown-entrypoint",
      severity: "error",
      sourcePath: "",
      message:
        `asset "${name}" is not in the build manifest` +
        (known.length === 0 ? " (no assets were declared)" : ` (declared: ${known.join(", ")})`),
    },
  };
}

// ---------------------------------------------------------------------------
// copyPublicDir
// ---------------------------------------------------------------------------

export interface PublicCopyResult {
  /**
   * Every copied file, posix and relative to publicDirectory, sorted. The
   * emitter (chunk 6) feeds this to publicCollisions. Directories are not
   * listed — only files can collide.
   */
  readonly copied: string[];
  readonly diagnostics: Diagnostic[];
}

function publicMissing(what: string, dir: string): Diagnostic {
  return {
    code: "asset.public-missing",
    severity: "error",
    sourcePath: dir,
    message: `assets.publicDirectory "${dir}" ${what}`,
  };
}

/**
 * Sorted recursive copy: directories are created (empty ones too — it is the
 * tree, preserved), files are copied byte-for-byte (no CRLF rewriting: these
 * are opaque files — favicons, CNAMEs, robots alternates). File MODES are NOT
 * a contract (copyFile copies content; executable bits etc. are meaningless
 * for static hosting and are neither preserved nor normalized on purpose).
 * Symlinks (file or directory) are an ERROR, never copied and never silently
 * skipped: following them could publish an arbitrary host tree into the public
 * output or recurse forever (the package-wide "symlinks don't extend a
 * boundary" rule), but skipping quietly would be a false pass — the author
 * put the file there expecting it to publish, and a green build with a missing
 * file is exactly what crust rule 1 forbids. Raw I/O errors are NOT swallowed
 * into diagnostics — a failed copy must reject the build, not half-emit.
 */
async function walkCopy(
  publicDir: string,
  staging: string,
  rel: string,
  copied: string[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const entries = (await readdir(posix.join(publicDir, rel), { withFileTypes: true })).sort(
    (a, b) => compareStrings(a.name, b.name),
  );
  for (const d of entries) {
    const childRel = rel === "" ? d.name : posix.join(rel, d.name);
    if (d.isSymbolicLink()) {
      diagnostics.push({
        code: "asset.public-symlink",
        severity: "error",
        sourcePath: childRel,
        message:
          `the public entry "${childRel}" is a symbolic link; v1 never copies symlinks out of ` +
          `assets.publicDirectory (one could publish an arbitrary host tree) — replace it with a real file or directory`,
      });
      continue;
    }
    if (d.isDirectory()) {
      await mkdir(posix.join(staging, childRel), { recursive: true });
      await walkCopy(publicDir, staging, childRel, copied, diagnostics);
    } else if (d.isFile()) {
      await mkdir(posix.join(staging, posix.dirname(childRel)), { recursive: true });
      await copyFile(posix.join(publicDir, childRel), posix.join(staging, childRel));
      copied.push(childRel);
    }
    // fifo/socket/device entries are not copied — they are not files.
  }
}

/**
 * Copy assets.publicDirectory to the staging ROOT, preserving relative paths,
 * unhashed and unmodified (plan §2 — documented: public files get no cache
 * busting). No publicDirectory configured → silent no-op; configured but
 * absent/not-a-directory → asset.public-missing.
 */
export async function copyPublicDir(
  resolvedSite: ResolvedSite,
  stagingDir: string,
): Promise<PublicCopyResult> {
  const configured = resolvedSite.assets.publicDirectory;
  if (configured === undefined) return { copied: [], diagnostics: [] };
  const publicDir = toPosix(configured);
  const staging = toPosix(stagingDir);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(publicDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "does not exist" : `is not readable (${code ?? String(error)})`;
    return { copied: [], diagnostics: [publicMissing(why, publicDir)] };
  }
  if (!stat.isDirectory()) {
    const why = stat.isSymbolicLink()
      ? "is a symbolic link (v1 requires a real directory)"
      : "is not a directory";
    return { copied: [], diagnostics: [publicMissing(why, publicDir)] };
  }
  const copied: string[] = [];
  const diagnostics: Diagnostic[] = [];
  await walkCopy(publicDir, staging, "", copied, diagnostics);
  return { copied: copied.sort(compareStrings), diagnostics: sortDiagnostics(diagnostics) };
}

// ---------------------------------------------------------------------------
// publicCollisions
// ---------------------------------------------------------------------------

/**
 * Detect the copied public files that would clobber the emitted site.
 * `generatedPaths` are the files the emitter is about to write (index.html,
 * sitemap.xml, robots.txt, 404.html, every hashed assets/<name>-<hash>.<ext>)
 * — all posix and output-root-relative, same coordinates as `copiedPaths`.
 *
 * Four rules, deterministic order (copied paths sorted):
 *  1. the reserved prefix: `assets/` belongs to the generator whether an
 *     asset happens to be emitted right now or not — a public file there
 *     breaks the hashed-assets contract (the dev server serves assets/* as
 *     immutable; hashed names are the generator's namespace alone), so it is
 *     a collision even against an empty generated list (plan §2);
 *  2. an exact path collision with a generated file;
 *  3. a case-only collision with a generated file — the same file on
 *     case-insensitive filesystems (plan, Windows table: every path pass runs
 *     case-insensitive on top);
 *  4. a case-only collision between TWO copied public files — on a
 *     case-insensitive filesystem the second silently overwrites the first in
 *     staging, so the same pass runs over the copied set itself (a Linux-only
 *     exception would make the same config pass here and half-emit on Windows
 *     — the route table takes the same unconditional stance).
 * A file can trigger rule 1 AND rule 2/3 (it is both inside the reserved
 * namespace and a specific collision) — both diagnostics are honest, so both
 * are emitted; rules 2 and 3 are mutually exclusive.
 *
 * `sourcePath` is the copied file's public-relative posix path; the message
 * names the generated counterpart.
 */
export function publicCollisions(
  copiedPaths: readonly string[],
  generatedPaths: readonly string[],
): Diagnostic[] {
  const generatedExact = new Set<string>();
  const generatedFolded = new Map<string, string>();
  for (const g of [...generatedPaths].map(toPosix).sort(compareStrings)) {
    generatedExact.add(g);
    const folded = foldCase(g);
    if (!generatedFolded.has(folded)) generatedFolded.set(folded, g);
  }
  const diagnostics: Diagnostic[] = [];
  const copiedFolded = new Map<string, string>();
  for (const p of [...copiedPaths].map(toPosix).sort(compareStrings)) {
    const folded = foldCase(p);
    const twin = copiedFolded.get(folded);
    if (twin !== undefined && twin !== p) {
      diagnostics.push({
        code: "output.collision",
        severity: "error",
        sourcePath: p,
        message:
          `the public file "${p}" collides with the public file "${twin}" — ` +
          `they differ only by case and collide on case-insensitive filesystems`,
      });
    } else if (twin === undefined) {
      copiedFolded.set(folded, p);
    }
    if (folded.split("/")[0] === ASSETS_DIR) {
      diagnostics.push({
        code: "output.collision",
        severity: "error",
        sourcePath: p,
        message:
          `the public file "${p}" lands inside the reserved "${ASSETS_DIR}/" directory — ` +
          `hashed assets are emitted there and public files must live outside it`,
      });
    }
    if (generatedExact.has(p)) {
      diagnostics.push({
        code: "output.collision",
        severity: "error",
        sourcePath: p,
        message: `the public file "${p}" collides with the generated file "${p}"`,
      });
    } else {
      const foldedTarget = generatedFolded.get(folded);
      if (foldedTarget !== undefined && foldedTarget !== p) {
        diagnostics.push({
          code: "output.collision",
          severity: "error",
          sourcePath: p,
          message:
            `the public file "${p}" collides with the generated file "${foldedTarget}" — ` +
            `they differ only by case and collide on case-insensitive filesystems`,
        });
      }
    }
  }
  return diagnostics;
}
