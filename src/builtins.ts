import type { Context } from "./types";

export type Builtin = (rawArgs: string, ctx: Context) => Promise<number> | number;

const cdBuiltin: Builtin = (rawArgs, _ctx) => {
  const arg = rawArgs.trim();
  let target: string | undefined;
  if (arg === "" || arg === "~") {
    target = process.env.HOME;
  } else if (arg === "-") {
    target = process.env.OLDPWD;
    if (target) process.stdout.write(target + "\n");
  } else if (arg.startsWith("~/")) {
    target = (process.env.HOME ?? "") + arg.slice(1);
  } else {
    target = arg;
  }
  if (!target) {
    process.stderr.write("cd: no target\n");
    return 1;
  }
  const oldPwd = process.cwd();
  try {
    process.chdir(target);
    process.env.OLDPWD = oldPwd;
    process.env.PWD = process.cwd();
    return 0;
  } catch (err) {
    process.stderr.write(`cd: ${(err as Error).message}\n`);
    return 1;
  }
};

const exportBuiltin: Builtin = (rawArgs, _ctx) => {
  const arg = rawArgs.trim();
  if (arg === "") {
    for (const [k, v] of Object.entries(process.env)) {
      process.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  }
  const parts = splitArgsRespectingQuotes(arg);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return 0;
};

const aliasBuiltin: Builtin = (rawArgs, ctx) => {
  const arg = rawArgs.trim();
  if (arg === "") {
    for (const [k, v] of ctx.aliases) {
      process.stdout.write(`alias ${k}='${v}'\n`);
    }
    return 0;
  }
  const eq = arg.indexOf("=");
  if (eq === -1) {
    process.stderr.write(`alias: missing '=' in '${arg}'\n`);
    return 1;
  }
  const name = arg.slice(0, eq).trim();
  let value = arg.slice(eq + 1).trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  ctx.aliases.set(name, value);
  return 0;
};

const unaliasBuiltin: Builtin = (rawArgs, ctx) => {
  ctx.aliases.delete(rawArgs.trim());
  return 0;
};

const sourceBuiltin: Builtin = async (rawArgs, _ctx) => {
  const path = rawArgs.trim();
  if (!path) {
    process.stderr.write("source: missing file\n");
    return 1;
  }
  try {
    if (/\.(ts|js|mjs)$/.test(path)) {
      const resolved = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
      await import(resolved);
    } else {
      const proc = Bun.spawn(["sh", path], { stdio: ["inherit", "inherit", "inherit"] });
      await proc.exited;
      return proc.exitCode ?? 0;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`source: ${(err as Error).message}\n`);
    return 1;
  }
};

const exitBuiltin: Builtin = (rawArgs, ctx) => {
  const parsed = parseInt(rawArgs.trim() || "0", 10);
  ctx.exit(isNaN(parsed) ? 0 : parsed);
  return 0;
};

const historyBuiltin: Builtin = (_rawArgs, ctx) => {
  const width = Math.max(String(ctx.history.length).length, 1);
  for (let i = 0; i < ctx.history.length; i++) {
    const n = String(i + 1).padStart(width, " ");
    process.stdout.write(`${n}  ${ctx.history[i]}\n`);
  }
  return 0;
};

const helpBuiltin: Builtin = () => {
  process.stdout.write("crust builtins:\n");
  for (const name of Object.keys(builtins).sort()) {
    process.stdout.write(`  ${name}\n`);
  }
  return 0;
};

export const builtins: Record<string, Builtin> = {
  cd: cdBuiltin,
  export: exportBuiltin,
  alias: aliasBuiltin,
  unalias: unaliasBuiltin,
  source: sourceBuiltin,
  exit: exitBuiltin,
  history: historyBuiltin,
  help: helpBuiltin,
};

export function isBuiltin(name: string): boolean {
  return name in builtins;
}

function splitArgsRespectingQuotes(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === " ") {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}
