import type { MediaTypeObject, OpenApiSpec, OperationObject, ResponseObject } from "./loadSpec";

export interface PickedResponse {
  status: number;
  media: MediaTypeObject | null;
}

export function pickResponse(op: OperationObject): PickedResponse {
  const responses = op.responses ?? {};
  const keys = Object.keys(responses);
  const order: string[] = ["200", "201"];
  for (const k of keys) {
    if (/^2\d\d$/.test(k) && !order.includes(k)) order.push(k);
  }
  order.push("default");
  for (const k of keys) if (!order.includes(k)) order.push(k);

  for (const k of order) {
    const r = responses[k];
    if (!r) continue;
    return { status: parseStatus(k), media: pickMedia(r) };
  }
  return { status: 200, media: null };
}

function parseStatus(key: string): number {
  if (key === "default") return 200;
  const n = parseInt(key, 10);
  return Number.isFinite(n) ? n : 200;
}

function pickMedia(res: ResponseObject): MediaTypeObject | null {
  const content = res.content;
  if (!content) return null;
  if (content["application/json"]) return content["application/json"]!;
  for (const v of Object.values(content)) if (v) return v;
  return null;
}

export function synthesizeBody(media: MediaTypeObject | null, spec: OpenApiSpec): unknown {
  if (!media) return null;
  if ("example" in media && media.example !== undefined) return media.example;
  if (media.examples) {
    for (const ex of Object.values(media.examples)) {
      if (ex && "value" in ex) return ex.value;
    }
  }
  if (media.schema !== undefined) return generateFromSchema(media.schema, spec, new Set());
  return null;
}

function generateFromSchema(schema: unknown, spec: OpenApiSpec, visited: Set<string>): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === "string") {
    const refName = s.$ref;
    if (visited.has(refName)) return null;
    const resolved = resolveRef(refName, spec);
    if (!resolved) return null;
    const next = new Set(visited);
    next.add(refName);
    return generateFromSchema(resolved, spec, next);
  }

  if ("example" in s && s.example !== undefined) return s.example;

  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];

  if (Array.isArray(s.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const branch of s.allOf) {
      const value = generateFromSchema(branch, spec, visited);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(merged, value);
      }
    }
    return merged;
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    return generateFromSchema(s.oneOf[0], spec, visited);
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    return generateFromSchema(s.anyOf[0], spec, visited);
  }

  const type = s.type as string | undefined;
  switch (type) {
    case "string":
      return stringDefault(s.format as string | undefined);
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array": {
      const item = generateFromSchema(s.items, spec, visited);
      return [item];
    }
    case "object":
    case undefined: {
      const props = s.properties as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object") return type === "object" ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        out[k] = generateFromSchema(v, spec, visited);
      }
      return out;
    }
    case "null":
      return null;
    default:
      return null;
  }
}

function stringDefault(format: string | undefined): string {
  switch (format) {
    case "email":
      return "user@example.com";
    case "date-time":
      return "1970-01-01T00:00:00.000Z";
    case "date":
      return "1970-01-01";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
    case "byte":
      return "";
    default:
      return "string";
  }
}

function resolveRef(ref: string, spec: OpenApiSpec): unknown {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"))];
  }
  return cur ?? null;
}
