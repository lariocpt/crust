import { describe, expect, test } from "bun:test";
import { type JUnitSuite, renderJUnit } from "../src/junitXml";

describe("renderJUnit", () => {
  test("counts, times, and structure across suites", () => {
    const suites: JUnitSuite[] = [
      {
        name: "a.crust.ts",
        cases: [
          { name: "ok", classname: "a.crust.ts", timeMs: 1500 },
          {
            name: "bad",
            classname: "a.crust.ts",
            timeMs: 500,
            failure: { message: "status: expected 200, got 500", body: "line1\nline2" },
          },
        ],
      },
      {
        name: "b.crust.ts",
        cases: [
          {
            name: "boom",
            classname: "b.crust.ts",
            timeMs: 250,
            error: { message: "setup threw", body: "Error: setup threw\n  at x" },
          },
        ],
      },
    ];
    const xml = renderJUnit(suites, "test-fixture");
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n');
    expect(xml).toContain(
      '<testsuites name="test-fixture" tests="3" failures="1" errors="1" time="2.250">',
    );
    expect(xml).toContain(
      '<testsuite name="a.crust.ts" tests="2" failures="1" errors="0" time="2.000">',
    );
    expect(xml).toContain('<testcase name="ok" classname="a.crust.ts" time="1.500" />');
    expect(xml).toContain(
      '<failure message="status: expected 200, got 500">line1\nline2</failure>',
    );
    expect(xml).toContain(
      '<testsuite name="b.crust.ts" tests="1" failures="0" errors="1" time="0.250">',
    );
    expect(xml).toContain('<error message="setup threw">');
    expect(xml).toEndWith("</testsuites>\n");
  });

  test("escapes XML metacharacters in names, messages, and bodies", () => {
    const xml = renderJUnit([
      {
        name: 'we<ird & "name"',
        cases: [
          {
            name: "checks <a> & 'b'",
            classname: 'c "x"',
            timeMs: 1,
            failure: { message: 'expected {"a":"<1>"}', body: 'got {"a":"<2>"} & more' },
          },
        ],
      },
    ]);
    expect(xml).toContain('name="we&lt;ird &amp; &quot;name&quot;"');
    expect(xml).toContain('name="checks &lt;a&gt; &amp; &apos;b&apos;"');
    expect(xml).toContain('classname="c &quot;x&quot;"');
    expect(xml).toContain('message="expected {&quot;a&quot;:&quot;&lt;1&gt;&quot;}"');
    expect(xml).toContain("got {&quot;a&quot;:&quot;&lt;2&gt;&quot;} &amp; more");
    // No raw metacharacters may survive outside markup: strip the tags we
    // emitted and check the remainder.
    for (const line of xml.split("\n")) {
      const inner = line.replace(/<[^>]*>/g, "");
      expect(inner.includes("<")).toBe(false);
    }
  });

  test("strips XML-1.0-invalid control characters instead of emitting them", () => {
    const xml = renderJUnit([
      {
        name: "s",
        cases: [
          {
            name: "ctrl\u0000name",
            classname: "s",
            timeMs: 1,
            error: {
              message: "esc \u001b[31mred\u001b[0m",
              body: "bell\u0007 tab\tok\nline",
            },
          },
        ],
      },
    ]);
    expect(xml).toContain('name="ctrlname"');
    expect(xml).toContain('message="esc [31mred[0m"');
    // Tab and newline are legal XML and stay.
    expect(xml).toContain("bell tab\tok\nline");
    const hasInvalid = [...xml].some((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 && c !== 9 && c !== 10 && c !== 13;
    });
    expect(hasInvalid).toBe(false);
  });

  test("renders an empty run as a well-formed empty testsuites", () => {
    const xml = renderJUnit([]);
    expect(xml).toContain('tests="0" failures="0" errors="0" time="0.000"');
    expect(xml.trim().endsWith("</testsuites>")).toBe(true);
  });

  test("a suite's system-out is emitted once, escaped", () => {
    const xml = renderJUnit([
      {
        name: "s",
        cases: [{ name: "n", classname: "s", timeMs: 1 }],
        systemOut: "p95=1.5 [200:10] <raw>",
      },
    ]);
    expect(xml).toContain("<system-out>p95=1.5 [200:10] &lt;raw&gt;</system-out>");
  });
});
