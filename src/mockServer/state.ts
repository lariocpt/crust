/**
 * State backends for mock-server --stateful.
 *
 * The default backend is the in-process Map the server has always used; the
 * SQL backend persists the same CRUD state to sqlite or postgres via Bun.SQL
 * so it survives restarts and can be shared (and asserted on) cross-process.
 *
 * Public table contract (documented in docs/USAGE.md — treat as API):
 *   crust_mock_state (collection TEXT, id TEXT, doc TEXT|JSONB,
 *                     updated_at TEXT|timestamptz, PRIMARY KEY (collection, id))
 * Docs are stored as the BARE entity (envelopes stripped), last write wins.
 */

/** collection template -> (id -> stored bare entity) */
export type StateStore = Map<string, Map<string, Record<string, unknown>>>;

export interface StateBackend {
  get(collection: string, id: string): Promise<Record<string, unknown> | null>;
  list(collection: string): Promise<Record<string, unknown>[]>;
  /** "Ever written" — drives the untouched-collections-serve-examples rule. */
  has(collection: string): Promise<boolean>;
  put(collection: string, id: string, doc: Record<string, unknown>): Promise<void>;
  delete(collection: string, id: string): Promise<boolean>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** Wraps the live StateStore Map — the same instance stays exposed as RunningServer.state. */
export class MemoryStateBackend implements StateBackend {
  constructor(private readonly map: StateStore) {}

  async get(collection: string, id: string): Promise<Record<string, unknown> | null> {
    return this.map.get(collection)?.get(id) ?? null;
  }

  async list(collection: string): Promise<Record<string, unknown>[]> {
    const c = this.map.get(collection);
    return c ? [...c.values()] : [];
  }

  async has(collection: string): Promise<boolean> {
    return this.map.has(collection);
  }

  async put(collection: string, id: string, doc: Record<string, unknown>): Promise<void> {
    let c = this.map.get(collection);
    if (!c) {
      c = new Map();
      this.map.set(collection, c);
    }
    c.set(id, doc);
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.map.get(collection)?.delete(id) ?? false;
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async close(): Promise<void> {}
}

export type SqlDialect = "sqlite" | "postgres";

export interface StateSqlStrings {
  ddl: string;
  ddlTouched: string;
  upsert: string;
  touch: string;
  get: string;
  list: string;
  has: string;
  hasTouched: string;
  del: string;
  clear: string;
  clearTouched: string;
}

/**
 * The exact SQL each dialect runs — exported so tests can pin the public
 * table contract without a live database.
 */
export function stateSql(dialect: SqlDialect): StateSqlStrings {
  if (dialect === "sqlite") {
    return {
      ddl:
        "CREATE TABLE IF NOT EXISTS crust_mock_state (" +
        "collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT, " +
        "updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))",
      ddlTouched: "CREATE TABLE IF NOT EXISTS crust_mock_touched (collection TEXT PRIMARY KEY)",
      upsert:
        "INSERT OR REPLACE INTO crust_mock_state (collection, id, doc, updated_at) " +
        "VALUES (?, ?, ?, ?)",
      touch: "INSERT OR IGNORE INTO crust_mock_touched (collection) VALUES (?)",
      get: "SELECT doc FROM crust_mock_state WHERE collection = ? AND id = ?",
      list: "SELECT doc FROM crust_mock_state WHERE collection = ? ORDER BY updated_at, id",
      has: "SELECT 1 AS present FROM crust_mock_state WHERE collection = ? LIMIT 1",
      hasTouched: "SELECT 1 AS present FROM crust_mock_touched WHERE collection = ? LIMIT 1",
      del: "DELETE FROM crust_mock_state WHERE collection = ? AND id = ? RETURNING id",
      clear: "DELETE FROM crust_mock_state",
      clearTouched: "DELETE FROM crust_mock_touched",
    };
  }
  return {
    ddl:
      "CREATE TABLE IF NOT EXISTS crust_mock_state (" +
      "collection TEXT NOT NULL, id TEXT NOT NULL, doc JSONB, " +
      "updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))",
    ddlTouched: "CREATE TABLE IF NOT EXISTS crust_mock_touched (collection TEXT PRIMARY KEY)",
    upsert:
      "INSERT INTO crust_mock_state (collection, id, doc) VALUES ($1, $2, $3::jsonb) " +
      "ON CONFLICT (collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
    touch: "INSERT INTO crust_mock_touched (collection) VALUES ($1) ON CONFLICT DO NOTHING",
    get: "SELECT doc FROM crust_mock_state WHERE collection = $1 AND id = $2",
    list: "SELECT doc FROM crust_mock_state WHERE collection = $1 ORDER BY updated_at, id",
    has: "SELECT 1 AS present FROM crust_mock_state WHERE collection = $1 LIMIT 1",
    hasTouched: "SELECT 1 AS present FROM crust_mock_touched WHERE collection = $1 LIMIT 1",
    del: "DELETE FROM crust_mock_state WHERE collection = $1 AND id = $2 RETURNING id",
    clear: "DELETE FROM crust_mock_state",
    clearTouched: "DELETE FROM crust_mock_touched",
  };
}

type SqlClient = {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
};
type SqlCtor = new (url: string) => SqlClient;

// Deliberately NOT src/builtinFns/sql.ts's process-global client: state must
// bind to the server's own URL and lifecycle, not $DATABASE_URL.
function createSqlClient(url: string): SqlClient {
  const SQL = (Bun as unknown as { SQL?: SqlCtor }).SQL;
  if (!SQL) throw new Error("this Bun build has no Bun.SQL support");
  return new SQL(url);
}

/**
 * One implementation for both dialects: Bun.SQL speaks sqlite:// and
 * postgres:// through the same client, and `unsafe(sql, params)` covers the
 * placeholder-style difference. Reads go through to the database on every
 * request (no cache) — cross-process sharing depends on it; last write wins.
 */
export class SqlStateBackend implements StateBackend {
  readonly dialect: SqlDialect;
  private readonly sql: StateSqlStrings;
  // Fast path for collections written by THIS process; the persisted
  // crust_mock_touched table carries the same "ever written" fact across
  // processes and restarts, so a delete-emptied collection keeps 404ing
  // (never reverts to spec examples) no matter who emptied it.
  private readonly touched = new Set<string>();
  private ready: Promise<SqlClient> | null = null;

