import type { Context } from "./types";

const HOME = process.env.HOME ?? "/";

export function defaultPrompt(ctx?: Context): string {
  const cwd = displayCwd();
  const branch = gitBranch();
  const symbol = process.getuid && process.getuid() === 0 ? "#" : "$";
  const branchPart = branch ? ` \x1b[32m(${branch})\x1b[0m` : "";
  const envCount = ctx?.dotenv.history.length ?? 0;
  const envPart = envCount ? ` \x1b[33m[env: ${envCount}]\x1b[0m` : "";
  return `\x1b[36m${cwd}\x1b[0m${branchPart}${envPart} ${symbol} `;
}

export function displayCwd(): string {
  const cwd = process.cwd();
  if (cwd === HOME) return "~";
  if (cwd.startsWith(HOME + "/")) return "~" + cwd.slice(HOME.length);
  return cwd;
}

let lastCwd = "";
let cachedBranch: string | null = null;

export function gitBranch(): string | null {
  const cwd = process.cwd();
  if (cwd === lastCwd) return cachedBranch;
  lastCwd = cwd;
  try {
    const { stdout, exitCode } = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    if (exitCode !== 0) {
      cachedBranch = null;
    } else {
      const text = new TextDecoder().decode(stdout).trim();
      cachedBranch = text || null;
    }
  } catch {
    cachedBranch = null;
  }
  return cachedBranch;
}
