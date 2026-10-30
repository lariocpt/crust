// JSON-RPC 2.0 message layer for the MCP stdio transport.
//
// The wire contract (MCP stdio): one JSON message per line, `\n` delimited,
// no embedded newlines inside a message. This is the whole protocol surface
// crust needs — hand-rolled because the shipped artifact is a zero-dependency
// compiled binary, so the official SDK is not an option inside it.
//
// Honest framing: a line that is not valid JSON gets a -32700 response with
// id:null, exactly as JSON-RPC prescribes, and the connection keeps serving.
// Dropping it silently would let a partially-written message vanish without
// the client ever learning its call was never parsed.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: JsonObject;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

/** parseLine's discriminated result: a frame is EITHER a parsed message OR
 *  the -32700/-32600 response crust owes the client — never a bag of
 *  optional fields the dispatcher has to guess through. */
export type ParsedLine =
  | { kind: "request"; request: RpcRequest }
  | { kind: "notification"; notification: RpcNotification }
  | { kind: "invalid"; response: RpcResponse };

export interface RpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: JsonValue;
  error?: RpcError;
}

// The standard JSON-RPC codes MCP hosts expect, plus the one MCP-specific
// code the spec reserves for "the server got the request but refuses/cannot
// do it" (used here for the not-initialized guard).
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const SERVER_NOT_INITIALIZED = -32002;

export function isRequest(v: unknown): v is RpcRequest {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as RpcRequest).jsonrpc === "2.0" &&
    typeof (v as RpcRequest).method === "string" &&
    ((v as RpcRequest).id !== undefined || typeof (v as RpcRequest).id === "number")
  );
}

export function isNotification(v: unknown): v is RpcNotification {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as RpcNotification).jsonrpc === "2.0" &&
    typeof (v as RpcNotification).method === "string" &&
    (v as { id?: unknown }).id === undefined
  );
}

export function reply(id: number | string | null, result: JsonValue): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: number | string | null, error: RpcError): RpcResponse {
  return { jsonrpc: "2.0", id, error };
}

/** Parse one framed line into a discriminated result. A frame that is not
 *  valid JSON, or JSON without a string method, gets the prescribed error
 *  response (id:null) rather than silent loss — the client must learn its
 *  call was never understood. */
export function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      kind: "invalid",
      response: fail(null, { code: PARSE_ERROR, message: "parse error: line is not valid JSON" }),
    };
  }
  if (isRequest(value)) return { kind: "request", request: value };
  if (isNotification(value)) return { kind: "notification", notification: value };
  return {
    kind: "invalid",
    response: fail(null, {
      code: INVALID_REQUEST,
      message: "expected a JSON-RPC 2.0 request or notification with a string method",
    }),
  };
}

export function serialize(message: RpcResponse): string {
  // JSON.stringify NEVER emits a raw newline, so one message is always one
  // line — the only framing rule this transport has.
  return `${JSON.stringify(message)}\n`;
}
