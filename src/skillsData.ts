// Agent-facing skills, embedded into the binary via static text imports
// (compiled-binary-safe: no runtime fs dependency on the repo checkout).
// `skills install` writes them into .agents/skills/ and links them into
// .claude/skills/ — see SKILLS_SUBDIR for why that is the canonical half.
import { homedir } from "node:os";
import crustApiTesting from "../skills/crust-api-testing/SKILL.md" with { type: "text" };
import crustBuiltins from "../skills/crust-builtins/SKILL.md" with { type: "text" };
import crustCli from "../skills/crust-cli/SKILL.md" with { type: "text" };
import crustLoadTesting from "../skills/crust-load-testing/SKILL.md" with { type: "text" };
import crustLogs from "../skills/crust-logs/SKILL.md" with { type: "text" };
import crustMcp from "../skills/crust-mcp/SKILL.md" with { type: "text" };
import crustMockServer from "../skills/crust-mock-server/SKILL.md" with { type: "text" };
import crustPipelines from "../skills/crust-pipelines/SKILL.md" with { type: "text" };
import crustProcs from "../skills/crust-procs/SKILL.md" with { type: "text" };
import crustVerifyWebLinks from "../skills/crust-verify-web-links/SKILL.md" with { type: "text" };

export interface EmbeddedSkill {
  name: string;
  content: string;
}
export const EMBEDDED_SKILLS: EmbeddedSkill[] = [
  { name: "crust-api-testing", content: crustApiTesting },
  { name: "crust-builtins", content: crustBuiltins },
  { name: "crust-cli", content: crustCli },
  { name: "crust-load-testing", content: crustLoadTesting },
  { name: "crust-logs", content: crustLogs },
  { name: "crust-mcp", content: crustMcp },
  { name: "crust-mock-server", content: crustMockServer },
  { name: "crust-pipelines", content: crustPipelines },
  { name: "crust-procs", content: crustProcs },
  { name: "crust-verify-web-links", content: crustVerifyWebLinks },
];

// One-line description from the SKILL.md frontmatter, for `skills list`.
export function skillDescription(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1]?.split("\n").find((l) => l.startsWith("description:"));
  return line ? line.slice("description:".length).trim() : "";
}

/**
 * Where the real files land, relative to a project root or to `$HOME`.
 *
 * `.agents/skills` is the cross-client convention: Codex reads **only** that
 * path, Cursor and OpenCode read it alongside their own vendor directories, and
 * Claude Code reads only `.claude/skills`. So this is the canonical half and
 * `CLAUDE_SUBDIR` is the compatibility half — a per-skill link, not a second
 * copy, because two copies drift and one edited file becomes two questions.
 *
 * Never link the whole `skills/` directory: Codex writes its own `.system/`
 * into it and CLIs expect a real directory there. Per-skill, the link is
 * `.claude/skills/<name> -> ../../.agents/skills/<name>`.
 */
export const SKILLS_SUBDIR = ".agents/skills";

/** Claude Code's own discovery path, which does not read {@link SKILLS_SUBDIR}. */
export const CLAUDE_SUBDIR = ".claude/skills";

/**
 * `missing` — nothing installed. `current` — byte-identical to the embedded
 * copy. `edited` — present and DIFFERENT, which is the one state `install` must
 * not silently overwrite, and the reason the picker labels it in yellow instead
 * of treating it like the others.
 */
export type SkillStatus = "missing" | "current" | "edited";

export interface SkillStatuses {
  project: SkillStatus;
  global: SkillStatus;
}

/** Root of a scope: the project cwd, or `$HOME` when `global`. */
export function skillsRoot(global: boolean): string {
  return global ? homedir() : process.cwd().replace(/\/+$/, "");
}

/** Project-scoped, or `$HOME`-scoped when `global`. */
export function skillsBaseDir(global: boolean): string {
  return `${skillsRoot(global)}/${SKILLS_SUBDIR}`;
}

/** The directory one skill owns: `<base>/<name>`. */
export function skillDir(baseDir: string, name: string): string {
  return `${baseDir}/${name}`;
}

export function skillPath(baseDir: string, name: string): string {
  return `${skillDir(baseDir, name)}/SKILL.md`;
}

/** `<root>/.claude/skills` — Claude Code's discovery directory for this scope. */
export function claudeBaseDir(global: boolean): string {
  return `${skillsRoot(global)}/${CLAUDE_SUBDIR}`;
}

/** `<root>/.claude/skills/<name>` — where the link to {@link skillDir} belongs. */
export function claudeSkillDir(name: string, global: boolean): string {
  return `${claudeBaseDir(global)}/${name}`;
}

async function statusAt(path: string, content: string): Promise<SkillStatus> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "missing";
  return (await file.text()) === content ? "current" : "edited";
}

/**
 * Both scopes in one pass.
 *
 * The picker can switch target with `g` while it is open, and a redraw has to
 * be synchronous — so the answer for both scopes is read up front (ten small
 * files, twice) rather than re-queried on every keypress.
 */
export async function skillStatuses(skill: EmbeddedSkill): Promise<SkillStatuses> {
  const project = await statusAt(skillPath(skillsBaseDir(false), skill.name), skill.content);
  const global = await statusAt(skillPath(skillsBaseDir(true), skill.name), skill.content);
  return { project, global };
}
