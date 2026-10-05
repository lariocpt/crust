type BunSqlTemplate = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>) & {
  unsafe?: (query: string, params?: unknown[]) => Promise<unknown[]>;
};
type BunSqlCtor = new (url: string) => BunSqlTemplate;

let cachedClient: BunSqlTemplate | null = null;

function getClient(): BunSqlTemplate {
  if (cachedClient) return cachedClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("sql: no connection (set $DATABASE_URL)");
  }
  const SQL = (Bun as unknown as { SQL?: BunSqlCtor; sql?: BunSqlTemplate }).SQL;
  const bunSql = (Bun as unknown as { sql?: BunSqlTemplate }).sql;
  if (SQL) {
    cachedClient = new SQL(url);
    return cachedClient;
  }
  if (bunSql && bunSql.unsafe) {
    cachedClient = bunSql;
    return cachedClient;
  }
  throw new Error("sql: this Bun build has no Bun.SQL or Bun.sql.unsafe support");
}

async function runQuery(query: string, params: unknown[]): Promise<unknown[]> {
  if (!query.trim()) throw new Error("sql: missing query");
  const client = getClient();
  if (!client.unsafe) {
    throw new Error("sql: client missing .unsafe — parameterised query unsupported");
  }
  return client.unsafe(query, params);
}

function queryOf(arg: unknown): string {
  return arg === undefined || arg === null ? "" : String(arg);
}

/**
 * `sql "<query>" [params…]` as the FIRST stage: every declared argument
 * belongs to the query, there is no upstream item.
 */
export function sqlSource(args: unknown[]): Promise<unknown[]> {
  const [query, ...params] = args;
  return runQuery(queryOf(query), params);
}

/**
 * `… | sql "<query>" [params…]` MID-PIPELINE. The declared arguments are
 * separate from the piped item on purpose: the parser calls a mid-pipeline
 * function as `fn(item, ...declaredArgs)`, so reading the arguments positionally
 * and guessing which one is the query means an upstream item that happens to be
 * a string takes the query's slot — the declared query is discarded and the
 * item is executed instead (silently, exit 0, when the item is valid SQL).
 */
export function sqlStage(args: unknown[], item: unknown): Promise<unknown[]> {
  const [query, ...declared] = args;
  // Bind the piped item as the first parameter when the line declares none.
  // It used to be dropped on the floor, so `range(1,1) | sql "… WHERE id = ?"`
  // ran with zero params and returned [] — indistinguishable from "no rows
  // matched". An explicitly declared parameter still wins.
  const params = declared.length === 0 && item !== undefined && item !== null ? [item] : declared;
  return runQuery(queryOf(query), params);
}

/**
 * The generic registered-function entry point. `sqlSource`/`sqlStage` are what
 * the pipeline actually calls; this stays for anything that resolves `sql` out
 * of the context and calls it directly.
 */
export async function sql(...args: unknown[]): Promise<unknown[] | unknown> {
  if (args.length === 0) throw new Error("sql: missing query");
  const first = args[0];
  if (typeof first === "string") {
    return runQuery(first, args.slice(1));
  }
  // Mid-pipeline: the parser calls fn(item, ...declaredArgs), so args[0] is
  // the UPSTREAM ITEM and args[1] is the query.
  return sqlStage(args.slice(1), first);
}
