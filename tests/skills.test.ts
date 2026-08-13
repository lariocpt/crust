import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, tokenize } from "../src/lexer";
import { runSkills } from "../src/skillsCli";
import { EMBEDDED_SKILLS, skillDescription } from "../src/skillsData";

let dir: string;
let cwd: string;

beforeAll(async () => {
  cwd = process.cwd();
  dir = await realpath(await mkdtemp(join(tmpdir(), "crust-skills-")));
  process.chdir(dir);
});

afterAll(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("embedded skills", () => {
  test("every skill has matching frontmatter name and a description", () => {
    for (const s of EMBEDDED_SKILLS) {
      expect(s.content).toContain(`name: ${s.name}`);
      expect(skillDescription(s.content).length).toBeGreaterThan(20);
    }
  });

  // Grammar lint: every ```crust fenced line must still parse as the stage
  // kinds it demonstrates. Catches stale examples when the grammar changes.
  const KEYWORDS = new Set([
    "range(0,",
    "range(1,",
    "capture",
    "expect",
    "stats",
    "load",
    "read",
    "assert",
    "filter",
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "stdin",
    "grep",
  ]);

  test("every fenced crust example line classifies against the live grammar", () => {
    for (const s of EMBEDDED_SKILLS) {
      const fences = [...s.content.matchAll(/```crust\n([\s\S]*?)```/g)];
      expect(fences.length).toBeGreaterThan(0);
      for (const fence of fences) {
        for (const rawLine of fence[1]!.split("\n")) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const tokens = tokenize(line);
          expect(tokens.length).toBeGreaterThan(0);
          for (const t of tokens) {
            const kind = classify(t.text); // must not throw
            const head = t.text.trim().split(/\s+/)[0]!;
            if (KEYWORDS.has(head)) {
              // A keyword stage that classifies as shell = stale example.
              expect(`${head}:${kind.kind}`).not.toBe(`${head}:shell`);
            }
          }
        }
      }
    }
  });
});

describe("skills builtin", () => {
  test("install writes SKILL.md files under ./.claude/skills", async () => {
    const code = await runSkills(["install"]);
    expect(code).toBe(0);
    for (const s of EMBEDDED_SKILLS) {
      const content = await Bun.file(join(dir, ".claude", "skills", s.name, "SKILL.md")).text();
      expect(content).toBe(s.content);
    }
  });

  test("re-install is idempotent; a locally-edited file is refused without --force", async () => {
    expect(await runSkills(["install"])).toBe(0);
    const target = join(dir, ".claude", "skills", EMBEDDED_SKILLS[0]!.name, "SKILL.md");
    await Bun.write(target, "# locally edited\n");
    expect(await runSkills(["install"])).toBe(1);
    expect(await Bun.file(target).text()).toBe("# locally edited\n");
    expect(await runSkills(["install", "--force"])).toBe(0);
    expect(await Bun.file(target).text()).toBe(EMBEDDED_SKILLS[0]!.content);
  });

  test("list exits 0; unknown args exit 2", async () => {
    expect(await runSkills(["list"])).toBe(0);
    expect(await runSkills(["install", "--bogus"])).toBe(2);
    expect(await runSkills(["frobnicate"])).toBe(2);
  });
});
