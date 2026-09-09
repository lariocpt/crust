import type { MediaTypeObject, OpenApiSpec, OperationObject, ResponseObject } from "./loadSpec";
import { matchesPattern, normaliseType, sampleFromPattern } from "./schemaTypes";

export interface PickedResponse {
  status: number;
  media: MediaTypeObject | null;
  /**
   * The content type the media was chosen FROM. pickMedia has always fallen back to the first
   * documented type when there is no application/json, but callers had no way to learn which —
   * so the response went out as application/json regardless, and crust's own --proxy validator
   * rejected it ("content-type 'application/json' is not documented for status 200") on any spec
   * documenting text/html or application/javascript.
   */
  mediaType: string | null;
}

/**
 * `spec` is optional only for backward compatibility; pass it whenever you have one, or a
 * response written as `{ $ref: "#/components/responses/Foo" }` cannot be resolved and the
 * operation silently mocks a null body.
 */
export function pickResponse(op: OperationObject, spec?: OpenApiSpec): PickedResponse {
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
    return { status: parseStatus(k), ...pickMedia(r, spec) };
  }
  return { status: 200, media: null, mediaType: null };
}

function parseStatus(key: string): number {
  if (key === "default") return 200;
  const n = parseInt(key, 10);
  return Number.isFinite(n) ? n : 200;
}

function pickMedia(
  res: ResponseObject,
  spec?: OpenApiSpec,
): { media: MediaTypeObject | null; mediaType: string | null } {
  // A RESPONSE may itself be a $ref into components.responses — distinct from a $ref'd schema,
  // and the common style in hand-written specs (95 of ton-console's 99 operations). Reading
  // `.content` off the unresolved node yields undefined, so the operation answered 200 with a
  // null body while its spec documented a required object.
  let node = res as ResponseObject & { $ref?: unknown };
  const seen = new Set<string>();
  while (typeof node.$ref === "string" && spec) {
    if (seen.has(node.$ref)) return { media: null, mediaType: null }; // cyclic — no hang
    seen.add(node.$ref);
    const target = resolveRef(node.$ref, spec);
    if (!target || typeof target !== "object") return { media: null, mediaType: null };
    node = target as ResponseObject & { $ref?: unknown };
  }
  const content = node.content;
  if (!content) return { media: null, mediaType: null };
  if (content["application/json"]) {
    return { media: content["application/json"]!, mediaType: "application/json" };
  }
  for (const [type, v] of Object.entries(content)) if (v) return { media: v, mediaType: type };
  return { media: null, mediaType: null };
}

export function synthesizeBody(media: MediaTypeObject | null, spec: OpenApiSpec): unknown {
  if (!media) return null;
  if ("example" in media && media.example !== undefined) return media.example;
  if (media.examples) {
    for (const ex of Object.values(media.examples)) {
      if (ex && "value" in ex) return ex.value;
    }
  }
  if (media.schema !== undefined) {
    nodeBudget = NODE_BUDGET;
    try {
      // The sentinel is internal: a body is never the symbol itself.
      const value = generateFromSchema(media.schema, spec, new Set());
      return value === UNREPRESENTABLE ? null : value;
    } finally {
      nodeBudget = 0;
    }
  }
  return null;
}

/**
 * Generated values for `$ref`s already built during THIS body, and a count of how many times a
 * cycle had to be terminated.
 *
 * presalytics.io/ooxml issued 176 MILLION generateFromSchema calls for 134 responses — 25 million
 * for one of them, 53 seconds for the file — and nothing in it is recursive. Its schema graph is a
 * DAG, and every distinct path to a shared node rebuilt that node's entire subtree, so the cost
 * grew with the number of PATHS rather than the number of nodes. From outside, that is
 * indistinguishable from a hang.
 *
 * A subtree is reusable unless a cycle closed inside it on a ref that was already open ABOVE it —
 * only then does what it produced depend on the path that reached it. `terminatedRefs` names them
 * rather than counting them, which is the difference between reusing 90k subtrees and 5.17M.
 */
let nodeBudget = 0;
let budgetWarned = false;

/**
 * "Nothing valid can be produced here." Returned where a cycle has already been expanded as far as
 * it can be, and distinct from `null` — which is a VALUE, and a legal one for a nullable field.
 *
 * telegram.org is the case that needs it: Message -> pinned_message -> Chat -> pinned_message ->
 * Message. `Chat` sits outside the cycle, so it generates all its properties including the OPTIONAL
 * `pinned_message`, which re-enters and came back as `{}` — an object carrying none of Message's
 * required fields. 138 violations in one spec, every one crust's own.
 *
 * An optional property may simply be ABSENT, and absent always validates. So the caller decides:
 * omit it if it is optional, and fall back to the empty shape only where `required` forces presence.
 */
const UNREPRESENTABLE = Symbol("unrepresentable");

