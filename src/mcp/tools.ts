// The lifecycle plane of the MCP tool surface: mock servers, procs runners
// and logs sessions, held IN-PROCESS by the JobManager for as long as the
// MCP host keeps this server open. One-shot tools live in oneshot.ts; this
// module adds the stateful half and the full registry.
//
// What dies with the server: every held mock, every supervised process group,
// every tailed source. The stop tools report teardown honestly ("teardown
// still in flight past 10s") and server shutdown tears everything down.

import type { JobManager, MockJob } from "./jobs";
import { ONE_SHOT_TOOLS } from "./oneshot";
import type { JsonObject } from "./protocol";
import {
  fail,
  ok,
  optBool,
  optInt,
  optStr,
  reqStr,
  requireKeys,
  type ToolDef,
  ToolError,
  type ToolResult,
} from "./support";

const BUFFER_MIN = 1;
const BUFFER_MAX = 1_000_000; // the ring's own ceiling (logs/ring MAX_CAPACITY)

function mockUrl(job: MockJob): string {
  const host = job.server.hostname.includes(":") ? `[${job.server.hostname}]` : job.server.hostname;
  return `http://${host}:${job.server.port}`;
}

const MOCK_TOOLS: ToolDef[] = [
  {
    name: "crust_mock_server_start",
    description:
      "Boot a mock server from an OpenAPI/Swagger spec and KEEP it running across calls. Example-first responses; stateful CRUD with state (sqlite/postgres persistence) or seed data; validate/strict request validation (violations answer 422); proxy turns it into a conformance audit of a REAL API (forward untouched, record violations — read them with crust_mock_server_violations). port defaults to 0 (OS-assigned, collision-free — the returned url is the one to use). Returns id for stop/list/violations.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", description: "OpenAPI/Swagger spec, path or URL" },
        port: { type: "number", description: "listen port (default 0 = OS-assigned)" },
        host: { type: "string", description: "bind address (default 127.0.0.1)" },
        stateful: { type: "boolean", description: "in-memory CRUD on top of the examples" },
        state: {
          type: "string",
          description: "persist CRUD state: file path, sqlite:// or postgres:// URL",
        },
        seed: { type: "string", description: "JSON seed file inserted at boot" },
        validate: { type: "boolean", description: "validate requests, 422 on violations" },
        strict: { type: "boolean", description: "also enforce additionalProperties:false" },
        proxy: { type: "string", description: "upstream URL — validation-proxy mode" },
        proxy_timeout_ms: { type: "number" },
        report: { type: "string", description: "append violations as NDJSON (needs proxy)" },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(
        args,
        [
          "spec",
          "port",
          "host",
          "stateful",
          "state",
          "seed",
          "validate",
          "strict",
          "proxy",
          "proxy_timeout_ms",
          "report",
        ],
        ["spec"],
      );
      const job = await jm.startMock({
        spec: reqStr(args, "spec"),
        port: optInt(args, "port", 0, 65535) ?? 0,
        host: optStr(args, "host") ?? "127.0.0.1",
        stateful: optBool(args, "stateful"),
        state: optStr(args, "state"),
        seed: optStr(args, "seed"),
        validate: optBool(args, "validate"),
        strict: optBool(args, "strict"),
        proxy: optStr(args, "proxy"),
        proxyTimeoutMs: optInt(args, "proxy_timeout_ms", 1, 600_000),
        report: optStr(args, "report"),
      });
      const lines = [
        `${job.id}: ${job.server.routes.length} route(s) from ${job.origin} at ${mockUrl(job)}` +
          (job.modes ? ` (${job.modes})` : "") +
          (job.seeded ? ` seeded ${job.seeded}` : ""),
      ];
      for (const w of job.warnings) lines.push(`warning: ${w}`);
      return ok(lines.join("\n"));
    },
  },
  {
    name: "crust_mock_server_stop",
    description:
      "Stop one mock server (by id) or ALL of them (omit id). The port is released; stateful --state files keep their data on disk.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "mock id from crust_mock_server_start; omit = stop all",
        },
      },
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["id"]);
      const id = optStr(args, "id");
      if (id === undefined) {
        const all = jm.listMock();
        for (const job of all) await jm.stopMock(job.id);
        return ok(`stopped ${all.length} mock server(s)`);
      }
      await jm.stopMock(id);
      return ok(`${id}: stopped, port released`);
    },
  },
  {
    name: "crust_mock_server_list",
    description:
      "List held mock servers: id, url, routes, mode flags, uptime, and the violation count for proxy-mode audits.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(jm, args) {
      requireKeys(args, []);
      const jobs = jm.listMock();
      if (jobs.length === 0) return ok("no mock servers running");
      return ok(
        JSON.stringify(
          jobs.map((job) => ({
            id: job.id,
            url: mockUrl(job),
            spec: job.label,
            origin: job.origin,
            routes: job.server.routes.length,
            modes: job.modes,
            violations: job.server.violations.length,
            uptime_s: Math.round((Date.now() - job.startedAt) / 100) / 10,
          })),
          null,
          2,
        ),
      );
    },
  },
  {
    name: "crust_mock_server_violations",
    description:
      "Spec violations recorded by a proxy-mode mock (request and response sides), newest capped by limit. This is the conformance-audit answer: what the real API does that its own openapi.json forbids. Also works in validate mode (422 request violations).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        limit: { type: "number", description: "max violations to return (default 50)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["id", "limit"], ["id"]);
      const job = jm.get(reqStr(args, "id"));
      if (!job || job.kind !== "mock") throw new ToolError(`no mock server job ${args.id}`);
      const limit = optInt(args, "limit", 1, 1000) ?? 50;
      const all = job.server.violations;
      return ok(
        `${all.length} violation(s) recorded${all.length > limit ? `, showing ${limit}` : ""}:\n` +
          JSON.stringify(all.slice(0, limit), null, 2),
      );
    },
  },
];

