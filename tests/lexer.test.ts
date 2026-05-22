import { test, expect, describe } from "bun:test";
import { tokenize, classify } from "../src/lexer";

describe("tokenize — top-level pipe splitting", () => {
  test("simple shell pipeline", () => {
    expect(tokenize("ls | grep foo | head 5")).toEqual([
      { kind: "stage", text: "ls" },
      { kind: "stage", text: "grep foo" },
      { kind: "stage", text: "head 5" },
    ]);
  });

  test("pipes inside parens stay together", () => {
    expect(tokenize("(x => x | 2) | head")).toEqual([
      { kind: "stage", text: "(x => x | 2)" },
      { kind: "stage", text: "head" },
    ]);
  });

  test("pipes inside double quotes stay together", () => {
    expect(tokenize('echo "a | b" | wc -l')).toEqual([
      { kind: "stage", text: 'echo "a | b"' },
      { kind: "stage", text: "wc -l" },
    ]);
  });

  test("pipes inside single quotes stay together", () => {
    expect(tokenize("echo 'a | b' | wc -l")).toEqual([
      { kind: "stage", text: "echo 'a | b'" },
      { kind: "stage", text: "wc -l" },
    ]);
  });

  test("trims whitespace from each stage", () => {
    expect(tokenize("  ls   |   grep foo  ")).toEqual([
      { kind: "stage", text: "ls" },
      { kind: "stage", text: "grep foo" },
    ]);
  });

  test("single-stage line", () => {
    expect(tokenize("git status")).toEqual([{ kind: "stage", text: "git status" }]);
  });
});

describe("classify — stage kind dispatch", () => {
  test("glob source", () => {
    expect(classify("**/*.ts").kind).toBe("glob");
    expect(classify("src/*.ts").kind).toBe("glob");
    expect(classify("file[abc].txt").kind).toBe("glob");
  });

  test("range source", () => {
    const c = classify("range(0, 9)");
    expect(c.kind).toBe("range");
    if (c.kind === "range") {
      expect(c.start).toBe(0);
      expect(c.end).toBe(9);
    }
  });

  test("TS lambda", () => {
    expect(classify("(x => x * 2)").kind).toBe("lambda");
    expect(classify("(async x => await fetch(x))").kind).toBe("lambda");
  });

  test("HTTP verb", () => {
    const c = classify("POST https://example.com/users");
    expect(c.kind).toBe("http");
    if (c.kind === "http") {
      expect(c.verb).toBe("POST");
      expect(c.url).toBe("https://example.com/users");
    }
  });

  test("HTTP verb with shorthand URL", () => {
    const c = classify("GET :3000/health");
    expect(c.kind).toBe("http");
    if (c.kind === "http") {
      expect(c.verb).toBe("GET");
    }
  });

  test("falls back to shell command", () => {
    expect(classify("git status").kind).toBe("shell");
    expect(classify("ls -la").kind).toBe("shell");
  });

  test("quoted glob characters are not a glob", () => {
    expect(classify('"*.txt"').kind).toBe("shell");
  });
});
