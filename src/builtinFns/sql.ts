type BunSqlTemplate = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>) & {
  unsafe?: (query: string, params?: unknown[]) => Promise<unknown[]>;
};
type BunSqlCtor = new (url: string) => BunSqlTemplate;

/** The screen `sql --help` prints at parse time (F42). */
export const sqlUsage =
  'usage: sql "<query>" [params…]\n' +
  "  query   a Bun.SQL query; $DATABASE_URL selects the database\n" +
  "  params  bound positionally; a piped item with no declared params binds as the first";

let cachedClient: BunSqlTemplate | null = null;

function getClient(): BunSqlTemplate {
  if (cachedClient) return cachedClient;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("sql: no connection (set $DATABASE_URL)");
  }
  cachedIsPostgres = isPostgresUrl(url);
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

let cachedIsPostgres = false;

function getClientInfo(): { client: BunSqlTemplate; isPostgres: boolean } {
  return { client: getClient(), isPostgres: cachedIsPostgres };
}

/**
 * Does this URL address Postgres? `$n` is Postgres-only syntax.
 *
 * Deliberately NOT the binary `sqlite:`-or-else rule `stateDialect()` in
 * `src/mockServer/state.ts` uses: that module only ever serves sqlite and
 * postgres, so "everything else is postgres" is safe there. `Bun.SQL` will also
 * open `mysql://`, and mysql's placeholder is `?` — treating it as postgres would
 * rewrite a working query into a syntax error. So: rewrite on the postgres
 * schemes, leave everything else exactly as written.
 */
export function isPostgresUrl(url: string): boolean {
  const scheme = /^([a-z]+):\/\//i.exec(url)?.[1]?.toLowerCase();
  return scheme === "postgres" || scheme === "postgresql";
}

/**
 * Rewrite `?` placeholders to Postgres `$n`, left to right.
 *
 * `Bun.SQL`'s `unsafe()` does NOT do this (measured 2026-10-30 against a live
 * server: it forwarded the literal `?` and Postgres answered `syntax error at end
 * of input`, log line `STATEMENT: … WHERE name = ?`), and `?` is the placeholder
 * `docs/USAGE.md` and `CHANGELOG.md` both document — `$N` in a registered-fn
 * argument is a script positional, which is why the old `$1` form silently arrives
 * with `$1` already deleted.
 *
 * Only real placeholders move. A `?` inside a string literal (including the `''`
 * escape), a quoted identifier, a `--` line comment or a block comment, or a
 * dollar-quoted body is data or prose, and rewriting it corrupts the statement.
 *
 * Known limit, not detectable without a grammar: Postgres's jsonb `?` operator
 * (`WHERE data ? 'key'`) reads as a placeholder when the query also binds params.
 * Spell those as `jsonb_exists(data, 'key')` — or keep them in a query that binds
 * nothing, which this function leaves alone entirely.
 */
