// Shared plumbing for the MCP tool surface: result shapes, argument
// accessors that fail loudly (an agent that typos `threads` gets a named
// rejection, never a silently-ignored option), and output caps that are
// always ANNOUNCED — a silent cut is how false passes are born.

import type { JsonObject } from "./protocol";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  run(jm: import("./jobs").JobManager, args: JsonObject): Promise<ToolResult>;
}

/** Argument misuse and honest failures. The server turns these into isError
 *  tool results (the MCP contract for "the tool ran and said no");
 *  protocol-layer misuse (unknown tool, malformed params) stays a JSON-RPC
 *  error, per the spec. */
export class ToolError extends Error {}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Per-stream cap for captured child output. Tail-kept because the tail of a
 *  run is where the failure is; the marker states the total. */
export const OUTPUT_CAP = 256 * 1024;

export function capText(s: string, cap = OUTPUT_CAP): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return {
    text: `… crust-mcp: output truncated, showing last ${cap} of ${s.length} chars …\n${s.slice(-cap)}`,
    truncated: true,
  };
}

// ------------------------------------------------------------ arg reading ----

type Args = JsonObject;

function bad(name: string, want: string, got: unknown): never {
  const shown = typeof got === "string" ? JSON.stringify(got) : String(got);
  throw new ToolError(`invalid argument "${name}": expected ${want}, got ${shown}`);
}

/** Required string, trimmed non-empty. */
export function reqStr(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) bad(name, "non-empty string", v);
  return v as string;
}

export function optStr(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) bad(name, "non-empty string", v);
  return v as string;
}

export function reqInt(args: Args, name: string, min: number, max: number): number {
  const v = args[name];
  if (typeof v !== "number" || !Number.isFinite(v) || Math.trunc(v) !== v || v < min || v > max) {
    bad(name, `integer ${min}..${max}`, v);
  }
  return v as number;
}

export function optInt(args: Args, name: string, min: number, max: number): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  return reqInt(args, name, min, max);
}

export function optBool(args: Args, name: string): boolean | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") bad(name, "boolean", v);
  return v as boolean;
}

/** Flat string map (env vars). Rejects non-string values loudly — silently
 *  stringifying `{...}` into "[object Object]" would poison a run. */
export function optStrMap(args: Args, name: string): Record<string, string> | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) bad(name, "object of string values", v);
  const out: Record<string, string> = {};
  for (const [k, item] of Object.entries(v as JsonObject)) {
    if (typeof item !== "string") {
      throw new ToolError(`invalid "${name}.${k}": expected string, got ${String(item)}`);
    }
    out[k] = item;
  }
  return out;
}

export function optStrArray(args: Args, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    bad(name, "array of strings", v);
  }
  return v as string[];
}

/** Unknown keys are rejected, not ignored: a typo'd option that did nothing
 *  would let a caller believe a flag took effect. This mirrors parseFlags'
 *  value-swallow guard on every crust CLI. */
export function requireKeys(
  args: Args,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null) {
      throw new ToolError(`missing required argument "${name}"`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolError(`unknown argument "${key}" — allowed: ${allowed.join(", ")}`);
    }
  }
}
