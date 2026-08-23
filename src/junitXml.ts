// One serializer owns JUnit the way one parser owns every CLI (AGENTS.md
// rule 2): both test runners map their reports into this neutral model, so
// XML escaping and the element set live in exactly one place. The dialect is
// the surefire/jenkins common subset — testsuites/testsuite/testcase/
// failure/error/system-out — which every CI parser reads. No timestamp
// attribute: the reports record no start time, and inventing one at render
// time would misreport when the run happened.

export interface JUnitCase {
  name: string;
  classname: string;
  timeMs: number;
  failure?: { message: string; body: string };
  error?: { message: string; body: string };
}

export interface JUnitSuite {
  name: string;
  cases: JUnitCase[];
  systemOut?: string;
}

// XML 1.0 forbids most control characters entirely — they cannot be escaped,
// only removed. Failure bodies carry arbitrary user JSON and stack traces, so
// stripping them is load-bearing: one raw 0x1b and the whole report is
// unparseable to the CI that gates on it.
function esc(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them IS the point — XML 1.0 cannot represent these characters at all
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function renderJUnit(suites: JUnitSuite[], rootName = "crust"): string {
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let totalMs = 0;
  for (const s of suites) {
    for (const c of s.cases) {
      tests++;
      if (c.failure) failures++;
      if (c.error) errors++;
      totalMs += c.timeMs;
    }
  }
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(
    `<testsuites name="${esc(rootName)}" tests="${tests}" failures="${failures}" errors="${errors}" time="${sec(totalMs)}">`,
  );
  for (const s of suites) {
    let sFail = 0;
    let sErr = 0;
    let sMs = 0;
    for (const c of s.cases) {
      if (c.failure) sFail++;
      if (c.error) sErr++;
      sMs += c.timeMs;
    }
    out.push(
      `  <testsuite name="${esc(s.name)}" tests="${s.cases.length}" failures="${sFail}" errors="${sErr}" time="${sec(sMs)}">`,
    );
    for (const c of s.cases) {
      const open = `    <testcase name="${esc(c.name)}" classname="${esc(c.classname)}" time="${sec(c.timeMs)}"`;
      if (!c.failure && !c.error) {
        out.push(`${open} />`);
        continue;
      }
      out.push(`${open}>`);
      if (c.failure) {
        out.push(
          `      <failure message="${esc(c.failure.message)}">${esc(c.failure.body)}</failure>`,
        );
      }
      if (c.error) {
        out.push(`      <error message="${esc(c.error.message)}">${esc(c.error.body)}</error>`);
      }
      out.push("    </testcase>");
    }
    if (s.systemOut !== undefined) {
      out.push(`    <system-out>${esc(s.systemOut)}</system-out>`);
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return `${out.join("\n")}\n`;
}
