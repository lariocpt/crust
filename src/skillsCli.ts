import { FlagError, type FlagSpec, type ParsedFlags, parseFlags } from "./args";
import { type CompatOutcome, ensureClaudeLink, summarizeCompat } from "./skillsCompat";
import {
  EMBEDDED_SKILLS,
  type EmbeddedSkill,
  skillDescription,
  skillPath,
  skillStatuses,
  skillsBaseDir,
} from "./skillsData";
import { defaultChoice, type PickerEntry, pickSkills } from "./skillsPicker";

/**
 * Flags for the `install` verb. Exported so `crust --check 'skills install …'`
 * can lint the invocations the docs and skills tell people to run: until now
 * `skills` had no spec at all, which made it the one tool whose documented
 * flags could go stale in silence.
 *
 * `--select` is repeatable AND comma-separated because it reads both ways in a
 * shell (`--select crust-cli,crust-logs` and two `--select` flags).
 */
export const SKILLS_SPEC: FlagSpec = {
  global: { short: "g", type: "boolean" },
  force: { short: "f", type: "boolean" },
  all: { type: "boolean" },
  select: { type: "string", repeat: true },
};

const USAGE = `skills <list|install> [flags]

Claude agent skills shipped with crust — install them so coding agents know
how to drive crust's pipelines, tests, mocks, and process tooling.

  skills list                    show the embedded skills
  skills install                 on a terminal: pick which ones to install;
                                 otherwise (piped, CI): install every one
  skills install --all           every skill, no menu
  skills install --select a,b    only the named skills (repeatable)
  skills install --global        target ~/.agents/skills instead of ./.agents/skills
  skills install --force         overwrite locally-edited copies, and replace a
                                 real .claude/skills/<name> directory with a link

Each skill is written once, to .agents/skills/<name>/ — the cross-client
location Codex, Cursor and OpenCode read — and linked into
.claude/skills/<name>, because Claude Code is the one mainstream host that does
not read the standard path. A .claude/skills/<name> directory crust did not
write is left alone and reported; --force says it may become a link.

Run it as \`crust skills install\` from a shell, or type \`skills install\` at the
crust prompt — both reach the same code.
`;

interface InstallOutcome {
  wrote: number;
  upToDate: number;
  conflicts: string[];
  /** Per-skill result of the `.claude/skills` compatibility entry, in install order. */
  compat: Array<{ name: string; outcome: CompatOutcome }>;
}

/**
 * Write the chosen skills, never clobbering a locally-edited copy without
 * `force`. Returns what happened so the caller's summary is honest about a
 * partial install instead of claiming success.
 *
 * Files land in `.agents/skills/` (the cross-client convention) and each one is
 * linked into `.claude/skills/` for Claude Code, which does not read the
 * standard path yet.
 */
async function installSkills(
  chosen: EmbeddedSkill[],
  global: boolean,
  force: boolean,
): Promise<InstallOutcome> {
  const baseDir = skillsBaseDir(global);
  const outcome: InstallOutcome = { wrote: 0, upToDate: 0, conflicts: [], compat: [] };
  for (const skill of chosen) {
    const path = skillPath(baseDir, skill.name);
    const existing = Bun.file(path);
    if (await existing.exists()) {
      if ((await existing.text()) === skill.content) {
        outcome.upToDate++;
      } else if (!force) {
        outcome.conflicts.push(path);
        continue;
      } else {
        await Bun.write(path, skill.content);
        outcome.wrote++;
      }
    } else {
      await Bun.write(path, skill.content);
      outcome.wrote++;
    }
    outcome.compat.push({
      name: skill.name,
      outcome: await ensureClaudeLink(skill, global, force),
    });
  }
  return outcome;
}

function byName(names: string[]): EmbeddedSkill[] {
  const wanted = new Set(names);
  // In EMBEDDED_SKILLS order, so the summary matches `skills list`.
  return EMBEDDED_SKILLS.filter((s) => wanted.has(s.name));
}

