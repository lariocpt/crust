import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/mockServer/cli";
import { computeEnvelopes, detectEnvelopeKey } from "../src/mockServer/envelope";
import type { OpenApiSpec } from "../src/mockServer/loadSpec";
import { buildRoutes } from "../src/mockServer/router";
import { type RunningServer, type ServerOptions, startServer } from "../src/mockServer/server";
import {
  MemoryStateBackend,
  normalizeStateUrl,
  openStateBackend,
  SqlStateBackend,
  type StateBackend,
  stateDialect,
  stateSql,
} from "../src/mockServer/state";

let dir: string;
let n = 0;
const sqliteFile = (): string => join(dir, `state-${n++}.sqlite`);

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "crust-mock-state-")));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Flat spec — same shape the pre-envelope suite used.
const FLAT_SPEC = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: {
    "/things": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: {
              "application/json": { example: { items: [{ id: "seed", name: "Example" }] } },
            },
          },
        },
      },
      post: {
        responses: {
          "201": {
            description: "created",
            content: { "application/json": { example: { id: "seed", name: "Example" } } },
          },
        },
      },
    },
    "/things/{thingId}": {
      get: { responses: { "200": { description: "one" } } },
      patch: { responses: { "200": { description: "patched" } } },
      delete: { responses: { "204": { description: "gone" } } },
    },
    "/untouched": {
      get: {
        responses: {
          "200": {
            description: "static",
            content: { "application/json": { example: { fixed: true } } },
          },
        },
      },
    },
  },
} as unknown as OpenApiSpec;

// Envelope spec: create/item responses AND the request body wrap the entity.
const WRAPPED_SPEC = {
  openapi: "3.0.0",
  info: { title: "w", version: "1" },
  paths: {
    "/api/things": {
      get: {
        responses: {
          "200": {
            description: "list",
            content: {
              "application/json": { example: { things: [{ id: "seed", name: "Example" }] } },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: { "application/json": { example: { thing: { name: "Example" } } } },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": { example: { thing: { id: "seed", name: "Example" } } },
            },
          },
        },
      },
    },
    "/api/things/{thingId}": {
      get: {
        responses: {
          "200": {
            description: "one",
            content: {
              "application/json": { example: { thing: { id: "seed", name: "Example" } } },
            },
          },
        },
      },
      patch: { responses: { "200": { description: "patched" } } },
      delete: { responses: { "204": { description: "gone" } } },
    },
  },
} as unknown as OpenApiSpec;

async function withServer(
  opts: Partial<ServerOptions> & { spec: OpenApiSpec },
  fn: (server: RunningServer, base: string) => Promise<void>,
): Promise<void> {
  const server = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    stateful: true,
    log: () => {},
    ...opts,
  });
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop();
  }
}

describe("openStateBackend / normalizeStateUrl", () => {
  test("undefined -> memory backend over the SAME live map", async () => {
    const { backend, map } = openStateBackend(undefined);
    expect(backend).toBeInstanceOf(MemoryStateBackend);
    await backend.put("/c", "1", { id: "1" });
    expect(map.get("/c")?.get("1")).toEqual({ id: "1" });
  });

  test("bare path normalizes to sqlite://", () => {
    expect(normalizeStateUrl("/tmp/x.sqlite")).toBe("sqlite:///tmp/x.sqlite");
    expect(normalizeStateUrl("./mock.sqlite")).toBe("sqlite://./mock.sqlite");
  });

  test("sqlite/postgres/postgresql URLs pass through; dialect derives from scheme", () => {
    expect(normalizeStateUrl("sqlite:///tmp/x.sqlite")).toBe("sqlite:///tmp/x.sqlite");
    expect(normalizeStateUrl("postgres://u@h/db")).toBe("postgres://u@h/db");
    expect(normalizeStateUrl("postgresql://u@h/db")).toBe("postgresql://u@h/db");
    expect(stateDialect("sqlite:///tmp/x.sqlite")).toBe("sqlite");
    expect(stateDialect("postgres://u@h/db")).toBe("postgres");
    expect(stateDialect("postgresql://u@h/db")).toBe("postgres");
    const { backend } = openStateBackend("postgres://u@h/db");
    expect((backend as SqlStateBackend).dialect).toBe("postgres");
  });

  test("unsupported scheme throws (CLI maps to exit 2)", () => {
    expect(() => normalizeStateUrl("redis://localhost/0")).toThrow(/unsupported --state scheme/);
    expect(() => openStateBackend("mysql://u@h/db")).toThrow(/unsupported --state scheme/);
  });
});

