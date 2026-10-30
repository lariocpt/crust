// The MCP server tested over REAL stdio — a JSON-RPC client spawn of
// `bun src/index.ts mcp`, not an in-process shortcut. Protocol framing,
// stdout purity, honest failures and lifecycle teardown are exactly the
// seams a shortcut cannot prove.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ------------------------------------------------------------------ client ----

type ReplyFn = (v: any) => void;

class McpClient {
  private pending = new Map<string | number, ReplyFn>();
  /** Frames the server sent that match no request id (parse-error replies
   *  carry id:null) — the bad-frame assertions read these. */
  unmatched: any[] = [];
  private nextId = 0;
  private proc!: ReturnType<typeof Bun.spawn>;
  private stdinCtl!: ReadableStreamDefaultController<Uint8Array>;

  static async start(args: string[] = ["mcp"]): Promise<McpClient> {
    const c = new McpClient();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (s) => {
        ctl = s; // start() runs synchronously — the controller is live on return
      },
    });
    c.stdinCtl = ctl;
    c.proc = Bun.spawn([process.execPath, "src/index.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      stdin: stream,
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    const stdout = c.proc.stdout as unknown as ReadableStream<Uint8Array>;
    void (async () => {
      let buf = "";
      for await (const chunk of stdout) {
        buf += dec.decode(chunk, { stream: true });
        let i = buf.indexOf("\n");
        while (i !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) {
            // A protocol stream that carries ANY non-JSON byte is corruption —
            // parsing everything through JSON is the purity assertion.
            const msg = JSON.parse(line);
            const waiter = msg.id !== undefined ? c.pending.get(msg.id) : undefined;
            if (msg.id !== undefined && waiter) {
              c.pending.delete(msg.id);
              waiter(msg);
            } else {
              c.unmatched.push(msg);
            }
          }
          i = buf.indexOf("\n");
        }
      }
    })();
    return c;
  }

  /** Write a raw line — for frames the rpc() shape cannot express. */
  raw(line: string): void {
    this.stdinCtl.enqueue(new TextEncoder().encode(line));
  }

  /** Enqueue a raw frame and return a promise for the reply whose id matches
   *  the frame's. The bad-frame test needs to control the id and observe the
   *  ordering between a bad line's -32700 (id:null) and a known reply. */
  replyFor(frame: string): Promise<any> {
    const id = (JSON.parse(frame) as { id?: number | string }).id;
    return new Promise((res) => {
      if (id !== undefined) this.pending.set(id, res);
      this.raw(`${frame}\n`); // the transport frame IS the newline — never omit it
    });
  }

  async rpc(method: string, params?: object): Promise<any> {
    const id = ++this.nextId;
    const p = new Promise<any>((res, rej) => {
      this.pending.set(id, res);
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`mcp rpc timeout: ${method}`));
      }, 25_000);
    });
    this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  note(method: string, params?: object): void {
    this.raw(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async call(name: string, args: object = {}): Promise<{ isError?: boolean; text: string }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const payload = r.result ?? r.error;
    return {
      isError: r.result?.isError,
      text: String(payload?.content?.[0]?.text ?? JSON.stringify(payload)),
    };
  }

  async initialize(): Promise<void> {
    const r = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "crust-tests", version: "0" },
    });
    expect(r.result?.serverInfo?.name).toBe("crust");
    this.note("notifications/initialized", {});
  }

  closeStdin(): void {
    this.stdinCtl.close();
  }

  async exited(): Promise<number> {
    return await this.proc.exited;
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

// ------------------------------------------------------------------ suite ----

const clients: McpClient[] = [];
let dir: string;

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "crust-mcp-")));
});

afterAll(async () => {
  for (const c of clients) c.kill();
  await rm(dir, { recursive: true, force: true });
});

async function client(): Promise<McpClient> {
  const c = await McpClient.start();
  clients.push(c);
  return c;
}

// built inside beforeAll — bun evaluates module top-level before fixtures
const specPath = (): string => join(dir, "spec.json");
async function writeSpec(): Promise<void> {
  await writeFile(
    specPath(),
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "mcp-test", version: "1" },
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { example: { things: ["a"] } } },
              },
            },
          },
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    }),
  );
}

