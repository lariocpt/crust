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
//
// Determinism (plan §4.6): entrypoints are iterated in sorted name order, the
// manifest is a Map in that insertion order, the public copy traverses sorted
// per directory, and all returned paths are posix (plan, Windows table).

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
import { posix } from "node:path";
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

/**
 * Bundle every declared script/style entrypoint into `stagingDir` and return
 * the manifest (plan §4.2). One Bun.build per entrypoint into a fresh mkdtemp
 * dir (stale-leak guard, see header); the build must emit EXACTLY ONE file,
 * which is hashed (sha256, first 16 hex of the final bytes) and copied to
 * `assets/<name>-<hash>.<ext>`. A failing entrypoint produces diagnostics and
 * does NOT cancel its siblings — every problem is collected (config.ts
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
      try {
        // entrypoints as an ARRAY (locked fact); outdir is fresh, so nothing
        // but this build's own outputs can be collected from it.
        const result = await Bun.build({
          entrypoints: [entry.path],
          outdir,
          target: "browser",
        });
        if (!result.success) {
          diagnostics.push(...bundleFailed(entry, bundlerMessages(result)));
          continue;
        }
        outputs = result.outputs;
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
      const bytes = await readFile(emittedPath);
      // Hash contract (plan §1): first 16 hex (64 bits) of sha256 over the
      // FINAL emitted bytes — post-transform, so any input change moves it.
      // digest("hex") is lowercase by construction. Collision safety: the
      // manifest is keyed by the DECLARED name and the emitted name embeds the
      // hash, so two distinct assets can only overwrite each other if they
      // share both name (config rejects that) and hash; a 64-bit preimage-free
      // collision budget over a site's handful of assets is unreachable, so
      // identical name+hash honestly implies identical content.
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
