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

describe("capture classification", () => {
  test("capture with lambda", () => {
    expect(classify("capture ID (r => r.id)")).toEqual({
      kind: "capture",
      name: "ID",
      source: "(r => r.id)",
    });
  });

  test("capture without lambda captures the item itself", () => {
    expect(classify("capture RAW")).toEqual({ kind: "capture", name: "RAW", source: null });
  });

  test("invalid env name falls through to shell", () => {
    expect(classify("capture 9x (r => r)").kind).toBe("shell");
  });
});

describe("filter classification", () => {
  test("filter with lambda", () => {
    expect(classify("filter (l => l.ok)")).toEqual({
      kind: "filter",
      source: "(l => l.ok)",
    });
  });

  test("pipe inside the lambda stays one stage", () => {
    const tokens = tokenize('range(0,3) | filter (l => l.includes("|") || l.ok)');
    expect(tokens.length).toBe(2);
    expect(classify(tokens[1]!.text).kind).toBe("filter");
  });

  test("bare filter and filter-with-flags fall through to shell", () => {
    expect(classify("filter").kind).toBe("shell");
    expect(classify("filter --help").kind).toBe("shell");
    expect(classify("filter -v foo").kind).toBe("shell");
  });
});

describe("expect classification", () => {
  test("exact three-digit code", () => {
    expect(classify("expect 404")).toEqual({ kind: "expect", matcher: 404 });
  });

  test("class shorthand", () => {
    expect(classify("expect 2xx")).toEqual({ kind: "expect", matcher: "2xx" });
    expect(classify("expect 5xx")).toEqual({ kind: "expect", matcher: "5xx" });
  });

  test("malformed matchers fall through to shell", () => {
    expect(classify("expect 20x").kind).toBe("shell");
    expect(classify("expect 6xx").kind).toBe("shell");
    expect(classify("expect ok").kind).toBe("shell");
  });
});

describe("load classification", () => {
  test("single phase", () => {
    expect(classify("load 30s 100/s")).toEqual({
      kind: "load",
      phases: [{ durMs: 30000, rps: 100 }],
    });
  });

  test("ms durations, per-minute and decimal rates", () => {
    expect(classify("load 200ms 50/s")).toEqual({
      kind: "load",
      phases: [{ durMs: 200, rps: 50 }],
    });
    expect(classify("load 1m 30/m")).toEqual({
      kind: "load",
      phases: [{ durMs: 60000, rps: 0.5 }],
    });
    expect(classify("load 2s 0.5/s")).toEqual({
      kind: "load",
      phases: [{ durMs: 2000, rps: 0.5 }],
    });
  });

  test("ramp phases", () => {
    expect(classify("load 100ms 20/s, 100ms 60/s")).toEqual({
      kind: "load",
      phases: [
        { durMs: 100, rps: 20 },
        { durMs: 100, rps: 60 },
      ],
    });
  });

  test("malformed spec throws with usage", () => {
    expect(() => classify("load 30 100")).toThrow("load: expected");
    expect(() => classify("load fast")).toThrow("load: expected");
    expect(() => classify("load 10s 50/s, nope")).toThrow("load: expected");
  });

  test("bare load falls through to shell", () => {
    expect(classify("load").kind).toBe("shell");
  });
});

describe("stats flags", () => {
  test("--every forms still classify", () => {
    expect(classify("stats --every 5s")).toEqual({ kind: "stats", everySec: 5, out: undefined });
    expect(classify("stats --every=2")).toEqual({ kind: "stats", everySec: 2, out: undefined });
    expect(classify("stats")).toEqual({ kind: "stats", everySec: undefined, out: undefined });
  });

  test("--out alone and combined with --every", () => {
    expect(classify("stats --out results.json")).toEqual({
      kind: "stats",
      everySec: undefined,
      out: "results.json",
    });
    expect(classify("stats --every 2 --out r.json")).toEqual({
      kind: "stats",
      everySec: 2,
      out: "r.json",
    });
  });

  test("unknown flag falls through to shell", () => {
    expect(classify("stats --bogus").kind).toBe("shell");
    expect(classify("stats --out").kind).toBe("shell");
  });
});

describe("review fixes — grammar", () => {
  test("backslash-escaped quotes inside double quotes stay one stage", () => {
    const tokens = tokenize('{"size":"6\\" nominal"} | POST :3000/x');
    expect(tokens).toHaveLength(2);
    expect(classify(tokens[0]!.text).kind).toBe("json");
  });

  test("parallel 0 is a loud error, not a hang", () => {
    expect(() => classify("parallel 0")).toThrow("parallel: N must be >= 1");
  });
});

describe("http --timeout", () => {
  test("--timeout duration forms", () => {
    expect(classify("GET :3000/x --timeout 5s")).toEqual({
      kind: "http",
      verb: "GET",
      url: ":3000/x",
      headers: [],
      timeoutMs: 5000,
    });
    expect(classify('POST :3000/x -H "a: b" --timeout=250ms').timeoutMs).toBe(250);
    expect(classify("GET :3000/x --timeout 2m").timeoutMs).toBe(120_000);
  });

  test("malformed duration and unknown --flags throw", () => {
    expect(() => classify("GET :3000/x --timeout fast")).toThrow("bad duration");
    expect(() => classify("GET :3000/x --timeout")).toThrow("--timeout requires a duration");
    expect(() => classify("GET :3000/x --retry 3")).toThrow('http: unknown flag "--retry"');
  });

  test("bare non-flag tokens after the URL stay ignored (back-compat)", () => {
    const k = classify("GET :3000/x extra junk");
    expect(k.kind).toBe("http");
    expect((k as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });
});
