// The dev server (plan §4.3/§4.4, chunk 9). Serves the site from a dev
// staging tree with live rebuild, and NEVER touches the output directory:
//
//   - builds into a dev staging SIBLING of the output (devStagingDirFor,
//     same filesystem, never /tmp) and serves it in place — the output
//     directory is only ever written by a production build's publish rename;
//   - serves production AND draft routes; each draft page carries the DRAFT
//     banner (build.ts) and link.draft / link.broken are warnings (the dev
//     server serves them, so the links resolve there — plan §5);
//   - a content change → ~100 ms debounced FULL in-process rebuild into a
//     FRESH staging tree; the serve root is swapped only on success, so a
//     failed rebuild prints its diagnostics and the last complete build
//     keeps serving (a half tree is never served — crust rule 1); the
//     watcher (fs.watch recursive, polling fallback) diffs every event
//     against a (mtime, size) baseline taken BEFORE the initial build, so
//     a recursive watch's replay of its pre-watch state (measured under
//     load) and the build's own writes never read as changes, while an edit
//     made even during the initial build is caught;
//   - a code/config change (anything under the config directory that is not
//     content, including the config file itself) → onCodeChange(): the CLI
//     worker exits with sentinel 75 and its wrapper re-execs it, because a
//     fresh process is the only way to re-import transitively imported code;
//     a library caller without a callback gets a printed restart hint. No
//     HMR, ever — the browser does a full reload;
//   - the configured port in use → a `dev.port-in-use` diagnostic (v1 does
//     NOT auto-increment: a silently different port serves the site where
//     the user is not looking — a false pass wearing a success exit);
//   - headers: HTML and public-directory files `no-store`, hashed
//     `assets/<name>-<hash>.<ext>` `public, max-age=31536000, immutable`.
//
// URL resolution is the single resolver of plan §4.5's table (E1), shared
// with the sitemap/canonical machinery via normalizeRequestPath + routeToFile.

import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { devBuild, devRebuild, loadResolvedConfig } from "./build";
import { BuildError, type Diagnostic, formatDiagnostics } from "./diagnostics";
import { devStagingDirFor, isCustodianSibling, sweepDeadDevStaging } from "./emit";
import { filesystemPath as posix } from "./fs-path";
import { normalizeRequestPath, routeToFile } from "./routes";
import type { ResolvedSite } from "./types";

const REBUILD_DEBOUNCE_MS = 100;
const POLL_INTERVAL_MS = 500;

/** One console line of dev-server output (progress goes to stderr; only the
 *  "serving at" URL line goes to stdout, and the CLI writes that one). */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// URL → file resolution (plan §4.5, the E1 table)
// ---------------------------------------------------------------------------

/**
 * The dev server's URL → file resolver — the single resolver of the E1
 * table (plan §4.5), so sitemap, `ctx.url()`, the link validator and this
 * server cannot drift:
 *
 *   /          → index.html
 *   /a         → a.html
 *   /a/b       → a/b.html
 *   /a/        → 404 (normalizeRequestPath answers null: empty segment,
 *                pinned in v1)
 *   /a.html    → the SAME file `/a` serves (a.html) — the lenient form;
 *                the canonical URL stays extensionless
 *   unmatched  → the 404 page with HTTP status 404 (never a 200 with a
 *                404 body)
 *
 * Candidates are tried in this order and the first that exists wins:
 *   1. path ending in `.html`: the LITERAL route's file (routeToFile:
 *      `/a.html` → `a.html.html`) — a page whose route genuinely ends in
 *      `.html` is served at its own URL first (exact beats lenient);
 *   2. path ending in `.html`: the lenient canonical form (suffix stripped,
 *      remainder mapped: `/a.html` → `/a` → `a.html`);
 *   3. path not ending in `.html`: the route mapping (`/a` → `a.html`);
 *   4. the literal path itself (`/favicon.txt` → `favicon.txt`) —
 *      publicDirectory files and other non-route files land at their
 *      literal names; a route mapping always wins over a same-named file.
 */
