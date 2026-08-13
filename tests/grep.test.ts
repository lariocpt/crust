import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/lexer";
import { parse } from "../src/parser";
import { grepStage } from "../src/transforms";
import type { Context } from "../src/types";

function ctx(): Context {
  return { aliases: new Map(), functions: new Map(), history: [] } as never;
}

async function drain(line: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of parse(line)(ctx()).lines()) out.push(item);
  return out;
}

describe("classifyGrep — native subset vs shell fallback", () => {
  const native = (t: string) => {
    const k = classify(t);
    expect(k.kind).toBe("grep");
    return k as Extract<ReturnType<typeof classify>, { kind: "grep" }>;
  };
  const shell = (t: string) => expect(classify(t).kind).toBe("shell");

  test("plain pattern goes native, raw preserved", () => {
    const k = native("grep ERROR");
    expect(k).toEqual({
      kind: "grep",
      raw: "grep ERROR",
      pattern: "ERROR",
      ignoreCase: false,
      invert: false,
      fixed: false,
    });
  });

  test("supported flags parse; -E is a no-op", () => {
    expect(native("grep -i error")).toMatchObject({ ignoreCase: true });
    expect(native("grep -v DEBUG")).toMatchObject({ invert: true });
    expect(native("grep -F a.b")).toMatchObject({ fixed: true });
    expect(native('grep -E "A|B"')).toMatchObject({ pattern: "A|B", fixed: false });
    expect(native("grep -i -v warn")).toMatchObject({ ignoreCase: true, invert: true });
  });

  test("quoted patterns keep spaces and strip quotes", () => {
    expect(native('grep "not found"')).toMatchObject({ pattern: "not found" });
    expect(native("grep 'exact phrase'")).toMatchObject({ pattern: "exact phrase" });
  });

  test("everything outside the subset falls back to shell", () => {
    shell("grep"); // bare → system grep (--help etc.)
    shell("grep -iv error"); // combined flags
    shell("grep -c ERROR"); // unknown flag
    shell("grep --color ERROR"); // long flag
    shell("grep -e ERROR"); // unsupported -e
    shell("grep ERROR app.log"); // two positionals = file grep
    shell("grep $PATTERN"); // env expansion is sh's job
    shell('grep -i "$LEVEL"'); // dollar anywhere in stage
    shell("grep 'a\\.b'"); // backslash → BRE/ERE escape semantics
    shell("grep '[[:digit:]]'"); // POSIX class
    shell("grep -F -E x"); // conflicting flags → let grep error
    shell("grep '*.log'"); // JS-invalid regex (nothing to repeat)
    shell("grep '(unclosed'"); // JS-invalid regex
  });
});

