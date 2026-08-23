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

// The loopback shorthands (`port:N`, `:PORT/path`) must not let the OS pick an
// address family on the user's behalf, because the two ends of the round trip
// do not pick the same one.
//
// `Bun.listen({hostname:"localhost"})` — and `vite --host localhost`, and
// `server.listen(port, "localhost")` — resolve in verbatim getaddrinfo order and
// bind ::1 first where that exists. Our probe's connect path instead goes
// through glibc's AI_ADDRCONFIG, which DROPS AAAA when the machine has no
// non-loopback IPv6 address. A default-bridge Docker container is exactly that
// machine: the service listens on ::1, the probe knocks on 127.0.0.1, and a
// service that is up is reported "not ready" until the timeout expires.
//
// So try every loopback address ourselves. The v6 literal is required — a v6
// HOSTNAME does not help, since ADDRCONFIG substitutes 127.0.0.1 for it too.
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
const loopbackFanout = (host: string): string[] => (host === "localhost" ? LOOPBACK_HOSTS : [host]);

// First success wins; false only once every candidate has failed. Waiting for
// the slowest (Promise.all) would make a black-holed family cost a probe its
// whole timeout even when the other answered instantly.
function anyTrue(tasks: Array<() => Promise<boolean>>): Promise<boolean> {
  if (tasks.length === 1) return tasks[0]!();
  return new Promise<boolean>((resolve) => {
    let pending = tasks.length;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      if (ok || --pending === 0) {
        settled = true;
        resolve(ok);
      }
    };
    for (const task of tasks) task().then(finish, () => finish(false));
  });
}

function tcpOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
      hostname: host,
      port,
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

async function httpOnce(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    void res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

// Same fan-out for the http shorthand: `:3000/health` becomes
// http://localhost:3000/health, which has the identical family problem. An
// EXPLICIT host the user typed is left exactly as typed.
function httpCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  if (parsed.hostname !== "localhost") return [url];
  return [
    url,
    ...LOOPBACK_HOSTS.map((h) => {
      const u = new URL(url);
      u.hostname = h.includes(":") ? `[${h}]` : h;
      return u.toString();
    }),
  ];
}

// One probe, hard-capped at timeoutMs. Never throws — false covers refused,
// timed out, and non-2xx alike.
export async function probeOnce(t: ReadyTarget, timeoutMs: number): Promise<boolean> {
  if (t.kind === "http") {
    return anyTrue(httpCandidates(t.url).map((u) => () => httpOnce(u, timeoutMs)));
  }
  return anyTrue(loopbackFanout(t.host).map((h) => () => tcpOnce(h, t.port, timeoutMs)));
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