/**
 * How many schema nodes one response body may expand before crust stops going deeper.
 *
 * Some real schema graphs are MUTUALLY recursive — presalytics.io/ooxml has
 * `Slide.Slides.Details` referencing `Shared.*.Details` referencing back — and with per-path cycle
 * detection the honest cost of a complete body grows with the number of PATHS, not nodes: 52
 * million expansions for 134 responses, 53 seconds for the file. Reuse cannot fix it, because in a
 * mutually recursive graph almost every subtree really does depend on the path that reached it
 * (3.64M of 3.69M were genuinely path-dependent, not conservatively assumed to be).
 *
 * So the depth is bounded instead. Past the budget a `$ref` terminates exactly as a cycle does —
 * carrying the properties its schema requires — so a truncated body is still a body that validates.
 * 20,000 is far above any ordinary response: across 4,138 real-world specs only a handful reach it,
 * and those are the ones that otherwise look like a hang.
 */
const NODE_BUDGET = 20_000;

/**
 * The referenced schema with the referring node's own keywords laid over it.
 *
 * Only NARROWING keywords are carried across — `enum`, `format`, `pattern`, the bounds, `example`.
 * Structural ones (`type`, `properties`, `items`) are not, and that restraint is deliberate: sibling
 * keywords were ILLEGAL beside `$ref` before OpenAPI 3.1, so every Swagger-2 conversion in the wild
 * carries siblings that the tools of that era ignored. Applying azure's structural leftovers turned
 * seven correct bodies wrong. A narrowing sibling is unambiguous intent; a conflicting `type` is far
 * more likely to be conversion noise, and crust does not act on a guess about which.
 */
const NARROWING_SIBLINGS = new Set([
  "enum",
  "const",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "example",
  "examples",
  "default",
]);

function withRefSiblings(node: Record<string, unknown>, resolved: unknown): unknown {
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return resolved;
  const siblings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node))
    if (k !== "$ref" && NARROWING_SIBLINGS.has(k)) siblings[k] = v;
  if (Object.keys(siblings).length === 0) return resolved;
  return { ...(resolved as Record<string, unknown>), ...siblings };
}

/**
 * The other half of discriminator handling: the INHERITANCE idiom, which is what real specs use.
 *
 * The union form — a base with `oneOf` plus a discriminator — is what the specification's own
 * example shows. Apple's sirikit-cloud-media writes the opposite way round, and so does most of the
 * corpus: the derived schema carries `allOf: [{$ref: Base}]` AND the discriminator whose mapping
 * names the keys that select IT. Several keys may map to the same schema; any of them is a correct
 * answer, and leaving the property at its plain "string" default is not.
 */
function withOwnDiscriminator(value: unknown, resolved: unknown, refName: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (!resolved || typeof resolved !== "object") return value;
  const disc = (resolved as Record<string, unknown>).discriminator as
    | { propertyName?: unknown; mapping?: unknown }
    | undefined;
  const prop = disc?.propertyName;
  const mapping = disc?.mapping;
  if (typeof prop !== "string" || !mapping || typeof mapping !== "object") return value;

  const out = value as Record<string, unknown>;
  const existing = out[prop];
  // Only fill a slot nothing has decided. A branch that pinned it with const/enum already said so.
  if (typeof existing === "string" && existing !== "string" && existing !== "") return value;
  for (const [key, target] of Object.entries(mapping as Record<string, unknown>)) {
    if (target === refName) {
      out[prop] = key;
      return out;
    }
  }
  return value;
}

/**
 * The first branch of a union, merged with whatever the NODE itself declares.
 *
 * The same mistake the allOf path had, in the other combinator. Keywords are independent: a node
 * carrying `oneOf` and its own `properties` must satisfy both. Real specs lean on this — influxdata
 * uses `oneOf` purely to say "one of these REQUIRED sets" and declares the actual properties on the
 * node — so taking the branch alone found `{required: [...]}` with no type and no properties and
 * produced `null` for the entire object.
 *
 * The branch wins on conflict: it is the narrower statement about which variant this is.
 */
function unionValue(
  s: Record<string, unknown>,
  branches: unknown[],
  spec: OpenApiSpec,
  visited: Set<string>,
): unknown {
  const branch = branches[0];
  const fromBranch = withDiscriminator(generateFromSchema(branch, spec, visited), branch, s);
  if (s.properties === undefined) return fromBranch;

  const { oneOf: _o, anyOf: _a, ...own } = s;
  const fromNode = generateFromSchema(own, spec, visited);
  if (!fromNode || typeof fromNode !== "object" || Array.isArray(fromNode)) return fromBranch;
  if (!fromBranch || typeof fromBranch !== "object" || Array.isArray(fromBranch)) return fromNode;
  return { ...(fromNode as Record<string, unknown>), ...(fromBranch as Record<string, unknown>) };
}

