import { describe, expect, test } from "bun:test";
import { classify, tokenize } from "../src/lexer";

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

  test("tail <path> classifies as a tail source", () => {
    const c = classify("tail app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.paths).toEqual(["app.log"]);
      expect(c.lines).toBe(10);
      expect(c.follow).toBe(false);
    }
  });

  test("tail -F <path> turns on follow", () => {
    const c = classify("tail -F app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.follow).toBe(true);
      expect(c.paths).toEqual(["app.log"]);
    }
  });

  test("tail -f <path> turns on follow", () => {
    const c = classify("tail -f app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.follow).toBe(true);
    }
  });

  test("tail -n N <path> parses the line count", () => {
    const c = classify("tail -n 50 app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.lines).toBe(50);
    }
  });

  test("tail --lines=N <path> parses the line count", () => {
    const c = classify("tail --lines=200 app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.lines).toBe(200);
    }
  });

  test("tail accepts multiple paths", () => {
    const c = classify("tail a.log b.log c.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.paths).toEqual(["a.log", "b.log", "c.log"]);
    }
  });

  test("tail preserves glob patterns in paths (expanded by the source)", () => {
    const c = classify("tail logs/*.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.paths).toEqual(["logs/*.log"]);
    }
  });

  test("tail -f a.log b.log = follow + multiple paths", () => {
    const c = classify("tail -f a.log b.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.follow).toBe(true);
      expect(c.paths).toEqual(["a.log", "b.log"]);
    }
  });

  test("tail -F -n 0 <path> = follow only, no initial cut", () => {
    const c = classify("tail -F -n 0 app.log");
    expect(c.kind).toBe("tail");
    if (c.kind === "tail") {
      expect(c.follow).toBe(true);
      expect(c.lines).toBe(0);
    }
  });

  test("unrecognized tail flag falls back to shell", () => {
    expect(classify("tail -c 200 app.log").kind).toBe("shell");
  });

  test("bare tail (no path) falls back to shell", () => {
    expect(classify("tail").kind).toBe("shell");
    expect(classify("tail --help").kind).toBe("shell");
  });
});
