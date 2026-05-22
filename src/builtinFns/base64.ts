export function base64(...args: unknown[]): string {
  const decode = args.some(
    (a) => a === "-d" || a === "decode" || a === "--decode",
  );
  const real = args.filter(
    (a) => a !== "-d" && a !== "decode" && a !== "--decode",
  );
  const value = real[0];
  if (value === undefined || value === null) {
    throw new Error("base64: missing input");
  }
  if (value instanceof Uint8Array) {
    if (decode) throw new Error("base64: cannot decode a binary input");
    return Buffer.from(value).toString("base64");
  }
  const str = String(value);
  return decode
    ? Buffer.from(str, "base64").toString("utf8")
    : Buffer.from(str, "utf8").toString("base64");
}
