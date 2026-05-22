import type { Context } from "../types";
import { base64 } from "./base64";
import { salt } from "./salt";
import { jwt } from "./jwt";
import { bundle } from "./bundle";
import { sql } from "./sql";

export function registerBuiltinFns(ctx: Context): void {
  ctx.functions.set("base64", base64 as (...a: unknown[]) => unknown);
  ctx.functions.set("salt", salt as (...a: unknown[]) => unknown);
  ctx.functions.set("jwt", jwt as (...a: unknown[]) => unknown);
  ctx.functions.set("bundle", bundle as (...a: unknown[]) => unknown);
  ctx.functions.set("sql", sql as (...a: unknown[]) => unknown);
}
