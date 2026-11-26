// The @crust/site docs gate — the TypeScript analogue of `crust --check`.
//
// crust validates its own docs by parsing every documented crust LINE
// (tests/docs-lint.test.ts). Site examples are TypeScript, not crust lines,
// so the bridge here is the compiler: every ```ts fence in docs/USAGE.md and
// README.md is extracted, wrapped with a standard prelude (the package's own
// public surface), and TYPE-CHECKED with tsc --noEmit against a generated
// tsconfig plus the fixture project (tests/fixtures/docs-example — the same
// tree tests/docs.test.ts builds end to end). An example that does not
// compile is a broken example, exactly like a crust line that does not parse.
//
// Second tooth (both directions): every code in the src/diagnostics.ts
// registry must appear in the USAGE.md diagnostics table (imported from the
// source, so a new code turns this gate red until it is documented — codes
// are never repurposed, so the table can only ever grow), AND the table may
// not name a code the registry does not have (the table is "the full code
// vocabulary" — a phantom row would document behavior the package cannot
// emit).
//
// Third tooth: a fence-count canary per file (docs-lint.test.ts's minLines
// pattern) — a scanner that silently stops finding examples must fail, not
// pass by checking nothing.
//
// Fence contract: a fence either manages its own imports (any `import`
// statement) or gets the prelude; `"@crust/site"` resolves through the
// generated tsconfig's paths map to src/index.ts, so fences read exactly as
// a user's files do.
//
// Run: bun scripts/lint-docs.mjs   (wired into bun test via tests/docs.test.ts)

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DiagnosticCodes } from "../src/diagnostics.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const STAGING = `${PKG}tests/fixtures/docs-example/.docs-gen`;
const TSCONFIG = `${STAGING}/tsconfig.json`;

/** Per-file fence canaries — slightly below the real counts (see the header). */
const DOCS = [
  { file: `${PKG}docs/USAGE.md`, label: "docs/USAGE.md", minFences: 15 },
  { file: `${PKG}README.md`, label: "README.md", minFences: 3 },
];

/** The standard prelude for fences that do not manage their own imports. */
const PRELUDE = [
  "import {",
  "  build,",
  "  canonicalUrl,",
  "  checkOutputOverlap,",
  "  defineSite,",
  "  findRouteCollisions,",
  "  finalizeDocument,",
  "  html,",
  "  isNormalizedRoute,",
  "  normalizeRoute,",
  "  parseFrontmatter,",
  "  resolveConfigPaths,",
  "  routeToFile,",
  "  url,",
  "  validateUrl,",
  "  BuildError,",
  "  DiagnosticCodes,",
  "  sortDiagnostics,",
  '} from "@crust/site";',
  "import type {",
  "  BuildOptions,",
  "  BuildPage,",
  "  BuildResult,",
  "  Diagnostic,",
  "  DiagnosticCode,",
  "  FrontmatterResult,",
  "  Html,",
  "  HtmlValue,",
  "  Layout,",
  "  LayoutContext,",
  "  Page,",
  "  PageFrontmatter,",
  "  ResolvedSite,",
  "  RouteEntry,",
  "  Severity,",
  "  Site,",
  "  SiteConfig,",
  '} from "@crust/site";',
];

/**
 * Extract every ```ts fence from a markdown file. Fence tracking toggles on
 * ANY line-initial run of >= 3 backticks (so a ```` wrapper or a nested
 * ```sh block is skipped whole, never half-read); only the `ts` info string
 * is collected. Returns 1-based open-line numbers and the content lines.
 */
function extractTsFences(text) {
  const lines = text.split("\n");
  const fences = [];
  let open = null; // { marker: "`".repeat(n), info, startLine, content: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(`{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m) open = { n: m[1].length, info: m[2].trim(), startLine: i + 1, content: [] };
      continue;
    }
    // A closing fence: at least as many backticks, nothing but spaces after.
    const close = new RegExp(`^\`{${open.n},}\\s*$`);
    if (close.test(line)) {
      if (open.info === "ts") fences.push({ startLine: open.startLine, content: open.content });
      open = null;
      continue;
    }
    open.content.push(line);
  }
  if (open !== null) throw new Error(`unclosed \`\`\`${open.info} fence at line ${open.startLine}`);
  return fences;
}

/** The generated tsconfig: the package's own options, plus the paths bridge. */
function tsconfigJson() {
  return JSON.stringify(
    {
      compilerOptions: {
        lib: ["ESNext"],
        target: "ESNext",
        module: "ESNext",
        moduleDetection: "force",
        allowJs: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noFallthroughCasesInSwitch: true,
        types: ["bun-types"],
        baseUrl: PKG,
        paths: { "@crust/site": ["src/index.ts"] },
      },
      // The fences, plus the fixture config they document (the tree
      // tests/docs.test.ts builds — the gate compiles against it too).
      include: ["*.ts", "../site.config.ts"],
    },
    null,
    2,
  );
}