/**
 * Names the union branch that was actually chosen.
 *
 * crust picks the first branch and used to leave the discriminator property at whatever its schema
 * said in general — usually the plain `"string"` default — so the body it produced matched NO branch
 * of the union it came from, by crust's own validator. 28 of 61 sampled union violations across the
 * corpus were exactly this.
 *
 * The value is not inferred. `discriminator.mapping` states which key selects which schema; without
 * a mapping OpenAPI says the value is the schema's own name. A branch that pins the property itself
 * — with `const`, or an `enum` of one — has already said what it is, and is left alone: the spec
 * outranks anything derived from it.
 */
function withDiscriminator(
  value: unknown,
  branch: unknown,
  union: Record<string, unknown>,
): unknown {
  const disc = union.discriminator as { propertyName?: unknown; mapping?: unknown } | undefined;
  const prop = disc?.propertyName;
  if (typeof prop !== "string" || !value || typeof value !== "object" || Array.isArray(value))
    return value;
  const ref = (branch as Record<string, unknown> | null)?.$ref;
  if (typeof ref !== "string") return value;

  const out = value as Record<string, unknown>;
  // Only fill a slot the branch did not decide for itself.
  const existing = out[prop];
  if (typeof existing === "string" && existing !== "string" && existing !== "") return value;

  const mapping = disc?.mapping;
  if (mapping && typeof mapping === "object") {
    for (const [key, target] of Object.entries(mapping as Record<string, unknown>)) {
      if (target === ref) {
        out[prop] = key;
        return out;
      }
    }
  }
  // No mapping: OpenAPI's default is the schema name, the last segment of the ref.
  const name = ref.slice(ref.lastIndexOf("/") + 1);
  if (name) out[prop] = name;
  return out;
}