describe("dialect SQL delta (the public table contract)", () => {
  test("sqlite: TEXT doc, TEXT updated_at, INSERT OR REPLACE with ? params", () => {
    const s = stateSql("sqlite");
    expect(s.ddl).toContain("CREATE TABLE IF NOT EXISTS crust_mock_state");
    expect(s.ddl).toContain("doc TEXT");
    expect(s.ddl).toContain("updated_at TEXT NOT NULL");
    expect(s.ddl).toContain("PRIMARY KEY (collection, id)");
    expect(s.upsert).toBe(
      "INSERT OR REPLACE INTO crust_mock_state (collection, id, doc, updated_at) VALUES (?, ?, ?, ?)",
    );
  });

  test("postgres: JSONB doc, timestamptz default now(), ON CONFLICT upsert with $n params", () => {
    const s = stateSql("postgres");
    expect(s.ddl).toContain("CREATE TABLE IF NOT EXISTS crust_mock_state");
    expect(s.ddl).toContain("doc JSONB");
    expect(s.ddl).toContain("updated_at timestamptz NOT NULL DEFAULT now()");
    expect(s.ddl).toContain("PRIMARY KEY (collection, id)");
    expect(s.upsert).toBe(
      "INSERT INTO crust_mock_state (collection, id, doc) VALUES ($1, $2, $3::jsonb) " +
        "ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
    );
  });
});

describe("StateBackend contract (memory + sqlite)", () => {
  const backends: Array<[string, () => StateBackend]> = [
    ["memory", () => new MemoryStateBackend(new Map())],
    ["sqlite", () => new SqlStateBackend(`sqlite://${sqliteFile()}`)],
  ];

  for (const [kind, make] of backends) {
    test(`${kind}: put/get/list/has/delete/clear`, async () => {
      const b = make();
      try {
        expect(await b.has("/c")).toBe(false);
        expect(await b.get("/c", "1")).toBeNull();
        await b.put("/c", "1", { id: "1", name: "a" });
        await b.put("/c", "2", { id: "2", name: "b" });
        expect(await b.has("/c")).toBe(true);
        expect(await b.get("/c", "1")).toEqual({ id: "1", name: "a" });
        expect((await b.list("/c")).length).toBe(2);
        // last write wins
        await b.put("/c", "1", { id: "1", name: "a2" });
        expect(await b.get("/c", "1")).toEqual({ id: "1", name: "a2" });
        expect((await b.list("/c")).length).toBe(2);
        expect(await b.delete("/c", "nope")).toBe(false);
        expect(await b.delete("/c", "1")).toBe(true);
        expect(await b.delete("/c", "2")).toBe(true);
        // "ever written": an emptied collection is NOT untouched
        expect(await b.has("/c")).toBe(true);
        expect(await b.list("/c")).toEqual([]);
        await b.put("/c", "3", { id: "3" });
        await b.clear();
        expect(await b.has("/c")).toBe(false);
        expect(await b.list("/c")).toEqual([]);
      } finally {
        await b.close();
      }
    });
  }
});

