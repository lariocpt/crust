import { EMBEDDED_SKILLS, skillDescription } from "./skillsData";

const USAGE = `skills <list|install> [--global] [--force]

Claude agent skills shipped with crust — install them so coding agents know
how to drive crust's pipelines, tests, mocks, and process tooling.

  skills list                 show embedded skills
  skills install              write to ./.claude/skills/<name>/SKILL.md
  skills install --global     write to ~/.claude/skills/ instead
  skills install --force      overwrite locally-edited copies
`;

export async function runSkills(args: string[]): Promise<number> {
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === "list") {
    for (const s of EMBEDDED_SKILLS) {
      process.stdout.write(`${s.name}\n    ${skillDescription(s.content)}\n`);
    }
    return 0;
  }

  if (cmd === "install") {
    let global = false;
    let force = false;
    for (const a of args.slice(1)) {
      if (a === "--global") global = true;
      else if (a === "--force") force = true;
      else {
        process.stderr.write(`skills: unknown argument ${a}\n${USAGE}`);
        return 2;
      }
    }
    const baseDir = global
      ? `${process.env.HOME}/.claude/skills`
      : `${process.cwd()}/.claude/skills`;
    let wrote = 0;
    let upToDate = 0;
    const conflicts: string[] = [];
    for (const s of EMBEDDED_SKILLS) {
      const path = `${baseDir}/${s.name}/SKILL.md`;
      const existing = Bun.file(path);
      if (await existing.exists()) {
        const current = await existing.text();
        if (current === s.content) {
          upToDate++;
          continue;
        }
        if (!force) {
          conflicts.push(path);
          continue;
        }
      }
      await Bun.write(path, s.content);
      wrote++;
    }
    if (conflicts.length > 0) {
      process.stderr.write(
        `skills: ${conflicts.length} file(s) differ from the embedded version — pass --force to overwrite:\n` +
          conflicts.map((p) => `  ${p}\n`).join(""),
      );
      return 1;
    }
    process.stdout.write(`skills: installed ${wrote}, up-to-date ${upToDate} → ${baseDir}\n`);
    return 0;
  }

  process.stderr.write(`skills: unknown command ${cmd}\n${USAGE}`);
  return 2;
}