function generateFromSchema(schema: unknown, spec: OpenApiSpec, visited: Set<string>): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  if (typeof s.$ref === "string") {
    const refName = s.$ref;
    const resolved = resolveRef(refName, spec);
    if (visited.has(refName)) {
      // A cycle has to stop somewhere, but stopping with `null` puts a value of the WRONG TYPE in
      // the body, which crust's own validator then rejects — a self-inflicted violation on any spec
      // with a recursive model (AWS amplifyuibuilder, athena). The empty shape of the declared type
      // terminates the recursion just as firmly and is a body the validator accepts.
      //
      // But `{}` is an object that carries none of the properties its schema DEMANDS, which merely
      // traded the `type` violation for a `required` one — 4,663 of them across all 4,138 APIs-guru
      // specs. So the terminating level generates its REQUIRED properties and stops there. The
      // recursive property is nearly always optional (a slot may contain a sub-slot), so omitting
      // optional properties is what makes this both complete and finite. `depth` is what guarantees
      // the finiteness when the recursive property is itself required: one shallow level, then the
      // empty shape.
      // The marker is what makes "one shallow level" true rather than aspirational: a REQUIRED
      // property that closes the loop lands here again, sees it, and stops with the empty shape.
      if (visited.has(`${refName}#shallow`)) return UNREPRESENTABLE;
      return shallowForCycle(resolved, spec, visited, refName);
    }
    if (!resolved) return null;
    // Out of budget: stop descending, exactly as at a cycle, so the body stays well-typed.
    //
    // Except for a SCALAR: a `$ref` to a string, number, boolean or enum cannot recurse, costs one
    // step, and is where the useful value lives. Refusing those too made every enum-constrained
    // field in a truncated body wrong — 974 `enum` violations across the 12 specs the budget makes
    // finishable at all, which is a poor trade for nothing saved. The budget exists to stop
    // UNBOUNDED expansion, and a leaf is not that.
    if (nodeBudget <= 0 && !isScalarSchema(resolved)) {
      if (!budgetWarned) {
        budgetWarned = true;
        process.stderr.write(
          `mock-server: schema graph too deeply recursive to expand fully; response bodies are ` +
            `truncated at ${NODE_BUDGET} nodes and remain schema-valid\n`,
        );
      }
      return shallowForCycle(resolved, spec, visited, refName);
    }
    nodeBudget--;
    const next = new Set(visited);
    next.add(refName);
    // JSON Schema 2020-12 and OpenAPI 3.1 allow keywords ALONGSIDE `$ref`, and they apply. Returning
    // the referenced schema alone dropped them: ideal-postcodes narrows a referenced string with a
    // sibling `enum`, and the mock emitted "string" — a value no branch of the surrounding union
    // accepts. crust's fixture generator already merges these; the mock now agrees with it.
    const effective = withRefSiblings(s, resolved);
    return withOwnDiscriminator(generateFromSchema(effective, spec, next), effective, refName);
  }

  if ("example" in s && s.example !== undefined) return s.example;
  // 3.1 replaced the singular `example` with an `examples` ARRAY on the schema itself (distinct
  // from the media-type `examples` map handled in synthesizeBody).
  if (Array.isArray(s.examples) && s.examples.length > 0) return s.examples[0];
  // JSON Schema `const` pins the only legal value; synthesising anything else is a body our own
  // validator rejects.
  if ("const" in s && s.const !== undefined) return s.const;

  if (Array.isArray(s.enum) && s.enum.length > 0) return pickEnumMember(s.enum, s);

  if (Array.isArray(s.allOf)) {
    // allOf means "this, refined", and the thing being refined is not always an object: AWS's
    // specs wrap every enum as `allOf: [{$ref: '.../Status'}]`. Merging with Object.assign alone
    // DISCARDED a scalar branch and returned {} — an empty object where an enum string belongs,
    // which crust's own validator then rejected (4,538 times across 300 real-world specs).
    // So: merge the object branches when there are any, and otherwise fall back to the first
    // branch that produced a value at all. Objects still win a mixed allOf, because merging is
    // the meaningful reading there and a stray scalar branch must not displace it.
    const merged: Record<string, unknown> = {};
    let sawObject = false;
    let scalar: unknown;
    for (const branch of s.allOf) {
      const value = generateFromSchema(branch, spec, visited);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // An EMPTY object contributed nothing, and treating it as a contribution let it outrank a
        // sibling that had real content. AWS writes every field as
        // `allOf: [{$ref: RealThing}, {description: "..."}]`, and the description-only branch
        // synthesises `{}`; where RealThing was a LIST, the `{}` won and the array was discarded —
        // 12 self-inflicted "expected array, got object" violations in one spec.
        if (Object.keys(value).length === 0) continue;
        Object.assign(merged, value);
        sawObject = true;
      } else if (scalar === undefined && value !== undefined && value !== null) {
        scalar = value;
      }
    }
    // The node's OWN keywords still apply. `allOf` is an intersection, not a replacement: a schema
    // carrying both `allOf` and its own `properties` must satisfy both, and taking the allOf path
    // and returning here dropped the siblings entirely. appcenter.ms writes
    // `allOf: [{allOf: [inner], properties: outer}]` and crust mocked 2 of 12 fields — the largest
    // single group in the full 4,138-spec sweep. Generated with `allOf` removed so this cannot
    // recurse. Which side "wins" is the wrong question — see mergePropertySchemas below.
    // If this allOf describes an OBJECT, build it from merged property SCHEMAS rather than from
    // merged property values — see mergePropertySchemas. A fragment that adds `enum` to a property
    // the base declared as a plain string then constrains the value instead of losing a race to it.
    // Only the properties that are genuinely CONTESTED get rebuilt. A property declared once has
    // already been generated correctly in `merged`; regenerating EVERY property from a merged
    // schema made the full-corpus sweep run several times longer, because each property's own
    // generation re-walked its ancestors' allOf trees. Rebuilding just the contested ones is the
    // same answer for a fraction of the work.
    const contested = contestedProperties(s, spec);
    if (s.properties !== undefined || contested !== null) {
      const out: Record<string, unknown> = {};
      // The node's OWN properties first (PR #24: taking the allOf path used to drop them entirely),
      // then the branches over them.
      if (s.properties !== undefined) {
        const { allOf: _ignored, ...own } = s;
        const ownValue = generateFromSchema(own, spec, visited);
        if (ownValue && typeof ownValue === "object" && !Array.isArray(ownValue))
          Object.assign(out, ownValue);
      }
      Object.assign(out, merged);
      // Then the properties the chain declares MORE THAN ONCE, rebuilt from their merged schema.
      // Neither side of that overlap is reliably the narrowing — azure inherits
      // `ruleType: {type: string}` and restates it with an `enum`, and both value-level precedences
      // were measured on the full corpus and both lose. Keywords settle it: the union of every
      // fragment keeps the base's `type` AND the derived `enum`, because neither overwrites what
      // the other alone declares. Only contested names are rebuilt; the rest are already right.
      for (const [name, parts] of Object.entries(contested ?? {})) {
        out[name] = generateFromSchema(Object.assign({}, ...parts), spec, visited);
      }
      repairPlaceholders(out, s, spec, visited);
      if (Object.keys(out).length > 0) return out;
    }
    if (sawObject) {
      repairPlaceholders(merged, s, spec, visited);
      return merged;
    }
    if (scalar !== undefined) return scalar;
    // Every branch was documentation-only or unbuildable. `{}` is right for an object and wrong for
    // anything else, so let the node's own `type` have the last word before defaulting to it.
    const declared = emptyOfDeclaredType(s);
    return declared !== null ? declared : merged;
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    return unionValue(s, s.oneOf, spec, visited);
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    return unionValue(s, s.anyOf, spec, visited);
  }

  // OpenAPI 3.1 allows `type: ["string","null"]` — the form that replaced 3.0's `nullable: true`.
  // Reading it as a bare string made every union fall through to `default: return null`, which for
  // a union without "null" is a body validateRequest.ts itself rejects. Prefer the first
  // non-"null" member so a nullable field still gets representative data; a schema whose only type
  // is "null" still yields null.
  const type = pickType(s.type);
  switch (type) {
    case "string":
      return stringDefault(s);
    case "integer":
    case "number":
      return numberDefault(s, type === "integer");
    case "boolean":
      return false;
    case "array": {
      // Honour the schema's own bounds. One element was the default and remains it, but minItems
      // and maxItems are as binding here as minLength is on a string — a maxItems of 0 means the
      // empty array, and synthesising one element there is a body our own validator rejects.
      const generatedItem = generateFromSchema(s.items, spec, visited);
      // An array whose element cannot be represented is the EMPTY array, not an array of nothing.
      if (generatedItem === UNREPRESENTABLE) return [];
      const item = generatedItem;
      const min = typeof s.minItems === "number" ? s.minItems : null;
      const max = typeof s.maxItems === "number" ? s.maxItems : null;
      let count = 1;
      if (min !== null && min > count) count = min;
      if (max !== null && max < count) count = max;
      if (count > 100) count = 100; // a mock body nobody can read helps nobody
      return Array.from({ length: Math.max(0, count) }, () => item);
    }
    case "object":
    case undefined: {
      const props = s.properties as Record<string, unknown> | undefined;
      if (!props || typeof props !== "object") {
        if (type !== "object") return null;
        // `required` without `properties` is legal and real specs write it — a branch of an allOf
        // that adds only a requirement. The names still have to be PRESENT, and nothing constrains
        // them, so null is the least assuming value. Returning a bare {} dropped them entirely.
        const bare: Record<string, unknown> = {};
        if (Array.isArray(s.required) && s.additionalProperties !== false) {
          for (const name of s.required) if (typeof name === "string") bare[name] = null;
        }
        return bare;
      }
      const out: Record<string, unknown> = {};
      const requiredHere = new Set(
        Array.isArray(s.required)
          ? s.required.filter((r): r is string => typeof r === "string")
          : [],
      );
      for (const [k, v] of Object.entries(props)) {
        const generated = generateFromSchema(v, spec, visited);
        if (generated === UNREPRESENTABLE) {
          // Optional: leave it out, which always validates. Required: presence is forced, so the
          // empty shape is the least-bad answer and the violation that remains is the schema's.
          if (requiredHere.has(k)) out[k] = emptyOfDeclaredType(deref(v, spec), spec) ?? {};
          continue;
        }
        out[k] = generated;
      }
      // A name in `required` that `properties` never describes. Real specs do this (ton-console's
      // Participant requires `date_create` and defines no such property), and omitting it made the
      // mock fail crust's OWN validator. Nothing constrains the name, so any value satisfies it —
      // `null` is the least assuming one. The exception is `additionalProperties: false`, where the
      // schema forbids the very key it demands: nothing can satisfy that, and inventing the key
      // would break the stricter rule instead, so the spec's contradiction is left visible.
      if (Array.isArray(s.required) && s.additionalProperties !== false) {
        for (const name of s.required) {
          if (typeof name === "string" && !Object.hasOwn(out, name)) out[name] = null;
        }
      }
      return out;
    }
    case "null":
      return null;
    default:
      return null;
  }
}

