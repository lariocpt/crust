// The one-shot execution plane of the MCP surface: every tool that runs and
// returns spawns a crust CHILD process per call.
//
// Why a child is structural, not cosmetic: runLine's pure-shell path spawns
// `sh -c` with INHERITED stdio — in-process execution would write raw bytes
// into the protocol's stdout and corrupt JSON-RPC. The child boundary also
// buys real exit codes, killable process groups, and per-call cwd/env.
//
// Honest-failure contract (the repo's first design rule, ported to MCP): a
// nonzero child exit, a killed timeout, or a failed assert is an isError
// result carrying the child's own output — never a success that measured
// nothing. Output caps are always announced, never silent.

import { killGroup } from "../sources";
import type { JsonObject } from "./protocol";
import {
  capText,
  fail,
  ok,
  optBool,
  optInt,
  optStr,
  optStrArray,
  optStrMap,
  reqStr,
  requireKeys,
  type ToolDef,
  ToolError,
  type ToolResult,
} from "./support";

// ------------------------------------------------------------- child crust ----

/** How to re-invoke THIS crust from inside itself. A compiled binary is its
 *  own argv[0]; under `bun src/index.ts` the runtime plus script path are. */
export function crustSpawnArgv(): string[] {
  const script = process.argv[1];
  if (script && /\.[cm]?[jt]sx?$/.test(script)) return [process.execPath, script];
  return [process.execPath];
}

export interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_MIN = 1_000;
export const TIMEOUT_MAX = 3_600_000;

/** Run `crust <args…>` to completion (or kill its whole process group at the
 *  deadline — children are spawned detached so grandchildren die too, the
 *  same lesson as crust's own shell stages). */
export async function runCrust(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ChildRun> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...crustSpawnArgv(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
  } catch (err) {
    // A bad cwd is Bun.spawn throwing ENOENT — name the argument at fault.
    if (opts.cwd !== undefined && (err as Error).message.includes(opts.cwd)) {
      throw new ToolError(`invalid "cwd": ${(err as Error).message}`);
    }
    throw err;
  }
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    killGroup(proc, "SIGKILL");
  }, timeoutMs);
  // No race needed: the watchdog KILLS the child, so `proc.exited` is the one
  // promise that always lands — with or without the deadline.
  const readOut = new Response(proc.stdout as ReadableStream).text();
  const readErr = new Response(proc.stderr as ReadableStream).text();
  await proc.exited;
  clearTimeout(killer);
  const stdout = await readOut;
  const stderr = await readErr;
  return { code: timedOut ? -1 : (proc.exitCode ?? -1), stdout, stderr, timedOut };
}

/** One child crust run rendered as a tool result. Nonzero exit and timeouts
 *  are isError with the child's verbatim streams — the line's answer is the
 *  child's, so the tool adds no verdict of its own beyond the exit code. */
export function renderRun(run: ChildRun, timeoutMs: number): ToolResult {
  const parts: string[] = [];
  if (run.timedOut) {
    parts.push(`timed out after ${timeoutMs}ms — process group killed (exit reported as -1)`);
  } else {
    parts.push(`exit ${run.code}`);
  }
  const out = capText(run.stdout);
  const err = capText(run.stderr);
  if (out.text.trim()) parts.push(`--- stdout ---\n${out.text.replace(/\n$/, "")}`);
  if (err.text.trim()) parts.push(`--- stderr ---\n${err.text.replace(/\n$/, "")}`);
  if (!out.text.trim() && !err.text.trim()) parts.push("(no output)");
  const failed = run.timedOut || run.code !== 0;
  return failed ? fail(parts.join("\n")) : ok(parts.join("\n"));
}

function timeoutArg(args: JsonObject, max = TIMEOUT_MAX): number | undefined {
  return optInt(args, "timeout_ms", TIMEOUT_MIN, max);
}

/** Per-call cwd/env/watchdog, shared by every one-shot tool. */
function callOpts(args: JsonObject): {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
} {
  return {
    cwd: optStr(args, "cwd"),
    env: optStrMap(args, "env"),
    timeoutMs: timeoutArg(args),
  };
}

// ------------------------------------------------------------ tool defs ----

