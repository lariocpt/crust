import { randomBytes } from "node:crypto";

export function salt(...args: unknown[]): string {
  let bytes = 16;
  let encoding: "hex" | "base64" | "base64url" = "hex";
  const positionals: string[] = [];
  for (const a of args) {
    if (typeof a !== "string" && typeof a !== "number") continue;
    const s = String(a);
    if (s === "hex" || s === "base64" || s === "base64url") {
      encoding = s;
    } else {
      positionals.push(s);
    }
  }
  if (positionals.length > 0) {
    const n = parseInt(positionals[0]!, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`salt: invalid byte count '${positionals[0]}'`);
    }
    bytes = n;
  }
  return randomBytes(bytes).toString(encoding);
}
