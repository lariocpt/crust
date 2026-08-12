import type { OpenApiSpec, OperationObject } from "./loadSpec";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export interface Route {
  method: string;
  template: string;
  regex: RegExp;
  operation: OperationObject;
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
    for (const [method, op] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      routes.push({
        method: method.toUpperCase(),
        template,
        regex: compileTemplate(template),
        operation: op as OperationObject,
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
}

export function matchRoute(routes: Route[], method: string, pathname: string): RouteLookup {
  const upper = method.toUpperCase();
  let pathExists = false;
  for (const r of routes) {
    if (r.regex.test(pathname)) {
      pathExists = true;
      if (r.method === upper) return { matched: r, pathExists: true };
    }
  }
  return { matched: null, pathExists };
}
