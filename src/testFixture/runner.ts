import { diffAsync, expandTarget as expandTargetShared } from "../fixtures";
import { validateSchema } from "../mockServer/validateRequest";
import type { Fixture, FixtureResult, RunOpts, RunReport, StressBucket } from "./types";

export async function runFixtures(opts: RunOpts): Promise<RunReport> {
  const threads = Math.max(1, Math.floor(opts.threads || 1));
  if (opts.threads < 1) {
    process.stderr.write(`test-fixture: --threads ${opts.threads} clamped to 1\n`);
  }
  const count = Math.max(1, Math.floor(opts.count ?? 1));
  if ((opts.count ?? 1) < 1) {
    process.stderr.write(`test-fixture: --count ${opts.count} clamped to 1\n`);
  }
  const files = await expandTarget(opts.target);
  const tasks: Array<() => Promise<FixtureResult>> = [];

  for (const file of files) {
    let mod: { default?: unknown };
    try {
      mod = await import(file);
    } catch (err) {
      const e = err as Error;
      tasks.push(async () => ({
        file,
        name: file,
        status: "error",
        durationMs: 0,
        failures: [],
        error: { message: `import failed: ${e.message}`, stack: e.stack },
      }));
      continue;
    }
    let raw = mod.default;
    if (typeof raw === "function") {
      try {
        raw = await (raw as () => unknown)();
      } catch (err) {
        const e = err as Error;
        tasks.push(async () => ({
          file,
          name: file,
          status: "error",
          durationMs: 0,
          failures: [],
          error: { message: `default function threw: ${e.message}`, stack: e.stack },
        }));
        continue;
      }
    }
    if (raw === undefined || raw === null) {
      tasks.push(async () => ({
        file,
        name: file,
        status: "error",
        durationMs: 0,
        failures: [],
        error: { message: "fixture has no default export" },
      }));
      continue;
    }
    const fxs = Array.isArray(raw) ? (raw as Fixture[]) : [raw as Fixture];
    fxs.forEach((fx, i) => {
      for (let iter = 1; iter <= count; iter++) {
        const iterArg = count > 1 ? iter : undefined;
        tasks.push(() => runOne(file, fx, i, iterArg, opts.timeoutMs));
      }
    });
  }

  // Pre-sized so settled results keep task order; under --bail the tail slots
  // stay holes and are dropped by the filter below — totals must never walk
  // undefined entries.
  const slots: FixtureResult[] = new Array(tasks.length);
  const inFlight = new Set<Promise<void>>();
  let bailed = false;
  for (let i = 0; i < tasks.length; i++) {
    while (inFlight.size >= threads) await Promise.race(inFlight);
    // A task that settled while we waited may have tripped bail; stop
    // starting new work but let anything already in flight finish.
    if (bailed) break;
    const idx = i;
    let t!: Promise<void>;
    t = (async () => {
      const r = await tasks[idx]!();
      slots[idx] = r;
      if (opts.bail && r.status !== "pass") bailed = true;
    })().finally(() => {
      inFlight.delete(t);
    });
    inFlight.add(t);
  }
  await Promise.all(inFlight);
  const results = slots.filter((r): r is FixtureResult => r !== undefined);

  const totals = { pass: 0, fail: 0, error: 0, ms: 0 };
  for (const r of results) {
    totals[r.status]++;
    totals.ms += r.durationMs;
  }
  const report: RunReport = { results, totals };
  if (bailed) {
    report.bailed = true;
    report.scheduled = tasks.length;
  }
  if (count > 1) report.stress = buildStressBuckets(results);
  return report;
}