function stripHtmlSuffix(route: string): string {
  const stripped = route.slice(0, -".html".length);
  return stripped === "" ? "/" : stripped;
}

/**
 * `routeToFile` re-validates its input and THROWS for routes that can never
 * be routes — and a REQUEST path may legitimately contain one of those off-
 * Windows: `normalizeRequestPath` rejects Windows reserved names (con/nul/
 * aux/com1…) only on win32, where they are devices, but `routeToFile`'s
 * validation rejects them on every platform, where they are ordinary file
 * names. A request for `/con` must therefore skip the route candidates and
 * still try the literal file (a public file named `con` is served), never
 * crash the fetch handler into a 500.
 */
function routeFileSafe(route: string): string | null {
  try {
    return routeToFile(route);
  } catch {
    return null;
  }
}

function candidateFiles(normalized: string): string[] {
  if (normalized === "/") return ["index.html"];
  const base = normalized.slice(1);
  const out: string[] = [];
  const push = (route: string): void => {
    const file = routeFileSafe(route);
    if (file !== null) out.push(file);
  };
  if (base.endsWith(".html")) {
    push(normalized);
    push(stripHtmlSuffix(normalized));
    out.push(decodeURIComponent(base));
    return out;
  }
  push(normalized);
  // normalizeRequestPath already rejected decoded separators/traversal.
  // Route filenames retain canonical escapes; public files use literal
  // filesystem names, so decode ONCE for this fallback (not recursively).
  out.push(decodeURIComponent(base));
  return out;
}

async function fileExists(dir: string, file: string): Promise<boolean> {
  try {
    return (await stat(posix.join(dir, file))).isFile();
  } catch {
    return false;
  }
}