describe("stateful round-trip over memory + sqlite backends", () => {
  const cases: Array<[string, () => Partial<ServerOptions>]> = [
    ["memory", () => ({})],
    ["sqlite", () => ({ state: sqliteFile() })],
  ];

  for (const [kind, extra] of cases) {
    test(`${kind}: POST -> GET -> list -> PATCH -> DELETE -> 404; untouched serves example`, async () => {
      await withServer({ spec: FLAT_SPEC, ...extra() }, async (server, base) => {
        const created = await fetch(`${base}/things`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Crusty" }),
        });
        expect(created.status).toBe(201);
        const item = (await created.json()) as { id: string; name: string };
        expect(item.name).toBe("Crusty");
        expect(item.id).toBeTruthy();
        expect(item.id).not.toBe("seed");

        // the store holds the entity (memory: via the live map; sql: via the backend)
        expect(await server.backend.get("/things", item.id)).toMatchObject({ name: "Crusty" });
        if (kind === "memory") {
          expect(server.state.get("/things")?.size).toBe(1);
        } else {
          expect(server.state.size).toBe(0); // SQL backends leave the map empty
        }

        const got = await fetch(`${base}/things/${item.id}`);
        expect(got.status).toBe(200);
        expect(((await got.json()) as { name: string }).name).toBe("Crusty");

        const list = (await (await fetch(`${base}/things`)).json()) as {
          items: Array<{ id: string }>;
        };
        expect(list.items.some((i) => i.id === item.id)).toBe(true);

        const patched = await fetch(`${base}/things/${item.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed" }),
        });
        expect(patched.status).toBe(200);
        expect(((await patched.json()) as { name: string }).name).toBe("Renamed");

        const del = await fetch(`${base}/things/${item.id}`, { method: "DELETE" });
        expect(del.status).toBe(204);
        expect((await fetch(`${base}/things/${item.id}`)).status).toBe(404);
        // emptied is not untouched: the list is [], not the spec example
        const emptied = (await (await fetch(`${base}/things`)).json()) as { items: unknown[] };
        expect(emptied.items).toEqual([]);

        const untouched = (await (await fetch(`${base}/untouched`)).json()) as { fixed: boolean };
        expect(untouched.fixed).toBe(true);
      });
    });
  }

  test.skipIf(!process.env.CRUST_TEST_PG_URL)("postgres: live e2e round-trip", async () => {
    await withServer(
      { spec: FLAT_SPEC, state: process.env.CRUST_TEST_PG_URL! },
      async (server, base) => {
        await server.resetState();
        const created = await fetch(`${base}/things`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "PG" }),
        });
        expect(created.status).toBe(201);
        const item = (await created.json()) as { id: string };
        expect((await fetch(`${base}/things/${item.id}`)).status).toBe(200);
        expect((await fetch(`${base}/things/${item.id}`, { method: "DELETE" })).status).toBe(204);
        await server.resetState();
      },
    );
  });
});

describe("restart persistence (sqlite)", () => {
  test("a second boot over the same file sees the first boot's rows", async () => {
    const file = sqliteFile();
    let id = "";
    await withServer({ spec: FLAT_SPEC, state: file }, async (_server, base) => {
      const created = await fetch(`${base}/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Survivor" }),
      });
      id = ((await created.json()) as { id: string }).id;
    });

    await withServer({ spec: FLAT_SPEC, state: file }, async (_server, base) => {
      // persisted rows make the collection "touched": list serves rows, not examples
      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ id: string; name: string }>;
      };
      expect(list.items).toEqual([expect.objectContaining({ id, name: "Survivor" })]);
      expect((await fetch(`${base}/things/${id}`)).status).toBe(200);
      // collections with no rows are still untouched after a restart
      const untouched = (await (await fetch(`${base}/untouched`)).json()) as { fixed: boolean };
      expect(untouched.fixed).toBe(true);
    });
  });
});

