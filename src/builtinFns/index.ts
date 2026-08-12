import type { Context } from "../types";
import { base64 } from "./base64";
import { bundle } from "./bundle";
import { jwt } from "./jwt";
import { salt } from "./salt";
import { sql } from "./sql";
import { wait } from "./wait";

export function registerBuiltinFns(ctx: Context): void {
  ctx.functions.set("base64", base64 as (...a: unknown[]) => unknown);
  ctx.functions.set("salt", salt as (...a: unknown[]) => unknown);
  ctx.functions.set("jwt", jwt as (...a: unknown[]) => unknown);
  ctx.functions.set("bundle", bundle as (...a: unknown[]) => unknown);
  ctx.functions.set("sql", sql as (...a: unknown[]) => unknown);
  ctx.functions.set("wait", wait as (...a: unknown[]) => unknown);
}
