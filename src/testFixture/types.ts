// Matcher predicates receive the actual value and (since 0.2) the fixture's
// setup context; they may be async — the runner awaits them.
export type Matcher<T = unknown> =
  | T
  | ((actual: T, ctx?: unknown) => boolean | Promise<boolean>)
  | (() => unknown);

export interface FixtureInput {
  url: string;
  method?: string;
  headers?: Record<string, string> | (() => unknown);
  body?: unknown;
  [key: string]: unknown;
}

export interface FixtureOutput {
  status?:
    | number
    | ((actual: number, ctx?: unknown) => boolean | Promise<boolean>)
    | (() => unknown);
  headers?:
    | Record<string, unknown>
    | ((actual: Record<string, string>, ctx?: unknown) => boolean | Promise<boolean>)
    | (() => unknown);
  data?: unknown;
  // A JSON Schema the response body must conform to. Inline only — fixture
  // schemas resolve against no spec, so a `$ref` anywhere in it is a loud
  // error. Validated by the mock-server subset walker (unknown keywords
  // pass); functions inside the schema object are never invoked.
  schema?: unknown;
  [key: string]: unknown;
}

export interface Fixture<Ctx = unknown> {
  name?: string;
  setup?: () => Ctx | Promise<Ctx>;
  teardown?: (ctx: Ctx) => unknown | Promise<unknown>;
  // input/output may be built from the setup context: pass a function of ctx
  // for the whole object, or 1-arg functions for individual input fields.
  input: FixtureInput | ((ctx: Ctx) => FixtureInput | Promise<FixtureInput>);
  output: FixtureOutput | ((ctx: Ctx) => FixtureOutput | Promise<FixtureOutput>);
}

export type FixtureModule =
  | Fixture
  | Fixture[]
  | (() => Fixture | Fixture[] | Promise<Fixture | Fixture[]>);

export interface FixtureFailure {
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface FixtureResult {
  file: string;
  name: string;
  iter?: number;
  status: "pass" | "fail" | "error";
  durationMs: number;
  failures: FixtureFailure[];
  error?: { message: string; stack?: string };
  responseStatus?: number;
}

export interface StressBucket {
  fixture: string;
  count: number;
  pass: number;
  fail: number;
  error: number;
  p50: number;
  p95: number;
  p99: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  statusCodes: Record<string, number>;
}

export interface RunReport {
  results: FixtureResult[];
  totals: { pass: number; fail: number; error: number; ms: number };
  stress?: StressBucket[];
  // Present only when --bail cut the run short: results then holds just the
  // tasks that settled, and scheduled is how many were queued in total.
  bailed?: true;
  scheduled?: number;
}

export interface RunOpts {
  target: string;
  threads: number;
  count?: number;
  timeoutMs?: number;
  bail?: boolean;
}
