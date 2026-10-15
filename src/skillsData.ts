// Agent-facing skills, embedded into the binary via static text imports
// (compiled-binary-safe: no runtime fs dependency on the repo checkout).
// `skills install` writes them into a project's .claude/skills/ directory.
import { homedir } from "node:os";
import crustApiTesting from "../skills/crust-api-testing/SKILL.md" with { type: "text" };
import crustBuiltins from "../skills/crust-builtins/SKILL.md" with { type: "text" };
import crustCli from "../skills/crust-cli/SKILL.md" with { type: "text" };
import crustLoadTesting from "../skills/crust-load-testing/SKILL.md" with { type: "text" };
import crustLogs from "../skills/crust-logs/SKILL.md" with { type: "text" };
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

/** Where skills land, relative to a project root or to the home directory. */
export const SKILLS_SUBDIR = ".claude/skills";

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

/** Project-scoped, or `$HOME`-scoped when `global`. */
export function skillsBaseDir(global: boolean): string {
  return global
    ? `${homedir()}/${SKILLS_SUBDIR}`
    : `${process.cwd().replace(/\/+$/, "")}/${SKILLS_SUBDIR}`;
}

export function skillPath(baseDir: string, name: string): string {
  return `${baseDir}/${name}/SKILL.md`;
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
 * be synchronous — so the answer for both scopes is read up front (nine small
 * files, twice) rather than re-queried on every keypress.
 */
export async function skillStatuses(skill: EmbeddedSkill): Promise<SkillStatuses> {
  const project = await statusAt(skillPath(skillsBaseDir(false), skill.name), skill.content);
  const global = await statusAt(skillPath(skillsBaseDir(true), skill.name), skill.content);
  return { project, global };
}
