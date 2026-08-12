#!/usr/bin/env bun
import { loadSpec } from "./loadSpec";
import { startServer } from "./server";
import { normalizeStateUrl, stateDialect } from "./state";

const USAGE = `mock-server --swagger <url-or-path> [--port N] [--host addr] [--stateful]
            [--state <path|url>] [--seed <file.json>]
            [--validate] [--proxy <upstream> [--proxy-timeout ms] [--report path]]

Boots a Bun.serve instance that mocks every operation in the given
OpenAPI 3.x spec. Bodies come from the spec's examples when available,
otherwise are synthesised from schemas (strings -> "string", ints -> 0,
arrays -> [item], objects -> {props}, enums -> first value).

  --swagger <src>   URL (http://, https://) or local path (.json, .yaml).
  --port N          listen port (default 3000; 0 = OS-assigned).
  --host addr       bind address (default 0.0.0.0).
  --stateful        in-memory CRUD: POST creates, GET returns what was
                    created, PATCH/PUT merge, DELETE removes. Untouched
                    collections keep serving the spec's examples.
  --state <p|url>   persist the CRUD state in SQL instead of memory: a bare
                    path or sqlite:// URL, or postgres://. Survives restarts
                    and is shared cross-process (table crust_mock_state).
                    Implies --stateful; excludes --proxy.
  --seed <file>     JSON file { "<collection>": [ {...}, ... ] } inserted at
                    boot into collections with no rows yet (never clobbers a
                    persistent store). Items without an id get a uuid.
                    Implies --stateful; excludes --proxy.
  --validate        validate requests against the spec; violations answer
                    422 with a JSON violation list instead of the mock body.
  --proxy <url>     validation-proxy mode: forward every request to the
                    upstream, return its response untouched, record request
                    AND response spec violations (GET /__crust/violations
                    to inspect, DELETE to clear). Excludes --stateful.
  --proxy-timeout N upstream timeout in milliseconds (default 30000).
  --report <path>   append each violation as an NDJSON line (needs --proxy).
`;

export async function runCli(args: string[]): Promise<number> {
  let swagger: string | undefined;
  let port = 3000;
  let host = "0.0.0.0";
  let stateful = false;
  let state: string | undefined;
  let seed: string | undefined;
  let validate = false;
  let proxy: string | undefined;
  let proxyTimeout = 30000;
  let report: string | undefined;

  function intFlag(value: string | undefined, name: string): number | null {
    const n = parseInt(value ?? "", 10);
    if (!Number.isFinite(n)) {
      process.stderr.write(`mock-server: ${name} requires an integer\n`);
      return null;
    }
    return n;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (a === "--swagger") {
      swagger = args[++i];
    } else if (a.startsWith("--swagger=")) {
      swagger = a.slice("--swagger=".length);
    } else if (a === "--port") {
      const n = intFlag(args[++i], "--port");
      if (n === null) return 2;
      port = n;
    } else if (a.startsWith("--port=")) {
      const n = intFlag(a.slice("--port=".length), "--port");
      if (n === null) return 2;
      port = n;
    } else if (a === "--host") {
      host = args[++i] ?? host;
    } else if (a.startsWith("--host=")) {
      host = a.slice("--host=".length);
    } else if (a === "--stateful") {
      stateful = true;
    } else if (a === "--state") {
      state = args[++i];
    } else if (a.startsWith("--state=")) {
      state = a.slice("--state=".length);
    } else if (a === "--seed") {
      seed = args[++i];
    } else if (a.startsWith("--seed=")) {
      seed = a.slice("--seed=".length);
    } else if (a === "--validate") {
      validate = true;
    } else if (a === "--proxy") {
      proxy = args[++i];
    } else if (a.startsWith("--proxy=")) {
      proxy = a.slice("--proxy=".length);
    } else if (a === "--proxy-timeout") {
      const n = intFlag(args[++i], "--proxy-timeout");
      if (n === null) return 2;
      proxyTimeout = n;
    } else if (a.startsWith("--proxy-timeout=")) {
      const n = intFlag(a.slice("--proxy-timeout=".length), "--proxy-timeout");
      if (n === null) return 2;
      proxyTimeout = n;
    } else if (a === "--report") {
      report = args[++i];
    } else if (a.startsWith("--report=")) {
      report = a.slice("--report=".length);
    } else {
      process.stderr.write(`mock-server: unknown arg '${a}'\n`);
      process.stderr.write(USAGE);
      return 2;
    }
  }

  if (!swagger) {
    process.stderr.write("mock-server: --swagger is required\n");
    process.stderr.write(USAGE);
    return 2;
  }

  // --state / --seed imply --stateful.
  if (state !== undefined || seed !== undefined) stateful = true;

  // Conflicts are caught before any boot work (spec load, port bind).
  if (proxy !== undefined && state !== undefined) {
    process.stderr.write("mock-server: --proxy and --state are mutually exclusive\n");
    return 2;
  }
  if (proxy !== undefined && seed !== undefined) {
    process.stderr.write("mock-server: --proxy and --seed are mutually exclusive\n");
    return 2;
  }
  if (proxy !== undefined && stateful) {
    process.stderr.write("mock-server: --proxy and --stateful are mutually exclusive\n");
    return 2;
  }
  if (state !== undefined) {
    // Scheme is validated before loadSpec so a typo'd URL fails fast.
    try {
      state = normalizeStateUrl(state);
    } catch (err) {
      process.stderr.write(`mock-server: ${(err as Error).message}\n`);
      return 2;
    }
  }
  if (report !== undefined && proxy === undefined) {
    process.stderr.write("mock-server: --report requires --proxy\n");
    return 2;
  }
  if (proxy !== undefined) {
    try {
      new URL(proxy);
    } catch {
      process.stderr.write(`mock-server: --proxy requires a valid URL (got '${proxy}')\n`);
      return 2;
    }
  }
  if (proxyTimeout <= 0) {
    process.stderr.write("mock-server: --proxy-timeout must be a positive integer\n");
    return 2;
  }
  // A redundant --validate alongside --proxy is accepted silently (proxy mode
  // already implies request+response validation).

  let loaded: Awaited<ReturnType<typeof loadSpec>>;
  try {
    loaded = await loadSpec(swagger);
  } catch (err) {
    process.stderr.write(`mock-server: ${(err as Error).message}\n`);
    return 1;
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      port,
      hostname: host,
      spec: loaded.spec,
      stateful,
      state,
      seed,
      validate,
      proxy,
      proxyTimeoutMs: proxyTimeout,
      report,
    });
  } catch (err) {
    process.stderr.write(`mock-server: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`mock-server: ${server.routes.length} route(s) from ${loaded.origin}\n`);
  const modes = `${stateful ? " (stateful)" : ""}${validate && proxy === undefined ? " (validate)" : ""}${
    proxy !== undefined ? ` (proxy -> ${proxy})` : ""
  }${state !== undefined ? ` (state: ${stateDialect(state)})` : ""}${
    seed !== undefined ? ` (seeded ${server.seeded})` : ""
  }`;
  process.stdout.write(`mock-server: listening on http://${host}:${server.port}${modes}\n`);

  return await new Promise<number>((resolve) => {
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      process.stdout.write(`\nmock-server: ${signal} received, stopping\n`);
      await server.stop();
      resolve(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