export function toDollarPlaceholders(query: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i] as string;
    if (c === "'" || c === '"') {
      const end = scanQuoted(query, i);
      out += query.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "/" && query[i + 1] === "*") {
      const end = scanBlockComment(query, i);
      out += query.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "-" && query[i + 1] === "-") {
      const nl = query.indexOf("\n", i);
      const end = nl === -1 ? query.length : nl;
      out += query.slice(i, end);
      i = end - 1;
      continue;
    }
    const opener = dollarQuoteAt(query, i);
    if (opener !== null) {
      const end = scanDollarQuoted(query, i, opener);
      out += query.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "?") {
      n++;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * End (exclusive) of the quoted run starting at `start`.
 *
 * The `''` branch is NOT load-bearing for placeholder placement, and that was
 * measured rather than assumed: an exhaustive sweep over strings built from
 * { `'`, `?`, space, `a` } up to six tokens found **zero** inputs where the output
 * differs with and without it. Both readings consume quotes in pairs, and what
 * protects a `?` is the parity of quotes before it, which a doubled quote never
 * changes. It stays because it is the correct model of the literal — a scanner that
 * thinks `'don'` is a complete literal is wrong even when the wrongness is invisible
 * to this particular caller — and so that anything added here later (a diagnostic
 * quoting the literal, say) starts from a true reading.
 */
function scanQuoted(s: string, start: number): number {
  const quote = s[start] as string;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === quote) {
      if (quote === "'" && s[i + 1] === "'") {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return s.length; // unterminated — pass the rest through untouched
}

/** End (exclusive) of a block comment run; Postgres nests these, so count depth. */
function scanBlockComment(s: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < s.length; ) {
    if (s[i] === "/" && s[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (s[i] === "*" && s[i + 1] === "/") {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else i++;
  }
  return s.length; // unterminated — pass the rest through untouched
}

/** The dollar-quote opener at `i` (`$$`, `$tag$`), or null. `$1` is NOT one. */
function dollarQuoteAt(s: string, i: number): string | null {
  if (s[i] !== "$") return null;
  const m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 64));
  return m ? m[0] : null;
}

/** End (exclusive) of a dollar-quoted body; an unclosed one runs to the end. */
function scanDollarQuoted(s: string, start: number, opener: string): number {
  const body = start + opener.length;
  const close = s.indexOf(opener, body);
  return close === -1 ? s.length : close + opener.length;
}

/**
 * The single decision point: rewrite this query or send it as written.
 *
 * Both halves carry weight. `params.length > 0` because a query that binds nothing
 * has nothing to number, and a literal `?` (a jsonb operator, a `?` in a constant)
 * must survive. `isPostgres` because `$n` is Postgres-only syntax.
 *
 * Why the dialect half is pinned HERE rather than by the sqlite end-to-end test:
 * Bun's sqlite driver was measured to accept `$1` and `?` equally (both return the
 * row), so rewriting sqlite queries by mistake would NOT show up as a failure there
 * — while `mysql://` has `?` as its only placeholder, so the same mistake there is a
 * syntax error. The cost of the mistake is invisible on one dialect and real on
 * another, which is exactly the case for testing the decision itself.
 */
export function queryForDialect(query: string, params: unknown[], isPostgres: boolean): string {
  return isPostgres && params.length > 0 ? toDollarPlaceholders(query) : query;
}

async function runQuery(query: string, params: unknown[]): Promise<unknown[]> {
  if (!query.trim()) throw new Error("sql: missing query");
  const { client, isPostgres } = getClientInfo();
  // Two shapes of the same trap. (a) A `$n` survived with nothing bound. (b) The
  // tail stops on an operator — the usual case, because `$1` is expanded BEFORE
  // crust sees the string, so there is no `$n` left to find and the query simply
  // ends at `= `. A query cannot end on an operator in valid SQL, so this cannot
  // misfire on a real statement, and it deliberately ignores params.length: the
  // dogfood shape declares a param (`… = " 42`) whose placeholder has vanished.
  // A piped item with nowhere to bind (`| sql "SELECT count(*) FROM t"`) is a
  // documented pattern and stays untouched.
  if (endsDangling(query) || (params.length === 0 && dollarRefOutsideLiterals(query))) {
    // Almost always the positional-argument trap: `$1` is the script's argument and
    // the parser expanded it (to nothing, off the command line), so the query that
    // reaches the driver ends mid-expression. The driver's "syntax error at end of
    // input" points at the SQL; this points at the cause.
    throw new Error(
      "sql: $n in this query is a script POSITIONAL argument, not a bind placeholder — " +
        'the bind placeholder is ? (sql "… WHERE name = ?" "Court"). A bare $n expands to ' +
        "the script argument and leaves the query unfinished.",
    );
  }
  if (!client.unsafe) {
    throw new Error("sql: client missing .unsafe — parameterised query unsupported");
  }
  const sent = queryForDialect(query, params, isPostgres);
  return client.unsafe(sent, params);
}

/**
 * A query that stops on an operator, with nothing bound, is the positional trap in
 * its ordinary shape: `sql "… WHERE email = $1" "a@b.c"` arrives here as
 * `… WHERE email = ` because the parser expanded `$1` away before crust saw it. The
 * `$n` check cannot see that case — the `$1` is already gone — and the driver's
 * "syntax error at end of input" blames the SQL.
 */
function endsDangling(query: string): boolean {
  const q = query.replace(/(?:\s|--[^\n]*)+$/, "");
  return /(?:[<>=!]|\b(?:AND|OR|WHERE|LIKE|IN|IS|BY|VALUES)\b)$/i.test(q);
}

function dollarRefOutsideLiterals(query: string): boolean {
  for (let i = 0; i < query.length; i++) {
    const c = query[i] as string;
    if (c === "'" || c === '"') {
      i = scanQuoted(query, i) - 1;
      continue;
    }
    if (c === "/" && query[i + 1] === "*") {
      i = scanBlockComment(query, i) - 1;
      continue;
    }
    if (c === "-" && query[i + 1] === "-") {
      const nl = query.indexOf("\n", i);
      i = nl === -1 ? query.length : nl - 1;
      continue;
    }
    if (c === "$" && /\$\d/.test(query.slice(i))) return true;
  }
  return false;
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
