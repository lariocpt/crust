// The `lines` stage — the answer to `read` yielding whole-file items.
//
// `read f.txt` and `lines f.txt` print identically on a terminal, which is
// exactly what made the difference invisible: `read f | filter (l => …)` hands
// the predicate the ENTIRE file as one string, so it matches when any line
// matches. `grep` hid this by splitting internally. These tests pin both the
// distinction and the fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/lexer";
import { parse } from "../src/parser";
import { readLines } from "../src/sources";
import type { Context } from "../src/types";

const ctx = () => ({ aliases: new Map(), functions: new Map(), history: [] }) as unknown as Context;
const drain = async (line: string): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const item of parse(line)(ctx()).lines()) out.push(item);
  return out;
};

let dir: string;
let cwd: string;

beforeAll(async () => {
  cwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "crust-lines-"));
  process.chdir(dir);
  await writeFile(join(dir, "a.txt"), "alpha\nbravo\ncharlie\n");
  await writeFile(join(dir, "b.txt"), "delta\n");
  await writeFile(join(dir, "nonl.txt"), "one\ntwo");
});
afterAll(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("classify", () => {
  test("`lines <glob>` is a source, bare `lines` is a transform", () => {
    expect(classify("lines **/*.log")).toEqual({ kind: "lines", pattern: "**/*.log" });
    expect(classify("lines")).toEqual({ kind: "lines", pattern: null });
  });

  test("`read` keeps its whole-file meaning", () => {
    expect(classify("read fixtures/*.json")).toEqual({
      kind: "readsrc",
      pattern: "fixtures/*.json",
    });
  });
});

describe("lines as a source", () => {
  test("yields one item per line, where read yields one per file", async () => {
    expect(await drain("lines a.txt")).toEqual(["alpha", "bravo", "charlie"]);
    expect(await drain("read a.txt")).toEqual(["alpha\nbravo\ncharlie\n"]);
  });

  test("a downstream predicate sees LINES — the whole point", async () => {
    expect(await drain("lines a.txt | filter (l => l.includes('bravo'))")).toEqual(["bravo"]);
    // Contrast: read hands the filter the entire file, so everything passes.
    expect(await drain("read a.txt | filter (l => l.includes('bravo'))")).toEqual([
      "alpha\nbravo\ncharlie\n",
    ]);
  });

  test("drops the trailing empty line, and handles a file without a final newline", async () => {
    expect(await drain("lines a.txt")).toHaveLength(3);
    expect(await drain("lines nonl.txt")).toEqual(["one", "two"]);
  });

  test("globs are sorted, so a run is reproducible", async () => {
    expect(await drain("lines [ab].txt")).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  test("no match is a hard error, matching read", async () => {
    expect(drain("lines nomatch*.zzz")).rejects.toThrow(/lines: no files matched/);
  });

  test("the TS source is usable directly", async () => {
    expect(await readLines("a.txt").collect()).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("lines as a transform", () => {
  test("splits whole-file items from read", async () => {
    expect(await drain("read a.txt | lines")).toEqual(["alpha", "bravo", "charlie"]);
    expect(await drain("read a.txt | lines | filter (l => l.includes('bravo'))")).toEqual([
      "bravo",
    ]);
  });

  test("splits across multiple upstream items", async () => {
    expect(await drain("read [ab].txt | lines")).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  test("a single-line item passes through unchanged", async () => {
    expect(await drain("range(1,3) | lines")).toEqual(["1", "2", "3"]);
  });
});

describe("errors name the right fix", () => {
  test("bare `lines` as a source says what it needs", async () => {
    expect(drain("lines")).rejects.toThrow(/needs a file pattern as a source/);
  });

  test("a pattern mid-pipeline points at the bare form", async () => {
    expect(drain("range(1,2) | lines foo.txt")).rejects.toThrow(/use bare `lines`/);
  });
});