async function resolveServedFile(serveRoot: string, normalized: string): Promise<string | null> {
  for (const candidate of candidateFiles(normalized)) {
    if (await fileExists(serveRoot, candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// response headers
// ---------------------------------------------------------------------------

/** Content types for the extensions a generated site emits (html/js/css/xml/
 *  txt) plus the common public-directory types; anything unknown answers
 *  `application/octet-stream` (a guess is a lie, octet-stream is not). */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function contentTypeOf(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/** `assets/<name>-<16-hex-hash>.<ext>` — the hashed-asset naming contract
 *  (assets.ts). Only these get the immutable cache: the hash IS the version. */
const HASHED_ASSET = /^assets\/[A-Za-z0-9_-]+-[0-9a-f]{16}\.[A-Za-z0-9]+$/;

function cacheControlOf(file: string): string {
  // Default no-store (HTML, public files, sitemap, robots — the dev server
  // is a preview, not a cache); hashed assets are the only immutable ones.
  return HASHED_ASSET.test(file) ? "public, max-age=31536000, immutable" : "no-store";
}

// ---------------------------------------------------------------------------
// the watcher
// ---------------------------------------------------------------------------

type WatchKind = "content" | "code";
type Classifier = (absolutePath: string) => WatchKind | null;

/** One file's poll-stamp: mtime (float ms) + size cover edit/create/delete/
 *  truncate — the four changes the dev loop must see. */
interface FileStamp {
  mtime: number;
  size: number;
}
type Snapshot = Map<string, FileStamp>;

interface DevWatcher {
  stop(): void;
}

/** True iff `path` equals `root` or is below it (component-wise). */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Classify one absolute path:
 *   - under content.directory            → "content" (a rebuild)
 *   - under the output tree, or a CUSTODIAN sibling of it (production
 *     staging, dev staging, lock file, out-old — isCustodianSibling) → null:
 *     the package's own file traffic (including this process's own staging
 *     builds) must never feed back into the watcher as a change;
 *   - elsewhere under the config directory (the config file itself, layouts,
 *     entrypoints, anything else) → "code" (a worker restart);
 *   - anywhere else → null.
 */
function makeClassifier(resolved: ResolvedSite, outputDir: string): Classifier {
  const outputParent = posix.dirname(outputDir);
  const outputName = posix.basename(outputDir);
  return (absolutePath: string): WatchKind | null => {
    const p = toPosix(absolutePath);
    if (isUnder(p, resolved.content.directory)) return "content";
    if (isUnder(p, outputDir)) return null;
    const rel = posix.relative(outputParent, p);
    if (rel !== "" && !rel.startsWith("..")) {
      const first = rel.split("/")[0];
      if (first === outputName || isCustodianSibling(first)) return null;
    }
    if (isUnder(p, resolved.configDir)) return "code";
    return null;
  };
}

/**
 * Recursive walk recording regular-file (mtime, size) stamps. Symlinks are
 * never followed (the containment story: they never extend a boundary), and
 * a directory that classifies null (the output tree / a custodian sibling)
 * is pruned entirely — nothing below it is an input, so a long dev session
 * does not re-walk its own staging trees on every poll.
 *
 * The SAME walk is the baseline the event watcher verifies against (the
 * watcher section below): one shared Map, taken BEFORE the initial build.
 */
async function snapshotDir(abs: string, out: Snapshot, classify: Classifier): Promise<void> {
  // Plain readdir (strings) + one lstat per entry: withFileTypes is only a
  // stat-optimization, and lstat is needed anyway (a symlink must be told
  // from a file by lstat, not by a cached dirent).
  let names: string[];
  try {
    names = await readdir(abs);
  } catch {
    return; // vanished between polls — nothing to record
  }
  for (const name of names) {
    const full = posix.join(abs, toPosix(name));
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (classify(full) === null) continue; // prune: output tree / custodian
      await snapshotDir(full, out, classify);
    } else if (st.isFile()) {
      out.set(full, { mtime: st.mtimeMs, size: st.size });
    }
  }
}

/**
 * Polling watcher: the PRIMARY path on Windows (fs.watch is unreliable
 * there — plan Windows table) and the FALLBACK everywhere else. One diff
 * per poll over each watched root's (mtime, size) walk, compared against
 * the SHARED baseline (taken before the initial build, the same Map the
 * event watcher verifies against — the two backends can therefore hand over
 * without losing state). Added, removed and changed files each produce one
 * classified event (the debouncer upstream coalesces the burst — a rename
 * is seen as remove+add, two events, one rebuild). The baseline is updated
 * IN PLACE (the shared Map keeps its identity across a backend switch).
 */
function startPolling(
  roots: readonly string[],
  classify: Classifier,
  onEvent: (kind: WatchKind) => void,
  baseline: Snapshot,
): DevWatcher {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      const next: Snapshot = new Map();
      for (const r of roots) await snapshotDir(r, next, classify);
      for (const [abs, stamp] of next) {
        const old = baseline.get(abs);
        if (old === undefined || old.mtime !== stamp.mtime || old.size !== stamp.size) {
          const kind = classify(abs);
          if (kind !== null) onEvent(kind);
        }
        baseline.set(abs, stamp);
      }
      for (const abs of [...baseline.keys()]) {
        if (!next.has(abs)) {
          const kind = classify(abs);
          if (kind !== null) onEvent(kind);
          baseline.delete(abs);
        }
      }
    })();
  }, POLL_INTERVAL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * fs.watch (recursive) watcher: the PRIMARY path off-Windows. A root that
 * cannot be watched (it is missing) or an error event mid-life makes the
 * whole watcher fall back to polling (a per-root half-watched state would
 * miss changes on the dead root — a false pass in the dev loop).
 *
 * Event VERIFICATION (the replay guard): a recursive inotify watch
 * intermittently REPLAYS its pre-watch state — files that existed when the
 * watch started arrive as events shortly after it is established (measured
 * under load: the whole tree, config file included, delivered at startup).
 * A replay of a file the user never touched must not fire (it would
 * classify the config file as a code change and trigger a spurious
 * rebuild). The truth is the baseline stamp: an event for a file whose
 * (mtime, size) still match the baseline is a replay and is dropped; a
 * stamp that differs is a REAL change (even one made during the initial
 * build, which the pre-build baseline caught); a file absent from the
 * baseline is new and fires. The baseline entry is updated in place when a
 * change is confirmed, so a duplicate delivery of the same change is
 * dropped, and the polling fallback inherits the current baseline.
 * A root-level event (filename empty) is always passed to the classifier —
 * no root replay was observed, and a spurious one costs at most a wasted
 * (identical-output) rebuild, never a wrong serve.
 */
function startFsWatch(
  roots: readonly string[],
  classify: Classifier,
  onEvent: (kind: WatchKind) => void,
  onUnusable: () => void,
  baseline: Snapshot,
): DevWatcher {
  let stopped = false;
  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    let w: FSWatcher;
    try {
      w = watch(root, { recursive: true }, (_eventType, filename) => {
        if (stopped) return;
        // filename is relative to the watch root (measured: Linux reports
        // "a/b/inner.md"); null/undefined/empty means the root itself
        // changed, and a Buffer (the old-style filename) stringifies to the
        // same relative path — anything that is not a clean string is
        // treated as a root event rather than crashing the callback.
        const rel = filename === null || filename === undefined ? "" : String(filename);
        const abs = rel === "" ? root : posix.join(root, toPosix(rel));
        void (async () => {
          if (stopped) return;
          const old = baseline.get(abs);
          if (old !== undefined) {
            // The file was part of the pre-watch state: verify the change
            // against the baseline stamp before believing the event.
            let st: Awaited<ReturnType<typeof lstat>> | null = null;
            try {
              st = await lstat(abs);
            } catch {
              st = null;
            }
            if (st !== null && !st.isSymbolicLink()) {
              const stamp = { mtime: st.mtimeMs, size: st.size };
              if (stamp.mtime === old.mtime && stamp.size === old.size) return; // a replay
              baseline.set(abs, stamp);
            } else {
              baseline.delete(abs); // deleted before the event was processed
            }
          }
          const kind = classify(abs);
          if (kind !== null) onEvent(kind);
        })();
      });
    } catch {
      // a root that cannot be watched (e.g. the content dir is missing)
      // disqualifies the whole event-driven path: close what we opened and
      // let the caller switch to polling
      for (const opened of watchers) {
        try {
          opened.close();
        } catch {
          // already closed
        }
      }
      throw new Error(`fs.watch(${JSON.stringify(root)}) is unavailable`);
    }
    w.on("error", () => {
      if (!stopped) onUnusable();
    });
    watchers.push(w);
  }
  return {
    stop() {
      stopped = true;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
    },
  };
}