/**
 * The first enum member that satisfies the schema's own declared type.
 *
 * probely writes `{type: "string", enum: [null, "trial", "plan", "subscribe"]}` — the null means
 * "no action required" and is explained in the description — and taking enum[0] blindly emitted a
 * value crust's own validator rejects. The schema contradicts itself about ONE member; the other
 * three satisfy everything it says. Preferring one of those is not a guess, it is reading the rest
 * of the same enum.
 *
 * Where NO member fits, enum[0] stands: the schema is unsatisfiable and inventing a value outside
 * the enum would be worse than reporting the contradiction it already has.
 */
function pickEnumMember(members: unknown[], schema: Record<string, unknown>): unknown {
  const declared = normaliseType(schema.type, schema.nullable);
  if (declared.length === 0) return members[0];
  const fits = (value: unknown): boolean => {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : (typeof value as string);
    if (declared.includes(actual)) return true;
    // JSON has one number type; the schema may say `integer` or `number` for the same member.
    return actual === "number" && (declared.includes("integer") || declared.includes("number"));
  };
  const match = members.find(fits);
  return match !== undefined ? match : members[0];
}

/**
 * A number inside the schema's own bounds. 0 is the friendly default, but a schema saying
 * `minimum: 1` (every paginated `page`/`size` field) made 0 a body our own validator rejects.
 * Handles both `exclusiveMinimum` spellings: 3.1's numeric bound and 3.0's boolean modifier on
 * `minimum`. Integers step by 1, plain numbers by 1 as well — the value only has to be legal,
 * not interesting.
 */