export const ONE_SHOT_TOOLS: ToolDef[] = [
  {
    name: "crust_run_line",
    description:
      "Run one crust line (or several separated by newlines) in a fresh `crust -c` child and capture its streams. The full grammar is available: pipelines, HTTP verbs, sql, procs(), load, asserts. cwd and env apply to THIS call only — a child never keeps session state between calls; pass $-style env vars explicitly. Nonzero exit (a failed assert, a 404 expect, a shell stage failing) is an error result carrying the child's exit code and output.",
    inputSchema: {
      type: "object",
      properties: {
        line: { type: "string", description: "crust line(s); newlines separate script lines" },
        cwd: { type: "string", description: "working directory for the child" },
        env: { type: "object", additionalProperties: { type: "string" } },
        timeout_ms: {
          type: "number",
          description: "kill the whole process group at this deadline (default 120000)",
        },
      },
      required: ["line"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(args, ["line", "cwd", "env", "timeout_ms"], ["line"]);
      const line = reqStr(args, "line");
      const o = callOpts(args);
      const run = await runCrust(["-c", line], { ...o });
      return renderRun(run, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  },
  {
    name: "crust_check_line",
    description:
      "Parse crust line(s) WITHOUT running them — the same linter that guards this repo's docs (`crust --check`). No I/O, no spawn: examples referencing files or ports check clean. Reports the first parse failure with the offending line. Use it to validate generated crust before spending a run.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: "line(s) to parse; same splitting as the runtime (backslash continuation)",
        },
      },
      required: ["line"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(args, ["line"], ["line"]);
      const run = await runCrust(["--check", reqStr(args, "line")], { timeoutMs: 15_000 });
      return renderRun(run, 15_000);
    },
  },
  {
    name: "crust_test_fixture",
    description:
      "Run .crust.ts fixture files (or a glob) with `test-fixture`: setup() context, async matchers, JUnit/JSON reports; -n/-j turn any fixture into a stress run with p50/p95/p99. Failures are an error result with the runner's own report verbatim — an unknown matcher key or a thrown predicate fails the run, never passes quietly.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "fixture file or glob, e.g. tests/api/**/*.crust.ts",
        },
        out: { type: "string", description: "report path (.json / .junit.xml by extension)" },
        threads: { type: "number", description: "-j parallel threads" },
        count: { type: "number", description: "-n iterations per fixture (stress runs)" },
        per_test_timeout_ms: { type: "number", description: "-t per-fixture timeout" },
        bail: { type: "boolean", description: "-b stop at first failure" },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        timeout_ms: { type: "number", description: "child watchdog (default 120000)" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(
        args,
        [
          "target",
          "out",
          "threads",
          "count",
          "per_test_timeout_ms",
          "bail",
          "cwd",
          "env",
          "timeout_ms",
        ],
        ["target"],
      );
      const argv = ["test-fixture", reqStr(args, "target")];
      const out = optStr(args, "out");
      if (out) argv.push("-o", out);
      const threads = optInt(args, "threads", 1, 1024);
      if (threads !== undefined) argv.push("-j", String(threads));
      const count = optInt(args, "count", 1, 1_000_000);
      if (count !== undefined) argv.push("-n", String(count));
      const t = optInt(args, "per_test_timeout_ms", 1, TIMEOUT_MAX);
      if (t !== undefined) argv.push("-t", String(t));
      if (optBool(args, "bail")) argv.push("-b");
      const o = callOpts(args);
      const run = await runCrust(argv, o);
      return renderRun(run, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  },
  {
    name: "crust_test_pipes",
    description:
      "Run .pipes suites (one shorthand pipeline per line, chained via capture) with `test-pipes`. -s supplies a setup .ts module for $BASE/$TOKEN context; -o writes a JUnit report. A suite that measured nothing fails — the runner never reports a false pass.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: ".pipes file or glob" },
        out: { type: "string", description: "JUnit report path" },
        setup: { type: "string", description: "-s setup .ts module" },
        per_test_timeout_ms: { type: "number" },
        bail: { type: "boolean" },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        timeout_ms: { type: "number" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(
        args,
        ["target", "out", "setup", "per_test_timeout_ms", "bail", "cwd", "env", "timeout_ms"],
        ["target"],
      );
      const argv = ["test-pipes", reqStr(args, "target")];
      const out = optStr(args, "out");
      if (out) argv.push("-o", out);
      const setup = optStr(args, "setup");
      if (setup) argv.push("-s", setup);
      const t = optInt(args, "per_test_timeout_ms", 1, TIMEOUT_MAX);
      if (t !== undefined) argv.push("-t", String(t));
      if (optBool(args, "bail")) argv.push("-b");
      const o = callOpts(args);
      const run = await runCrust(argv, o);
      return renderRun(run, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  },
  {
    name: "crust_gen_fixtures",
    description:
      "Generate a fixture suite from an OpenAPI spec with `gen-fixtures`: CRUD flow files plus a negative-case matrix (required-field drops, wrong types) as .crust.ts fixtures in an output dir. Point crust_test_fixture at the generated glob afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "OpenAPI/Swagger spec, path or URL" },
        out: { type: "string", description: "output directory (default fixtures/generated)" },
        setup: {
          type: "string",
          description: "setup module name the fixtures import (default ../setup.ts)",
        },
        no_flows: { type: "boolean", description: "skip the CRUD flow suite, negative cases only" },
        cwd: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(args, ["spec", "out", "setup", "no_flows", "cwd", "timeout_ms"], ["spec"]);
      const argv = ["gen-fixtures", reqStr(args, "spec")];
      const out = optStr(args, "out");
      if (out) argv.push("-o", out);
      const setup = optStr(args, "setup");
      if (setup) argv.push("-s", setup);
      if (optBool(args, "no_flows")) argv.push("--no-flows");
      const o = callOpts(args);
      const run = await runCrust(argv, o);
      return renderRun(run, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },
  },
  {
    name: "crust_verify_web_links",
    description:
      "Crawl a site and verify every link, anchor, redirect chain and OG/meta tag with `verify-web-links` (machine-readable JSON output). --base-url discovers the sitemap (robots.txt → /sitemap.xml); site_map_url takes a local sitemap so build output can be checked before publishing. Broken links / meta regressions exit nonzero → error result with the violations. Crawling is long-running: raise timeout_ms for big sites.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "site URL or sitemap path/URL (positional; shape decides)",
        },
        base_url: { type: "string", description: "--base-url: auto-discover the sitemap" },
        site_map_url: { type: "string", description: "local/alternate sitemap (sitemap-index OK)" },
        fixtures: { type: "string", description: ".crust.ts fixtures to diff meta against" },
        concurrency: { type: "number" },
        per_request_timeout_ms: { type: "number" },
        max_depth: { type: "number" },
        max_pages: { type: "number" },
        exclude: { type: "array", items: { type: "string" }, description: "URL patterns to skip" },
        no_recurse: { type: "boolean" },
        no_anchors: { type: "boolean" },
        include_external: { type: "boolean" },
        strict: { type: "boolean", description: "treat warnings (redirects, OG) as failures" },
        cwd: { type: "string" },
        timeout_ms: { type: "number", description: "child watchdog (default 600000)" },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(
        args,
        [
          "source",
          "base_url",
          "site_map_url",
          "fixtures",
          "concurrency",
          "per_request_timeout_ms",
          "max_depth",
          "max_pages",
          "exclude",
          "no_recurse",
          "no_anchors",
          "include_external",
          "strict",
          "cwd",
          "timeout_ms",
        ],
        ["source"],
      );
      const argv = ["verify-web-links", reqStr(args, "source"), "--json", "--no-progress"];
      const baseUrl = optStr(args, "base_url");
      if (baseUrl) argv.push("--base-url", baseUrl);
      const smap = optStr(args, "site_map_url");
      if (smap) argv.push("--site-map-url", smap);
      const fixtures = optStr(args, "fixtures");
      if (fixtures) argv.push("--fixtures", fixtures);
      const c = optInt(args, "concurrency", 1, 64);
      if (c !== undefined) argv.push("-c", String(c));
      const t = optInt(args, "per_request_timeout_ms", 100, TIMEOUT_MAX);
      if (t !== undefined) argv.push("-t", String(t));
      const d = optInt(args, "max_depth", 0, 1000);
      if (d !== undefined) argv.push("--max-depth", String(d));
      const p = optInt(args, "max_pages", 1, 1_000_000);
      if (p !== undefined) argv.push("--max-pages", String(p));
      for (const ex of optStrArray(args, "exclude") ?? []) argv.push("--exclude", ex);
      if (optBool(args, "no_recurse")) argv.push("--no-recurse");
      if (optBool(args, "no_anchors")) argv.push("--no-anchors");
      if (optBool(args, "include_external")) argv.push("--include-external");
      if (optBool(args, "strict")) argv.push("--strict");
      const o = callOpts(args);
      const run = await runCrust(argv, { ...o, timeoutMs: o.timeoutMs ?? 600_000 });
      return renderRun(run, o.timeoutMs ?? 600_000);
    },
  },
  {
    name: "crust_load_run",
    description:
      'A paced load run CI can gate on, built as the documented pipeline: `load <dur> <rate>/s | parallel <n> | <target> | stats | assert`. Thresholds are assert composition, so a failure names the predicate and exits nonzero; a run that measured nothing is tagged `empty` and refused. Multi-phase ramps: phases: "10s 50/s, 5m 200/s" (mutually exclusive with duration+rate). Returns the stats output; assert failures are error results with the stats still included.',
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: 'stages under load, e.g. "GET http://localhost:3000/health | expect 200"',
        },
        duration: { type: "string", description: 'phase duration, e.g. "30s" or "5m"' },
        rate: { type: "number", description: "requests per second for the duration" },
        phases: {
          type: "string",
          description: 'multi-phase schedule "10s 50/s, 5m 200/s" instead of duration+rate',
        },
        parallel: { type: "number", description: "worker pool size (default 50)" },
        stats_every: { type: "number", description: "rolling window seconds for stats lines" },
        stats_out: { type: "string", description: "write the final stats JSON to this path" },
        assert: {
          type: "string",
          description: 'gate predicate, e.g. "s => s.p95 < 250" (parens optional)',
        },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        timeout_ms: {
          type: "number",
          description: "child watchdog; default is the schedule plus 60s grace",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    async run(_jm, args) {
      requireKeys(
        args,
        [
          "target",
          "duration",
          "rate",
          "phases",
          "parallel",
          "stats_every",
          "stats_out",
          "assert",
          "cwd",
          "env",
          "timeout_ms",
        ],
        ["target"],
      );
      const duration = optStr(args, "duration");
      const phases = optStr(args, "phases");
      const rate = optInt(args, "rate", 1, 1_000_000);
      if (phases !== undefined && (duration !== undefined || rate !== undefined)) {
        throw new ToolError('"phases" replaces "duration"+"rate" — give one shape, not both');
      }
      let head: string;
      let scheduleText: string;
      if (phases !== undefined) {
        if (!/^\s*\d[\d.]*\s*(ms|s|m|h)?\s+\d/.test(phases)) {
          throw new ToolError('invalid "phases": expected "10s 50/s, 5m 200/s"');
        }
        head = `load ${phases}`;
        scheduleText = phases;
      } else {
        if (duration === undefined || rate === undefined) {
          throw new ToolError('give "duration" + "rate", or "phases"');
        }
        if (!/^\d+(\.\d+)?(ms|s|m|h)$/.test(duration)) {
          throw new ToolError('invalid "duration": expected like "30s", "5m", "2h"');
        }
        head = `load ${duration} ${rate}/s`;
        scheduleText = duration;
      }
      const parallel = optInt(args, "parallel", 1, 100_000) ?? 50;
      let stats = "stats";
      const every = optInt(args, "stats_every", 1, 3600);
      if (every !== undefined) stats += ` --every ${every}`;
      const statsOut = optStr(args, "stats_out");
      if (statsOut) stats += ` --out ${statsOut}`;
      let line = `${head} | parallel ${parallel} | ${reqStr(args, "target").trim()} | ${stats}`;
      const assertText = optStr(args, "assert");
      if (assertText !== undefined) {
        const pred = assertText.trim();
        line += ` | assert ${pred.startsWith("(") ? pred : `(${pred})`}`;
      }
      // Grace computed from the schedule itself — a watchdog shorter than the
      // run is a guaranteed false failure, and the repo refuses to ship one.
      let scheduleMs = 0;
      for (const m of scheduleText.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)) {
        const n = Number(m[1]);
        scheduleMs +=
          n * (m[2] === "ms" ? 1 : m[2] === "s" ? 1_000 : m[2] === "m" ? 60_000 : 3_600_000);
      }
      const defaultTimeout = Math.max(30_000, scheduleMs) + 60_000;
      const timeoutMs = timeoutArg(args) ?? Math.min(defaultTimeout, TIMEOUT_MAX);
      const o = callOpts(args);
      const run = await runCrust(["-c", line], { ...o, timeoutMs });
      return renderRun(run, timeoutMs);
    },
  },
];
