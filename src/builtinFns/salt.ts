import { randomBytes } from "node:crypto";

/**
 * `salt` — random bytes as text.
 *
 * Registered as a crust function, so it is called `salt(...args)` where
 * mid-pipeline `args[0]` is the upstream ITEM (the crust.fn convention). That
 * used to mean the item was parsed as the byte count: `echo abc | salt 4` died
 * with `invalid byte count 'abc'` and the `4` was never looked at. The size is
 * therefore taken from the LAST positional, which is the only slot a line
 * argument can occupy when an item is also present.
 */
/** The screen `salt --help` prints at parse time (F42). */
export const saltUsage =
  "usage: salt [bytes] [hex|base64|base64url]\n" +
  "  bytes   how many random bytes to print (default 16)\n" +
  "  the encoding may come first or last: `salt 32 base64url` = `salt base64url 32`";

export function salt(...args: unknown[]): string {
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
  if (positionals.length === 0) return randomBytes(16).toString(encoding);
  const size = args.length >= 2 ? positionals[positionals.length - 1]! : positionals[0]!;
  const bytes = Number.parseInt(size, 10);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(
      `salt: '${size}' is not a byte count — the byte count is its own argument, ` +
        "e.g. `… | salt 8` (default 16 bytes)",
    );
  }
  return randomBytes(bytes).toString(encoding);
}
