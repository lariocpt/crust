// `mongo "<expr>"` — MongoDB as a pipeline citizen, shaped after `sql`.
//
// The expression is evaluated against a live `db` handle (same trusted-eval
// stance as lambdas and `procs`: this is an interactive shell evaluating the
// user's own typed code). A cursor is drained with toArray() so each document
// becomes its own item; a write command yields its result object as one item.
//
// Two shipped binaries, one source tree:
// - the CLEAN binary stays zero-dependency and does NOT carry the driver;
//   using `mongo` there is a loud redirect to the mongo variant, never a
//   mystery. (Measured 2026-11-12, Bun 1.4.3/1.4.4-canary: a compiled binary
//   cannot resolve bare npm specifiers from files OUTSIDE the bundle — the
//   old G13 shim trick fails for mongodb because of its own `bson` dep — so
//   runtime loading from the user's project is not a path that works.)
// - the MONGO variant (src/index-mongo.ts) statically bundles the driver at
//   build time and registers it through setBundledMongo(); it just works.
// Running from source resolves the driver normally via node_modules.

/** What `mongo` prints in a binary that has no driver (the clean build). */
export const MONGO_VARIANT_HINT =
  "mongo: this crust binary has no mongo support — install the mongo variant: " +
  "npm i -g @lariocpt/crust-mongo (or curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash -s -- crust-mongo)";

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

/**
 * Set by src/mongo-bundled.ts — compiled ONLY into the -mongo variant, where
 * the driver is statically bundled and handed over here before index.ts runs.
 */
let bundledMongo: { MongoClient: new (uri: string) => MongoClientLike } | null = null;
export function setBundledMongo(
  m: { MongoClient: new (uri: string) => MongoClientLike } | null,
): void {
  bundledMongo = m;
  cachedDb = null;
}

/**
 * A compiled Bun binary reports its virtual bundle entry as argv[1]
 * (/$bunfs/root/<name>); source runs report the real script path. Measured
 * 2026-11-12, Bun 1.4.3 — import.meta.url is NOT the signal: it keeps
 * reporting the original source path even inside the binary.
 */
function isCompiled(): boolean {
  return (process.argv[1] ?? "").includes("$bunfs");
}

async function resolveDriver(): Promise<{ MongoClient: new (uri: string) => MongoClientLike }> {
  if (bundledMongo) return bundledMongo;
  if (isCompiled()) {
    // Clean binary: the driver cannot be loaded at runtime from outside the
    // bundle (measured — see header). Point at the variant that ships it.
    throw new Error(MONGO_VARIANT_HINT);
  }
  // Source mode: the specifier goes through a variable on purpose — a literal
  // would make tsc demand @types/mongodb for the zero-dependency clean build.
  const driverSpec = "mongodb";
  try {
    return await import(driverSpec);
  } catch {
    throw new Error(
      "mongo: needs the mongodb driver — bun add mongodb in the crust source tree (or install the mongo variant)",
    );
  }
}

async function getDb(): Promise<MongoDbLike> {
  if (cachedDb) return cachedDb;
  const url = process.env.MONGODB_URI ?? process.env.MONGO_URL;
  if (!url) {
    throw new Error("mongo: no connection (set $MONGODB_URI)");
  }
  const mongodb = await resolveDriver();
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
