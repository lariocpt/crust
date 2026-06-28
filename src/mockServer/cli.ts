#!/usr/bin/env bun
import { loadSpec } from "./loadSpec";
import { startServer } from "./server";

const USAGE = `mock-server --swagger <url-or-path> [--port N] [--host addr]

Boots a Bun.serve instance that mocks every operation in the given
OpenAPI 3.x spec. Bodies come from the spec's examples when available,
otherwise are synthesised from schemas (strings -> "string", ints -> 0,
arrays -> [item], objects -> {props}, enums -> first value).

  --swagger <src>   URL (http://, https://) or local path (.json, .yaml).
  --port N          listen port (default 3000; 0 = OS-assigned).
  --host addr       bind address (default 0.0.0.0).
`;

export async function runCli(args: string[]): Promise<number> {
  let swagger: string | undefined;
  let port = 3000;
  let host = "0.0.0.0";

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

  let loaded;
  try {
    loaded = await loadSpec(swagger);
  } catch (err) {
    process.stderr.write(`mock-server: ${(err as Error).message}\n`);
    return 1;
  }

  const server = startServer({ port, hostname: host, spec: loaded.spec });
  process.stdout.write(
    `mock-server: ${server.routes.length} route(s) from ${loaded.origin}\n`,
  );
  process.stdout.write(`mock-server: listening on http://${host}:${server.port}\n`);

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
