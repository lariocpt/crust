import { isSwagger2, swagger2to3 } from "./swagger2to3";

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, unknown> };
  [k: string]: unknown;
}

export interface OperationObject {
  responses?: Record<string, ResponseObject>;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  [k: string]: unknown;
}

export interface ParameterObject {
  name?: string;
  in?: string; // "path" | "query" | "header" | "cookie"
  required?: boolean;
  schema?: unknown;
  style?: string; // "form" (query default) | "spaceDelimited" | "pipeDelimited" | …
  explode?: boolean;
  $ref?: string;
  [k: string]: unknown;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
  $ref?: string;
  [k: string]: unknown;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  [k: string]: unknown;
}

export interface MediaTypeObject {
  schema?: unknown;
  example?: unknown;
  examples?: Record<string, { value?: unknown } | undefined>;
  [k: string]: unknown;
}

export async function loadSpec(source: string): Promise<{ spec: OpenApiSpec; origin: string }> {
  const text = source.includes("://") ? await fetchText(source) : await readText(source);
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksJson ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(`failed to parse spec from ${source}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`spec at ${source} did not parse to an object`);
  }
  const spec = parsed as OpenApiSpec;
  // Normalise Swagger 2.0 documents into the OpenAPI 3.x shape the mock server
  // consumes (so a Flasgger/Swagger-2.0 spec works without manual conversion).
  if (isSwagger2(spec)) swagger2to3(spec);
  // OpenAPI 3.1 made `paths` OPTIONAL: a document describing only `webhooks` (and/or reusable
  // `components`) is valid and has nothing to serve. Rejecting it outright turned a conformant
  // spec into a load failure, so accept it with an empty paths object and let the caller report
  // "0 route(s)" plus the webhook count. A document with none of the three is still an error —
  // that is a spec we genuinely cannot use, not one that legitimately mocks nothing.
  if (!spec.paths || typeof spec.paths !== "object") {
    const hasWebhooks = !!(spec as { webhooks?: unknown }).webhooks;
    const hasComponents = !!(spec as { components?: unknown }).components;
    if (!hasWebhooks && !hasComponents) {
      throw new Error(`spec at ${source} has no 'paths' object`);
    }
    spec.paths = {};
  }
  return { spec, origin: source };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function readText(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`spec not found: ${path}`);
  return await file.text();
}

function parseYaml(text: string): unknown {
  const yaml = (Bun as unknown as { YAML?: { parse: (s: string) => unknown } }).YAML;
  if (!yaml) {
    throw new Error("YAML parsing requires Bun >= 1.2 (Bun.YAML.parse not found)");
  }
  return yaml.parse(text);
}
