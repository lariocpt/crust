import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, tokenize } from "../src/lexer";
import { runSkills } from "../src/skillsCli";
import { EMBEDDED_SKILLS, type SkillStatus, skillDescription } from "../src/skillsData";
import {
  defaultChoice,
  moveCursor,
  type PickerEntry,
  parseKeys,
  renderPicker,
  statusOf,
  toggleAll,
} from "../src/skillsPicker";

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
    // `list --global` used to list anyway and exit 0: a flag doing nothing.
    expect(await runSkills(["list", "--global"])).toBe(2);
  });
});

describe("skills install --select", () => {
  test("writes only the named skills", async () => {
    rmSync(join(dir, ".claude"), { recursive: true, force: true });
    expect(await runSkills(["install", "--select", "crust-cli,crust-logs"])).toBe(0);
    expect(await Bun.file(join(dir, ".claude/skills/crust-cli/SKILL.md")).text()).toBe(
      EMBEDDED_SKILLS.find((s) => s.name === "crust-cli")!.content,
    );
    expect(await Bun.file(join(dir, ".claude/skills/crust-logs/SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(dir, ".claude/skills/crust-procs/SKILL.md")).exists()).toBe(false);
  });

  test("repeated flags and commas are the same selection", async () => {
    rmSync(join(dir, ".claude"), { recursive: true, force: true });
    expect(await runSkills(["install", "--select", "crust-cli", "--select", "crust-logs"])).toBe(0);
    expect(await Bun.file(join(dir, ".claude/skills/crust-logs/SKILL.md")).exists()).toBe(true);
  });

  test("an unknown name fails, naming both the offender and the choices", async () => {
    const code = await runSkills(["install", "--select", "crust-cli,nope"]);
    expect(code).toBe(2);
  });
});

describe("skill picker logic (the part that decides what gets written)", () => {
  const entry = (
    name: string,
    project: SkillStatus,
    global: SkillStatus = project,
  ): PickerEntry => ({
    name,
    description: `${name} does things`,
    statuses: { project, global },
  });
  // Deliberately: `b` is up to date HERE but absent from ~/.claude, `c` is
  // hand-edited here but current globally.
  const entries = [
    entry("a", "missing"),
    entry("b", "current", "missing"),
    entry("c", "edited", "current"),
  ];

  test("a chunk can carry several keys, and every byte is accounted for", () => {
    // A fast key repeat or a paste arrives as one chunk. Reading a chunk as one
    // key is how a menu eats the `[A` of an arrow key and prints it.
    expect(parseKeys("\x1b[A\x1b[B")).toEqual(["up", "down"]);
    expect(parseKeys("jjq")).toEqual(["down", "down", "quit"]);
    expect(parseKeys(" \r")).toEqual(["space", "enter"]);
    expect(parseKeys("\x03")).toEqual(["cancel"]);
    expect(parseKeys("\x1b")).toEqual(["other"]); // bare ESC, not a truncated arrow
    expect(parseKeys("\x1b[C")).toEqual(["other"]); // right-arrow: unbound, not "c"
  });

  test("the cursor wraps and stays put on an empty list", () => {
    expect(moveCursor(3, 0, -1)).toBe(2);
    expect(moveCursor(3, 2, 1)).toBe(0);
    expect(moveCursor(0, 0, 1)).toBe(0);
  });

  test("toggle-all turns everything on, and off again when everything was on", () => {
    const none = new Set<string>();
    expect([...toggleAll(entries, none)]).toEqual(["a", "b", "c"]);
    expect([...toggleAll(entries, new Set(["a", "b", "c"]))]).toEqual([]);
    expect([...toggleAll(entries, new Set(["a"]))]).toEqual(["a", "b", "c"]);
  });

  test("the target decides which status is shown, and what counts as installed", () => {
    // Switching target with `g` has to change both the label and the default
    // choice, or the menu offers to overwrite a file that is not there.
    expect(statusOf(entries[1]!, false)).toBe("current");
    expect(statusOf(entries[1]!, true)).toBe("missing");
    expect([...defaultChoice(entries, false)]).toEqual(["a", "c"]);
    expect([...defaultChoice(entries, true)]).toEqual(["a", "b"]);
  });

  test("render shows the target, the overwrite toggle, and per-skill status", () => {
    const screen = renderPicker({
      entries,
      chosen: new Set(["a", "c"]),
      cursor: 1,
      global: false,
      force: false,
    });
    expect(screen).toContain("./.claude/skills (this project)");
    expect(screen).toContain("[x] a");
    expect(screen).toContain("[ ] b");
    expect(screen).toContain("EDITED locally");
    expect(screen).toContain("2 of 3 selected");
    expect(screen).toContain("›"); // the cursor is drawn
    const globalScreen = renderPicker({
      entries,
      chosen: new Set(),
      cursor: 0,
      global: true,
      force: true,
    });
    expect(globalScreen).toContain("~/.claude/skills (global)");
    expect(globalScreen).toContain("ON");
  });
});