describe("grepStage — matcher semantics", () => {
  async function run(
    opts: { pattern: string; ignoreCase?: boolean; invert?: boolean; fixed?: boolean },
    items: unknown[],
  ): Promise<string[]> {
    const stage = grepStage({
      pattern: opts.pattern,
      ignoreCase: opts.ignoreCase ?? false,
      invert: opts.invert ?? false,
      fixed: opts.fixed ?? false,
    });
    const out: string[] = [];
    for await (const line of stage((await import("../src/pipeline")).Pipeline.of(items)).lines()) {
      out.push(line);
    }
    return out;
  }

  test("regex match, case sensitivity, invert", async () => {
    const lines = ["ERROR boom", "warn slow", "error again", "ok"];
    expect(await run({ pattern: "ERROR" }, lines)).toEqual(["ERROR boom"]);
    expect(await run({ pattern: "error", ignoreCase: true }, lines)).toEqual([
      "ERROR boom",
      "error again",
    ]);
    expect(await run({ pattern: "err", invert: true, ignoreCase: true }, lines)).toEqual([
      "warn slow",
      "ok",
    ]);
  });

  test("-F is literal: dots and pipes do not regex", async () => {
    const lines = ["a.b", "axb", "A|B", "A"];
    expect(await run({ pattern: "a.b", fixed: true }, lines)).toEqual(["a.b"]);
    expect(await run({ pattern: "A|B", fixed: true }, lines)).toEqual(["A|B"]);
    expect(await run({ pattern: "a.b" }, lines)).toEqual(["a.b", "axb"]);
  });

  test("ERE alternation and anchors work natively", async () => {
    const lines = ["alpha", "beta", "gamma"];
    expect(await run({ pattern: "alpha|gamma" }, lines)).toEqual(["alpha", "gamma"]);
    expect(await run({ pattern: "^b" }, lines)).toEqual(["beta"]);
  });

  test("objects are matched on their formatItem JSON and yielded as strings", async () => {
    const items = [{ level: "error", msg: "boom" }, { level: "info" }, "plain error line"];
    const got = await run({ pattern: '"level":"error"' }, items);
    expect(got).toEqual(['{"level":"error","msg":"boom"}']);
    expect(await run({ pattern: "error" }, items)).toEqual([
      '{"level":"error","msg":"boom"}',
      "plain error line",
    ]);
  });

  test("no sticky state across lines (no g flag)", async () => {
    const lines = ["abab", "abab", "abab"];
    expect(await run({ pattern: "ab" }, lines)).toEqual(lines);
  });
});

describe("grep e2e in pipelines", () => {
  test("range | lambda | grep filters formatted items", async () => {
    const got = await drain("range(1, 20) | (n => `item-${n}`) | grep 'item-1[0-9]'");
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => `item-1${i}`));
  });

  test("source-position grep stays a shell file-grep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-grep-"));
    try {
      const log = join(dir, "app.log");
      await Bun.write(log, "one ERROR here\nfine\nanother ERROR\n");
      // Two positionals → shell path → system grep reads the FILE.
      const got = await drain(`grep ERROR ${log}`);
      expect(got).toEqual(["one ERROR here", "another ERROR"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("follow liveness: tail -F | grep sees an appended match promptly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-grep-live-"));
    try {
      const log = join(dir, "live.log");
      await Bun.write(log, "seed noise\n");
      const pipeline = parse(`tail -n 0 -F ${log} | grep ERROR`)(ctx());
      const iter = pipeline.lines()[Symbol.asyncIterator]();
      const first = iter.next();
      // Append AFTER the follow starts; a block-buffered sh grep would sit on
      // this line for ~4KB worth of quiet — the native stage must not.
      await Bun.sleep(150);
      const fd = Bun.file(log);
      await Bun.write(log, `${await fd.text()}plain line\nERROR live hit\n`);
      const winner = await Promise.race([
        first.then((r) => r.value as string),
        Bun.sleep(1000).then(() => "TIMEOUT"),
      ]);
      expect(winner).toBe("ERROR live hit");
      await iter.return?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("grep — review fixes", () => {
  test("multi-line items are matched and yielded PER LINE (read | grep parity)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crust-grep-ml-"));
    try {
      const log = join(dir, "app.log");
      await Bun.write(log, "line one ok\nline two ERROR boom\nline three ok\nline four ok\n");
      expect(await drain(`read ${log} | grep ERROR`)).toEqual(["line two ERROR boom"]);
      expect(await drain(`read ${log} | grep -v ERROR`)).toEqual([
        "line one ok",
        "line three ok",
        "line four ok",
        "", // the sh path's child also saw a trailing blank line
      ]);
      const counted = await drain(`read ${dir}/*.log | grep ERROR | wc -l`);
      expect(counted).toEqual(["1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GNU-vs-JS dialect edges fall back to shell", () => {
    expect(classify("grep -E 'ab{,5}c'").kind).toBe("shell"); // GNU open interval
    expect(classify("grep 'ERROR(?=:)'").kind).toBe("shell"); // JS-only lookahead
    expect(classify("grep -F '{,'").kind).toBe("grep"); // -F is literal — guards don't apply
  });
});
