/**
 * Envelope detection for the stateful CRUD layer.
 *
 * Many specs wrap entities: a POST 201 example of {"thing": {"id": …}}.
 * The store always holds the BARE entity; responses re-wrap with the
 * detected key so a client capturing t.thing.id gets the REAL id back.
 * Detection is deterministic and flat-on-ambiguity — a spec the scan can't
 * read behaves exactly like today's flat handling.
 */
import type { OpenApiSpec, OperationObject, RequestBodyObject } from "./loadSpec";
import { pickResponse, resolveRef, synthesizeBody } from "./mockResponse";
import type { Route } from "./router";

export interface EnvelopeInfo {
  /** Wrapper key for POST (create) responses, from the POST's success media. */
  create: string | null;
  /** Wrapper key for item GET/PUT/PATCH responses (falls back to `create`). */
  item: string | null;
  /** Wrapper key request bodies arrive under, from the POST's request media. */
  req: string | null;
}

export const FLAT_ENVELOPE: EnvelopeInfo = { create: null, item: null, req: null };

// Matches a trailing "/{param}" segment: "/things/{id}" is an item path whose
// collection key is "/things" — the same key a bare "/things" template maps to.
const TRAILING_PARAM = /\/\{[^/}]+\}$/;

export function collectionKeyOf(template: string): { key: string; isItem: boolean } {
  const isItem = TRAILING_PARAM.test(template);
  return { key: isItem ? template.replace(TRAILING_PARAM, "") : template, isItem };
}

/**
 * A body is enveloped when it is a plain object with EXACTLY ONE
 * object-valued property and NO top-level `id` — anything else is flat.
 */
export function detectEnvelopeKey(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  if (Object.hasOwn(body, "id")) return null;
  const objectKeys = Object.keys(body).filter((k) => isPlainObject(body[k]));
  return objectKeys.length === 1 ? objectKeys[0]! : null;
}

/** Per-collection envelope descriptors, computed once at startServer. */
export function computeEnvelopes(routes: Route[], spec: OpenApiSpec): Map<string, EnvelopeInfo> {
  const posts = new Map<string, Route>();
  const itemGets = new Map<string, Route>();
  for (const r of routes) {
    const { key, isItem } = collectionKeyOf(r.template);
    if (!isItem && r.method === "POST" && !posts.has(key)) posts.set(key, r);
    if (isItem && r.method === "GET" && !itemGets.has(key)) itemGets.set(key, r);
  }

  const out = new Map<string, EnvelopeInfo>();
  for (const key of new Set([...posts.keys(), ...itemGets.keys()])) {
    const post = posts.get(key);
    let create: string | null = null;
    let req: string | null = null;
    if (post) {
      create = detectEnvelopeKey(synthesizeBody(pickResponse(post.operation).media, spec));
      // A request envelope is only trusted when it AGREES with the response
      // side: a lone object-valued request prop that isn't the response's
      // envelope key (e.g. an `owner: {...}` sub-object on a flat create) is
      // entity data, and unwrapping it would corrupt stored entities.
      const reqCandidate = detectEnvelopeKey(requestBodyExample(post.operation, spec));
      req = reqCandidate !== null && reqCandidate === create ? reqCandidate : null;
    }
    // Item responses reuse the create envelope when the item GET documents no
    // body; an item GET that documents its own (even flat) object wins.
    let item = create;
    const itemGet = itemGets.get(key);
    if (itemGet) {
      const body = synthesizeBody(pickResponse(itemGet.operation).media, spec);
      if (isPlainObject(body)) item = detectEnvelopeKey(body);
    }
    if (create !== null || item !== null || req !== null) out.set(key, { create, item, req });
  }
  return out;
}

function requestBodyExample(op: OperationObject, spec: OpenApiSpec): unknown {
  let rb = op.requestBody;
  if (rb && typeof rb.$ref === "string") {
    const resolved = resolveRef(rb.$ref, spec);
    if (resolved && typeof resolved === "object") rb = resolved as RequestBodyObject;
  }
  const content = rb?.content;
  if (!content) return null;
  const media = content["application/json"] ?? Object.values(content).find((v) => v) ?? null;
  return synthesizeBody(media, spec);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
