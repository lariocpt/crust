import { appendFile } from "node:fs/promises";
import { collectionKeyOf, computeEnvelopes, FLAT_ENVELOPE } from "./envelope";
import type { OpenApiSpec } from "./loadSpec";
import { pickResponse, synthesizeBody } from "./mockResponse";
import { forward, UpstreamError } from "./proxy";
import { buildRoutes, matchRoute, paramNames, type Route } from "./router";
import { openStateBackend, type StateBackend, type StateStore } from "./state";
import {
  isJsonContentType,
  undocumentedOperation,
  type Violation,
  validateRequest,
  validateResponse,
} from "./validateRequest";

export interface ServerOptions {
  port: number;
  hostname: string;
  spec: OpenApiSpec;
  log?: (line: string) => void;
  stateful?: boolean;
  /** Persist stateful CRUD: bare path / sqlite:// file / postgres:// URL. Implies stateful. */
  state?: string;
  /** JSON seed file { "<collection template>": [ {…}, … ] }. Implies stateful. */
  seed?: string;
  /** Validate requests against the spec; violations → 422 (mock mode). */
  validate?: boolean;
  /**
   * Enforce a literal `additionalProperties: false` at plain object nodes
   * (implies validate in mock mode). Composed nodes — allOf-merged objects,
   * combinator siblings, patternProperties — stay exempt, so strict still
   * never invents a violation.
   */
  strict?: boolean;
  /** Upstream base URL — validation-proxy mode (implies request+response validation). */
  proxy?: string;
  proxyTimeoutMs?: number;
  /** NDJSON file to append violations to as they happen. */
  report?: string;
}

export type { StateStore } from "./state";

export interface RunningServer {
  port: number;
  hostname: string;
  routes: Route[];
  /** The live store for the memory backend; an empty placeholder for SQL backends. */
  state: StateStore;
  backend: StateBackend;
  /** Items actually inserted from --seed (0 when unseeded or all collections had rows). */
  seeded: number;
  resetState: () => Promise<void>;
  violations: Violation[];
  clearViolations: () => void;
  stop: () => Promise<void>;
}

const MAX_VIOLATIONS = 1000;
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

// Armed via PUT /__crust/override (mock mode): the next matching request(s)
// answer this instead of the mock. Exists for failure injection when the APP
// under test owns the request — it can't send a Prefer-style control header,
// so the mock itself must be armable. `match.bodyContains` + `times: 1`
// lets a fixture running under --threads arm a failure for ITS OWN request
// (scoped by a unique value it put in the body) without racing siblings.
interface MockOverride {
  method: string;
  path: string;
  status: number;
  body?: unknown;
  contentType?: string;
  /** consume after N matches (armed until DELETE when omitted) */
  times?: number;
  match?: { bodyContains?: string };
}

function validateOverride(p: unknown): string | null {
  if (!isPlainObject(p)) return "override payload must be a JSON object";
  if (typeof p.method !== "string" || p.method.length === 0) return "method: required string";
  if (typeof p.path !== "string" || !p.path.startsWith("/")) {
    return "path: required string starting with /";
  }
  if (
    typeof p.status !== "number" ||
    !Number.isInteger(p.status) ||
    p.status < 100 ||
    p.status > 599
  ) {
    return "status: integer 100-599 required";
  }
  if (p.times !== undefined && (!Number.isInteger(p.times) || (p.times as number) < 1)) {
    return "times: integer >= 1";
  }
  if (p.contentType !== undefined && typeof p.contentType !== "string") {
    return "contentType: string";
  }
  if (p.match !== undefined) {
    if (!isPlainObject(p.match)) return "match: object";
    if (p.match.bodyContains !== undefined && typeof p.match.bodyContains !== "string") {
      return "match.bodyContains: string";
    }
  }
  return null;
}

