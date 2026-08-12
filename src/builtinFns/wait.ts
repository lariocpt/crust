import { awaitReady, parseDuration, parseReadyTarget } from "../readiness";

const USAGE =
  "usage: wait <target> [--timeout <dur>] [--interval <dur>]\n" +
  '  target:   ":3001/api/health" | "http(s)://…" | "port:3001"\n' +
  '  duration: "300ms", "30s", "2m" (bare number = ms); --timeout defaults 30s, --interval 500ms';

// `wait :3001/health --timeout 30s` — block until a target answers, then emit
// one summary item (so it works as a pipeline source in the REPL, `crust -c`,
// and .pipes files). A timeout throws, which runLine turns into exit 1.
export async function wait(...args: unknown[]): Promise<{
  target: string;
  ready: true;
  ms: number;
  attempts: number;
}> {
  const strs = args.map((a) => String(a));
  let target: string | null = null;
  let timeout = "30s";
  let interval = "500ms";

  for (let i = 0; i < strs.length; i++) {
    const a = strs[i]!;
    const eq = a.match(/^--(timeout|interval)=(.+)$/);
    if (eq) {
      if (eq[1] === "timeout") timeout = eq[2]!;
      else interval = eq[2]!;
      continue;
    }
    if (a === "--timeout" || a === "--interval") {
      const v = strs[++i];
      if (v == null) throw new Error(`wait: ${a} needs a value\n${USAGE}`);
      if (a === "--timeout") timeout = v;
      else interval = v;
      continue;
    }
    if (a.startsWith("--")) throw new Error(`wait: unknown flag ${a}\n${USAGE}`);
    if (target !== null) throw new Error(`wait: unexpected extra argument "${a}"\n${USAGE}`);
    target = a;
  }
  if (target === null) throw new Error(`wait: missing target\n${USAGE}`);

  let parsed: ReturnType<typeof parseReadyTarget>;
  let timeoutMs: number;
  let intervalMs: number;
  try {
    parsed = parseReadyTarget(target);
    timeoutMs = parseDuration(timeout);
    intervalMs = parseDuration(interval);
  } catch (err) {
    throw new Error(`wait: ${(err as Error).message}\n${USAGE}`);
  }

  const res = await awaitReady(parsed, { intervalMs, timeoutMs });
  if (!res) throw new Error(`wait: ${target} not ready after ${timeout}`);
  return { target, ready: true, ms: res.ms, attempts: res.attempts };
}
