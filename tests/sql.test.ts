import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPostgresUrl, queryForDialect, toDollarPlaceholders } from "../src/builtinFns/sql";

/**
 * G34. `docs/USAGE.md` and `CHANGELOG.md` both say the bind placeholder is `?`
 * (and that `$N` in an fn argument is a script positional), but
 * `runQuery` handed the query to the driver untouched. Bun's Postgres client
 * speaks `$n` and does NOT rewrite `?` — measured against a live server, whose
 * log kept the literal `?` and answered `syntax error at end of input` — while
 * sqlite's placeholder genuinely IS `?`. So the rewrite belongs in crust, and
 * it has to be gated on the dialect or it breaks sqlite.
 */

// sql.ts caches its client at module scope, so a test that changes
// DATABASE_URL needs a fresh module graph (same reason discover.test.ts does it).
const freshSql = async (): Promise<typeof import("../src/builtinFns/sql")> =>
  await import(`../src/builtinFns/sql?t=${Date.now()}-${Math.random()}`);

describe("toDollarPlaceholders", () => {
  test("numbers ? left to right", () => {
    expect(toDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  test("a query with no placeholder is returned untouched", () => {
    expect(toDollarPlaceholders("SELECT count(*) FROM t")).toBe("SELECT count(*) FROM t");
  });

  test("? inside a string literal is text, not a placeholder", () => {
    expect(toDollarPlaceholders("SELECT '?' AS q, ? AS p")).toBe("SELECT '?' AS q, $1 AS p");
  });

  test("an escaped '' inside a literal does not end the literal", () => {
    expect(toDollarPlaceholders("WHERE a = 'it''s ?' AND b = ?")).toBe(
      "WHERE a = 'it''s ?' AND b = $1",
    );
  });

  test("a placeholder AFTER an escaped quote is still a placeholder", () => {
    // Pinned as BEHAVIOUR, not as a guard: neither this nor the case above can tell
    // the `''` branch from its absence — an exhaustive sweep found no input where the
    // two readings differ (see scanQuoted). Kept because this is the contract a user
    // reads, and because "the test would catch it" must not be claimed when it would not.
    expect(toDollarPlaceholders("SELECT 'don''t' AS s, ? AS p")).toBe(
      "SELECT 'don''t' AS s, $1 AS p",
    );
  });

  test("a ? in a line comment is not a placeholder", () => {
    expect(toDollarPlaceholders("SELECT ? -- what about ? here\nFROM t WHERE ? = 1")).toBe(
      "SELECT $1 -- what about ? here\nFROM t WHERE $2 = 1",
    );
  });

  test("a ? in a block comment is not a placeholder", () => {
    expect(toDollarPlaceholders("/* why ? */ SELECT ?")).toBe("/* why ? */ SELECT $1");
  });

  test("? inside a dollar-quoted body is not a placeholder", () => {
    expect(toDollarPlaceholders("SELECT $$ a ? $$, ?")).toBe("SELECT $$ a ? $$, $1");
  });

  test("? inside a quoted identifier is not a placeholder", () => {
    expect(toDollarPlaceholders('SELECT "?" FROM t WHERE ? = 1')).toBe(
      'SELECT "?" FROM t WHERE $1 = 1',
    );
  });
});

describe("isPostgresUrl", () => {
  test("postgres schemes get the rewrite", () => {
    expect(isPostgresUrl("postgres://u@h:5432/db")).toBe(true);
    expect(isPostgresUrl("postgresql://u@h/db")).toBe(true);
    expect(isPostgresUrl("POSTGRES://u@h/db")).toBe(true);
  });

  test("sqlite and mysql keep their own ? — rewriting them would break them", () => {
    expect(isPostgresUrl("sqlite://./x.sqlite")).toBe(false);
    expect(isPostgresUrl("mysql://u@h:3306/db")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
  });
});

describe("queryForDialect — the rewrite decision itself", () => {
  test("postgres, something bound: ? becomes $n", () => {
    expect(
      queryForDialect("WHERE a = ? AND b = ?", [1, 2], isPostgresUrl("postgres://u@h/d")),
    ).toBe("WHERE a = $1 AND b = $2");
  });

  test("postgres, nothing bound: the query stays exactly what the user wrote", () => {
    // A literal ? (jsonb's operator, a constant) survives a query that binds nothing.
    expect(
      queryForDialect("SELECT * FROM j WHERE d ? 'k'", [], isPostgresUrl("postgres://u@h/d")),
    ).toBe("SELECT * FROM j WHERE d ? 'k'");
  });

  test("sqlite and mysql: never rewritten, params or not", () => {
    // Bun's sqlite accepts $n too, so this cannot be caught end-to-end — which is
    // why the decision is pinned here. mysql would genuinely break.
    for (const url of ["sqlite://./x.sqlite", "mysql://u@h:3306/db", "SQLite://X"]) {
      expect(queryForDialect("WHERE a = ?", [1], isPostgresUrl(url))).toBe("WHERE a = ?");
    }
  });
});

describe("sql stage binds the documented ? placeholder", () => {
  let dir: string;
  const saved = process.env.DATABASE_URL;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crust-sql-"));
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    await rm(dir, { recursive: true, force: true });
  });

  test("sqlite: declared params bind, and the query is NOT rewritten", async () => {
    // What this pins: the binding path works on sqlite with the documented `?`,
    // and crust still sends it unrewritten. It is NOT the guard against an ungated
    // rewrite — measured, Bun's sqlite driver accepts `$1` just as happily, so that
    // mutation survives here (checked, not assumed). The gate itself is pinned by
    // queryForDialect below, where mysql's genuinely-different behaviour is asserted.
    process.env.DATABASE_URL = `sqlite://${join(dir, "bind.sqlite")}`;
    const sql = await freshSql();
    await sql.sqlSource(["CREATE TABLE t (id int, name text)"]);
    await sql.sqlSource(["INSERT INTO t VALUES (?, ?)", 42, "alpha"]);
    expect(await sql.sqlSource(["SELECT name FROM t WHERE id = ?", 42])).toEqual([
      { name: "alpha" },
    ]);
  });

  test("sqlite: a piped item with no declared params binds as the first parameter", async () => {
    process.env.DATABASE_URL = `sqlite://${join(dir, "piped.sqlite")}`;
    const sql = await freshSql();
    await sql.sqlSource(["CREATE TABLE t (id int, name text)"]);
    await sql.sqlSource(["INSERT INTO t VALUES (?, ?)", 7, "pip"]);
    expect(await sql.sqlStage(["SELECT name FROM t WHERE id = ?"], 7)).toEqual([{ name: "pip" }]);
  });

  test("sqlite: two placeholders bind in written order", async () => {
    process.env.DATABASE_URL = `sqlite://${join(dir, "order.sqlite")}`;
    const sql = await freshSql();
    await sql.sqlSource(["CREATE TABLE t (id int, name text)"]);
    await sql.sqlSource(["INSERT INTO t VALUES (?, ?)", 1, "one"]);
    await sql.sqlSource(["INSERT INTO t VALUES (?, ?)", 2, "two"]);
    expect(await sql.sqlSource(["SELECT name FROM t WHERE name = ? AND id = ?", "two", 2])).toEqual(
      [{ name: "two" }],
    );
  });

  test("a $n left in the query by positional expansion names the trap instead of the driver's error", async () => {
    // `sql "… = $1" "x"` reaches runQuery as `… = ` (the parser expanded $1 to
    // empty). But a query that still carries $n with nothing bound is the same
    // mistake one step earlier, and the Postgres wording for it points nowhere.
    process.env.DATABASE_URL = `sqlite://${join(dir, "diag.sqlite")}`;
    const sql = await freshSql();
    let message = "";
    try {
      await sql.sqlSource(["SELECT name FROM t WHERE id = $1"]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.toLowerCase()).toContain("positional");
    expect(message).toContain("?");
  });

  test("the shape the dogfood hit — `$1` already expanded away — names the trap too", async () => {
    // `sql "… WHERE id = $1" 42` arrives as `… WHERE id = ` with nothing bound. No
    // `$n` survives to detect, so the tail itself has to be the signal.
    process.env.DATABASE_URL = `sqlite://${join(dir, "dangling.sqlite")}`;
    const sql = await freshSql();
    let message = "";
    try {
      await sql.sqlSource(["SELECT name FROM t WHERE id = "]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.toLowerCase()).toContain("positional");
    expect(message).toContain("?");
  });

  test("a declared param whose placeholder vanished names the trap (the dogfood's exact line)", async () => {
    // `sql "… WHERE id = $1" 42`: the param is still there, the placeholder isn't.
    process.env.DATABASE_URL = `sqlite://${join(dir, "vanished.sqlite")}`;
    const sql = await freshSql();
    let message = "";
    try {
      await sql.sqlSource(["SELECT name FROM t WHERE id = ", 42]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.toLowerCase()).toContain("positional");
  });

  test("a complete query that binds nothing is left alone by the diagnostic", async () => {
    // Control for the check above: a real query ending on a normal token must run.
    process.env.DATABASE_URL = `sqlite://${join(dir, "control.sqlite")}`;
    const sql = await freshSql();
    await sql.sqlSource(["CREATE TABLE ok (a int)"]);
    expect(await sql.sqlSource(["SELECT count(*) AS n FROM ok"])).toEqual([{ n: 0 }]);
  });
});

// The class this whole file exists for is Postgres-specific, so the suite is not
// honest unless a real Postgres runs it. CRUST_PG_URL opts in; CI with a database
// sets it. A skipped test is counted by the runner, not hidden.
const PG = process.env.CRUST_PG_URL;
const pgTest = PG ? test : test.skip;

describe("postgres (set $CRUST_PG_URL to run)", () => {
  pgTest("? is converted to $n before the driver sees it", async () => {
    process.env.DATABASE_URL = PG as string;
    const sql = await freshSql();
    await sql.sqlSource(["DROP TABLE IF EXISTS crust_g34"]);
    await sql.sqlSource(["CREATE TABLE crust_g34 (id int, name text)"]);
    await sql.sqlSource(["INSERT INTO crust_g34 VALUES (?, ?)", 42, "alpha"]);
    expect(await sql.sqlSource(["SELECT name FROM crust_g34 WHERE id = ?", 42])).toEqual([
      { name: "alpha" },
    ]);
    expect(
      await sql.sqlSource(["SELECT id FROM crust_g34 WHERE name = ? AND id = ?", "alpha", 42]),
    ).toEqual([{ id: 42 }]);
    await sql.sqlSource(["DROP TABLE crust_g34"]);
  });
});
