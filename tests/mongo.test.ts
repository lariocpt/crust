// `mongo "<expr>"` — MongoDB as a registered builtin fn, shaped after sql.
//
// The always-run cases pin the loud-failure contract: no connection, a bad
// expression (checked BEFORE any network call), a missing expression, and a
// missing driver. The round-trip cases run only when $MONGODB_URI points at a
// real server — mongo has no embedded mode like sql's sqlite trick, so
// integration is opt-in by design.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerBuiltinFns } from "../src/builtinFns";
import {
  __resetMongoClientForTests,
  MONGO_VARIANT_HINT,
  setBundledMongo,
} from "../src/builtinFns/mongo";
import { parse } from "../src/parser";
import type { Context } from "../src/types";

const ENTRY = `${import.meta.dir}/../src/index.ts`;

// The driver is "present" when node_modules can see it from the repo — it is
// a devDependency now, so in-repo runs always have it; the guard keeps the
// missing-driver case honest in stripped checkouts.
let driverPresent = false;
{
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, "node_modules", "mongodb"))) {
      driverPresent = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const liveUri = process.env.MONGODB_URI;

const savedUri = process.env.MONGODB_URI;
const savedUrl = process.env.MONGO_URL;
const savedDb = process.env.MONGODB_DB;

function setEnv(uri: string | undefined, db?: string) {
  if (uri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = uri;
  if (db === undefined) delete process.env.MONGODB_DB;
  else process.env.MONGODB_DB = db;
  delete process.env.MONGO_URL;
  __resetMongoClientForTests();
}

function freshCtx(): Context {
  const c = { aliases: new Map(), functions: new Map(), history: [] } as unknown as Context;
  registerBuiltinFns(c);
  return c;
}

async function run(line: string): Promise<unknown[]> {
  return (await parse(line)(freshCtx()).collect()) as unknown[];
}

beforeAll(() => {
  delete process.env.MONGO_URL;
});

afterAll(() => {
  if (savedUri === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = savedUri;
  if (savedUrl === undefined) delete process.env.MONGO_URL;
  else process.env.MONGO_URL = savedUrl;
  if (savedDb === undefined) delete process.env.MONGODB_DB;
  else process.env.MONGODB_DB = savedDb;
  __resetMongoClientForTests();
});

describe("mongo registration & help", () => {
  test("mongo is registered as a builtin fn", () => {
    const c = { aliases: new Map(), functions: new Map(), history: [] } as unknown as Context;
    registerBuiltinFns(c);
    expect(typeof c.functions.get("mongo")).toBe("function");
  });

  test("mongo --help: usage on stdout, exit 0, no connection needed", async () => {
    const proc = Bun.spawn(["bun", ENTRY, "-c", "mongo --help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CRUST_CONFIG: "/dev/null", MONGODB_URI: "" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("usage: mongo");
    expect(stderr).toBe("");
  });
});

describe("mongo loud failures (no server needed)", () => {
  test("no connection names the env var", async () => {
    setEnv(undefined);
    await expect(run(`mongo "db.users.find({})"`)).rejects.toThrow(
      /mongo: no connection \(set \$MONGODB_URI\)/,
    );
  });

  test("MONGO_URL is accepted as the fallback name", async () => {
    setEnv(undefined);
    // Invalid (not unreachable): the driver rejects it at construction, so the
    // run fails on the URI — proof the fallback name was accepted, fast.
    process.env.MONGO_URL = "not-a-valid-uri";
    const err = await run(`mongo "db.users.find({})"`).catch((e: Error) => e.message);
    expect(typeof err).toBe("string");
    expect(err).not.toContain("no connection");
  });

  test("a syntax error is about the line, checked before any network call", async () => {
    // Bogus unreachable URI on purpose: the complaint must be the expression,
    // not a connection timeout or refusal.
    setEnv("mongodb://127.0.0.1:1/x");
    await expect(run(`mongo "db..find("`)).rejects.toThrow(/mongo: bad expression/);
  });

  test("a missing expression is loud, not an empty result", async () => {
    setEnv("mongodb://127.0.0.1:1/x");
    await expect(run(`mongo ""`)).rejects.toThrow(/mongo: missing expression/);
  });

  test.skipIf(driverPresent)("a missing driver names the fix", async () => {
    setEnv("mongodb://127.0.0.1:1/x");
    await expect(run(`mongo "db.users.find({})"`)).rejects.toThrow(
      /needs the mongodb driver — bun add mongodb/,
    );
  });

  test("a registered bundled driver is used instead of any import", async () => {
    // The -mongo variant hands the statically bundled driver over through
    // setBundledMongo; this fake proves the seam wins over resolution and
    // that the shell-sugar proxy works on any driver-shaped object.
    const calls: string[] = [];
    class FakeClient {
      constructor(uri: string) {
        calls.push(`ctor:${uri}`);
      }
      async connect() {
        calls.push("connect");
      }
      unref() {
        calls.push("unref");
      }
      db(name?: string) {
        calls.push(`db:${name ?? ""}`);
        return {
          collection(name: string) {
            calls.push(`coll:${name}`);
            return {
              find: (q: unknown) => ({ toArray: async () => [{ ok: 1, q }] }),
            };
          },
        };
      }
    }
    setBundledMongo({
      MongoClient: FakeClient as unknown as new (uri: string) => never,
    });
    try {
      setEnv("mongodb://fake/ignored", "seamdb");
      const out = await run(`mongo "db.widgets.find({a: 1})"`);
      expect(out).toEqual([{ ok: 1, q: { a: 1 } }]);
      expect(calls).toContain("ctor:mongodb://fake/ignored");
      expect(calls).toContain("db:seamdb");
      expect(calls).toContain("coll:widgets");
      expect(calls).toContain("unref");
    } finally {
      setBundledMongo(null);
      __resetMongoClientForTests();
    }
  });

  test("the clean-binary redirect names the mongo variant package", () => {
    // The compiled clean binary cannot load the driver at runtime (measured);
    // its mongo error must point at the installable variant. The $bunfs branch
    // itself only fires inside a compiled binary — the release workflow
    // verifies that end to end; here the contract is the message itself.
    expect(MONGO_VARIANT_HINT).toContain("@lariocpt/crust-mongo");
    expect(MONGO_VARIANT_HINT).toContain("crust-mongo");
  });
});

describe("mongo integration (needs $MONGODB_URI)", () => {
  let dir: string;
  const db = `crust_test_${Date.now()}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-mongo-"));
    if (liveUri) setEnv(liveUri, db);
  });

  afterAll(async () => {
    if (liveUri) {
      // Best-effort cleanup of the test database.
      try {
        const spec = "mongodb";
        const { MongoClient } = (await import(spec)) as {
          MongoClient: new (
            uri: string,
          ) => {
            connect(): Promise<unknown>;
            db(name: string): { dropDatabase(): Promise<unknown> };
            close(): Promise<void>;
          };
        };
        const client = new MongoClient(liveUri);
        await client.connect();
        await client.db(db).dropDatabase();
        await client.close();
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  });

  const t = liveUri ? test : test.skip;

  t("source: insert then find streams one item per document", async () => {
    await run(`mongo "db.widgets.insertMany([{n: 1}, {n: 2}, {n: 3}])"`);
    const out = await run(`mongo "db.widgets.find({}).sort({n: 1})"`);
    expect(out.length).toBe(3);
    expect((out[0] as { n: number }).n).toBe(1);
  });

  t("mid-pipeline binds the piped item as item", async () => {
    await Bun.write(join(dir, "docs.json"), JSON.stringify([{ n: 10 }, { n: 11 }]));
    const out = await run(
      `read ${join(dir, "*.json")} | (s => JSON.parse(s)) | mongo "db.gadgets.insertMany(item)"`,
    );
    expect(out.length).toBe(1);
    const found = await run(`mongo "db.gadgets.find({})"`);
    expect(found.length).toBe(2);
  });

  t("cursor chaining (.limit) yields the capped set", async () => {
    const out = await run(`mongo "db.widgets.find({}).limit(2)"`);
    expect(out.length).toBe(2);
  });

  t("a bad method is a labelled expression failure, not a stack dump", async () => {
    await expect(run(`mongo "db.widgets.findNotExisting({})"`)).rejects.toThrow(
      /mongo: expression failed/,
    );
  });
});