describe("mcp protocol", () => {
  test("initialize echoes supported versions, falls back for unknown ones", async () => {
    const c = await client();
    const known = await c.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(known.result.protocolVersion).toBe("2025-03-26");
    expect(known.result.capabilities.tools).toBeDefined();
    const unknown = await c.rpc("initialize", {
      protocolVersion: "1999-01-01",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    });
    expect(unknown.result.protocolVersion).toBe("2025-06-18"); // never echo what we do not speak
    c.kill();
  });

  test("tools/list requires initialize and lists every tool with a schema", async () => {
    const c = await client();
    const early = await c.rpc("tools/list", {});
    expect(early.error?.code).toBe(-32002);
    await c.initialize();
    const list = await c.rpc("tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "crust_run_line",
      "crust_check_line",
      "crust_test_fixture",
      "crust_test_pipes",
      "crust_gen_fixtures",
      "crust_verify_web_links",
      "crust_load_run",
      "crust_mock_server_start",
      "crust_mock_server_stop",
      "crust_mock_server_list",
      "crust_mock_server_violations",
      "crust_procs_start",
      "crust_procs_stop",
      "crust_logs_open",
      "crust_logs_query",
      "crust_logs_close",
    ]);
    for (const tool of list.result.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
    c.kill();
  });

  test("bad frames answer with protocol errors, unknown methods and tools refuse", async () => {
    const c = await client();
    await c.initialize();
    // a non-JSON LINE gets a -32700 reply with id:null — nothing is lost silently
    c.raw("{not json}\n");
    const reply = c.replyFor(JSON.stringify({ jsonrpc: "2.0", id: 777, method: "ping" }));
    await reply; // resolves only after the ping is answered → the bad-line reply is already recorded
    expect(c.unmatched.some((m) => m.error?.code === -32700)).toBe(true);
    const badMethod = await c.rpc("resources/list", {});
    expect(badMethod.error?.code).toBe(-32601);
    const badTool = await c.call("crust_nope", {});
    expect(badTool.text).toContain("unknown tool");
    c.kill();
  });
});

