import { Pipeline, type PipelineStage, pipelineStage } from "./pipeline";

async function httpRequest(
  url: string,
  method: string,
  body: unknown,
  opts?: RequestInit,
): Promise<Response> {
  const init: RequestInit = { ...opts, method };

  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      init.body = body;
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      init.body = body as BodyInit;
    } else {
      init.body = JSON.stringify(body);
      const headers = new Headers(opts?.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      init.headers = headers;
    }
  }

  return fetch(url, init);
}

function makeHttp(method: "POST" | "PUT" | "PATCH" | "DELETE") {
  return <T>(url: string, opts?: RequestInit): PipelineStage<T, Response> =>
    pipelineStage<T, Response>((input) =>
      Pipeline.of(
        (async function* () {
          for await (const item of input.lines()) {
            yield await httpRequest(url, method, item, opts);
          }
        })(),
      ),
    );
}

export const POST = makeHttp("POST");
export const PUT = makeHttp("PUT");
export const PATCH = makeHttp("PATCH");
export const DELETE = makeHttp("DELETE");

export type ExpectMatcher<T> = number | "2xx" | "3xx" | "4xx" | "5xx" | ((item: T) => boolean);

export class ExpectError<T> extends Error {
  constructor(
    public readonly item: T,
    public readonly index: number,
    public readonly matcher: ExpectMatcher<T>,
  ) {
    super(`expect: item at index ${index} failed matcher ${String(matcher)}`);
    this.name = "ExpectError";
  }
}

function matches<T>(item: T, matcher: ExpectMatcher<T>): boolean {
  if (typeof matcher === "function") return matcher(item);
  if (typeof matcher === "number") {
    return item instanceof Response && item.status === matcher;
  }
  const m = matcher.match(/^(\d)xx$/);
  if (m && item instanceof Response) {
    const cls = parseInt(m[1]!, 10);
    return item.status >= cls * 100 && item.status < (cls + 1) * 100;
  }
  return false;
}

export function expect<T>(matcher: ExpectMatcher<T>): PipelineStage<T, T> {
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        let i = 0;
        for await (const item of input.lines()) {
          if (!matches(item, matcher)) throw new ExpectError(item, i, matcher);
          yield item;
          i++;
        }
      })(),
    ),
  );
}

export function time<T>(
  label: string,
  out: { write(s: string): unknown } = process.stderr,
): PipelineStage<T, T> {
  return pipelineStage<T, T>((input) =>
    Pipeline.of(
      (async function* () {
        const start = performance.now();
        let count = 0;
        try {
          for await (const item of input.lines()) {
            count++;
            yield item;
          }
        } finally {
          const ms = (performance.now() - start).toFixed(1);
          out.write(`[time] ${label}: ${ms}ms (${count} item${count === 1 ? "" : "s"})\n`);
        }
      })(),
    ),
  );
}

export function parallel<T, U>(n: number, fn: (x: T) => U | Promise<U>): PipelineStage<T, U> {
  return pipelineStage<T, U>((input) =>
    Pipeline.of(
      (async function* () {
        const items: T[] = [];
        for await (const item of input.lines()) items.push(item);

        const results: U[] = new Array(items.length);
        const inFlight = new Set<Promise<void>>();

        for (let i = 0; i < items.length; i++) {
          while (inFlight.size >= n) {
            await Promise.race(inFlight);
          }
          const idx = i;
          let task!: Promise<void>;
          task = (async () => {
            results[idx] = await fn(items[idx]!);
          })().finally(() => {
            inFlight.delete(task);
          });
          inFlight.add(task);
        }
        await Promise.all(inFlight);

        for (const r of results) yield r;
      })(),
    ),
  );
}
