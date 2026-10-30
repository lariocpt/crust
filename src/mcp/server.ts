// `crust mcp` — the Model Context Protocol server over stdio.
//
// Transport contract: one JSON-RPC 2.0 message per line on stdin/stdout.
// stdout belongs to the protocol EXCLUSIVELY: before anything else runs,
// process.stdout.write is redirected to stderr, so user init.ts logs,
// stray console.log calls (fragment lambdas run in-process!) and library
// chatter can never corrupt a response stream. Protocol frames go out on
// the saved original writer, with drain backpressure — the same honesty
// runLine learned: exiting while Bun's write queue is non-empty truncates
// output.
//
// Lifetime contract: the MCP host owns the lifecycle. stdin EOF, SIGINT or
// SIGTERM all tear down every held job (mock ports closed, procs groups
// killed) before exiting — never leaving an orphaned mock server behind.
//
// Tool calls are serialized (one in flight at a time). Not politeness: the
// interrupt bus is process-global, and two live-window queries draining at
// once would fire each other's children. Serializing makes the bus
// reasoning in queryStream exactly the interactive session's reasoning.

import pkg from "../../package.json" with { type: "json" };
import { registerBuiltinFns } from "../builtinFns";
import { dotenvLoad } from "../builtins";
import { loadConfig } from "../config";
import { markStdinConsumed } from "../sources";
import type { Context } from "../types";
import { JobManager } from "./jobs";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  type JsonValue,
  METHOD_NOT_FOUND,
  parseLine,
  type RpcRequest,
  type RpcResponse,
  fail as rpcFail,
  reply as rpcReply,
  SERVER_NOT_INITIALIZED,
  serialize,
} from "./protocol";
import { ToolError } from "./support";
import { toolByName, toolsList } from "./tools";

export const MCP_USAGE = `crust mcp — Model Context Protocol server over stdio

  Speaks JSON-RPC 2.0, one message per line, on stdin/stdout. Starts no
  REPL: stdin belongs to the protocol, stdout to the server. Tool output
  is captured per call; the streams never mix.

  Configure in an MCP host (OpenCode, Claude Code, Codex, Cursor, ...):
    { "mcpServers": { "crust": { "command": "crust", "args": ["mcp"] } } }

  tools/list returns every crust capability as a direct tool: one-shot
  runners (crust_run_line, crust_check_line, crust_test_fixture,
  crust_test_pipes, crust_gen_fixtures, crust_verify_web_links,
  crust_load_run) and lifecycle tools held open across calls
  (crust_mock_server_*, crust_procs_*, crust_logs_*).

  Held jobs (mock servers, procs, log sessions) die with this process;
  stop tools report teardown honestly. A nonzero child exit is ALWAYS an
  isError result — crust never reports a false pass, including over MCP.
`;