  constructor(readonly url: string) {
    this.dialect = stateDialect(url);
    this.sql = stateSql(this.dialect);
  }

  // Lazy open + idempotent DDL, function-wrapped (never top-level await —
  // that breaks --bytecode compiles). A failed open is NOT cached: the next
  // call retries instead of serving the stale rejection forever.
  private ensure(): Promise<SqlClient> {
    this.ready ??= (async () => {
      const client = createSqlClient(this.url);
      await client.unsafe(this.sql.ddl);
      await client.unsafe(this.sql.ddlTouched);
      return client;
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async get(collection: string, id: string): Promise<Record<string, unknown> | null> {
    const client = await this.ensure();
    const rows = (await client.unsafe(this.sql.get, [collection, id])) as Array<{ doc: unknown }>;
    return rows.length > 0 ? parseDoc(rows[0]!.doc) : null;
  }

  async list(collection: string): Promise<Record<string, unknown>[]> {
    const client = await this.ensure();
    const rows = (await client.unsafe(this.sql.list, [collection])) as Array<{ doc: unknown }>;
    return rows.map((r) => parseDoc(r.doc));
  }

  async has(collection: string): Promise<boolean> {
    if (this.touched.has(collection)) return true;
    const client = await this.ensure();
    const rows = await client.unsafe(this.sql.has, [collection]);
    if (rows.length > 0) return true;
    const marks = await client.unsafe(this.sql.hasTouched, [collection]);
    return marks.length > 0;
  }

  async put(collection: string, id: string, doc: Record<string, unknown>): Promise<void> {
    const client = await this.ensure();
    const params =
      this.dialect === "sqlite"
        ? [collection, id, JSON.stringify(doc), new Date().toISOString()]
        : [collection, id, JSON.stringify(doc)];
    await client.unsafe(this.sql.upsert, params);
    await client.unsafe(this.sql.touch, [collection]);
    this.touched.add(collection);
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const client = await this.ensure();
    const rows = await client.unsafe(this.sql.del, [collection, id]);
    await client.unsafe(this.sql.touch, [collection]);
    this.touched.add(collection);
    return rows.length > 0;
  }

  async clear(): Promise<void> {
    const client = await this.ensure();
    await client.unsafe(this.sql.clear);
    await client.unsafe(this.sql.clearTouched);
    this.touched.clear();
  }

  async close(): Promise<void> {
    if (!this.ready) return;
    const client = await this.ready;
    this.ready = null;
    await client.close();
  }
}

function parseDoc(doc: unknown): Record<string, unknown> {
  // sqlite stores TEXT; postgres JSONB comes back already parsed.
  if (typeof doc === "string") return JSON.parse(doc) as Record<string, unknown>;
  if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
  return {};
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Normalize a --state value to a connection URL. Bare paths become
 * sqlite://<path>; sqlite/postgres URLs pass through; anything else throws
 * (the CLI maps that to exit 2).
 */
export function normalizeStateUrl(state: string): string {
  const m = SCHEME.exec(state);
  if (!m) return `sqlite://${state}`;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "sqlite" || scheme === "postgres" || scheme === "postgresql") {
    // Canonicalize the scheme so dialect detection downstream can't disagree
    // with the check here (SQLITE://x must not open as postgres).
    return scheme + state.slice(m[1]!.length);
  }
  throw new Error(
    `unsupported --state scheme '${scheme}:' (use a file path, sqlite://, or postgres://)`,
  );
}

export function stateDialect(url: string): SqlDialect {
  return url.toLowerCase().startsWith("sqlite:") ? "sqlite" : "postgres";
}

/**
 * undefined -> memory backend over a fresh Map (the map IS the live store);
 * anything else -> SQL backend (map stays an empty placeholder so
 * RunningServer.state keeps its shape).
 */
export function openStateBackend(state: string | undefined): {
  backend: StateBackend;
  map: StateStore;
} {
  const map: StateStore = new Map();
  if (state === undefined) return { backend: new MemoryStateBackend(map), map };
  return { backend: new SqlStateBackend(normalizeStateUrl(state)), map };
}
