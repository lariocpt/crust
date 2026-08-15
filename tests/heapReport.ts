import { afterAll } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import v8 from "node:v8";

const OUT_DIR = resolve(process.cwd(), ".crust/heap");
const TOP_N = 10;
// Every `bun test` wrote a ~680KB snapshot and nothing ever removed one; the
// directory had reached 226 files / 279MB. Keep a short history — enough to
// diff a regression against the previous few runs — and drop the rest.
const KEEP_SNAPSHOTS = 5;

function pruneSnapshots(): void {
  try {
    const files = readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".heapsnapshot"))
      .map((f) => {
        const p = resolve(OUT_DIR, f);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(KEEP_SNAPSHOTS)) rmSync(stale.p, { force: true });
  } catch {
    /* pruning is best-effort — never fail a test run over housekeeping */
  }
}

const startedAt = performance.now();
const rssAtStart = process.memoryUsage.rss();

type HeapSnapshot = {
  nodes: number[];
  nodeClassNames: string[];
};

// Bun's heap snapshot (v3 Inspector format) packs nodes as a flat array
// with stride 4: [id, size, classIdx, flags] per node.
const NODE_STRIDE = 4;
const CLASS_IDX_OFFSET = 2;

function topClasses(snap: HeapSnapshot, n: number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (let i = 0; i < snap.nodes.length; i += NODE_STRIDE) {
    const classIdx = snap.nodes[i + CLASS_IDX_OFFSET] as number;
    const name = snap.nodeClassNames[classIdx] ?? "<unknown>";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function emitReport(): void {
  try {
    const elapsedMs = performance.now() - startedAt;
    const mem = process.memoryUsage();
    // Two heap walks, deliberately: Bun's JSC-format snapshot is the only one
    // carrying the class histogram below, while v8.writeHeapSnapshot produces
    // the devtools-loadable file the docs tell you to open. Measured together
    // at roughly 100-130ms on this suite's ~40k-node heap — ~1.5% of the run,
    // which is the price of both artifacts.
    const snap = Bun.generateHeapSnapshot() as HeapSnapshot;

    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = resolve(OUT_DIR, `tests-${stamp}.heapsnapshot`);
    const written = v8.writeHeapSnapshot(file);
    pruneSnapshots();

    const top = topClasses(snap, TOP_N);
    const lines: string[] = [];
    lines.push("");
    lines.push("─── heap report ───────────────────────────────");
    lines.push(`elapsed:      ${elapsedMs.toFixed(0)} ms`);
    lines.push(`rss:          ${fmtBytes(mem.rss)} (Δ ${fmtBytes(mem.rss - rssAtStart)})`);
    lines.push(`heap used:    ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`);
    lines.push(`external:     ${fmtBytes(mem.external)}`);
    lines.push(`nodes:        ${(snap.nodes.length / NODE_STRIDE).toLocaleString()}`);
    lines.push(`snapshot:     ${written}`);
    lines.push(`top ${TOP_N} classes (by node count):`);
    for (const [name, count] of top) {
      lines.push(`  ${count.toString().padStart(8)}  ${name}`);
    }
    lines.push("───────────────────────────────────────────────");
    process.stderr.write(`${lines.join("\n")}\n`);
  } catch (err) {
    process.stderr.write(`[heapReport] failed: ${(err as Error).message}\n`);
  }
}

let emitted = false;
function once(): void {
  if (emitted) return;
  emitted = true;
  emitReport();
}

process.on("beforeExit", once);
process.on("exit", once);
// Bun's test runner short-circuits process exit hooks, so also register an
// afterAll. The preload runs once per test file, so afterAll is registered
// per file; the `once` guard ensures the report is emitted only once.
afterAll(once);
