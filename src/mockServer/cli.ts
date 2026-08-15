#!/usr/bin/env bun
import { FlagError, type FlagSpec, parseFlags } from "../args";
import { loadSpec } from "./loadSpec";
import { startServer } from "./server";
import { normalizeStateUrl, stateDialect } from "./state";

const USAGE = `mock-server <spec> [-p N] [-b addr] [--stateful]
            [--state <path|url>] [--seed <file.json>]
            [--validate] [--proxy <upstream> [--proxy-timeout ms] [--report path]]

Boots a Bun.serve instance that mocks every operation in the given
OpenAPI 3.x spec. Bodies come from the spec's examples when available,
otherwise are synthesised from schemas (strings -> "string", ints -> 0,
arrays -> [item], objects -> {props}, enums -> first value).

  -p, --port N      listen port (default 3000; 0 = OS-assigned).
  The spec may also be given as --swagger <url-or-path>.
  -b, --host addr   bind address (default 0.0.0.0). "-b" for bind, because "-H"
                    is the HEADER flag on every http stage and in curl.
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

export const SPEC: FlagSpec = {
  swagger: { type: "string", positional: 0 },
  port: { short: "p", type: "number" },
  host: { short: "b", type: "string" },
  stateful: { type: "boolean" },
  state: { type: "string" },
  seed: { type: "string" },
  validate: { type: "boolean" },
  proxy: { type: "string" },
  "proxy-timeout": { type: "number" },
  report: { type: "string" },
};

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

  try {
    const { values, rest, help } = parseFlags(args, SPEC);
    if (help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (rest.length > 0) throw new FlagError(`unexpected argument "${rest[0]}"`);
    swagger = values.swagger as string | undefined;
    port = (values.port as number | undefined) ?? 3000;
    host = (values.host as string | undefined) ?? "0.0.0.0";
    stateful = values.stateful === true;
    state = values.state as string | undefined;
    seed = values.seed as string | undefined;
    validate = values.validate === true;
    proxy = values.proxy as string | undefined;
    proxyTimeout = (values["proxy-timeout"] as number | undefined) ?? 30000;
    report = values.report as string | undefined;
  } catch (err) {
    process.stderr.write(`mock-server: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  if (!swagger) {
    process.stderr.write(`mock-server: an OpenAPI spec (path or URL) is required\n${USAGE}`);
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
