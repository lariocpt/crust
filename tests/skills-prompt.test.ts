import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldAsk } from "../npm/lib/skills-prompt.mjs";

// The install-time prompt is the one place crust writes into somebody's project
// without being asked twice, so the DECISION is the thing worth testing: a wrong
// "yes" hangs CI on a question nobody is there to answer, or drops nine SKILL.md
// files into node_modules/crust. The question itself is a readline call.
let dir: string;
const SKILLS = ".claude/skills";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crust-skillsprompt-"));
});

afterAll(() => rm(dir, { recursive: true, force: true }));

/** A project dir that has nothing installed yet (the state worth asking about). */
async function emptyProject(name: string): Promise<string> {
  const p = join(dir, name);
  await mkdir(p, { recursive: true });
  return p;
}

describe("postinstall skills prompt: gating", () => {
  test("asks on a terminal, from a project directory", async () => {
    const project = await emptyProject("ask");
    const r = shouldAsk({
      env: { INIT_CWD: project },
      stdinTty: true,
      stdoutTty: true,
    });
    expect(r).toEqual({ ask: true, dir: project });
  });

  test("silent when either end of the terminal is missing", async () => {
    const project = await emptyProject("no-tty");
    const base = { env: { INIT_CWD: project }, stdoutTty: true };
    expect(shouldAsk({ ...base, stdinTty: false }).ask).toBe(false);
    expect(shouldAsk({ env: { INIT_CWD: project }, stdinTty: true, stdoutTty: false }).ask).toBe(
      false,
    );
  });

  test("silent in CI — a build with no human must not wait on a prompt", async () => {
    const project = await emptyProject("ci");
    const r = shouldAsk({
      env: { INIT_CWD: project, CI: "true" },
      stdinTty: true,
      stdoutTty: true,
    });
    expect(r.ask).toBe(false);
  });

  test("silent when the user opted out", async () => {
    const project = await emptyProject("optout");
    const r = shouldAsk({
      env: { INIT_CWD: project, CRUST_NO_SKILLS: "1" },
      stdinTty: true,
      stdoutTty: true,
    });
    expect(r.ask).toBe(false);
  });

  test("silent for a global install: there is no project to write into", async () => {
    const project = await emptyProject("global");
    const r = shouldAsk({
      env: { INIT_CWD: project, npm_config_global: "true" },
      stdinTty: true,
      stdoutTty: true,
    });
    expect(r.ask).toBe(false);
  });

  test("silent when pulled in as a dependency (cwd is inside node_modules)", async () => {
    const nested = join(dir, "consumer", "node_modules", "crust");
    await mkdir(nested, { recursive: true });
    const r = shouldAsk({ env: { INIT_CWD: nested }, stdinTty: true, stdoutTty: true });
    expect(r.ask).toBe(false);
    // And with no INIT_CWD at all: guessing the cwd would write into the package.
    expect(shouldAsk({ env: {}, stdinTty: true, stdoutTty: true }).ask).toBe(false);
  });

  test("silent once the user already has crust skills installed", async () => {
    const project = await emptyProject("installed");
    await mkdir(join(project, SKILLS, "crust-cli"), { recursive: true });
    await writeFile(join(project, SKILLS, "crust-cli", "SKILL.md"), "---\nname: crust-cli\n---\n");
    const r = shouldAsk({ env: { INIT_CWD: project }, stdinTty: true, stdoutTty: true });
    expect(r.ask).toBe(false);
  });

  test("an unrelated .claude/skills entry is not 'already installed'", async () => {
    const project = await emptyProject("other-skills");
    await mkdir(join(project, SKILLS, "my-own-skill"), { recursive: true });
    const r = shouldAsk({ env: { INIT_CWD: project }, stdinTty: true, stdoutTty: true });
    expect(r.ask).toBe(true);
  });
});