function numberDefault(s: Record<string, unknown>, isInt = true): number {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let lo = num(s.minimum);
  let hi = num(s.maximum);
  const exMin = num(s.exclusiveMinimum);
  const exMax = num(s.exclusiveMaximum);
  if (exMin !== null) lo = exMin + (isInt ? 1 : Number.EPSILON);
  else if (s.exclusiveMinimum === true && lo !== null) lo += isInt ? 1 : Number.EPSILON;
  if (exMax !== null) hi = exMax - (isInt ? 1 : Number.EPSILON);
  else if (s.exclusiveMaximum === true && hi !== null) hi -= isInt ? 1 : Number.EPSILON;
  if (lo !== null && lo > 0) return lo;
  if (hi !== null && hi < 0) return hi;
  return 0;
}

/** `normaliseType`'s single-value counterpart: the type to synthesise a value for. */
function pickType(raw: unknown): string | undefined {
  const types = normaliseType(raw);
  if (types.length === 0) return undefined;
  return types.find((t) => t !== "null") ?? "null";
}

/**
 * A string that satisfies the schema's own constraints.
 *
 * Was: the literal "string" for anything without a known format. Swept across 300 real-world
 * specs that produced 1,444 violations crust's own validator raised against crust's own mock —
 * "string" is 6 characters, so it breaks every maxLength below 6, every minLength above it, and
 * every pattern. genFixtures' validValue had always honoured these; the mock had not.
 *
 * Order matters: `format` wins (an email must look like an email), then `pattern`, then the
 * length bounds clamp whatever came out. A pattern crust cannot sample falls back to the padded
 * default rather than to something that merely looks plausible.
 */
/** Resolve a `$ref` chain without generating anything. */
function deref(schema: unknown, spec: OpenApiSpec, depth = 0): unknown {
  let s = schema;
  while (
    s &&
    typeof s === "object" &&
    typeof (s as Record<string, unknown>).$ref === "string" &&
    depth < 20
  ) {
    s = resolveRef((s as Record<string, unknown>).$ref as string, spec);
    depth++;
  }
  return s;
}

/** True when an array's items point back at something already open on this path. */
function itemsReenter(items: unknown, visited: Set<string>): boolean {
  if (!items || typeof items !== "object") return false;
  const ref = (items as Record<string, unknown>).$ref;
  return typeof ref === "string" && visited.has(ref);
}

/**
 * The value a `$ref` cycle terminates with: an object carrying the properties its schema requires,
 * and nothing else. Optional properties are dropped — that is what stops the recursion, since the
 * property that closes the loop is almost always optional. A REQUIRED property that closes the loop
 * gets the empty shape, so the nesting is finite either way.
 */
function shallowForCycle(
  resolved: unknown,
  spec: OpenApiSpec,
  visited: Set<string>,
  refName: string,
): unknown {
  const empty = emptyOfDeclaredType(resolved, spec);
  if (!resolved || typeof resolved !== "object") return empty;
  // Read through allOf: bitbucket composes every recursive type that way, so the node itself
  // carries neither the properties nor the required list that describe it.
  const shape = composedShape(resolved, spec);
  const props = shape.properties;
  const required = shape.required;
  if (Object.keys(props).length === 0 || required.length === 0) return empty;

  const marked = new Set(visited);
  marked.add(`${refName}#shallow`);
  const out: Record<string, unknown> = {};
  for (const name of required) {
    if (typeof name !== "string") continue;
    const sub = props[name];
    if (sub === undefined) {
      out[name] = null; // required but never described — the same rule as the object case
      continue;
    }
    // A required ARRAY of the type we are terminating: the empty array satisfies `required` and is
    // finite, where one element would be a terminating level carrying none of ITS OWN required
    // properties — valid at the top and invalid at every level below. bbc.co.uk's `ChildCategory`
    // requires `child_categories`, an array of ChildCategory. The schema offers this answer itself;
    // crust was declining to take it. `minItems` still wins where the spec asks for elements.
    const subSchema = deref(sub, spec);
    if (subSchema && typeof subSchema === "object") {
      const ss = subSchema as Record<string, unknown>;
      const wantsElements = typeof ss.minItems === "number" && ss.minItems > 0;
      if (
        normaliseType(ss.type, ss.nullable).includes("array") &&
        !wantsElements &&
        itemsReenter(ss.items, visited)
      ) {
        out[name] = [];
        continue;
      }
    }
    // `visited` still holds refName, so a required property that closes the loop lands back in the
    // cycle branch; the marker makes it terminate there with the empty shape instead of recursing.
    out[name] = generateFromSchema(sub, spec, marked);
  }
  return out;
}