function buildStressBuckets(results: FixtureResult[]): StressBucket[] {
  const groups = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const key = `${r.file}::${r.name.replace(/#\d+$/, "")}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: StressBucket[] = [];
  for (const [key, runs] of groups) {
    const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b);
    const statusCodes: Record<string, number> = {};
    let pass = 0;
    let fail = 0;
    let errCount = 0;
    let sum = 0;
    for (const r of runs) {
      sum += r.durationMs;
      if (r.status === "pass") pass++;
      else if (r.status === "fail") fail++;
      else errCount++;
      const code = r.responseStatus != null ? String(r.responseStatus) : "n/a";
      statusCodes[code] = (statusCodes[code] ?? 0) + 1;
    }
    out.push({
      fixture: key,
      count: runs.length,
      pass,
      fail,
      error: errCount,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      minMs: durations[0] ?? 0,
      maxMs: durations[durations.length - 1] ?? 0,
      meanMs: sum / runs.length,
      statusCodes,
    });
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export async function expandTarget(target: string): Promise<string[]> {
  try {
    return await expandTargetShared(target);
  } catch (err) {
    const e = err as Error;
    if (e.message.includes("not a .crust.ts file")) {
      throw new Error(`test-fixture: ${e.message}`);
    }
    throw err;
  }
}

async function runOne(
  file: string,
  fx: Fixture,
  idx: number,
  iter?: number,
  timeoutMs?: number,
): Promise<FixtureResult> {
  const baseName = fx.name ?? `${file}#${idx}`;
  const name = iter != null ? `${baseName} #${iter}` : baseName;
  const start = performance.now();
  let setupCtx: unknown;
  let teardownErr: Error | null = null;
  let responseStatus: number | undefined;
  try {
    if (fx.setup) setupCtx = await fx.setup();
    // input/output may be functions of the setup context — the only way a
    // fixture can put a setup-created credential or id into the request.
    const rawInput = typeof fx.input === "function" ? await fx.input(setupCtx as never) : fx.input;
    // Resolve a whole-output FUNCTION of any arity here (a 0-arg one ignores
    // the ctx argument) so the schema extraction below sees the resolved
    // object — otherwise a 0-arg output factory returning {schema} would
    // smuggle the schema past extraction into the structural walk.
    let rawOutput =
      typeof fx.output === "function"
        ? await (fx.output as (c?: unknown) => unknown)(setupCtx)
        : fx.output;
    // `schema` is a RESERVED output key: a JSON Schema the response body must
    // conform to. Extracted BEFORE resolveDeep — a schema object may carry
    // keys like `default` whose function values must never be invoked. A
    // 0-arg FUNCTION as the schema value is the lazy-field form and is
    // resolved (its returned object's nested functions stay uninvoked).
    let responseSchema: unknown;
    if (rawOutput && typeof rawOutput === "object" && "schema" in rawOutput) {
      const { schema, ...rest } = rawOutput as Record<string, unknown>;
      responseSchema =
        typeof schema === "function" && schema.length === 0
          ? await (schema as () => unknown)()
          : schema;
      rawOutput = rest as typeof rawOutput;
      assertNoRefs(responseSchema);
    }
    assertKnownOutputKeys(rawOutput);
    const input = (await resolveDeep(rawInput, setupCtx, true)) as Record<string, unknown>;
    const expected = (await resolveDeep(rawOutput, setupCtx, false)) as Record<string, unknown>;
    const actual = await performRequest(input, timeoutMs);
    responseStatus = actual.status;
    const failures = await diffAsync("output", expected, actual, setupCtx);
    if (responseSchema !== undefined) {
      for (const v of validateSchema(actual.data, responseSchema, { paths: {} })) {
        failures.push({
          path: `output.data${v.pointer}`,
          expected: `${v.rule}: ${v.message}`,
          actual: v.received,
        });
      }
    }
    const r: FixtureResult = {
      file,
      name,
      status: failures.length ? "fail" : "pass",
      durationMs: performance.now() - start,
      failures,
      responseStatus,
    };
    if (iter != null) r.iter = iter;
    return r;
  } catch (err) {
    const e = err as Error;
    const r: FixtureResult = {
      file,
      name,
      status: "error",
      durationMs: performance.now() - start,
      failures: [],
      error: { message: e.message, stack: e.stack },
    };
    if (responseStatus != null) r.responseStatus = responseStatus;
    if (iter != null) r.iter = iter;
    return r;
  } finally {
    if (fx.teardown) {
      try {
        await fx.teardown(setupCtx);
      } catch (err) {
        teardownErr = err as Error;
      }
    }
    if (teardownErr) {
      process.stderr.write(`test-fixture: teardown of ${name} threw: ${teardownErr.message}\n`);
    }
  }
}