/** Polling on win32; otherwise fs.watch with a polling fallback. Both
 *  backends diff against the one shared baseline (see startDev). */
function startWatcher(
  roots: readonly string[],
  classify: Classifier,
  onEvent: (kind: WatchKind) => void,
  baseline: Snapshot,
): DevWatcher {
  if (process.platform === "win32") return startPolling(roots, classify, onEvent, baseline);
  let current: DevWatcher | null = null;
  const switchToPolling = (): void => {
    if (current === null) return;
    current.stop();
    current = startPolling(roots, classify, onEvent, baseline);
  };
  try {
    current = startFsWatch(roots, classify, onEvent, switchToPolling, baseline);
  } catch {
    current = null;
  }
  if (current === null) current = startPolling(roots, classify, onEvent, baseline);
  return current;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export interface StartDevOptions {
  /** Path to `site.config.ts`; relative paths resolve against the cwd. */
  readonly configFile: string;
  /** Overrides `dev.hostname` (default "localhost"). */
  readonly hostname?: string;
  /** Overrides `dev.port` (default: ephemeral — 0). */
  readonly port?: number;
  /**
   * Called when a code or config change is detected. The `crust-site dev`
   * CLI worker uses it to `process.exit(75)` — the wrapper re-execs the
   * worker, and a fresh process is the only way to re-import transitively
   * imported code (the config's layouts, its imports). Default: print a
   * restart hint (a library caller running `startDev` in its own process
   * cannot safely be exited by the library).
   */
  readonly onCodeChange?: () => void;
}

export interface DevServer {
  /** The port the server actually bound (an ephemeral port when unset). */
  readonly port: number;
  /** The display hostname (`0.0.0.0`/`::` are shown as `localhost`). */
  readonly hostname: string;
  /**
   * Stop the server: the watcher and any pending rebuild are shut down, the
   * server socket is closed, and the dev staging tree is deleted (it is
   * temporary — a kill in the middle is reclaimed by the next startup's
   * sweepDeadDevStaging).
   */
  stop(): Promise<void>;
}

interface DevState {
  readonly resolved: ResolvedSite;
  readonly outputDir: string;
  readonly configPath: string;
  /** Swapped to the fresh staging tree on every successful rebuild. */
  serveRoot: string;
  rebuilding: boolean;
  /** A content change arrived while a rebuild was running (or queued). */
  pendingRebuild: boolean;
  /** A code/config change arrived while a rebuild was running. */
  codeChangePending: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  rebuildInFlight: Promise<void> | null;
  stopped: boolean;
  watcher: DevWatcher | null;
}

/** The default onCodeChange: a hint, never a silent no-op. */
function defaultOnCodeChange(): void {
  log(
    "crust-site dev: code or config changed — this dev server cannot re-import its own code graph in-process. " +
      "Restart it to pick up the change (`crust-site dev` restarts its worker automatically).",
  );
}

/** `0.0.0.0`/`::`/`*` bind every interface; the URL printed to the user is localhost. */
function displayHost(hostname: string): string {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "*" ? "localhost" : hostname;
}

function portInUseDiagnostics(port: number, hostname: string): Diagnostic[] {
  return [
    {
      code: "dev.port-in-use",
      severity: "error",
      message:
        `dev port ${port} is already in use (bound hostname ${JSON.stringify(hostname)}). ` +
        `Stop the other process or set dev.port in the config — the dev server does not ` +
        `auto-increment, because a silently different port would serve the site somewhere ` +
        `you are not looking at`,
    },
  ];
}

/**
 * Start the dev server: load + resolve the config, sweep dead dev staging
 * from killed predecessors, run the initial mode-"dev" build, bind the
 * server (EADDRINUSE → `dev.port-in-use`), and start the watcher. Rejects
 * with a BuildError (every diagnostic) when the config is invalid or the
 * initial build fails — in both cases the dev staging is deleted and the
 * output directory has not been touched.
 */
export async function startDev(options: StartDevOptions): Promise<DevServer> {
  const configFile = options?.configFile ?? "";
  const loaded = await loadResolvedConfig(configFile);
  // A long dev session accumulates one dead-pid staging tree per worker
  // restart; reclaim them before adding our own (a killed process's litter
  // is bounded, never permanent).
  await sweepDeadDevStaging(loaded.resolved.output.directory);
  // The watcher baseline is taken BEFORE the initial build: the (mtime,
  // size) stamps of the pre-watch tree are the reference every later change
  // is diffed against. A pre-build baseline is the only one that also sees
  // an edit made DURING the initial build (a post-build baseline would miss
  // it forever) — and it is what makes the fs.watch replay guard
  // meaningful (a replay of an unmodified file matches it and is dropped).
  const roots = [
    ...new Set([toPosix(loaded.resolved.content.directory), toPosix(loaded.resolved.configDir)]),
  ];
  const classify = makeClassifier(loaded.resolved, posix.resolve(loaded.resolved.output.directory));
  const baseline: Snapshot = new Map();
  for (const r of roots) await snapshotDir(r, baseline, classify);

  const initial = await devBuild({ configFile });

  const resolved = initial.resolved;
  const outputDir = posix.resolve(resolved.output.directory);
  // the raw value BINDS; the display form is what the user types in a
  // browser (a 0.0.0.0 bind is announced as localhost)
  const bindHost = options.hostname ?? resolved.dev?.hostname ?? "localhost";
  const hostname = displayHost(bindHost);
  const port = options.port ?? resolved.dev?.port ?? 0;
  const onCodeChange = options.onCodeChange ?? defaultOnCodeChange;
  const prefix = new URL(resolved.site).pathname.replace(/\/$/, "");

  const state: DevState = {
    resolved,
    outputDir,
    configPath: initial.configPath,
    serveRoot: initial.staging,
    rebuilding: false,
    pendingRebuild: false,
    codeChangePending: false,
    debounceTimer: null,
    rebuildInFlight: null,
    stopped: false,
    watcher: null,
  };
  // The serve root behind the fetch handler: swapped on every successful
  // rebuild, deleted on stop. One mutable cell, read per request.
  const rootRef = { current: initial.staging };

  const cleanupStaging = async (): Promise<void> => {
    await rm(rootRef.current, { recursive: true, force: true }).catch(() => {});
  };

  // Bind. EADDRINUSE → `dev.port-in-use` (v1 does not auto-increment). Any
  // other throw or a missing bound port → the staging is deleted and the
  // error rethrown (the output directory is untouched).
  let server: ReturnType<typeof Bun.serve> | undefined;
  let boundPort: number | undefined;
  try {
    server = Bun.serve({
      hostname: bindHost,
      port,
      fetch: (req) => serveRequest(req, rootRef, prefix),
    });
    // bun-types types `port` as `number | undefined` (a unix-socket server
    // has none); a port-bound server always has one, so an undefined here is
    // an engine anomaly — fail honestly, never report a fake port.
    boundPort = server.port;
    if (boundPort === undefined) {
      throw new Error("the dev server bound no port (Bun.serve reported undefined)");
    }
  } catch (e) {
    server?.stop(true);
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      await cleanupStaging();
      throw new BuildError(portInUseDiagnostics(port, hostname));
    }
    await cleanupStaging();
    throw e;
  }

  // The watcher watches the same roots/classifier computed before the build
  // (one shared baseline across both backends).
  state.watcher = startWatcher(
    roots,
    classify,
    (kind) => {
      if (kind === "content") scheduleRebuild();
      else noteCodeChange();
    },
    baseline,
  );

  return {
    port: boundPort,
    hostname,
    stop: async (): Promise<void> => {
      state.stopped = true;
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
      state.watcher?.stop();
      if (state.rebuildInFlight !== null) await state.rebuildInFlight;
      server.stop(true);
      await cleanupStaging();
    },
  };

  function scheduleRebuild(): void {
    if (state.stopped) return;
    if (state.rebuilding) {
      state.pendingRebuild = true;
      return;
    }
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      if (state.stopped) return;
      state.rebuilding = true;
      state.rebuildInFlight = rebuildLoop();
    }, REBUILD_DEBOUNCE_MS);
  }

  function noteCodeChange(): void {
    if (state.stopped) return;
    // a code/config change voids any queued content rebuild: the session is
    // about to restart (CLI) or the user is told to (default), and the
    // queued rebuild would only waste a cycle before the exit.
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    state.pendingRebuild = false;
    if (state.rebuilding) {
      // let the in-flight rebuild settle (it started before the change
      // landed), then the loop fires the callback
      state.codeChangePending = true;
      return;
    }
    onCodeChange();
  }

  async function rebuildLoop(): Promise<void> {
    try {
      for (;;) {
        await doRebuild();
        if (state.codeChangePending) {
          state.codeChangePending = false;
          state.pendingRebuild = false;
          onCodeChange();
          return;
        }
        if (state.stopped || !state.pendingRebuild) return;
        state.pendingRebuild = false;
      }
    } finally {
      state.rebuilding = false;
      state.rebuildInFlight = null;
    }
  }

  async function doRebuild(): Promise<void> {
    const prev = state.serveRoot;
    const next = devStagingDirFor(state.outputDir);
    try {
      const result = await devRebuild(state.resolved, next, state.outputDir);
      if (state.stopped) {
        // stopped mid-rebuild: the tree nobody will serve is deleted here
        await rm(next, { recursive: true, force: true }).catch(() => {});
        return;
      }
      // success: swap the serve root, then delete the previous tree. The
      // swap is a pointer move — readers either see the complete old tree or
      // the complete new one, never a half tree. serveRoot tracks the swap
      // so the NEXT rebuild deletes the tree that was really just served
      // (not the initial one forever — that would leak one staging per
      // rebuild).
      rootRef.current = next;
      state.serveRoot = next;
      await rm(prev, { recursive: true, force: true }).catch(() => {});
      const drafts = result.draftPages.length;
      log(
        `crust-site dev: rebuilt in ${result.durationMs} ms — ${result.pages.length} page` +
          `${result.pages.length === 1 ? "" : "s"}, ${drafts} draft${drafts === 1 ? "" : "s"}`,
      );
      if (result.warnings.length > 0) {
        log(formatDiagnostics(result.warnings, { color: process.stderr.isTTY === true }));
      }
    } catch (e) {
      // failure: delete the half tree and keep serving the last complete
      // build (crust rule 1: the diagnostics are printed, the stale content
      // keeps serving — never a false "rebuilt" line).
      await rm(next, { recursive: true, force: true }).catch(() => {});
      if (e instanceof BuildError) {
        log(`crust-site dev: rebuild failed — the last complete build keeps serving\n`);
        log(formatDiagnostics(e.diagnostics, { color: process.stderr.isTTY === true }));
      } else {
        log(
          `crust-site dev: rebuild failed (${messageOf(e)}) — the last complete build keeps serving`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

async function serveNotFound(serveRoot: string): Promise<Response> {
  try {
    const buf = await Bun.file(posix.join(serveRoot, "404.html")).arrayBuffer();
    return new Response(buf, {
      status: 404,
      headers: new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      }),
    });
  } catch {
    // 404.html missing from the serve root is an engine bug (every build
    // emits it) — answer a plain 404 anyway: never a 200 with a 404 body.
    return new Response("Not Found", {
      status: 404,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
    });
  }
}

async function serveRequest(
  req: Request,
  rootRef: { current: string },
  prefix: string,
): Promise<Response> {
  const serveRoot = rootRef.current;
  let normalized: string | null;
  try {
    let pathname = new URL(req.url).pathname;
    // Match the serialized site prefix at a segment boundary, once only.
    // Keep root-relative preview URLs working too. Validate the remaining
    // path normally: stripping a mount must not admit traversal/separators.
    if (prefix !== "" && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      pathname = pathname.slice(prefix.length) || "/";
    }
    normalized = normalizeRequestPath(pathname);
  } catch {
    normalized = null;
  }
  if (normalized === null) return serveNotFound(serveRoot);
  const file = await resolveServedFile(serveRoot, normalized);
  if (file === null) return serveNotFound(serveRoot);
  const abs = posix.join(serveRoot, file);
  // containment re-verified on the resolved path (the write-path rule,
  // applied to reads): the resolver only emits clean relative paths, but an
  // upstream bug must 404, not serve outside the tree.
  if (abs !== serveRoot && !abs.startsWith(`${serveRoot}/`)) return serveNotFound(serveRoot);
  let buf: ArrayBuffer;
  try {
    buf = await Bun.file(abs).arrayBuffer();
  } catch {
    return serveNotFound(serveRoot);
  }
  return new Response(buf, {
    status: 200,
    headers: new Headers({
      "content-type": contentTypeOf(file),
      "cache-control": cacheControlOf(file),
    }),
  });
}
