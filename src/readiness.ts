// Shared readiness probing — used by the `procs` source (ready:/after: gates)
// and the `wait` registered function. A target is either an HTTP URL (ready =
// any 2xx) or a bare TCP port (ready = the connect succeeds).

export type ReadyTarget =
  | { kind: "http"; url: string }
  | { kind: "tcp"; host: string; port: number };

// `":3001/api/health"` → http://localhost:3001/api/health (same shorthand the
// parser's normalizeUrl gives HTTP stages), full http(s) URLs pass through,
// `"port:3001"` probes TCP connect on localhost.
export function parseReadyTarget(s: string): ReadyTarget {
  const t = s.trim();
  const portMatch = t.match(/^port:(\d+)$/);
  if (portMatch) {
    const port = parseInt(portMatch[1]!, 10);
    if (port < 1 || port > 65535) throw new Error(`readiness: port out of range in "${s}"`);
    return { kind: "tcp", host: "localhost", port };
  }
  if (t.startsWith(":")) return { kind: "http", url: `http://localhost${t}` };
  if (/^https?:\/\//.test(t)) return { kind: "http", url: t };
  throw new Error(
    `readiness: bad target "${s}" — expected ":3001/path", "http(s)://…" or "port:3001"`,
  );
}

export function formatReadyTarget(t: ReadyTarget): string {
  return t.kind === "http" ? t.url : `port:${t.port}`;
}

// "300" | "300ms" | "30s" | "2m" → milliseconds. Bare numbers are ms.
export function parseDuration(s: string): number {
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!m) throw new Error(`bad duration "${s}" — expected e.g. "300ms", "30s", "2m"`);
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? "ms";
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : 60_000);
}

// One probe, hard-capped at timeoutMs. Never throws — false covers refused,
// timed out, and non-2xx alike.
export async function probeOnce(t: ReadyTarget, timeoutMs: number): Promise<boolean> {
  if (t.kind === "http") {
    try {
      const res = await fetch(t.url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      void res.body?.cancel().catch(() => {});
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    Bun.connect({
      hostname: t.host,
      port: t.port,
      socket: {
        open(socket) {
          done(true);
          socket.end();
        },
        data() {},
        error() {
          done(false);
        },
        connectError() {
          done(false);
        },
        close() {},
      },
    }).catch(() => done(false));
  });
}

export interface AwaitReadyOpts {
  intervalMs: number;
  timeoutMs: number;
  /**
   * Per-probe cap (default min(intervalMs * 4, 2000)). Raise it for targets
   * that accept slowly — a health endpoint with a >2s TTFB can never pass
   * the default cap no matter how generous timeoutMs is.
   */
  probeTimeoutMs?: number;
  onAttempt?: () => void;
  /** checked between attempts — return true to stop waiting (yields null) */
  abort?: () => boolean;
  /** inter-probe sleep, injectable so callers can race it (e.g. against child exit) */
  waitBetween?: (ms: number) => Promise<unknown>;
}

// Poll until ready or the deadline passes. Per-probe timeout defaults to
// min(intervalMs * 4, 2000) so a black-holed target can't eat the budget in
// one bite; probeTimeoutMs overrides it for slow-to-accept targets.
// Resolves {ms, attempts} on success, null on timeout or abort.
export async function awaitReady(
  t: ReadyTarget,
  opts: AwaitReadyOpts,
): Promise<{ ms: number; attempts: number } | null> {
  const start = performance.now();
  const probeTimeoutMs = opts.probeTimeoutMs ?? Math.min(opts.intervalMs * 4, 2000);
  const sleep = opts.waitBetween ?? ((ms: number) => Bun.sleep(ms));
  let attempts = 0;
  for (;;) {
    if (opts.abort?.()) return null;
    attempts++;
    opts.onAttempt?.();
    const ok = await probeOnce(t, probeTimeoutMs);
    const elapsed = performance.now() - start;
    if (ok) return { ms: Math.round(elapsed), attempts };
    if (elapsed >= opts.timeoutMs) return null;
    if (opts.abort?.()) return null;
    await sleep(Math.min(opts.intervalMs, opts.timeoutMs - elapsed));
  }
}