describe("mcp one-shot tools", () => {
  let c: McpClient;
  beforeAll(async () => {
    c = await client();
    await c.initialize();
  });
  afterAll(() => c.kill());

  test("crust_run_line runs grammar and reports exit 0 with stdout", async () => {
    const r = await c.call("crust_run_line", { line: "range(1,3) | (n => n * 11)" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("exit 0");
    expect(r.text).toContain("11");
    expect(r.text).toContain("33");
  });

  test("honest failure: a nonzero shell exit is an isError with the code", async () => {
    const r = await c.call("crust_run_line", { line: "sh -c 'exit 7'" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exit 7");
  });

  test("honest failure: a failing assert is an error result", async () => {
    const r = await c.call("crust_run_line", { line: "range(1,1) | assert (x => x === 2)" });
    expect(r.isError).toBe(true);
  });

  test("cwd and env apply per call", async () => {
    await writeFile(join(dir, "marker.txt"), "here");
    const r = await c.call("crust_run_line", {
      line: 'sh -c "cat marker.txt && echo $MCP_TEST_VAR"',
      cwd: dir,
      env: { MCP_TEST_VAR: "injected" },
    });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("here");
    expect(r.text).toContain("injected");
  });

  test("timeout kills the child and says so", async () => {
    const start = Date.now();
    const r = await c.call("crust_run_line", { line: "sleep 30", timeout_ms: 1200 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timed out");
    expect(Date.now() - start).toBeLessThan(10_000); // killed at the deadline, not after the sleep
  });

  test("crust_check_line lints good and bad lines without running them", async () => {
    const good = await c.call("crust_check_line", {
      line: "load 1s 10/s | GET :3000/health | stats",
    });
    expect(good.isError).toBeUndefined();
    expect(good.text).toContain("parse");
    const bad = await c.call("crust_check_line", { line: "GET :3000 | expect" });
    expect(bad.isError).toBe(true);
  });
});

describe("mcp mock server lifecycle", () => {
  let c: McpClient;
  beforeAll(async () => {
    await writeSpec();
    c = await client();
    await c.initialize();
  });
  afterAll(() => c.kill());

  test("start → serve → list → violations → stop, port released", async () => {
    const start = await c.call("crust_mock_server_start", { spec: specPath(), validate: true });
    expect(start.isError).toBeUndefined();
    const url = start.text.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const okRes = await fetch(`${url}/things`);
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ things: ["a"] });
    // validate mode: a request missing the required "name" answers 422 AND records
    const violation = await fetch(`${url}/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notName: 1 }),
    });
    expect(violation.status).toBe(422);

    const list = await c.call("crust_mock_server_list");
    expect(list.text).toContain("mock-1");
    expect(list.text).toContain('"routes": 2');
    expect(list.text).toContain('"violations": 1');

    const v = await c.call("crust_mock_server_violations", { id: "mock-1" });
    expect(v.text).toContain("1 violation(s)");

    const stop = await c.call("crust_mock_server_stop", { id: "mock-1" });
    expect(stop.isError).toBeUndefined();
    expect(await fetch(`${url}/things`).catch(() => "gone")).toBe("gone");
    const empty = await c.call("crust_mock_server_list");
    expect(empty.text).toContain("no mock servers running");
  });

  test("unknown ids refuse honestly", async () => {
    const r = await c.call("crust_mock_server_stop", { id: "mock-99" });
    expect(r.isError).toBe(true);
  });
});

describe("mcp procs + logs sessions", () => {
  let c: McpClient;
  beforeAll(async () => {
    c = await client();
    await c.initialize();
  });
  afterAll(() => c.kill());

  test("procs_start supervises, queries hit the buffer, stop tears down", async () => {
    const start = await c.call("crust_procs_start", {
      commands: { greeter: "sh -c 'echo hello-alpha; echo hello-beta'" },
    });
    expect(start.isError).toBeUndefined();
    const id = start.text.match(/logs-\d+/)![0];
    // give the child its two lines (the pump is async)
    for (
      let i = 0;
      i < 40 && !(await c.call("crust_logs_query", { id })).text.includes("hello-alpha");
    ) {
      await Bun.sleep(50);
    }
    const dump = await c.call("crust_logs_query", { id });
    expect(dump.isError).toBeUndefined();
    expect(dump.text).toContain("hello-alpha");
    expect(dump.text).toContain("hello-beta");
    const filtered = await c.call("crust_logs_query", {
      id,
      query: 'filter (l => l.proc === "greeter") | (l => l.line) | grep beta',
    });
    expect(filtered.isError).toBeUndefined();
    expect(filtered.text).toContain("hello-beta");
    const stop = await c.call("crust_procs_stop", { id });
    expect(stop.isError).toBeUndefined();
    expect(stop.text).toContain("torn down cleanly");
    const gone = await c.call("crust_logs_query", { id });
    expect(gone.isError).toBe(true);
  });

  test("zero-match queries answer zero, loudly — never silence", async () => {
    const file = join(dir, "logs.txt");
    await writeFile(file, "alpha line\nbeta line\n");
    const open = await c.call("crust_logs_open", { source: `tail -n 10 -F ${file}` });
    const id = open.text.match(/logs-\d+/)![0];
    await Bun.sleep(150); // let the tail's first read land in the buffer
    const miss = await c.call("crust_logs_query", { id, query: 'filter (l => l === "not-here")' });
    expect(miss.isError).toBeUndefined(); // zero is an answer
    expect(miss.text).toContain("zero items");
    const bad = await c.call("crust_logs_query", { id, query: "not crust syntax ((" });
    expect(bad.isError).toBe(true);
    await c.call("crust_logs_close", { id });
  });

  test("json mode parses NDJSON items before the fragment", async () => {
    const file = join(dir, "ndjson.log");
    await writeFile(file, '{"level":40,"m":"info"}\n{"level":50,"m":"warn"}\nplain line\n');
    const open = await c.call("crust_logs_open", { source: `tail -n 10 -F ${file}` });
    const id = open.text.match(/logs-\d+/)![0];
    await Bun.sleep(150); // the tail's first read lands in the ring before the query
    const q = await c.call("crust_logs_query", {
      id,
      json: true,
      query: 'filter (e => typeof e === "object" && e.level >= 50)',
    });
    expect(q.isError).toBeUndefined();
    expect(q.text).toContain("warn");
    expect(q.text).toContain("stayed raw"); // the plain line is COUNTED, not dropped
    await c.call("crust_logs_close", { id });
  });

  test("live queries collect from a growing source within the window", async () => {
    const file = join(dir, "grow.log");
    await writeFile(file, "");
    const open = await c.call("crust_logs_open", { source: `tail -n 0 -F ${file}` });
    const id = open.text.match(/logs-\d+/)![0];
    const appending = setInterval(() => void appendFile(file, `tick-${Date.now()}\n`), 40);
    const live = await c.call("crust_logs_query", { id, live_ms: 400, limit: 50 });
    clearInterval(appending);
    expect(live.isError).toBeUndefined();
    expect(live.text).toContain("live");
    expect(live.text).toContain("tick-");
    await c.call("crust_logs_close", { id });
  });
});

describe("mcp lifetime", () => {
  test("stdin EOF tears every held job down and exits 0", async () => {
    await writeSpec();
    const c = await client();
    await c.initialize();
    const ms = await c.call("crust_mock_server_start", { spec: specPath() });
    const url = ms.text.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    expect((await fetch(`${url}/things`)).status).toBe(200);
    c.closeStdin();
    const code = await Promise.race([
      c.exited(),
      Bun.sleep(5_000).then(() => -999), // hang detector: teardown must not wedge the exit
    ]);
    expect(code).toBe(0);
    expect(await fetch(`${url}/things`).catch(() => "gone")).toBe("gone");
  });

  test("`crust mcp` refuses arguments; `crust mcp --help` prints usage", async () => {
    const bad = await Bun.spawn([process.execPath, "src/index.ts", "mcp", "--oops"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    expect(bad).toBe(2);
    const help = Bun.spawn([process.execPath, "src/index.ts", "mcp", "--help"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(help.stdout).text();
    expect(await help.exited).toBe(0);
    expect(out).toContain("Model Context Protocol");
    expect(out).toContain('"args": ["mcp"]');
  });

  test("a REPL line `mcp` refuses instead of sh's misleading 127", async () => {
    const proc = Bun.spawn([process.execPath, "src/index.ts", "-c", "mcp"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("Model Context Protocol server");
  });
});