// ------------------------------------------------------------- streams ----

function describeQuery(
  result: {
    items: string[];
    truncated: boolean;
    live: { collected: number; dropped: number; timedOut: boolean } | null;
    rawJson: { retro: number; live: number };
    buffer: { size: number; capacity: number; pushed: number; evicted: number; ended: boolean };
    sourceError: string | null;
  },
  notes: string[],
): string {
  const head: string[] = [];
  head.push(
    `${result.items.length} item(s) shown | retro ${result.items.length - (result.live?.collected ?? 0)} + live ${result.live?.collected ?? 0}` +
      (result.live?.timedOut ? " (live window ended at its deadline)" : ""),
  );
  head.push(
    `buffer ${result.buffer.size}/${result.buffer.capacity} (pushed ${result.buffer.pushed}, evicted ${result.buffer.evicted}) | source: ${result.buffer.ended ? "ended" : "live"}`,
  );
  if (result.truncated)
    head.push("note: output hit the item limit — raise limit or narrow the query");
  if (result.live && result.live.dropped > 0) {
    head.push(
      `note: live view lagged — dropped ${result.live.dropped} oldest item(s) under pressure`,
    );
  }
  const raw = result.rawJson.retro + result.rawJson.live;
  if (raw > 0) head.push(`note: json mode — ${raw} item(s) stayed raw (not JSON objects)`);
  if (result.sourceError) head.push(`source error: ${result.sourceError}`);
  return [...head, ...notes, result.items.join("\n")].filter((s) => s !== "").join("\n");
}

