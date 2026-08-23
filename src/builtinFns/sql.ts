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

export async function sql(...args: unknown[]): Promise<unknown[] | unknown> {
  if (args.length === 0) throw new Error("sql: missing query");
  const first = args[0];
  let query: string;
  let params: unknown[] = [];
  if (typeof first === "string") {
    query = first;
    params = args.slice(1);
  } else {
    // Mid-pipeline: the parser calls fn(item, ...declaredArgs), so args[0] is
    // the UPSTREAM ITEM and args[1] is the query.
    query = String(args[1] ?? "");
    params = args.slice(2);
    if (!query) throw new Error("sql: missing query");
    // Bind the piped item as the first parameter when the line declares none.
    // It used to be dropped on the floor, so `range(1,1) | sql "… WHERE id = ?"`
    // ran with zero params and returned [] — indistinguishable from "no rows
    // matched". An explicitly declared parameter still wins.
    if (params.length === 0 && first !== undefined && first !== null) {
      params = [first];
    }
  }
  const client = getClient();
  if (!client.unsafe) {
    throw new Error("sql: client missing .unsafe — parameterised query unsupported");
  }
  const rows = await client.unsafe(query, params);
  return rows;
}
