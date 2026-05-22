import { Pipeline } from "./pipeline";
import { Glob, file } from "bun";

export function range(start: number, end: number): Pipeline<number> {
  return Pipeline.of(
    (async function* () {
      for (let i = start; i <= end; i++) yield i;
    })(),
  );
}

export function glob(pattern: string): Pipeline<string> {
  const g = new Glob(pattern);
  return Pipeline.of(
    (async function* () {
      for await (const f of g.scan({ cwd: process.cwd(), absolute: false })) {
        yield f;
      }
    })(),
  );
}

export function read(path: string): Pipeline<string> {
  return Pipeline.of(
    (async function* () {
      const text = await file(path).text();
      const lines = text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) yield line;
    })(),
  );
}

export function GET(url: string, opts?: RequestInit): Pipeline<Response> {
  return Pipeline.of(
    (async function* () {
      const res = await fetch(url, { ...opts, method: "GET" });
      yield res;
    })(),
  );
}