/**
 * Every schema fragment declared for each property, merged keyword-by-keyword across an `allOf`
 * chain and the node's own `properties`.
 *
 * Merging generated VALUES cannot work, and both precedences were tried on the full corpus to prove
 * it: azure inherits `ruleType: {type: string}` from a base and restates it with an `enum`, so
 * letting the branch win emits the inherited "string" that the enum forbids — but letting the node
 * win instead cost 668 more violations elsewhere, because a node's own fragment is often the
 * vaguer one. Neither side is reliably the narrowing.
 *
 * Keywords are. `allOf` is an intersection, so a property's effective schema is the union of every
 * keyword any fragment declares: the base contributes `type`, the derived schema contributes
 * `enum`, and Object.assign keeps both because the base never mentions `enum` to overwrite it.
 */
/**
 * Undo a placeholder that outranked a real description.
 *
 * A branch may REQUIRE a name without describing it, and the object case fills such a name with null
 * — correctly, since presence is forced and nothing constrains it. But that null means "nothing
 * describes this", and merging let it overwrite a sibling branch that DID describe the property:
 * turbinelabs declares `zone_key: {type: string}` in one branch of an allOf and merely requires it
 * in another, so the mock returned null against a schema saying string.
 *
 * A placeholder cannot outrank a description. Any null with a fragment behind it is regenerated from
 * that fragment; a name nothing describes keeps its null, because that is still the honest answer.
 */
function repairPlaceholders(
  out: Record<string, unknown>,
  s: Record<string, unknown>,
  spec: OpenApiSpec,
  visited: Set<string>,
): void {
  let fragments: Record<string, Record<string, unknown>[]> | null = null;
  for (const [name, value] of Object.entries(out)) {
    if (value !== null) continue;
    fragments ??= mergePropertySchemas(s, spec);
    const parts = fragments[name];
    if (!parts || parts.length === 0) continue;
    out[name] = generateFromSchema(
      parts.length === 1 ? parts[0] : Object.assign({}, ...parts),
      spec,
      visited,
    );
  }
}

/** The properties an allOf chain declares MORE THAN ONCE — the only ones whose effective schema
 *  differs from the single fragment that produced their value. */
function contestedProperties(
  schema: unknown,
  spec: OpenApiSpec,
): Record<string, Record<string, unknown>[]> | null {
  const frags = mergePropertySchemas(schema, spec);
  const out: Record<string, Record<string, unknown>[]> = {};
  let any = false;
  for (const [name, parts] of Object.entries(frags)) {
    if (parts.length > 1) {
      out[name] = parts;
      any = true;
    }
  }
  return any ? out : null;
}

function mergePropertySchemas(
  schema: unknown,
  spec: OpenApiSpec,
  into: Record<string, Record<string, unknown>[]> = {},
  depth = 0,
): Record<string, Record<string, unknown>[]> {
  if (!schema || typeof schema !== "object" || depth > 10) return into;
  let s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const resolved = resolveRef(s.$ref, spec);
    if (!resolved) return into;
    s = resolved as Record<string, unknown>;
  }
  // Branches first, the node's own fragments last: on a keyword both genuinely declare, the node
  // restating it is the deliberate act.
  if (Array.isArray(s.allOf))
    for (const branch of s.allOf) mergePropertySchemas(branch, spec, into, depth + 1);
  if (s.properties && typeof s.properties === "object") {
    for (const [name, sub] of Object.entries(s.properties as Record<string, unknown>)) {
      if (!sub || typeof sub !== "object") continue;
      let list = into[name];
      if (!list) {
        list = [];
        into[name] = list;
      }
      list.push(sub as Record<string, unknown>);
    }
  }
  return into;
}

/**
 * A schema that cannot expand into anything: no properties, no items, no combinators, no `$ref`.
 * Generating one costs a single step whatever the budget says, and it is where an `enum`, a
 * `format` or a `pattern` actually lives.
 */
function isScalarSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  if (s.$ref !== undefined) return false;
  if (s.properties !== undefined || s.items !== undefined) return false;
  if (s.allOf !== undefined || s.oneOf !== undefined || s.anyOf !== undefined) return false;
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) return false;
  const types = normaliseType(s.type, s.nullable);
  if (types.length === 0) return Array.isArray(s.enum) || s.const !== undefined;
  return types.every(
    (ty) =>
      ty === "string" || ty === "number" || ty === "integer" || ty === "boolean" || ty === "null",
  );
}

/**
 * A node's shape, read through `allOf`. Both the cycle terminator and `emptyOfDeclaredType` need to
 * answer "what type is this, and what does it require?", and real specs answer that inside an allOf
 * branch rather than on the node — bitbucket composes every recursive type that way. Reading the
 * node alone found nothing and the cycle terminated with `null`: 349 of 356 sampled `type` residues
 * across the full corpus. Shallow by design: it merges branch shape, not values.
 */
