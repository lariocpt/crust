import { splitArgs } from "./args";
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
  // splitArgs strips quotes, so `export FOO="a b"` arrives as one part `FOO=a b`.
  const parts = splitArgs(arg);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    process.env[part.slice(0, eq)] = part.slice(eq + 1);
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
      const proc = Bun.spawn(["sh", path], {
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env },
      });
      await proc.exited;
      return proc.exitCode ?? 0;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`source: ${(err as Error).message}\n`);
    return 1;
  }
};

const exitBuiltin: Builtin = async (rawArgs, ctx) => {
  const parsed = parseInt(rawArgs.trim() || "0", 10);
  await ctx.exit(isNaN(parsed) ? 0 : parsed);
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

const dotenvBuiltin: Builtin = async (rawArgs, ctx) => {
  const parts = splitArgs(rawArgs.trim());
  if (parts[0] === "status" || parts[0] === "list") return dotenvStatus(ctx);
  if (parts[0] === "clear") return dotenvClear(ctx);

  let configPath = "./.env";
  let append = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "--append") {
      append = true;
    } else if (p === "--config") {
      const next = parts[++i];
      if (!next) {
        process.stderr.write("dotenv: --config requires a path\n");
        return 2;
      }
      configPath = next;
    } else if (p.startsWith("--config=")) {
      configPath = p.slice("--config=".length);
    } else {
      process.stderr.write(`dotenv: unknown arg '${p}'\n`);
      return 2;
    }
  }
  return dotenvLoad(ctx, configPath, append ? "append" : "overwrite");
};

async function dotenvLoad(
  ctx: Context,
  path: string,
  mode: "overwrite" | "append",
): Promise<number> {
  const abs = path.startsWith("/") ? path : `${process.cwd()}/${path}`;
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    process.stderr.write(`dotenv: ${abs}: not found\n`);
    return 1;
  }
  const text = await file.text();
  const pairs = parseDotenv(text);
  if (ctx.dotenv.snapshot === null) {
    ctx.dotenv.snapshot = { ...process.env };
  }
  const written: string[] = [];
  for (const [k, v] of pairs) {
    if (mode === "append" && process.env[k] !== undefined) continue;
    process.env[k] = v;
    written.push(k);
  }
  ctx.dotenv.history.push({ path: abs, mode, ts: Date.now(), keys: written });
  process.stdout.write(`dotenv: loaded ${written.length} var(s) from ${abs} (${mode})\n`);
  return 0;
}

function dotenvStatus(ctx: Context): number {
  if (ctx.dotenv.history.length === 0) {
    process.stdout.write("dotenv: no loads\n");
    return 0;
  }
  const totalKeys = new Set(ctx.dotenv.history.flatMap((r) => r.keys)).size;
  process.stdout.write(
    `dotenv: ${ctx.dotenv.history.length} load(s), ${totalKeys} unique var(s) touched\n`,
  );
  const idxWidth = String(ctx.dotenv.history.length).length;
  for (let i = 0; i < ctx.dotenv.history.length; i++) {
    const r = ctx.dotenv.history[i]!;
    const idx = String(i + 1).padStart(idxWidth, " ");
    const iso = new Date(r.ts).toISOString();
    const shown = r.keys.slice(0, 6).join(", ");
    const more = r.keys.length > 6 ? `, +${r.keys.length - 6} more` : "";
    const keyList = r.keys.length === 0 ? "(no vars)" : `(${r.keys.length} vars: ${shown}${more})`;
    process.stdout.write(`  ${idx}  ${iso}  ${r.mode.padEnd(9)}  ${r.path}  ${keyList}\n`);
  }
  return 0;
}

function dotenvClear(ctx: Context): number {
  if (ctx.dotenv.snapshot === null) {
    process.stdout.write("dotenv: nothing to clear\n");
    return 0;
  }
  const snap = ctx.dotenv.snapshot;
  for (const k of Object.keys(process.env)) {
    if (!(k in snap)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  ctx.dotenv.snapshot = null;
  ctx.dotenv.history = [];
  process.stdout.write("dotenv: cleared\n");
  return 0;
}

function parseDotenv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    const quoted =
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2);
    if (!quoted) {
      const hash = val.indexOf(" #");
      if (hash !== -1) val = val.slice(0, hash).trimEnd();
    } else {
      val = val.slice(1, -1);
    }
    out.push([key, val]);
  }
  return out;
}

const testFixtureBuiltin: Builtin = async (rawArgs, _ctx) => {
  const args = splitArgs(rawArgs);
  const binPath = `${process.env.HOME}/.crust/bin/crust-test-fixture`;
  if (await Bun.file(binPath).exists()) {
    const proc = Bun.spawn([binPath, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
    return proc.exitCode ?? 0;
  }
  const { runCli } = await import("./testFixture/cli");
  return await runCli(args);
};

const testPipesBuiltin: Builtin = async (rawArgs, _ctx) => {
  const args = splitArgs(rawArgs);
  const { runCli } = await import("./testPipes/cli");
  return await runCli(args);
};

const genFixturesBuiltin: Builtin = async (rawArgs, _ctx) => {
  const args = splitArgs(rawArgs);
  const { runCli } = await import("./genFixtures/cli");
  return await runCli(args);
};

const mockServerBuiltin: Builtin = async (rawArgs, _ctx) => {
  const args = splitArgs(rawArgs);
  const { runCli } = await import("./mockServer/cli");
  return await runCli(args);
};

const verifyWebLinksBuiltin: Builtin = async (rawArgs, _ctx) => {
  const args = splitArgs(rawArgs);
  const { runCli } = await import("./verifyWebLinks/cli");
  return await runCli(args);
};

const skillsBuiltin: Builtin = async (rawArgs, _ctx) => {
  const { runSkills } = await import("./skillsCli");
  return await runSkills(splitArgs(rawArgs.trim()));
};

export const builtins: Record<string, Builtin> = {
  skills: skillsBuiltin,
  cd: cdBuiltin,
  export: exportBuiltin,
  alias: aliasBuiltin,
  unalias: unaliasBuiltin,
  source: sourceBuiltin,
  exit: exitBuiltin,
  history: historyBuiltin,
  help: helpBuiltin,
  dotenv: dotenvBuiltin,
  "test-fixture": testFixtureBuiltin,
  "test-pipes": testPipesBuiltin,
  "gen-fixtures": genFixturesBuiltin,
  "mock-server": mockServerBuiltin,
  "verify-web-links": verifyWebLinksBuiltin,
};

export function isBuiltin(name: string): boolean {
  return name in builtins;
}
