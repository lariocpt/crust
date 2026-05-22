export type Matcher<T = unknown> = T | ((actual: T) => boolean) | (() => unknown);

export interface FixtureInput {
  url: string;
  method?: string;
  headers?: Record<string, string> | (() => unknown);
  body?: unknown;
  [key: string]: unknown;
}

export interface FixtureOutput {
  status?: number | ((actual: number) => boolean) | (() => unknown);
  headers?: Record<string, unknown> | ((actual: Record<string, string>) => boolean) | (() => unknown);
  data?: unknown;
  [key: string]: unknown;
}

export interface Fixture {
  name?: string;
  setup?: () => unknown | Promise<unknown>;
  teardown?: (ctx: unknown) => unknown | Promise<unknown>;
  input: FixtureInput;
  output: FixtureOutput;
}

export type FixtureModule = Fixture | Fixture[] | (() => Fixture | Fixture[] | Promise<Fixture | Fixture[]>);

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
}

export interface RunOpts {
  target: string;
  threads: number;
  count?: number;
}
