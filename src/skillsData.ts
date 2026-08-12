// Agent-facing skills, embedded into the binary via static text imports
// (compiled-binary-safe: no runtime fs dependency on the repo checkout).
// `skills install` writes them into a project's .claude/skills/ directory.
import crustLoadTesting from "../skills/crust-load-testing/SKILL.md" with { type: "text" };
import crustMockServer from "../skills/crust-mock-server/SKILL.md" with { type: "text" };
import crustPipelines from "../skills/crust-pipelines/SKILL.md" with { type: "text" };

export interface EmbeddedSkill {
  name: string;
  content: string;
}

export const EMBEDDED_SKILLS: EmbeddedSkill[] = [
  { name: "crust-load-testing", content: crustLoadTesting },
  { name: "crust-mock-server", content: crustMockServer },
  { name: "crust-pipelines", content: crustPipelines },
];

// One-line description from the SKILL.md frontmatter, for `skills list`.
export function skillDescription(content: string): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1]?.split("\n").find((l) => l.startsWith("description:"));
  return line ? line.slice("description:".length).trim() : "";
}