describe("--seed", () => {
  const seedItems = [{ id: "s-1", name: "Seeded One" }, { name: "No Id Yet" }];

  test("fresh backend seeds and serves the list; missing ids are deterministic", async () => {
    const seedPath = join(dir, "seed-ok.json");
    await writeFile(seedPath, JSON.stringify({ "/things": seedItems }));
    let firstDerivedId = "";
    await withServer({ spec: FLAT_SPEC, seed: seedPath }, async (server, base) => {
      expect(server.seeded).toBe(2);
      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ id: string; name: string }>;
      };
      expect(list.items.length).toBe(2);
      expect(list.items.some((i) => i.id === "s-1")).toBe(true);
      const noId = list.items.find((i) => i.name === "No Id Yet")!;
      // Deterministic content-derived id, not a random uuid — concurrent
      // seeders of a shared store must converge on identical rows.
      expect(noId.id.startsWith("seed-")).toBe(true);
      firstDerivedId = noId.id;
      // seeded collections count as written: item GET hits the store
      expect((await fetch(`${base}/things/s-1`)).status).toBe(200);
      expect((await fetch(`${base}/things/absent`)).status).toBe(404);
    });
    await withServer({ spec: FLAT_SPEC, seed: seedPath }, async (_server, base) => {
      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ id: string; name: string }>;
      };
      expect(list.items.find((i) => i.name === "No Id Yet")!.id).toBe(firstDerivedId);
    });
  });

  test("re-boot with the same seed does not duplicate or clobber (empty-only rule)", async () => {
    const file = sqliteFile();
    const seedPath = join(dir, "seed-reboot.json");
    await writeFile(seedPath, JSON.stringify({ "/things": seedItems }));

    await withServer({ spec: FLAT_SPEC, state: file, seed: seedPath }, async (server, base) => {
      expect(server.seeded).toBe(2);
      const patched = await fetch(`${base}/things/s-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Edited After Seed" }),
      });
      expect(patched.status).toBe(200);
    });

    await withServer({ spec: FLAT_SPEC, state: file, seed: seedPath }, async (server, base) => {
      expect(server.seeded).toBe(0); // rows exist -> seeding skipped entirely
      const list = (await (await fetch(`${base}/things`)).json()) as {
        items: Array<{ id: string; name: string }>;
      };
      expect(list.items.length).toBe(2); // no duplicates
      expect(list.items.find((i) => i.id === "s-1")?.name).toBe("Edited After Seed"); // no clobber
    });
  });

  test("unknown collection key -> boot warning line, not an error", async () => {
    const seedPath = join(dir, "seed-unknown.json");
    await writeFile(seedPath, JSON.stringify({ "/nope": [{ id: "x" }], "/things": [{ id: "y" }] }));
    const logs: string[] = [];
    await withServer(
      { spec: FLAT_SPEC, seed: seedPath, log: (l) => logs.push(l) },
      async (server, base) => {
        expect(server.seeded).toBe(1);
        expect(logs.some((l) => l.includes("'/nope'") && l.includes("matches no route"))).toBe(
          true,
        );
        expect((await fetch(`${base}/things/y`)).status).toBe(200);
      },
    );
  });

  test("invalid seed JSON: startServer rejects; runCli exits 1", async () => {
    const specPath = join(dir, "flat-spec.json");
    await writeFile(specPath, JSON.stringify(FLAT_SPEC));
    const badSeed = join(dir, "seed-bad.json");
    await writeFile(badSeed, "{not json");
    await expect(
      startServer({
        port: 0,
        hostname: "127.0.0.1",
        spec: FLAT_SPEC,
        seed: badSeed,
        log: () => {},
      }),
    ).rejects.toThrow(/not valid JSON/);
    expect(await runCli(["--swagger", specPath, "--seed", badSeed, "--port", "0"])).toBe(1);
    // missing file and non-object shapes are runtime failures too
    expect(
      await runCli(["--swagger", specPath, "--seed", join(dir, "ghost.json"), "--port", "0"]),
    ).toBe(1);
    const arraySeed = join(dir, "seed-array.json");
    await writeFile(arraySeed, JSON.stringify([1, 2]));
    expect(await runCli(["--swagger", specPath, "--seed", arraySeed, "--port", "0"])).toBe(1);
  });
});

describe("resetState + stop", () => {
  const cases: Array<[string, () => string | undefined]> = [
    ["memory", () => undefined],
    ["sqlite", () => sqliteFile()],
  ];

  for (const [kind, stateOf] of cases) {
    test(`${kind}: await resetState() truncates back to untouched`, async () => {
      const state = stateOf();
      await withServer({ spec: FLAT_SPEC, state }, async (server, base) => {
        await fetch(`${base}/things`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ephemeral" }),
        });
        await server.resetState();
        // untouched again: the list is the spec example
        const list = (await (await fetch(`${base}/things`)).json()) as {
          items: Array<{ name: string }>;
        };
        expect(list.items).toEqual([{ id: "seed", name: "Example" }]);
        if (state !== undefined) {
          const rows = (await queryFile(state, "SELECT COUNT(*) AS n FROM crust_mock_state")) as [
            { n: number },
          ];
          expect(Number(rows[0].n)).toBe(0);
        }
      });
    });
  }

  test("stop() closes the backend; the sqlite file is reopenable", async () => {
    const file = sqliteFile();
    await withServer({ spec: FLAT_SPEC, state: file }, async (_server, base) => {
      await fetch(`${base}/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "kept", name: "Kept" }),
      });
    });
    const rows = (await queryFile(
      file,
      "SELECT id FROM crust_mock_state WHERE collection = '/things'",
    )) as Array<{ id: string }>;
    expect(rows).toEqual([{ id: "kept" }]);
  });
});

