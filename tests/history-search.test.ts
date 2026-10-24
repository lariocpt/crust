// The pure Ctrl-R search core (G09 unit A).
//
// `searchHistory` is the reverse-incremental matcher behind the editor's
// 0x12 search mode: substring, case-insensitive, most-recent-first, with
// `skip` stepping further back for successive Ctrl-R presses. Keeping it out
// of `src/editor.ts` is what makes it testable — the editor (G09 unit B) owns
// repaint, cursor, and I/O; this function never mutates history and never
// touches the disk.
//
// Pinned semantics: empty query matches every entry; duplicates are stepped
// one by one (no dedupe — `appendHistory` already drops consecutive dups, so
// a repeated command is stored once per stretch); `skip` past the last match
// (or negative) yields null, which the editor renders as "no match" and
// inserts the typed query on Enter (zsh semantics, gap guardrail).
import { describe, expect, test } from "bun:test";
import { appendHistory, searchHistory } from "../src/history";

describe("searchHistory — ordering", () => {
  const history = ["git status", "ls -la", "git push origin main", "ls /tmp"];

  test("skip 0 is the newest match", () => {
    expect(searchHistory(history, "git", 0)).toBe("git push origin main");
    expect(searchHistory(history, "ls", 0)).toBe("ls /tmp");
  });

  test("skip steps further back, oldest last", () => {
    expect(searchHistory(history, "git", 1)).toBe("git status");
    expect(searchHistory(history, "ls", 1)).toBe("ls -la");
  });

  test("skip past the last match is null", () => {
    expect(searchHistory(history, "git", 2)).toBeNull();
    expect(searchHistory(history, "ls", 2)).toBeNull();
    expect(searchHistory(history, "ls", 99)).toBeNull();
  });

  test("negative skip matches nothing", () => {
    expect(searchHistory(history, "git", -1)).toBeNull();
  });
});

describe("searchHistory — matching", () => {
  test("substring, not prefix or whole word", () => {
    expect(searchHistory(["echo hi", "push it"], "sh", 0)).toBe("push it");
    expect(searchHistory(["echo hi", "push it"], "sh", 1)).toBeNull();
  });

  test("case-insensitive on both sides", () => {
    const history = ["GIT STATUS", "git push"];
    expect(searchHistory(history, "git", 0)).toBe("git push");
    expect(searchHistory(history, "git", 1)).toBe("GIT STATUS");
    expect(searchHistory(history, "GIT", 0)).toBe("git push");
    expect(searchHistory(history, "Git", 1)).toBe("GIT STATUS");
  });

  test("spaces match literally", () => {
    expect(searchHistory(["abc", "de f"], " ", 0)).toBe("de f");
    expect(searchHistory(["abc", "de f"], " ", 1)).toBeNull();
  });
});

describe("searchHistory — empty query", () => {
  test("empty query matches every entry, newest first", () => {
    const history = ["a", "b", "c"];
    expect(searchHistory(history, "", 0)).toBe("c");
    expect(searchHistory(history, "", 1)).toBe("b");
    expect(searchHistory(history, "", 2)).toBe("a");
    expect(searchHistory(history, "", 3)).toBeNull();
  });
});

describe("searchHistory — no match and empty history", () => {
  test("query matching nothing is null", () => {
    expect(searchHistory(["echo a", "echo b"], "zeta", 0)).toBeNull();
  });

  test("empty history is null for any query", () => {
    expect(searchHistory([], "git", 0)).toBeNull();
    expect(searchHistory([], "", 0)).toBeNull();
  });
});

describe("searchHistory — duplicates", () => {
  test("repeated entries are stepped one by one, no dedupe", () => {
    const history = ["a", "b", "a"];
    expect(searchHistory(history, "a", 0)).toBe("a");
    expect(searchHistory(history, "a", 1)).toBe("a");
    expect(searchHistory(history, "a", 2)).toBeNull();
  });
});

describe("appendHistory — consecutive-duplicate rule (verify, don't change)", () => {
  test("a line equal to the newest entry is not appended", async () => {
    const history = ["ls"];
    await appendHistory("ls", history);
    expect(history).toEqual(["ls"]);
  });

  test("a whitespace-only line is not appended", async () => {
    const history = ["ls"];
    await appendHistory("   ", history);
    expect(history).toEqual(["ls"]);
  });
});