function composedShape(
  schema: unknown,
  spec: OpenApiSpec,
  depth = 0,
): { types: string[]; properties: Record<string, unknown>; required: string[]; bag: boolean } {
  const out = {
    types: [] as string[],
    properties: {} as Record<string, unknown>,
    required: [] as string[],
    bag: false,
  };
  if (!schema || typeof schema !== "object" || depth > 10) return out;
  let s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") {
    const resolved = resolveRef(s.$ref, spec);
    if (!resolved || depth >= 10) return out;
    s = resolved as Record<string, unknown>;
  }
  out.types.push(...normaliseType(s.type, s.nullable));
  if (s.properties && typeof s.properties === "object") Object.assign(out.properties, s.properties);
  if (Array.isArray(s.required))
    out.required.push(...s.required.filter((r): r is string => typeof r === "string"));
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) out.bag = true;
  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) {
      const sub = composedShape(branch, spec, depth + 1);
      out.types.push(...sub.types);
      Object.assign(out.properties, sub.properties);
      out.required.push(...sub.required);
      out.bag ||= sub.bag;
    }
  }
  return out;
}

/**
 * The empty value of whatever type a schema declares: `{}` for an object, `[]` for an array, and
 * `null` when nothing is declared and no honest guess exists. Used wherever crust gives up on
 * building a value — a `$ref` cycle, an `allOf` with nothing in it — because giving up is not a
 * licence to emit the wrong type. `null` where `type: object` is declared is a violation crust
 * inflicts on itself.
 */
function emptyOfDeclaredType(schema: unknown, spec?: OpenApiSpec): unknown {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  const types = normaliseType(s.type, s.nullable);
  if (types.includes("object")) return {};
  if (types.includes("array")) return [];
  // `type` is optional in JSON Schema and real specs leave it out constantly. The shape is still
  // legible from the keywords, and guessing from them beats emitting `null` into a typed slot.
  if (s.properties !== undefined || s.additionalProperties !== undefined) return {};
  if (s.items !== undefined) return [];
  // Last resort: the shape may live in an allOf branch rather than on the node.
  if (spec) {
    const shape = composedShape(s, spec);
    if (shape.types.includes("object") || Object.keys(shape.properties).length > 0 || shape.bag)
      return {};
    if (shape.types.includes("array")) return [];
  }
  return null;
}

function stringDefault(s: Record<string, unknown>): string {
  const format = s.format as string | undefined;
  const min = typeof s.minLength === "number" ? s.minLength : null;
  const max = typeof s.maxLength === "number" ? s.maxLength : null;

  const pattern = typeof s.pattern === "string" ? s.pattern : null;
  let value = formatDefault(format);
  // Both declared: the PATTERN is the narrower statement. A format names a family of values; a
  // pattern names which of them. peertube writes `{format: "uri", pattern: "magnet:\\?xt=urn:..."}`
  // and taking the format default emitted "https://example.com" — a value the field's own regex
  // rejects. The format default is kept only where it actually satisfies the pattern.
  if (value !== null && pattern !== null && !matchesPattern(pattern, value)) value = null;
  if (value === null) {
    // Hand the sampler the length requirement so it can buy it from an open-ended quantifier,
    // rather than us padding the answer afterwards and breaking the match it just verified.
    value = pattern ? sampleFromPattern(pattern, min ?? 0) : "string";
  } else if (min === null && max === null) {
    return value; // a formatted value with no length bounds: leave it exactly as it was
  }

  // A formatted value that cannot fit maxLength means the SCHEMA contradicts itself: a uuid is 36
  // characters and cannot be 8. Truncating produced "00000000" — not a uuid — which merely traded a
  // maxLength violation for a format one while making the mock data less useful. Keep the valid
  // formatted value; it is the better wrong answer, and the one the docs already described.
  // "formatted" means the value in hand CAME from the format default — not merely that a format was
  // declared. Where the pattern overrode it, the value is a pattern sample and truncating it is the
  // thing the clamp guard below exists to prevent.
  const formatted = formatDefault(format) !== null && value === formatDefault(format);
  // A value that already matches its pattern is one crust VERIFIED. Clamping it afterwards silently
  // unmakes that: a checked "0" padded to minLength became "0xxxxxxxxxxx", and the fallback
  // truncated to "gen" — 153 of 668 pattern violations across 300 real specs were crust breaking its
  // own work. Where the length bound and the pattern cannot both hold, the pattern is the narrower
  // statement about the field, so it wins; the length violation is then the SPEC's contradiction to
  // answer for, and --validate still reports it.
  const held = pattern !== null && matchesPattern(pattern, value);
  const clamped = ((v: string): string => {
    if (max !== null && v.length > max && !formatted) v = v.slice(0, Math.max(0, max));
    if (min !== null && v.length < min) v = v.padEnd(min, "x");
    return v;
  })(value);
  if (held && !matchesPattern(pattern, clamped)) return value;
  return clamped;
}

function formatDefault(format: string | undefined): string | null {
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
      return null;
  }
}

export function resolveRef(ref: string, spec: OpenApiSpec): unknown {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur: unknown = spec;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[
      decodeURIComponent(p.replace(/~1/g, "/").replace(/~0/g, "~"))
    ];
  }
  return cur ?? null;
}
