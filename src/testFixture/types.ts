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
  status: "pass" | "fail" | "error";
  durationMs: number;
  failures: FixtureFailure[];
  error?: { message: string; stack?: string };
}

export interface RunReport {
  results: FixtureResult[];
  totals: { pass: number; fail: number; error: number; ms: number };
}

export interface RunOpts {
  target: string;
  threads: number;
}
