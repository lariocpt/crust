import { awaitReady, parseDuration, parseReadyTarget } from "../readiness";

export const waitUsage =
  "usage: wait <target> [--timeout <dur>] [--interval <dur>] [--probe-timeout <dur>]\n" +
  '  target:   ":3001/api/health" | "http(s)://…" | "port:3001"\n' +
  '  duration: "300ms", "30s", "2m" (bare number = ms); --timeout defaults 30s, --interval 500ms\n' +
  "  --probe-timeout caps each probe (default min(interval*4, 2s)) — raise for slow-to-accept targets";

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
  let probeTimeout: string | null = null;

  for (let i = 0; i < strs.length; i++) {
    const a = strs[i]!;
    const eq = a.match(/^--(timeout|interval|probe-timeout)=(.+)$/);
    if (eq) {
      if (eq[1] === "timeout") timeout = eq[2]!;
      else if (eq[1] === "interval") interval = eq[2]!;
      else probeTimeout = eq[2]!;
      continue;
    }
    if (a === "--timeout" || a === "--interval" || a === "--probe-timeout") {
      const v = strs[++i];
      if (v == null) throw new Error(`wait: ${a} needs a value\n${waitUsage}`);
      if (a === "--timeout") timeout = v;
      else if (a === "--interval") interval = v;
      else probeTimeout = v;
      continue;
    }
    if (a.startsWith("--")) throw new Error(`wait: unknown flag ${a}\n${waitUsage}`);
    if (target !== null) throw new Error(`wait: unexpected extra argument "${a}"\n${waitUsage}`);
    target = a;
  }
  if (target === null) throw new Error(`wait: missing target\n${waitUsage}`);

  let parsed: ReturnType<typeof parseReadyTarget>;
  let timeoutMs: number;
  let intervalMs: number;
  let probeTimeoutMs: number | undefined;
  try {
    parsed = parseReadyTarget(target);
    timeoutMs = parseDuration(timeout);
    intervalMs = parseDuration(interval);
    probeTimeoutMs = probeTimeout == null ? undefined : parseDuration(probeTimeout);
  } catch (err) {
    throw new Error(`wait: ${(err as Error).message}\n${waitUsage}`);
  }

  const res = await awaitReady(parsed, { intervalMs, timeoutMs, probeTimeoutMs });
  if (!res) {
    // A bare ":3000" is an HTTP probe of "/". A spec-driven server — mock-server,
    // most APIs — has no root route, so it answers 404 forever and readiness never
    // fires while the process is perfectly up (measured: `wait :4481` timed out at
    // 30s while `GET :4481/pets` returned 200 the whole time). Name the probe and
    // both escapes, or the user reads it as a server that boots slowly.
    const rootProbe = target.startsWith(":") && !target.slice(1).includes("/");
    const hint = rootProbe
      ? ` — ":${target.slice(1)}" probes the root path, and an HTTP target is ready only ` +
        `on a 2xx. Point it at a health path (":${target.slice(1)}/health") or use ` +
        `"port:${target.slice(1)}" for a TCP connect`
      : "";
    throw new Error(`wait: ${target} not ready after ${timeout}${hint}`);
  }
  return { target, ready: true, ms: res.ms, attempts: res.attempts };
}