/** Protocol versions this server answers, newest first. A client asking for
 *  an unknown one gets the newest — echoing a version this dispatch does not
 *  implement would be a promise crust cannot keep. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function runMcp(opts: { envFile?: string } = {}): Promise<number> {
  markStdinConsumed("the MCP protocol (stdin is the JSON-RPC channel)");

  // Save the real stdout writer, then redirect process.stdout to stderr —
  // BEFORE the config load. init.ts is user code that may console.log; with
  // the swap already in place its noise lands on stderr and the protocol
  // stream on fd 1 stays pure. The drain listener below still finds Bun's
  // real stdout object for backpressure.
  const realStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
    return process.stderr.write(text);
  }) as typeof process.stdout.write;

  const ctx = await createMcpContext(opts.envFile);
  const jm = new JobManager(ctx);
  let initialized = false;
  let exiting = false;

  const writeLine = async (message: RpcResponse): Promise<void> => {
    if (realStdout(serialize(message))) return;
    await new Promise<void>((res) => process.stdout.once("drain", () => res()));
  };

  // Tool calls serialize: see the header note about the global interrupt bus.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task, task);
  };

  const handleRequest = async (req: RpcRequest): Promise<RpcResponse | null> => {
    switch (req.method) {
      case "initialize": {
        const requested =
          typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "";
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0]!;
        initialized = true;
        return rpcReply(req.id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: "crust", title: "crust", version: pkg.version },
          instructions:
            "crust test-stack tools over MCP. One-shot tools run a fresh crust child per call: cwd/env apply per call and never persist — pass them explicitly. Lifecycle tools (mock server, procs, logs) are held by this server process and die when it exits. Nonzero exits, killed timeouts and failed asserts are isError results carrying the verbatim output; crust never reports a false pass.",
        });
      }
      case "ping":
        return rpcReply(req.id, {});
      case "tools/list":
        if (!initialized) {
          return rpcFail(req.id, {
            code: SERVER_NOT_INITIALIZED,
            message: `crust mcp: send initialize before ${req.method}`,
          });
        }
        return rpcReply(req.id, { tools: toolsList() });
      case "tools/call": {
        if (!initialized) {
          return rpcFail(req.id, {
            code: SERVER_NOT_INITIALIZED,
            message: "crust mcp: send initialize before tools/call",
          });
        }
        const name = req.params?.name;
        if (typeof name !== "string") {
          return rpcFail(req.id, { code: INVALID_PARAMS, message: 'tools/call: "name" required' });
        }
        const tool = toolByName(name);
        if (!tool) {
          // The spec's own example: an unknown tool is a protocol-level
          // error, not a tool result — the tool never existed to say no.
          return rpcFail(req.id, {
            code: INVALID_PARAMS,
            message: `unknown tool "${name}"`,
          });
        }
        const rawArgs = req.params?.arguments;
        if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
          return rpcFail(req.id, {
            code: INVALID_PARAMS,
            message: "tools/call: arguments must be an object",
          });
        }
        try {
          const result = await tool.run(jm, (rawArgs ?? {}) as Record<string, never>);
          // ToolResult is a plain data shape ({content, isError}); the cast is
          // the JsonValue boundary, not a hole — nothing here carries methods.
          return rpcReply(req.id, result as unknown as JsonValue);
        } catch (err) {
          // A failed RUN is a tool error, not a protocol error — the call
          // was understood and the ANSWER is "no, with evidence". The
          // never-a-false-pass rule applies: the message rides in a result.
          const kind = err instanceof ToolError ? "invalid arguments" : "error";
          return rpcReply(req.id, {
            content: [{ type: "text", text: `crust ${kind}: ${(err as Error).message}` }],
            isError: true,
          });
        }
      }
      default:
        return rpcFail(req.id, {
          code: METHOD_NOT_FOUND,
          message: `crust mcp does not implement "${req.method}"`,
        });
    }
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    await chain.catch(() => {});
    await jm.stopAll();
    process.stderr.write(`crust mcp: ${reason}, shutting down\n`);
    process.exit(0);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!exiting) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.trim()) {
          const parsed = parseLine(line);
          if (parsed.kind === "invalid") {
            const response = parsed.response;
            enqueue(async () => void (await writeLine(response)));
          } else if (parsed.kind === "request") {
            const req = parsed.request;
            enqueue(async () => {
              const response = await handleRequest(req);
              if (response) await writeLine(response);
            });
          } else {
            const note = parsed.notification;
            // The handshake's second half, and the cancel notice — both
            // arrive and neither needs a frame back. Anything else is said
            // to, never swallowed silently.
            if (
              note.method !== "notifications/initialized" &&
              note.method !== "notifications/cancelled"
            ) {
              process.stderr.write(`crust mcp: ignoring notification "${note.method}"\n`);
            }
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`crust mcp: stdin error: ${(err as Error).message}\n`);
    await chain.catch(() => {});
    await jm.stopAll();
    return 1;
  }
  // stdin closed: the host is gone. Tear every held job down, honestly.
  await chain.catch(() => {});
  await jm.stopAll();
  return 0;
}

/** The MCP context: registered functions (`sql`, `wait`, `base64` …) so
 *  fragments in crust_logs_query can use them; no aliases (the grammar a
 *  fragment uses is crust's own). An OPTIONAL --env-file and init.ts load
 *  with the stdout redirect already installed (see runMcp above) — a
 *  missing env file fails loudly, same contract as every other run mode. */
async function createMcpContext(envFile?: string): Promise<Context> {
  const ctx: Context = {
    aliases: new Map(),
    functions: new Map(),
    history: [],
    exit: async (code) => {
      process.exit(code ?? 0);
    },
    dotenv: { history: [], snapshot: null },
    signalHandlers: new Map(),
  };
  registerBuiltinFns(ctx);
  const report = (s: string): void => void process.stderr.write(s);
  if (envFile !== undefined) {
    const code = await dotenvLoad(ctx, envFile, "overwrite", report);
    if (code !== 0) throw new Error(`--env-file failed with exit ${code}`);
  }
  await loadConfig(ctx, process.env.CRUST_CONFIG);
  return ctx;
}

// Silence the unused-notice for the one code reserved for genuine dispatch
// bugs (every handler path currently has a defined answer).
void INTERNAL_ERROR;