function resolveSelection(raw: unknown): string[] | null {
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const names = list.flatMap((v) => String(v).split(",")).map((v) => v.trim());
  const known = new Set(EMBEDDED_SKILLS.map((s) => s.name));
  const bogus = names.filter((n) => n !== "" && !known.has(n));
  if (bogus.length > 0) {
    throw new FlagError(
      `unknown skill ${bogus.join(", ")} (see \`skills list\`: ${[...known].join(", ")})`,
    );
  }
  return names.filter((n) => n !== "");
}

/**
 * The menu is for humans, so it opens on a terminal and stays out of the way
 * otherwise. A piped or CI run installs everything — the behaviour every script
 * and every documented example already relies on; `--all` is for the case of a
 * human running one line from a terminal who does not want the menu.
 */
function wantsMenu(all: boolean, select: string[] | null): boolean {
  if (all || select) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function install(names: string[], global: boolean, force: boolean): Promise<number> {
  const outcome = await installSkills(byName(names), global, force);
  if (outcome.conflicts.length > 0) {
    process.stderr.write(
      `skills: ${outcome.conflicts.length} file(s) differ from the embedded version — pass --force to overwrite:\n` +
        outcome.conflicts.map((p) => `  ${p}\n`).join(""),
    );
    return 1;
  }
  const base = skillsBaseDir(global);
  const summary =
    outcome.wrote === 0
      ? `✔ ${outcome.upToDate} skill${outcome.upToDate === 1 ? "" : "s"} already current → ${base}`
      : `✔ installed ${outcome.wrote}, up-to-date ${outcome.upToDate} → ${base}`;
  process.stdout.write(`${summary}\n`);
  const compat = summarizeCompat(outcome.compat, global);
  if (compat.summary) process.stdout.write(`  ${compat.summary}\n`);
  for (const warning of compat.warnings) process.stderr.write(warning);
  return 0;
}

async function installCommand(argv: string[]): Promise<number> {
  let parsed: ParsedFlags;
  try {
    parsed = parseFlags(argv, SKILLS_SPEC);
  } catch (err) {
    process.stderr.write(`skills: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.rest.length > 0) {
    process.stderr.write(`skills: unexpected argument "${parsed.rest[0]}"\n${USAGE}`);
    return 2;
  }
  const global = parsed.values.global === true;
  const force = parsed.values.force === true;

  let select: string[] | null;
  try {
    select = resolveSelection(parsed.values.select);
  } catch (err) {
    process.stderr.write(`skills: ${(err as Error).message}\n`);
    return 2;
  }

  if (!wantsMenu(parsed.values.all === true, select)) {
    return install(select ?? EMBEDDED_SKILLS.map((s) => s.name), global, force);
  }

  const entries: PickerEntry[] = [];
  for (const skill of EMBEDDED_SKILLS) {
    entries.push({
      name: skill.name,
      description: skillDescription(skill.content),
      statuses: await skillStatuses(skill),
    });
  }
  const result = await pickSkills({
    entries,
    chosen: defaultChoice(entries, global),
    cursor: 0,
    global,
    force,
  });
  if (result.cancelled) {
    process.stdout.write("skills: cancelled, nothing written\n");
    return 0;
  }
  if (result.chosen.length === 0) {
    process.stdout.write("skills: nothing selected, nothing written\n");
    return 0;
  }
  return install(result.chosen, result.global, result.force);
}

export async function runSkills(args: string[]): Promise<number> {
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === "list") {
    // Strict on purpose: `skills list --global` used to print the same list and
    // exit 0, i.e. a flag silently doing nothing. `--check` refuses it, and the
    // runtime refusing more than the linter is how a documented line dies live.
    if (args.length > 1) {
      process.stderr.write(`skills list: unexpected argument "${args[1]}"\n${USAGE}`);
      return 2;
    }
    for (const s of EMBEDDED_SKILLS) {
      process.stdout.write(`${s.name}\n    ${skillDescription(s.content)}\n`);
    }
    return 0;
  }

  if (cmd === "install") return await installCommand(args.slice(1));

  process.stderr.write(`skills: unknown command ${cmd}\n${USAGE}`);
  return 2;
}
