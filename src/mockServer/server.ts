import type { OpenApiSpec } from "./loadSpec";
import { pickResponse, synthesizeBody } from "./mockResponse";
import { buildRoutes, matchRoute, paramNames, type Route } from "./router";

export interface ServerOptions {
  port: number;
  hostname: string;
  spec: OpenApiSpec;
  log?: (line: string) => void;
  stateful?: boolean;
}

export type StateStore = Map<string, Map<string, Record<string, unknown>>>;

export interface RunningServer {
  port: number;
  hostname: string;
  routes: Route[];
  state: StateStore;
  resetState: () => void;
  stop: () => Promise<void>;
}

// Matches a trailing "/{param}" segment: "/things/{id}" is an item path whose
// collection key is "/things" — the same key a bare "/things" template maps to.
const TRAILING_PARAM = /\/\{[^/}]+\}$/;

export function startServer(opts: ServerOptions): RunningServer {
  const routes = buildRoutes(opts.spec);
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const state: StateStore = new Map();

  // In-memory CRUD layer for --stateful. Returns null to fall through to the
  // default example/synthesis behavior — untouched collections keep serving
  // spec examples, so consumers see no change until they write.
  async function statefulResponse(
    req: Request,
    route: Route,
    params: Record<string, string>,
  ): Promise<Response | null> {
    const isItemPath = TRAILING_PARAM.test(route.template);
    const collectionKey = isItemPath ? route.template.replace(TRAILING_PARAM, "") : route.template;

    if (!isItemPath) {
      if (route.method === "POST") {
        const body = await readJsonObject(req);
        const picked = pickResponse(route.operation);
        const synth = synthesizeBody(picked.media, opts.spec);
        const base = isPlainObject(synth) ? synth : {};
        const bodyId = body.id;
        const id =
          typeof bodyId === "string" || typeof bodyId === "number" ? bodyId : crypto.randomUUID();
        const item = { ...base, ...body, id };
        let collection = state.get(collectionKey);
        if (!collection) {
          collection = new Map();
          state.set(collectionKey, collection);
        }
        collection.set(String(id), item);
        return jsonResponse(picked.status, item);
      }
      if (route.method === "GET") {
        const collection = state.get(collectionKey);
        if (!collection) return null;
        const items = [...collection.values()];
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

    const collection = state.get(collectionKey);
    if (!collection) return null;
    const names = paramNames(route.template);
    const id = params[names[names.length - 1]!] ?? "";
    const item = collection.get(id);

    if (route.method === "GET") {
      return item ? jsonResponse(200, item) : jsonResponse(404, { error: "not found" });
    }
    if (route.method === "PATCH" || route.method === "PUT") {
      if (!item) return jsonResponse(404, { error: "not found" });
      const body = await readJsonObject(req);
      const merged = { ...item, ...body };
      collection.set(id, merged);
      return jsonResponse(200, merged);
    }
    if (route.method === "DELETE") {
      if (!item) return jsonResponse(404, { error: "not found" });
      collection.delete(id);
      return new Response(null, { status: 204 });
    }
    return null;
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req) {
      const started = performance.now();
      const url = new URL(req.url);
      const lookup = matchRoute(routes, req.method, url.pathname);

      let response: Response;
      try {
        if (!lookup.matched) {
          const status = lookup.pathExists ? 405 : 404;
          response = jsonResponse(status, {
            error: lookup.pathExists ? "method not allowed" : "not found",
          });
        } else {
          const stateful = opts.stateful
            ? await statefulResponse(req, lookup.matched, lookup.params)
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
      } catch (err) {
        response = jsonResponse(500, { error: (err as Error).message });
      }

      const ms = Math.round(performance.now() - started);
      log(`${req.method.padEnd(6)} ${url.pathname.padEnd(28)} ${response.status}  ${ms}ms`);
      return response;
    },
  });

  return {
    port: server.port,
    hostname: opts.hostname,
    routes,
    state,
    resetState: () => state.clear(),
    stop: async () => {
      server.stop();
    },
  };
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

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