describe("SQL contract: assert on mock state from plain Bun.SQL", () => {
  test("json_extract over doc returns the BARE entity's fields", async () => {
    const file = sqliteFile();
    await withServer({ spec: WRAPPED_SPEC, state: file }, async (_server, base) => {
      const created = await fetch(`${base}/api/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing: { name: "Crusty" } }),
      });
      expect(created.status).toBe(201);
      await fetch(`${base}/api/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Flat Payload" }),
      });
    });
    // The documented SQL-assert story: the doc column IS the bare entity.
    const rows = (await queryFile(
      file,
      "SELECT json_extract(doc, '$.name') AS name FROM crust_mock_state " +
        "WHERE collection = '/api/things' ORDER BY name",
    )) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["Crusty", "Flat Payload"]);
    const wrapped = (await queryFile(
      file,
      "SELECT json_extract(doc, '$.thing') AS inner_thing FROM crust_mock_state " +
        "WHERE collection = '/api/things'",
    )) as Array<{ inner_thing: unknown }>;
    expect(wrapped.every((r) => r.inner_thing === null)).toBe(true); // stored BARE, not wrapped
  });
});

describe("envelope-aware CRUD", () => {
  test("detectEnvelopeKey: deterministic, flat on ambiguity", () => {
    expect(detectEnvelopeKey({ thing: { name: "x" } })).toBe("thing");
    expect(detectEnvelopeKey({ thing: { id: 1 }, status: "ok" })).toBe("thing"); // scalars allowed
    expect(detectEnvelopeKey({ id: "top", thing: { id: 1 } })).toBeNull(); // top-level id -> flat
    expect(detectEnvelopeKey({ a: { x: 1 }, b: { y: 2 } })).toBeNull(); // two object props
    expect(detectEnvelopeKey({ items: [1, 2] })).toBeNull(); // arrays are not envelopes
    expect(detectEnvelopeKey({})).toBeNull();
    expect(detectEnvelopeKey([{ thing: {} }])).toBeNull();
    expect(detectEnvelopeKey("thing")).toBeNull();
    expect(detectEnvelopeKey(null)).toBeNull();
  });

  test("computeEnvelopes: create/item/req from the wrapped spec; flat spec yields none", () => {
    const envs = computeEnvelopes(buildRoutes(WRAPPED_SPEC), WRAPPED_SPEC);
    expect(envs.get("/api/things")).toEqual({ create: "thing", item: "thing", req: "thing" });
    const flat = computeEnvelopes(buildRoutes(FLAT_SPEC), FLAT_SPEC);
    expect(flat.get("/things")).toBeUndefined();
  });

  test("computeEnvelopes: item falls back to create when the item GET documents no body", () => {
    const spec = structuredClone(WRAPPED_SPEC) as {
      paths: Record<string, Record<string, unknown>>;
    };
    spec.paths["/api/things/{thingId}"]!.get = { responses: { "200": { description: "one" } } };
    const envs = computeEnvelopes(
      buildRoutes(spec as unknown as OpenApiSpec),
      spec as unknown as OpenApiSpec,
    );
    expect(envs.get("/api/things")).toEqual({ create: "thing", item: "thing", req: "thing" });
  });

  test("computeEnvelopes: an explicitly flat item GET wins over the create envelope", () => {
    const spec = structuredClone(WRAPPED_SPEC) as {
      paths: Record<string, Record<string, unknown>>;
    };
    spec.paths["/api/things/{thingId}"]!.get = {
      responses: {
        "200": {
          description: "one",
          content: { "application/json": { example: { id: "seed", name: "Example" } } },
        },
      },
    };
    const envs = computeEnvelopes(
      buildRoutes(spec as unknown as OpenApiSpec),
      spec as unknown as OpenApiSpec,
    );
    expect(envs.get("/api/things")).toEqual({ create: "thing", item: null, req: "thing" });
  });

  test("wrapped POST responds with the envelope, stores the BARE entity, and the id round-trips", async () => {
    await withServer({ spec: WRAPPED_SPEC }, async (server, base) => {
      // request arrives WRAPPED — the req envelope is unwrapped before storing
      const created = await fetch(`${base}/api/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing: { name: "Crusty" } }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { thing: { id: string; name: string } };
      expect(body.thing.name).toBe("Crusty");
      expect(body.thing.id).toBeTruthy();
      expect(body.thing.id).not.toBe("seed"); // the pre-fix hybrid leaked the example id

      // the store holds the BARE entity — no envelope key, no stale fields
      const stored = await server.backend.get("/api/things", body.thing.id);
      expect(stored).toEqual({ id: body.thing.id, name: "Crusty" });

      // the captured id round-trips through every item verb
      const got = await fetch(`${base}/api/things/${body.thing.id}`);
      expect(got.status).toBe(200);
      expect(((await got.json()) as { thing: { name: string } }).thing.name).toBe("Crusty");

      const list = (await (await fetch(`${base}/api/things`)).json()) as {
        things: Array<{ id: string }>;
      };
      expect(list.things).toEqual([{ id: body.thing.id, name: "Crusty" }]);

      const patched = await fetch(`${base}/api/things/${body.thing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing: { name: "Renamed" } }),
      });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { thing: { name: string } }).thing.name).toBe("Renamed");
      expect(await server.backend.get("/api/things", body.thing.id)).toEqual({
        id: body.thing.id,
        name: "Renamed",
      });

      const del = await fetch(`${base}/api/things/${body.thing.id}`, { method: "DELETE" });
      expect(del.status).toBe(204);
      expect((await fetch(`${base}/api/things/${body.thing.id}`)).status).toBe(404);
    });
  });

  test("a FLAT request body against a wrapped spec still creates correctly", async () => {
    await withServer({ spec: WRAPPED_SPEC }, async (server, base) => {
      const created = await fetch(`${base}/api/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bare Body" }),
      });
      const body = (await created.json()) as { thing: { id: string; name: string } };
      expect(body.thing.name).toBe("Bare Body");
      expect(await server.backend.get("/api/things", body.thing.id)).toEqual({
        id: body.thing.id,
        name: "Bare Body",
      });
    });
  });

  test("a client-supplied id inside the envelope is honored", async () => {
    await withServer({ spec: WRAPPED_SPEC }, async (_server, base) => {
      const created = await fetch(`${base}/api/things`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thing: { id: "mine-1", name: "Chosen" } }),
      });
      const body = (await created.json()) as { thing: { id: string } };
      expect(body.thing.id).toBe("mine-1");
      expect((await fetch(`${base}/api/things/mine-1`)).status).toBe(200);
    });
  });
});

describe("cli --state/--seed args", () => {
  // A path that cannot load — proves conflicts and scheme checks run BEFORE loadSpec
  // (a load attempt would exit 1, not 2).
  const ghostSpec = "/definitely/not/here.json";

  test("--state + --proxy exit 2 before spec load", async () => {
    expect(
      await runCli(["--swagger", ghostSpec, "--state", "x.sqlite", "--proxy", "http://u"]),
    ).toBe(2);
  });

  test("--seed + --proxy exit 2 before spec load", async () => {
    expect(await runCli(["--swagger", ghostSpec, "--seed", "s.json", "--proxy", "http://u"])).toBe(
      2,
    );
  });

  test("unsupported --state scheme exits 2 before spec load", async () => {
    expect(await runCli(["--swagger", ghostSpec, "--state", "redis://localhost/0"])).toBe(2);
    expect(await runCli(["--swagger", ghostSpec, "--state=mysql://u@h/db"])).toBe(2);
  });

  test("--seed implies --stateful (a seeded server answers from the store)", async () => {
    // via the options layer: no `stateful: true`, only `seed`
    const seedPath = join(dir, "seed-implies.json");
    await writeFile(seedPath, JSON.stringify({ "/things": [{ id: "imp-1", name: "Implied" }] }));
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      spec: FLAT_SPEC,
      seed: seedPath,
      log: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/things/imp-1`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { name: string }).name).toBe("Implied");
    } finally {
      await server.stop();
    }
  });
});

