import type { OpenApiSpec, OperationObject, ParameterObject } from "./loadSpec";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export interface Route {
  method: string;
  template: string;
  regex: RegExp;
  operation: OperationObject;
  /** Path-item-level parameters merged with (before) operation-level ones. */
  parameters: ParameterObject[];
  literalSegments: number;
}

export interface MatchResult {
  route: Route;
}

export function buildRoutes(spec: OpenApiSpec): Route[] {
  const paths = spec.paths ?? {};
  const routes: Route[] = [];
  for (const [template, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    // OpenAPI allows parameters at the path-item level, shared by every
    // operation under the path; operation-level parameters come after.
    const itemParams = (pathItem as { parameters?: unknown }).parameters;
    const pathParams = Array.isArray(itemParams) ? (itemParams as ParameterObject[]) : [];
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      const operation = op as OperationObject;
      routes.push({
        method: method.toUpperCase(),
        template,
        regex: compileTemplate(template),
        operation,
        parameters: [...pathParams, ...(operation.parameters ?? [])],
        literalSegments: countLiteralSegments(template),
      });
    }
  }
  routes.sort((a, b) => {
    if (b.literalSegments !== a.literalSegments) return b.literalSegments - a.literalSegments;
    return b.template.length - a.template.length;
  });
  return routes;
}

function compileTemplate(template: string): RegExp {
  const escaped = template.replace(/[.+^$()|[\]\\]/g, "\\$&");
  const withParams = escaped.replace(/\{([^/}]+)\}/g, "([^/]+)");
  return new RegExp(`^${withParams}$`);
}

function countLiteralSegments(template: string): number {
  return template.split("/").filter((seg) => seg.length > 0 && !/^\{[^/}]+\}$/.test(seg)).length;
}

export interface RouteLookup {
  matched: Route | null;
  pathExists: boolean;
  params: Record<string, string>;
}

export function matchRoute(routes: Route[], method: string, pathname: string): RouteLookup {
  const upper = method.toUpperCase();
  let pathExists = false;
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (m) {
      pathExists = true;
      if (r.method === upper) return { matched: r, pathExists: true, params: extractParams(r, m) };
    }
  }
  return { matched: null, pathExists, params: {} };
}

export function paramNames(template: string): string[] {
  return [...template.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]!);
}

/** Percent-decode a path segment; malformed sequences fall back to the raw text. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function extractParams(route: Route, m: RegExpExecArray): Record<string, string> {
  const params: Record<string, string> = {};
  const names = paramNames(route.template);
  for (let i = 0; i < names.length; i++) {
    // Decode before validation/stateful lookups — query params arrive decoded
    // via URLSearchParams, and path params must match that (an encoded id like
    // %C3%A9 would otherwise fail enum/pattern checks and miss store entries).
    params[names[i]!] = safeDecode(m[i + 1] ?? "");
  }
  return params;
}

/**
 * How many operations a 3.1 document describes under `webhooks`.
 *
 * Webhooks are callbacks the API SENDS to you; they are not endpoints it serves, so they are
 * deliberately not routed. A webhooks-only spec therefore mocks 0 routes, which is correct but
 * indistinguishable — from the outside — from a spec crust failed to parse. mock-server reports
 * this count so the operator can tell those two apart.
 */
export function countWebhookOperations(spec: unknown): number {
  const hooks = (spec as { webhooks?: unknown } | null | undefined)?.webhooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return 0;
  let n = 0;
  for (const item of Object.values(hooks as Record<string, unknown>)) {
    if (!item || typeof item !== "object") continue;
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (HTTP_METHODS.has(method.toLowerCase())) n++;
    }
  }
  return n;
}

/**
 * How many paths template their parameters the Express way (`/things/:id`) instead of the OpenAPI
 * way (`/things/{id}`).
 *
 * Such a path is not conformant, and crust deliberately does NOT rewrite it — silently reinterpreting
 * someone's spec is a worse failure than the one it fixes, and a literal `:id` segment is legal.
 * But matched literally it produces a route no client will ever request, while the boot line still
 * reports a healthy-looking count. 7 of the 17 usable specs in the react corpus are written this
 * way (21 paths, all from the Zuplo ecosystem), so mock-server names the number and lets the
 * operator decide.
 */
export function countColonParamPaths(spec: unknown): number {
  const paths = (spec as { paths?: unknown } | null | undefined)?.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return 0;
  let n = 0;
  for (const template of Object.keys(paths as Record<string, unknown>)) {
    if (template.split("/").some((seg) => /^:[A-Za-z_][A-Za-z0-9_]*$/.test(seg))) n++;
  }
  return n;
}

/**
 * Patterns written as JavaScript regex LITERALS — `/^[0-9]{5}$/i`, delimiters and flags included —
 * where JSON Schema wants a bare regex. The leading slash is then a literal character, so NOTHING
 * can satisfy the pattern: every value fails, including any the API really returns.
 *
 * crust does not rewrite them, because guessing at what a spec meant is how a mock starts lying.
 * It says so instead: the same reason the Express-style `:param` warning exists. sinao.app writes
 * both of its patterns this way and every response carrying one is unsatisfiable.
 */
export function countRegexLiteralPatterns(spec: unknown): number {
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 30) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const pattern = obj.pattern;
    // A bare regex may legitimately start with an escaped slash, so require a CLOSING delimiter
    // followed only by regex flag letters — the shape a JS literal has and a bare pattern does not.
    if (typeof pattern === "string" && /^\/.*\/[gimsuyv]*$/.test(pattern)) seen.add(pattern);
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(spec, 0);
  return seen.size;
}
