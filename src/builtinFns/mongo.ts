// `mongo "<expr>"` — MongoDB as a pipeline citizen, shaped after `sql`.
//
// The expression is evaluated against a live `db` handle (same trusted-eval
// stance as lambdas and `procs`: this is an interactive shell evaluating the
// user's own typed code). A cursor is drained with toArray() so each document
// becomes its own item; a write command yields its result object as one item.
//
// The driver is NOT bundled — the crust bundle stays zero-dependency.
// Resolution (all measured 2026-11-12 against a compiled --bytecode binary):
// a bare dynamic import resolves from the binary's virtual /$bunfs/root, NOT
// the process cwd, and importing the package by absolute path fails on the
// driver's own deps ("Cannot find package 'bson'"). What works is the same
// mechanism the fixture plane uses (G13): import a REAL file inside the user's
// project — its own bare imports resolve from its real location with full
// package context. So the fallback writes a one-line shim
// (`export * from "mongodb"`) into the project root, imports it, and removes
// it. A missing driver is a loud, actionable error, never a mystery.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The screen `mongo --help` prints at parse time (same contract as sqlUsage). */
export const mongoUsage =
  'usage: mongo "<expr>"\n' +
  "  expr    an expression on `db` — db.users.find({active: true}).limit(10)\n" +
  "          $MONGODB_URI selects the server; $MONGODB_DB the database (else the URI's)\n" +
  '  mid-pipeline the upstream item is bound as `item` — read docs.json | mongo "db.users.insertMany(item)"';

interface MongoCursorLike {
  toArray(): Promise<unknown[]>;
}

interface MongoDbLike {
  collection(name: string): unknown;
}

/**
 * mongosh sugar, driver reality: `db.widgets.find(…)` only works in the
 * mongo SHELL — the Node driver needs `db.collection("widgets")`. The proxy
 * gives expressions the shell shape: an unknown string property resolves to
 * a collection, everything the real Db owns (methods, symbols) passes
 * through untouched.
 */
function shellDb(db: MongoDbLike): unknown {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return target.collection(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface MongoClientLike {
  db(name?: string): MongoDbLike;
  connect(): Promise<unknown>;
  /** keep the socket from holding a one-shot crust run open (driver >= 4.x) */
  unref?(): void;
}

let cachedDb: MongoDbLike | null = null;

/** Walk up from the process cwd for an installed driver, import it for real. */
async function importFromCwd(): Promise<{ MongoClient: new (uri: string) => MongoClientLike }> {
  let dir = process.cwd();
  while (true) {
    const pkg = join(dir, "node_modules", "mongodb");
    if (existsSync(pkg)) {
      // The shim is what makes this work from a COMPILED binary: importing
      // the package directory or a deep file from inside the bundle fails
      // (bunfs-root resolution); importing a real file in the project works,
      // and the shim's own `from "mongodb"` resolves with full package
      // context. Same content every time, so concurrent runs cannot fight
      // over meaning; the file is removed as soon as the import resolves.
      const shim = join(dir, ".crust-mongo-shim.mjs");
      try {
        await Bun.write(shim, 'export * from "mongodb";\n');
        return await import(shim);
      } finally {
        await rm(shim, { force: true }).catch(() => {});
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "mongo: needs the mongodb driver — bun add mongodb (or npm i mongodb) " +
      "in the project you run crust from",
  );
}

async function getDb(): Promise<MongoDbLike> {
  if (cachedDb) return cachedDb;
  const url = process.env.MONGODB_URI ?? process.env.MONGO_URL;
  if (!url) {
    throw new Error("mongo: no connection (set $MONGODB_URI)");
  }
  let mongodb: { MongoClient: new (uri: string) => MongoClientLike };
  try {
    // The specifier goes through a variable on purpose: a literal would make
    // tsc demand @types/mongodb in the zero-dependency bundle. This path
    // serves source-mode runs whose tree can see the driver; the shipped
    // binary falls to the shim below (bunfs-root resolution).
    const driverSpec = "mongodb";
    mongodb = await import(driverSpec);
  } catch {
    mongodb = await importFromCwd();
  }
  const client = new mongodb.MongoClient(url);
  await client.connect();
  // unref so a one-shot `crust -c 'mongo …'` exits after the run instead of
  // waiting on the driver's pooled sockets; the REPL keeps the cached client.
  client.unref?.();
  try {
    cachedDb = shellDb(client.db(process.env.MONGODB_DB || undefined)) as MongoDbLike;
  } catch {
    // The driver throws when neither the URI nor an argument names a database.
    throw new Error(
      "mongo: no database — set $MONGODB_DB or include one in $MONGODB_URI (mongodb://host/mydb)",
    );
  }
  return cachedDb;
}

function exprOf(arg: unknown): string {
  if (arg === undefined || arg === null || arg === "") {
    throw new Error('mongo: missing expression (try: mongo "db.coll.find({})")');
  }
  return String(arg);
}

async function runExpr(expr: string, item: unknown): Promise<unknown[]> {
  // Build the function BEFORE connecting: a syntax error is about the line,
  // not the database, and must not wait on (or fail behind) a network call.
  // The item binding is `item`, NOT `$item`: registered-fn arguments go
  // through expandEnv (that is how $1 positionals reach `sql`), which would
  // silently eat `$item` into "" whenever no such env var exists.
  let fn: (db: MongoDbLike, item: unknown) => unknown;
  try {
    fn = new Function("db", "item", `return (${expr});`) as typeof fn;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`mongo: bad expression "${expr}" — ${msg}`);
  }
  const db = await getDb();
  let value: unknown;
  try {
    value = fn(db, item);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`mongo: expression failed "${expr}" — ${msg}`);
  }
  // A cursor (find/aggregate) drains into one item per document; anything
  // else (insertOne/updateMany/deleteMany/…) is a single awaited result.
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as MongoCursorLike).toArray === "function"
  ) {
    return (value as MongoCursorLike).toArray();
  }
  return [await value];
}

/**
 * `mongo "<expr>"` as the FIRST stage: no upstream item, `item` is undefined.
 */
export function mongoSource(args: unknown[]): Promise<unknown[]> {
  return runExpr(exprOf(args[0]), undefined);
}

/**
 * `… | mongo "<expr>"` MID-PIPELINE. The parser calls a mid-pipeline function
 * as fn(item, ...declaredArgs) — same identity-dispatch shape as sqlStage —
 * and binds the piped item as `item` in the expression.
 */
export function mongoStage(args: unknown[], item: unknown): Promise<unknown[]> {
  return runExpr(exprOf(args[0]), item);
}

/**
 * The generic registered-function entry point; the pipeline calls
 * mongoSource/mongoStage via identity dispatch. Kept for anything that
 * resolves `mongo` out of the context and calls it directly.
 */
export async function mongo(...args: unknown[]): Promise<unknown[] | unknown> {
  if (args.length === 0) throw new Error("mongo: missing expression");
  const first = args[0];
  if (typeof first === "string") {
    return runExpr(first, undefined);
  }
  return mongoStage(args.slice(1), first);
}

/** Test seam: drop the cached client so env changes take effect. */
export function __resetMongoClientForTests(): void {
  cachedDb = null;
}