type SqlFileClient = {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
};

/** Open a sqlite state file the documented way — plain Bun.SQL, no crust code. */
async function queryFile(path: string, query: string): Promise<unknown[]> {
  const url = path.includes("://") ? path : `sqlite://${path}`;
  const Ctor = (Bun as unknown as { SQL: new (u: string) => SqlFileClient }).SQL;
  const client = new Ctor(url);
  try {
    return await client.unsafe(query);
  } finally {
    await client.close();
  }
}

describe("review fixes — state backend", () => {
  test("normalizeStateUrl canonicalizes scheme case", async () => {
    const { normalizeStateUrl, stateDialect } = await import("../src/mockServer/state");
    expect(normalizeStateUrl("SQLITE://./x.db")).toBe("sqlite://./x.db");
    expect(stateDialect(normalizeStateUrl("SQLITE://./x.db"))).toBe("sqlite");
  });

  test("has() survives delete-all across a fresh backend over the same file", async () => {
    const { SqlStateBackend } = await import("../src/mockServer/state");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = await mkdtemp(join(tmpdir(), "crust-touch-"));
    try {
      const file = join(d, "s.sqlite");
      const a = new SqlStateBackend(`sqlite://${file}`);
      await a.put("/api/things", "1", { id: "1" });
      await a.delete("/api/things", "1");
      await a.close();
      // A different process (fresh backend, empty in-memory Set) must still
      // know the collection was written — emptied ≠ untouched.
      const b = new SqlStateBackend(`sqlite://${file}`);
      expect(await b.has("/api/things")).toBe(true);
      await b.clear();
      expect(await b.has("/api/things")).toBe(false);
      await b.close();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("a failed open is retryable, not cached", async () => {
    const { SqlStateBackend } = await import("../src/mockServer/state");
    const bad = new SqlStateBackend("postgres://nobody@127.0.0.1:1/nope");
    await expect(bad.get("/x", "1")).rejects.toThrow();
    // Second call must attempt again (fresh rejection, not the cached one).
    await expect(bad.get("/x", "1")).rejects.toThrow();
    await bad.close();
  });
});
