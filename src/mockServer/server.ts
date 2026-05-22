import type { OpenApiSpec } from "./loadSpec";
import { buildRoutes, matchRoute, type Route } from "./router";
import { pickResponse, synthesizeBody } from "./mockResponse";

export interface ServerOptions {
  port: number;
  hostname: string;
  spec: OpenApiSpec;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  hostname: string;
  routes: Route[];
  stop: () => Promise<void>;
}

export function startServer(opts: ServerOptions): RunningServer {
  const routes = buildRoutes(opts.spec);
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req) {
      const started = performance.now();
      const url = new URL(req.url);
      const lookup = matchRoute(routes, req.method, url.pathname);

      let response: Response;
      try {
        if (!lookup.matched) {
          const status = lookup.pathExists ? 405 : 404;
          response = jsonResponse(status, { error: lookup.pathExists ? "method not allowed" : "not found" });
        } else {
          const picked = pickResponse(lookup.matched.operation);
          const body = synthesizeBody(picked.media, opts.spec);
          if (picked.status === 204 || body === undefined) {
            response = new Response(null, { status: picked.status });
          } else {
            response = jsonResponse(picked.status, body);
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