// callUnary distinguishes the two sides: in INPUT, a 1-arg function is a
// ctx-consumer and gets called with the setup context; in OUTPUT it is a
// matcher predicate and must be left alone for diffAsync (which calls it with
// (actual, ctx)). 0-arg functions resolve on both sides, as before.
async function resolveDeep(value: unknown, ctx: unknown, callUnary: boolean): Promise<unknown> {
  if (typeof value === "function") {
    if ((value as Function).length === 0) {
      return await (value as () => unknown)();
    }
    if (callUnary && (value as Function).length === 1) {
      return await (value as (c: unknown) => unknown)(ctx);
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await resolveDeep(v, ctx, callUnary));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = await resolveDeep(v, ctx, callUnary);
  }
  return out;
}

// performRequest returns exactly these; `schema` is the reserved key handled
// before this runs. An unknown key here is always a mistake, and it used to be
// a SILENT one: diffAsync walks Object.keys(expected) against actual[k], so a
// misspelled key resolved to undefined and any predicate that didn't
// dereference its argument returned truthy — `output: {dta: (d) => true}`
// reported a PASS. `input` takes `body` while `output` takes `data`, so this is
// an easy slip to make.
const KNOWN_OUTPUT_KEYS = ["data", "headers", "schema", "status"];

// A $ref in output.schema is an authoring error, not a soft pass: the runner
// validates against a stub spec (there is nothing to resolve refs against),
// so every $ref would resolve to nothing and the schema would validate
// SUCCESSFULLY — the author believes a shape is enforced when none is.
// Keys whose values are DATA rather than schema (enum members, examples,
// defaults) are skipped, so a payload that happens to contain a "$ref" field
// is never flagged.
const DATA_BEARING_KEYS = new Set(["enum", "const", "example", "examples", "default"]);

function assertNoRefs(schema: unknown, pointer = ""): void {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) assertNoRefs(schema[i], `${pointer}/${i}`);
    return;
  }
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$ref") {
      throw new Error(
        `output.schema contains a $ref (${pointer || "/"}) — inline it; fixture schemas resolve against no spec, so $refs would silently pass`,
      );
    }
    if (DATA_BEARING_KEYS.has(k)) continue;
    assertNoRefs(v, `${pointer}/${k}`);
  }
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = prev[j]!;
      prev[j] = next;
    }
  }
  return prev[b.length]!;
}

function assertKnownOutputKeys(rawOutput: unknown): void {
  if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return;
  for (const key of Object.keys(rawOutput as Record<string, unknown>)) {
    if (KNOWN_OUTPUT_KEYS.includes(key)) continue;
    // `body` is too far from `data` for edit distance to catch, yet it is the
    // single most likely slip: the REQUEST field is `input.body`, the RESPONSE
    // body is `output.data`.
    const hint =
      key === "body"
        ? ' — the response body is "data" ("body" is the request field)'
        : nearestKey(key);
    throw new Error(`output.${key}: unknown key${hint} (valid: ${KNOWN_OUTPUT_KEYS.join(", ")})`);
  }
}

function nearestKey(key: string): string {
  const near = KNOWN_OUTPUT_KEYS.map((k) => [k, editDistance(key, k)] as const)
    .filter(([, d]) => d <= 3)
    .sort((x, y) => x[1] - y[1])[0];
  return near ? ` — did you mean "${near[0]}"?` : "";
}

async function performRequest(
  input: Record<string, unknown>,
  timeoutMs?: number,
): Promise<{
  status: number;
  headers: Record<string, string>;
  data: unknown;
}> {
  const url = input.url;
  if (typeof url !== "string") throw new Error("fixture input.url must be a string");
  const init: RequestInit = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "url") continue;
    (init as Record<string, unknown>)[k] = v;
  }
  if (init.method === undefined) init.method = "GET";
  // A fixture's own `signal` (copied above) wins; --timeout only fills the gap.
  let timeoutSignal: AbortSignal | undefined;
  if (timeoutMs != null && init.signal == null) {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
    init.signal = timeoutSignal;
  }
  let r: Response;
  let text: string;
  try {
    r = await fetch(url, init);
    // Body read is covered too — a server that streams slowly must not
    // escape the deadline.
    text = await r.text();
  } catch (err) {
    // Bun's abort error message is generic ("The operation was aborted");
    // name the deadline so the fixture error is actionable.
    if (timeoutSignal?.aborted) {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let data: unknown;
  try {
    data = text === "" ? "" : JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, headers, data };
}