const STREAM_TOOLS: ToolDef[] = [
  {
    name: "crust_procs_start",
    description:
      "Supervise dev processes with crust procs() and KEEP them running across calls: one merged {proc, stream, line} stream, per-proc env, dependency ordering (after), readiness probes (ready), restart backoff, and process-group teardown on stop. Query the merged output with crust_logs_query (id is shared); gate readiness in a follow-up crust_run_line with `wait :3000/health`. Items with stream ready/exit are supervision events, not app logs.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "object",
          description:
            'proc name -> command string, or {cmd, env, after, ready, live, restart} — e.g. {"db": "docker compose up db", "api": {"cmd": "bun api.ts", "after": "db", "ready": ":3000/health"}}',
          additionalProperties: true,
        },
        buffer: { type: "number", description: "ring buffer capacity (default 10000)" },
      },
      required: ["commands"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["commands", "buffer"], ["commands"]);
      const commands = args.commands;
      if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
        throw new ToolError('invalid "commands": object of proc name -> command');
      }
      const entries = Object.entries(commands as JsonObject);
      if (entries.length === 0) throw new ToolError('invalid "commands": at least one proc');
      for (const [name, v] of entries) {
        if (typeof v !== "string" && (typeof v !== "object" || v === null || Array.isArray(v))) {
          throw new ToolError(`invalid "commands.${name}": command string or spec object`);
        }
      }
      const buffer = optInt(args, "buffer", BUFFER_MIN, BUFFER_MAX) ?? 10_000;
      const job = await jm.startProcs(commands as Record<string, never>, buffer);
      return ok(
        `${job.id}: supervising ${entries.length} proc(s): ${entries.map(([n]) => n).join(", ")}\n` +
          "items are {proc, stream, line} objects (stream also carries ready/exit events) — " +
          `query with crust_logs_query id="${job.id}", stop with crust_procs_stop`,
      );
    },
  },
  {
    name: "crust_procs_stop",
    description:
      "Stop a procs session: SIGTERM→SIGKILL escalation across every proc's whole process group, so grandchildren die too. Reports honestly if a child is still unwinding past 10s.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["id"], ["id"]);
      const id = reqStr(args, "id");
      const note = await jm.stopStream(id);
      return ok(`${id}: ${note}`);
    },
  },
  {
    name: "crust_logs_open",
    description:
      "Open a live log session over a held source and keep it buffering across calls: `tail -n 0 -F path[-F glob]`, a held shell command (`docker logs -f my-app`), a `procs({...})` literal, or any crust source (read, GET). Then crust_logs_query runs ordinary pipeline fragments over the BUFFERED past and a bounded live window — iterate on filters without losing history. Same session ids as crust_logs_query/close.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            'source spec verbatim, e.g. "tail -n 0 -F ./logs/*.log" or "docker logs -f api"',
        },
        buffer: { type: "number", description: "ring capacity in items (default 10000)" },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["source", "buffer"], ["source"]);
      const buffer = optInt(args, "buffer", BUFFER_MIN, BUFFER_MAX) ?? 10_000;
      const job = await jm.openStream(reqStr(args, "source"), buffer);
      return ok(
        `${job.id}: buffering "${job.label}" — last ${buffer} items kept; query with crust_logs_query`,
      );
    },
  },
  {
    name: "crust_logs_query",
    description:
      "Query a held stream session (from crust_logs_open OR crust_procs_start): every line is ordinary crust pipeline grammar — `filter (l => l.proc === 'api') | (l => l.line) | grep -i timeout`, `stats --every 5`, `assert (...)`. Runs over the BUFFERED past first, then over live for live_ms if asked (0 = retro only). json parses NDJSON items before the fragment. Empty fragment = buffer dump. Procs sessions stream {proc, stream, line} objects.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "session id from crust_logs_open / crust_procs_start" },
        query: {
          type: "string",
          description: "pipeline fragment; empty = dump the buffer (oldest first)",
        },
        live_ms: {
          type: "number",
          description: "also stream live for this many ms after the past (default 0, max 300000)",
        },
        json: { type: "boolean", description: "parse JSON-object lines at query time" },
        limit: { type: "number", description: "max items returned (default 500, max 5000)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["id", "query", "live_ms", "json", "limit"], ["id"]);
      const result = await jm.queryStream(reqStr(args, "id"), optStr(args, "query") ?? "", {
        liveMs: optInt(args, "live_ms", 0, 300_000),
        json: optBool(args, "json"),
        limit: optInt(args, "limit", 1, 5_000),
      });
      const notes: string[] = [];
      if (
        result.live === null &&
        (optInt(args, "live_ms", 0, 300_000) ?? 0) > 0 &&
        result.buffer.ended
      ) {
        notes.push("note: source had already ended — retro only");
      }
      const text = describeQuery(result, notes);
      // Honest failure: a query whose source died with an error, or whose
      // fragment matched zero items, must not read as a clean answer.
      if (result.sourceError) return fail(text);
      if (result.items.length === 0) {
        return ok(
          `${text}\nzero items — this query matched nothing (zero is an answer, not a pass)`,
        );
      }
      return ok(text);
    },
  },
  {
    name: "crust_logs_close",
    description:
      "Close a stream session (tails, held commands, logs-side procs literals) and kill its held source. For crust_procs_start sessions use crust_procs_stop (same mechanism).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(jm, args) {
      requireKeys(args, ["id"], ["id"]);
      const id = reqStr(args, "id");
      const note = await jm.stopStream(id);
      return ok(`${id}: ${note}`);
    },
  },
];

export const ALL_TOOLS: ToolDef[] = [...ONE_SHOT_TOOLS, ...MOCK_TOOLS, ...STREAM_TOOLS];

export function toolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** The tools/list payload — schemas verbatim, so hosts see exactly what
 *  tools/call accepts. */
export function toolsList(): JsonObject[] {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
