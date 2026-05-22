import { describe, expect, test } from "bun:test";
import { parse } from "../src/parser";
import { Pipeline } from "../src/pipeline";
import { expect as expectStage, time } from "../src/transforms";

function captureWriter(): { write(s: string): void; output: string[] } {
  const output: string[] = [];
  return {
    output,
    write(s: string) {
      output.push(s);
    },
  };
}

describe("time — TS API", () => {
  test("passes items through unchanged", async () => {
    const sink = captureWriter();
    const p = Pipeline.of([1, 2, 3]).pipe(time<number>("data", sink));
    expect(await p.collect()).toEqual([1, 2, 3]);
  });

  test("emits one line on completion with label and item count", async () => {
    const sink = captureWriter();
    await Pipeline.of([1, 2, 3]).pipe(time<number>("warmup", sink)).collect();
    expect(sink.output).toHaveLength(1);
    expect(sink.output[0]).toMatch(/^\[time\] warmup: \d+(\.\d+)?ms \(3 items\)\n$/);
  });

  test("singular form for one item", async () => {
    const sink = captureWriter();
    await Pipeline.of([42]).pipe(time<number>("once", sink)).collect();
    expect(sink.output[0]).toMatch(/\(1 item\)/);
  });

  test("fires even when a downstream stage throws mid-pipeline", async () => {
    const sink = captureWriter();
    const p = Pipeline.of([1, 2, 3])
      .pipe(time<number>("guarded", sink))
      .pipe(expectStage<number>((x) => x < 2));
    await expect(p.collect()).rejects.toThrow();
    expect(sink.output).toHaveLength(1);
    expect(sink.output[0]).toMatch(/\[time\] guarded:/);
  });
});

describe("time — shell-line", () => {
  test('`time "label" | range(0, 3)` returns the same items as range alone', async () => {
    const p = parse('time "shell-form" | range(0, 3)')();
    expect(await p.collect()).toEqual([0, 1, 2, 3]);
  });

  test("`time` with no following pipeline throws a helpful error", () => {
    expect(() => parse('time "lonely"')()).toThrow(/must be followed by a pipeline/);
  });

  test("`time` is rejected as a non-first stage", () => {
    expect(() => parse('range(0, 3) | time "mid-pipeline"')()).toThrow(
      /only allowed as the first stage/,
    );
  });

  test("single-quoted label works", async () => {
    const p = parse("time 'sq' | range(0, 1)")();
    expect(await p.collect()).toEqual([0, 1]);
  });
});