async function runTsc() {
  const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", TSCONFIG], {
    cwd: PKG,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: `${stdout}${stderr}`, code };
}

/** Map a tsc line back to `doc:line`, or pass fixture paths through. */
function mapTscLine(rawLine, fenceByFile) {
  const m = /^(.+?)\((\d+),(\d+)\): (error \S+): (.*)$/.exec(rawLine.trim());
  if (m === null) return `  ${rawLine.trim()}`;
  const [, file, lineStr, col, err, message] = m;
  const line = Number(lineStr);
  const base = file.slice(file.lastIndexOf("/") + 1);
  const fence = fenceByFile.get(base);
  if (fence === undefined) return `  ${file}:${line}:${col}: ${err}: ${message}`;
  const docLine = fence.startLine + (line - fence.offset);
  const where =
    line <= fence.offset
      ? `${fence.label}:${fence.startLine} (generated prelude)`
      : `${fence.label}:${docLine}`;
  return `  ${where}: ${err}: ${message}`;
}

async function main() {
  const failures = [];

  // 1. Extract fences, enforce the canaries.
  const fences = [];
  for (const doc of DOCS) {
    const text = await readFile(doc.file, "utf8");
    const found = extractTsFences(text);
    if (found.length < doc.minFences) {
      failures.push(
        `${doc.label}: only ${found.length} \`\`\`ts fences found (canary: >= ${doc.minFences}) — ` +
          "a scanner that finds no examples must fail, never pass by checking nothing",
      );
    }
    for (const [i, f] of found.entries()) {
      fences.push({ ...f, label: doc.label, name: `fence-${i}.ts` });
    }
  }

  // 2. Every diagnostic code in the registry must be documented in USAGE.md.
  const usage = await readFile(`${PKG}docs/USAGE.md`, "utf8");
  const tableRows = usage
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .join("\n");
  const undocumented = Object.values(DiagnosticCodes).filter(
    (code) => !tableRows.includes(`\`${code}\``),
  );
  for (const code of undocumented) {
    failures.push(`docs/USAGE.md: diagnostic code \`${code}\` is not in the diagnostics table`);
  }

  // 2b. The other direction: the table claims to be THE full code vocabulary,
  // so a row naming a code the registry does not have is a lie the registry
  // itself would reject (isDiagnostic is membership). Scoped to the
  // diagnostics section so other tables' backticked keys (`title`, …) stay
  // out of the check.
  const diagSection = (usage.match(/^## Diagnostics$([\s\S]*?)(?=^## )/m) ?? [])[1] ?? "";
  const phantom = [...diagSection.matchAll(/^\|\s*`([^`|]+)`\s*\|/gm)].map((m) => m[1]);
  for (const code of phantom.filter((c) => !Object.hasOwn(DiagnosticCodes, c))) {
    failures.push(
      `docs/USAGE.md: diagnostics table row \`${code}\` is not a code in the registry — the table is the full vocabulary, in both directions`,
    );
  }

  // 3. Type-check every fence (plus the fixture config) with tsc.
  await rm(STAGING, { recursive: true, force: true });
  await mkdir(STAGING, { recursive: true });
  const fenceByFile = new Map();
  try {
    let index = 0;
    for (const fence of fences) {
      const body = fence.content.join("\n");
      const ownImports = /^\s*import\s/m.test(body);
      const source = ownImports ? body : `${PRELUDE.join("\n")}\n${body}`;
      const name = fence.name.replace(".ts", `-${index++}.ts`);
      fence.name = name;
      fence.offset = ownImports ? 0 : PRELUDE.length;
      fenceByFile.set(name, fence);
      await writeFile(`${STAGING}/${name}`, `${source}\n`);
    }
    await writeFile(TSCONFIG, tsconfigJson());

    const tsc = await runTsc();
    if (tsc.code !== 0) {
      const mapped = tsc.output
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => mapTscLine(l, fenceByFile))
        .join("\n");
      failures.push(`tsc --noEmit failed for the documented examples:\n${mapped}`);
    }
  } finally {
    await rm(STAGING, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`lint-docs: FAILED\n\n${failures.join("\n\n")}\n`);
    process.exit(1);
  }
  const counts = DOCS.map(
    (d) => `${d.label}: ${fences.filter((f) => f.label === d.label).length} fences`,
  ).join(", ");
  console.log(
    `lint-docs: OK — ${counts}; ${Object.keys(DiagnosticCodes).length} diagnostic codes documented`,
  );
}

main().catch((e) => {
  console.error(`lint-docs: crashed: ${e?.stack ?? e}`);
  process.exit(1);
});
