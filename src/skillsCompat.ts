// Claude Code compatibility for the skill install: the real file lives in
// .agents/skills/<name>/ (the cross-client convention — see SKILLS_SUBDIR in
// skillsData.ts) and .claude/skills/<name> is a link to that same directory,
// because Claude Code is the one mainstream host that does not read
// .agents/skills yet.
//
// A link rather than a copy so there is one file to edit and no way for the two
// views to disagree; per-skill rather than one link over `skills/` because
// Codex keeps its own `.system/` in that directory and CLIs expect a real dir.
//
// Nothing here may fail an install. The canonical write already succeeded; a
// compatibility entry is a convenience, and losing it says so and moves on.
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  claudeBaseDir,
  claudeSkillDir,
  type EmbeddedSkill,
  skillDir,
  skillsBaseDir,
} from "./skillsData";

export type CompatOutcome =
  /** Link created now. `replacedDir`: a real directory stood here and `--force` replaced it. */
  | { kind: "linked"; replacedDir: boolean }
  /** Already a link to the canonical directory — nothing to do. */
  | { kind: "current" }
  /** Symlinks refused by the system (Windows without Developer Mode); wrote a copy instead. */
  | { kind: "copied"; reason: string }
  /** A real directory (or a plain file) is here. Untouched, and reported. */
  | { kind: "occupied" }
  /** A link, but to somewhere else — the user put it there. Untouched. */
  | { kind: "foreign"; target: string }
  /** Could not tell or act. Reported; the canonical file is still installed. */
  | { kind: "failed"; error: string };

/** The link target, written relative so a moved project or a synced `$HOME` keeps working. */
export function claudeLinkTarget(name: string, global: boolean): string {
  const link = claudeSkillDir(name, global);
  return relative(dirname(link), skillDir(skillsBaseDir(global), name));
}

/**
 * Make `.claude/skills/<name>` point at the installed skill.
 *
 * `force` consents to replacing the directory that stands there; without it a
 * real directory is left exactly as it is and merely reported, because it may
 * be a skill the user wrote themselves rather than a copy crust made earlier.
 */
export async function ensureClaudeLink(
  skill: EmbeddedSkill,
  global: boolean,
  force: boolean,
): Promise<CompatOutcome> {
  const link = claudeSkillDir(skill.name, global);
  const canonical = skillDir(skillsBaseDir(global), skill.name);
  let replacedDir = false;
  try {
    const st = await lstat(link);
    if (st.isSymbolicLink()) {
      const target = await readlink(link);
      return resolve(dirname(link), target) === resolve(canonical)
        ? { kind: "current" }
        : { kind: "foreign", target };
    }
    if (!st.isDirectory()) return { kind: "occupied" };
    if (!force) return { kind: "occupied" };
    await rm(link, { recursive: true, force: true });
    replacedDir = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { kind: "failed", error: (err as Error).message };
    }
  }

  try {
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), canonical), link, "dir");
    return { kind: "linked", replacedDir };
  } catch (err) {
    if (!replacedDir && isSymlinkUnsupported(err)) {
      try {
        await mkdir(dirname(link), { recursive: true });
        await Bun.write(`${link}/SKILL.md`, skill.content);
        return { kind: "copied", reason: (err as Error).message };
      } catch {
        /* fall through and report the symlink failure, which is the real cause */
      }
    }
    // Replaced a directory and then could not link: putting the content back as
    // a copy is better than leaving the user with neither.
    if (replacedDir) {
      try {
        await Bun.write(`${link}/SKILL.md`, skill.content);
      } catch {
        /* reported below — nothing more to do */
      }
    }
    return { kind: "failed", error: (err as Error).message };
  }
}

/** Windows without Developer Mode answers EPERM; some filesystems say ENOTSUP. */
function isSymlinkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EOPNOTSUPP";
}

/** One line for the install summary, plus anything the user should act on. */
export function summarizeCompat(
  results: Array<{ name: string; outcome: CompatOutcome }>,
  global: boolean,
): { summary: string | null; warnings: string[] } {
  const kinds = (kind: CompatOutcome["kind"]) => results.filter((r) => r.outcome.kind === kind);
  const linked = kinds("linked").length;
  const copied = kinds("copied").length;
  const made = [linked > 0 ? `linked ${linked}` : null, copied > 0 ? `copied ${copied}` : null]
    .filter((s): s is string => s !== null)
    .join(", ");
  const summary = made === "" ? null : `${made} into ${claudeBaseDir(global)} for Claude Code`;

  const warnings: string[] = [];
  const occupied = kinds("occupied");
  if (occupied.length > 0) {
    const one = occupied.length === 1;
    warnings.push(
      `! ${occupied.length} real ${one ? "directory" : "directories"} under ${claudeBaseDir(global)} crust did not write — left untouched.` +
        ` Remove ${one ? "it" : "them"}, or pass --force to link ${one ? "it" : "them"} instead:\n` +
        occupied.map((r) => `    ${claudeSkillDir(r.name, global)}\n`).join(""),
    );
  }
  for (const r of kinds("foreign")) {
    if (r.outcome.kind === "foreign") {
      warnings.push(
        `! ${claudeSkillDir(r.name, global)} links to ${r.outcome.target}, not to crust's copy — left alone\n`,
      );
    }
  }
  for (const r of kinds("failed")) {
    if (r.outcome.kind === "failed") {
      warnings.push(
        `! could not write ${claudeSkillDir(r.name, global)} (${r.outcome.error}) — the skill is installed; Claude Code may not find it\n`,
      );
    }
  }
  return { summary, warnings };
}