function overrideResponse(o: MockOverride): Response {
  if (o.body === undefined) {
    return new Response(null, {
      status: o.status,
      headers: o.contentType ? { "content-type": o.contentType } : {},
    });
  }
  if (typeof o.body === "string") {
    return new Response(o.body, {
      status: o.status,
      headers: { "content-type": o.contentType ?? "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(o.body), {
    status: o.status,
    headers: { "content-type": o.contentType ?? "application/json" },
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const routes = buildRoutes(opts.spec);
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const { backend, map: state } = openStateBackend(opts.state);
  const envelopes = computeEnvelopes(routes, opts.spec);
  const violations: Violation[] = [];
  let dropped = 0;
  let reportQueue: Promise<void> = Promise.resolve();

  let seeded = 0;
  if (opts.seed !== undefined) {
    try {
      seeded = await applySeed(opts.seed, backend, routes, log);
    } catch (err) {
      await backend.close();
      throw err;
    }
  }

  // Capped in-memory ring + optional NDJSON append (one line per violation,
  // as it happens). The report write is awaited per record so callers reading
  // the file after a request see everything that request produced.
  async function record(v: Violation): Promise<void> {
    violations.push(v);
    if (violations.length > MAX_VIOLATIONS) {
      violations.shift();
      dropped++;
    }
    if (opts.report) {
      reportQueue = reportQueue
        .then(() => appendFile(opts.report!, `${JSON.stringify(v)}\n`))
        .catch(() => {});
      await reportQueue;
    }
  }

  // CRUD layer for --stateful, over the state backend. Returns null to fall
  // through to the default example/synthesis behavior — untouched collections
  // keep serving spec examples, so consumers see no change until they write.
  // The store always holds BARE entities; responses (re)wrap with the
  // collection's detected envelope. Flat specs behave exactly as before.
  async function statefulResponse(
    body: Record<string, unknown>,
    route: Route,
    params: Record<string, string>,
  ): Promise<Response | null> {
    const { key: collectionKey, isItem: isItemPath } = collectionKeyOf(route.template);
    const env = envelopes.get(collectionKey) ?? FLAT_ENVELOPE;
    // Request bodies may arrive under the request envelope ({thing: {…}}).
    const unwrapReq = (b: Record<string, unknown>): Record<string, unknown> => {
      if (env.req && isPlainObject(b[env.req])) return b[env.req] as Record<string, unknown>;
      return b;
    };

    if (!isItemPath) {
      if (route.method === "POST") {
        const picked = pickResponse(route.operation);
        const synth = synthesizeBody(picked.media, opts.spec);
        let base: Record<string, unknown> = {};
        if (env.create) {
          const inner = isPlainObject(synth) ? synth[env.create] : undefined;
          if (isPlainObject(inner)) base = inner;
        } else if (isPlainObject(synth)) {
          base = synth;
        }
        const payload = unwrapReq(body);
        const bodyId = payload.id;
        const id =
          typeof bodyId === "string" || typeof bodyId === "number" ? bodyId : crypto.randomUUID();
        const entity = { ...base, ...payload, id };
        await backend.put(collectionKey, String(id), entity);
        return jsonResponse(picked.status, env.create ? { [env.create]: entity } : entity);
      }
      if (route.method === "GET") {
        if (!(await backend.has(collectionKey))) return null;
        const items = await backend.list(collectionKey);
        const picked = pickResponse(route.operation);
        const synth = synthesizeBody(picked.media, opts.spec);
        // Mirror the spec's documented collection shape: a bare array responds
        // as-is; an object with a single array-valued property (e.g.
        // { items: [...] }) wraps the stored items in that property.
        if (isPlainObject(synth)) {
          const arrayProps = Object.keys(synth).filter((k) => Array.isArray(synth[k]));
          if (arrayProps.length === 1) {
            return jsonResponse(picked.status, { ...synth, [arrayProps[0]!]: items });
          }
        }
        return jsonResponse(picked.status, items);
      }
      return null;
    }

    if (!(await backend.has(collectionKey))) return null;
    const names = paramNames(route.template);
    const id = params[names[names.length - 1]!] ?? "";
    const item = await backend.get(collectionKey, id);

    if (route.method === "GET") {
      if (!item) return jsonResponse(404, { error: "not found" });
      return jsonResponse(200, env.item ? { [env.item]: item } : item);
    }
    if (route.method === "PATCH" || route.method === "PUT") {
      if (!item) return jsonResponse(404, { error: "not found" });
      const merged = { ...item, ...unwrapReq(body) };
      await backend.put(collectionKey, id, merged);
      return jsonResponse(200, env.item ? { [env.item]: merged } : merged);
    }
    if (route.method === "DELETE") {
      const removed = await backend.delete(collectionKey, id);
      if (!removed) return jsonResponse(404, { error: "not found" });
      return new Response(null, { status: 204 });
    }
    return null;
  }

  const proxyMode = typeof opts.proxy === "string" && opts.proxy.length > 0;
  const validateMode = opts.validate === true;
  const statefulMode =
    opts.stateful === true || opts.state !== undefined || opts.seed !== undefined;
  const needsBody = validateMode || statefulMode || proxyMode;

  const overrides: MockOverride[] = [];
  // First armed match wins; a `times` override is consumed as it matches.
  const takeOverride = (method: string, pathname: string, rawBody: ArrayBuffer | null) => {
    const m = method.toUpperCase();
    for (let i = 0; i < overrides.length; i++) {
      const o = overrides[i]!;
      if (o.method !== m || o.path !== pathname) continue;
      if (o.match?.bodyContains !== undefined) {
        const text = rawBody ? new TextDecoder().decode(rawBody) : "";
        if (!text.includes(o.match.bodyContains)) continue;
      }
      if (o.times !== undefined) {
        o.times--;
        if (o.times <= 0) overrides.splice(i, 1);
      }
      return o;
    }
    return null;
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req) {
      const started = performance.now();
      const url = new URL(req.url);
      let violationCount = 0;

      let response: Response;
      try {
        // Proxy admin endpoint — handled first, never forwarded.
        if (proxyMode && url.pathname === "/__crust/violations") {
          if (req.method === "GET") {
            response = jsonResponse(200, { count: violations.length, dropped, violations });
          } else if (req.method === "DELETE") {
            violations.length = 0;
            dropped = 0;
            response = new Response(null, { status: 204 });
          } else {
            response = jsonResponse(405, { error: "method not allowed" });
          }
          logLine(req.method, url.pathname, response.status, started, 0);
          return response;
        }

        // Mock-mode failure injection — the control endpoint, handled before
        // everything else and never mocked or validated.
        if (!proxyMode && url.pathname === "/__crust/override") {
          if (req.method === "PUT") {
            let payload: unknown;
            try {
              payload = await req.json();
            } catch {
              payload = undefined;
            }
            const problem =
              payload === undefined ? "override payload must be JSON" : validateOverride(payload);
            if (problem) {
              response = jsonResponse(400, { error: problem });
            } else {
              const p = payload as Record<string, unknown>;
              overrides.push({
                method: (p.method as string).toUpperCase(),
                path: p.path as string,
                status: p.status as number,
                ...(p.body !== undefined ? { body: p.body } : {}),
                ...(p.contentType !== undefined ? { contentType: p.contentType as string } : {}),
                ...(p.times !== undefined ? { times: p.times as number } : {}),
                ...(p.match !== undefined ? { match: p.match as MockOverride["match"] } : {}),
              });
              response = jsonResponse(201, { armed: overrides.length });
            }
          } else if (req.method === "GET") {
            response = jsonResponse(200, { count: overrides.length, overrides });
          } else if (req.method === "DELETE") {
            overrides.length = 0;
            response = new Response(null, { status: 204 });
          } else {
            response = jsonResponse(405, { error: "method not allowed" });
          }
          logLine(req.method, url.pathname, response.status, started, 0);
          return response;
        }

        // Read the raw request body ONCE up front; every consumer (validator,
        // stateful CRUD, proxy forwarding, override bodyContains matching)
        // works from this copy.
        let rawBody: ArrayBuffer | null = null;
        let bodyPresent = false;
        let parsedBody: unknown;
        let jsonError: string | undefined;
        const contentType = req.headers.get("content-type");
        const overridesNeedBody = overrides.some((o) => o.match?.bodyContains !== undefined);
        if (needsBody || overridesNeedBody) {
          rawBody = await req.arrayBuffer();
          bodyPresent = rawBody.byteLength > 0;
          if (bodyPresent) {
            try {
              parsedBody = JSON.parse(new TextDecoder().decode(rawBody));
            } catch (err) {
              if (isJsonContentType(contentType)) jsonError = (err as Error).message;
            }
          }
        }

        // An armed override wins over validation, stateful CRUD and the mock:
        // an upstream simulating a 429 answers 429 no matter how valid the
        // request was. Never active in proxy mode (the upstream is real).
        if (!proxyMode) {
          const ov = takeOverride(req.method, url.pathname, rawBody);
          if (ov) {
            response = overrideResponse(ov);
            logLine(req.method, url.pathname, response.status, started, 0);
            return response;
          }
        }

        const lookup = matchRoute(routes, req.method, url.pathname);

        if (proxyMode) {
          // Validate the request (metadata only — the upstream still decides).
          let reqViolations: Violation[];
          if (lookup.matched) {
            reqViolations = validateRequest(
              {
                method: req.method,
                pathname: url.pathname,
                params: lookup.params,
                searchParams: url.searchParams,
                contentType,
                bodyPresent,
                body: parsedBody,
                jsonError,
              },
              lookup.matched,
              opts.spec,
              { strict: opts.strict === true },
            );
          } else {
            reqViolations = [undocumentedOperation(req.method, url.pathname)];
          }
          for (const v of reqViolations) await record(v);
          violationCount += reqViolations.length;

          try {
            const result = await forward(
              req.method,
              url,
              req.headers,
              rawBody,
              opts.proxy!,
              opts.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS,
            );
            if (lookup.matched) {
              const respCt = result.response.headers.get("content-type");
              let respBody: unknown;
              if (result.bodyText !== null && isJsonContentType(respCt)) {
                try {
                  respBody = JSON.parse(result.bodyText);
                } catch {
                  // non-JSON body despite the header — the validator skips it
                }
              }
              const respViolations = validateResponse(
                {
                  status: result.response.status,
                  contentType: respCt,
                  hasBody: result.hasBody,
                  body: respBody,
                },
                lookup.matched,
                opts.spec,
                { strict: opts.strict === true },
              ).map((v) => ({ ...v, path: url.pathname }));
              for (const v of respViolations) await record(v);
              violationCount += respViolations.length;
            }
            response = result.response;
          } catch (err) {
            if (err instanceof UpstreamError) {
              // Infra failure, not a spec violation — never recorded.
              response = jsonResponse(502, {
                error: "upstream unreachable",
                upstream: opts.proxy,
                detail: err.message,
              });
            } else {
              throw err;
            }
          }
        } else if (!lookup.matched) {
          const status = lookup.pathExists ? 405 : 404;
          response = jsonResponse(status, {
            error: lookup.pathExists ? "method not allowed" : "not found",
          });
        } else {
          let rejected: Response | null = null;
          if (validateMode) {
            const reqViolations = validateRequest(
              {
                method: req.method,
                pathname: url.pathname,
                params: lookup.params,
                searchParams: url.searchParams,
                contentType,
                bodyPresent,
                body: parsedBody,
                jsonError,
              },
              lookup.matched,
              opts.spec,
              { strict: opts.strict === true },
            );
            if (reqViolations.length > 0) {
              for (const v of reqViolations) await record(v);
              violationCount += reqViolations.length;
              rejected = new Response(
                JSON.stringify({
                  error: "request validation failed",
                  violations: reqViolations.map(
                    ({ pointer, rule, message, expected, received, location }) => ({
                      pointer,
                      rule,
                      message,
                      ...(expected !== undefined ? { expected } : {}),
                      ...(received !== undefined ? { received } : {}),
                      location,
                    }),
                  ),
                }),
                {
                  status: 422,
                  headers: {
                    "content-type": "application/json",
                    "x-crust-validation": "request",
                  },
                },
              );
            }
          }
          if (rejected) {
            // Composes with --stateful: an invalid write creates NOTHING.
            response = rejected;
          } else {
            const jsonBody = isPlainObject(parsedBody) ? parsedBody : {};
            const stateful = statefulMode
              ? await statefulResponse(jsonBody, lookup.matched, lookup.params)
              : null;
            if (stateful) {
              response = stateful;
            } else {
              const picked = pickResponse(lookup.matched.operation);
              const body = synthesizeBody(picked.media, opts.spec);
              if (picked.status === 204 || body === undefined) {
                response = new Response(null, { status: picked.status });
              } else {
                response = jsonResponse(picked.status, body);
              }
            }
          }
        }
      } catch (err) {
        response = jsonResponse(500, { error: (err as Error).message });
      }

      logLine(req.method, url.pathname, response.status, started, violationCount);
      return response;
    },
  });

  function logLine(
    method: string,
    pathname: string,
    status: number,
    started: number,
    violationCount: number,
  ): void {
    const ms = Math.round(performance.now() - started);
    const suffix = violationCount > 0 ? ` [${violationCount} violation(s)]` : "";
    log(`${method.padEnd(6)} ${pathname.padEnd(28)} ${status}  ${ms}ms${suffix}`);
  }

  return {
    port: server.port ?? opts.port,
    hostname: opts.hostname,
    routes,
    state,
    backend,
    seeded,
    resetState: () => backend.clear(),
    violations,
    clearViolations: () => {
      violations.length = 0;
      dropped = 0;
    },
    stop: async () => {
      // AWAIT the listener shutdown before closing the state backend. Unawaited,
      // in-flight handlers went on to call backend.get/put against a closed
      // client: measured with a slow handler, 50 of 50 in-flight requests
      // failed without this await and 50 of 50 succeeded with it.
      await server.stop();
      await backend.close();
    },
  };
}

/**
 * Seed { "<collection template>": [ {…}, … ] } into EMPTY collections only —
 * restart-safe: a persistent store's accumulated state is never clobbered.
 * Items without an id get a random uuid. Unknown collection keys warn and
 * boot anyway; unreadable/invalid files throw (the CLI maps that to exit 1).
 */
async function applySeed(
  seedPath: string,
  backend: StateBackend,
  routes: Route[],
  log: (line: string) => void,
): Promise<number> {
  const file = Bun.file(seedPath);
  if (!(await file.exists())) throw new Error(`seed file not found: ${seedPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`seed file ${seedPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`seed file ${seedPath} must be a JSON object of collection -> item[]`);
  }

  const knownCollections = new Set(routes.map((r) => collectionKeyOf(r.template).key));
  let inserted = 0;
  for (const [collection, items] of Object.entries(parsed)) {
    if (!knownCollections.has(collection)) {
      log(`mock-server: seed collection '${collection}' matches no route — skipped`);
      continue;
    }
    if (!Array.isArray(items)) {
      throw new Error(`seed collection '${collection}' must be an array of objects`);
    }
    // Empty-only: collections that already have rows are left untouched.
    if (await backend.has(collection)) continue;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (!isPlainObject(item)) {
        throw new Error(`seed collection '${collection}' contains a non-object item`);
      }
      const rawId = item.id;
      // Id-less seed items get a DETERMINISTIC id (hash of collection+index+
      // content) so concurrent seeders of a shared store converge on the same
      // rows instead of racing random UUIDs into duplicates.
      const id =
        typeof rawId === "string" || typeof rawId === "number"
          ? rawId
          : `seed-${Bun.hash(`${collection}#${i}#${JSON.stringify(item)}`).toString(16)}`;
      await backend.put(collection, String(id), { ...item, id });
      inserted++;
    }
  }
  return inserted;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
