// The "install the agent skills?" question, asked once, right after the binary
// lands in the cache.
//
// WHY HERE. The skills are the difference between an agent that guesses at
// crust's grammar and one that gets it right on the first try, and a user who
// installs the package is exactly the moment that decision is live. Asking once,
// at install, beats documenting the verb in a README nobody re-reads.
//
// WHAT IT MUST NEVER DO. Break `npm install`. Every failure mode — no TTY, no
// binary, spawn refused, user typed noise — resolves to "declined", and the
// caller keeps exit 0. A postinstall that exits non-zero aborts the whole
// install, and "I did not want to answer a question" is not a reason to refuse
// to install a package.
//
// The gating is a separate pure function because it is the part with real blast
// radius: prompt in CI and the build hangs on a question nobody is there to
// answer; skip the cwd check and the skills land inside node_modules/crust.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const SKILLS_SUBDIR = ".claude/skills";

/**
 * Decide whether to ask, and where "this project" is.
 *
 * `INIT_CWD` is the directory `npm`/`bun`/`pnpm` were actually run from; the
 * process cwd during a lifecycle script is the package directory
 * (node_modules/crust), which is NOT where a project-scoped skill belongs.
 */
export function shouldAsk({
  env = {},
  stdinTty = false,
  stdoutTty = false,
  dir = env.INIT_CWD,
} = {}) {
  if (!stdinTty || !stdoutTty) return { ask: false, reason: "not an interactive terminal" };
  // A CI runner has no human to answer, and `CI` is set by every mainstream one.
  if (env.CI) return { ask: false, reason: "CI" };
  if (env.CRUST_NO_SKILLS) return { ask: false, reason: "CRUST_NO_SKILLS is set" };
  // A global install has no project to write into; suggest the global verb instead.
  if (env.npm_config_global === "true" || env.npm_config_global === "1") {
    return { ask: false, reason: "global install" };
  }
  // Nested install (crust pulled in as somebody's dependency): the skills are for
  // the developer's own agent, not for the package that happens to depend on us.
  if (!dir || dir.split(path.sep).includes("node_modules")) {
    return { ask: false, reason: "not run from a project directory" };
  }
  if (!existsSync(dir)) return { ask: false, reason: "project directory is gone" };
  if (hasCrustSkills(path.join(dir, SKILLS_SUBDIR))) {
    return { ask: false, reason: "skills already installed" };
  }
  return { ask: true, dir };
}

/** Any `crust-*` skill already on disk counts as "this user has done this". */
function hasCrustSkills(skillsDir) {
  let names;
  try {
    names = readdirSync(skillsDir);
  } catch {
    return false;
  }
  return names.some((n) => n.startsWith("crust-"));
}

/**
 * Ask, and on yes hand the terminal to `crust skills install` so the picker —
 * not this script — decides which skills land where.
 *
 * stdio is inherited precisely so the picker can take raw mode over the same
 * terminal. Reading the answer here and then re-reading keystrokes there would
 * otherwise fight over stdin.
 */
export async function askSkills({ bin, env = {}, log = () => {}, cwd = env.INIT_CWD }) {
  // No binary, no question: the picker lives inside it, and asking something we
  // cannot act on turns a helpful prompt into a broken one.
  if (!bin || !existsSync(bin)) return { asked: false, reason: "binary not available yet" };
  const gate = shouldAsk({
    env,
    stdinTty: process.stdin.isTTY === true,
    stdoutTty: process.stdout.isTTY === true,
    dir: cwd,
  });
  if (!gate.ask) return { asked: false, reason: gate.reason };

  log("");
  log("crust ships agent skills (Claude Code reads them to drive crust correctly).");
  log(`Install them into ${gate.dir}? [y/N] `);

  const answer = await readAnswer();
  if (!/^y(es)?$/i.test(answer.trim())) {
    log("skipped — `crust skills install` does it later (add --global for ~/.claude).");
    log("to stop being asked: CRUST_NO_SKILLS=1");
    return { asked: true, installed: false };
  }
  const code = await new Promise((resolve) => {
    const child = spawn(bin, ["skills", "install"], { cwd: gate.dir, stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("close", (c) => resolve(c ?? -1));
  });
  return { asked: true, installed: code === 0, code };
}

/** One line from stdin. Resolves empty on EOF so a half-open pipe cannot hang. */
function readAnswer() {
  return new Promise((resolve) => {
    let buf = "";
    const done = (value) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) done(buf.slice(0, nl));
    };
    const onEnd = () => done(buf);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}
