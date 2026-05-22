import { createHmac, timingSafeEqual } from "node:crypto";

type Op = "sign" | "verify" | "decode";

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function pickSecret(args: unknown[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--secret" || a === "-s") {
      const next = args[i + 1];
      if (typeof next !== "string") throw new Error("jwt: --secret needs a value");
      return next;
    }
    if (typeof a === "string" && a.startsWith("--secret=")) {
      return a.slice("--secret=".length);
    }
  }
  const env = process.env.JWT_SECRET;
  if (env) return env;
  throw new Error("jwt: no secret (pass --secret <s> or set $JWT_SECRET)");
}

function pickPositionals(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--secret" || a === "-s") {
      i++;
      continue;
    }
    if (typeof a === "string" && a.startsWith("--secret=")) continue;
    out.push(a);
  }
  return out;
}

export function jwt(...args: unknown[]): unknown {
  const head = args[0];
  let op: Op;
  let rest: unknown[];
  if (head === "sign" || head === "verify" || head === "decode") {
    op = head;
    rest = args.slice(1);
  } else {
    op = "sign";
    rest = args;
  }
  const positionals = pickPositionals(rest);
  const value = positionals[0];

  if (op === "sign") {
    if (value === undefined) throw new Error("jwt sign: missing payload");
    const secret = pickSecret(rest);
    const payload = typeof value === "string" ? safeParse(value) : value;
    const header = { alg: "HS256", typ: "JWT" };
    const head = b64url(JSON.stringify(header));
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac("sha256", secret).update(`${head}.${body}`).digest());
    return `${head}.${body}.${sig}`;
  }

  if (op === "verify" || op === "decode") {
    if (typeof value !== "string") throw new Error(`jwt ${op}: missing token`);
    const parts = value.split(".");
    if (parts.length !== 3) throw new Error(`jwt ${op}: malformed token`);
    const [h, b, s] = parts as [string, string, string];
    const payload = JSON.parse(b64urlDecode(b).toString("utf8"));
    if (op === "decode") return payload;
    const secret = pickSecret(rest);
    const expected = createHmac("sha256", secret).update(`${h}.${b}`).digest();
    const got = b64urlDecode(s);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      throw new Error("jwt verify: signature mismatch");
    }
    return payload;
  }

  throw new Error(`jwt: unknown op '${op}'`);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
