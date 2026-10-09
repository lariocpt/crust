import type { Context } from "../types";
import { base64, base64Usage } from "./base64";
import { bundle, bundleUsage } from "./bundle";
import { jwt, jwtUsage } from "./jwt";
import { salt, saltUsage } from "./salt";
import { sql, sqlUsage } from "./sql";
import { wait, waitUsage } from "./wait";

export function registerBuiltinFns(ctx: Context): void {
  ctx.functions.set("base64", base64 as (...a: unknown[]) => unknown);
  ctx.functions.set("salt", salt as (...a: unknown[]) => unknown);
  ctx.functions.set("jwt", jwt as (...a: unknown[]) => unknown);
  ctx.functions.set("bundle", bundle as (...a: unknown[]) => unknown);
  ctx.functions.set("sql", sql as (...a: unknown[]) => unknown);
  ctx.functions.set("wait", wait as (...a: unknown[]) => unknown);
}

/**
 * The usage screens the registered builtins print for `-h`/`--help` at parse
 * time (F42). Keyed by the registered name, so `isBuiltinFn` decides whether
 * the name still owns the builtin — a user's `crust.fn("base64", …)` keeps its
 * handler's argument contract and its arguments' meaning.
 */
export const BUILTIN_FN_USAGE: Record<string, string> = {
  base64: base64Usage,
  salt: saltUsage,
  jwt: jwtUsage,
  bundle: bundleUsage,
  sql: sqlUsage,
  wait: waitUsage,
};

const BUILTIN_FNS: Record<string, (...a: unknown[]) => unknown> = {
  base64,
  salt,
  jwt,
  bundle,
  sql,
  wait,
};

/** True when `ctx` still maps `name` to the builtin it started with. */
export function isBuiltinFn(ctx: Context, name: string): boolean {
  const builtin = BUILTIN_FNS[name];
  return builtin !== undefined && ctx.functions.get(name) === builtin;
}
