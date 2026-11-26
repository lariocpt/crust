// The frontmatter contract: located diagnostics in FULL-FILE coordinates.
// Every fixture is built line-by-line so the expected line number is visible
// in the test itself (line 1 is the opening "---").
import { describe, expect, test } from "bun:test";
import { BuildError, type Diagnostic } from "../src/diagnostics";
import { parseFrontmatter } from "../src/frontmatter";

const SRC = "docs/page.md";

/** Join lines with LF; line N of the file is index N-1. */
function file(...lines: string[]): string {
  return lines.join("\n");
}

/** parseFrontmatter must reject `text`; returns the sorted diagnostics. */
function rejected(text: string): Diagnostic[] {
  try {
    parseFrontmatter(text, SRC);
  } catch (e) {
    expect(e).toBeInstanceOf(BuildError);
    return (e as BuildError).diagnostics;
  }
  throw new Error("parseFrontmatter accepted invalid frontmatter — a false pass");
}

function only(text: string): Diagnostic {
  const ds = rejected(text);
  expect(ds).toHaveLength(1);
  return ds[0];
}

describe("a complete valid document", () => {
  const text = file(
    "---", // 1
    "title: Hello", // 2
    "description: A page", // 3
    "layout: doc", // 4
    "route: /a/b", // 5
    "draft: false", // 6
    "data:", // 7
    "  x: 1", // 8
    "  nested:", // 9
    "    y: two", // 10
    "---", // 11
    "# Body", // 12
    "text", // 13
  );

  test("parses every built-in key and locates the body", () => {
    const r = parseFrontmatter(text, SRC);
    expect(r.frontmatter).toEqual({
      title: "Hello",
      description: "A page",
      layout: "doc",
      route: "/a/b",
      draft: false,
      data: { x: 1, nested: { y: "two" } },
    });
    expect(r.body).toBe("# Body\ntext");
    expect(r.bodyStartLine).toBe(12);
  });

  test("an empty body still reports the line where it would start", () => {
    const r = parseFrontmatter(file("---", "title: t", "---"), SRC);
    expect(r.body).toBe("");
    expect(r.bodyStartLine).toBe(4);
  });

  test("CRLF input keeps identical line numbers", () => {
    const r = parseFrontmatter(text.replace(/\n/g, "\r\n"), SRC);
    expect(r.frontmatter.title).toBe("Hello");
    expect(r.bodyStartLine).toBe(12);
  });
});

describe("block delimiters", () => {
  test("a file with no opening --- is frontmatter.missing at line 1", () => {
    const d = only(file("title: x", "", "body"));
    expect(d.code).toBe("frontmatter.missing");
    expect(d.line).toBe(1);
    expect(d.sourcePath).toBe(SRC);
  });

  test("an unclosed block is frontmatter.missing at line 1", () => {
    const d = only(file("---", "title: x"));
    expect(d.code).toBe("frontmatter.missing");
    expect(d.line).toBe(1);
  });

  test("a non-mapping document is frontmatter.not-mapping at its line", () => {
    const d = only(file("---", "just a plain string", "---", "body"));
    expect(d.code).toBe("frontmatter.not-mapping");
    expect(d.line).toBe(2);
  });

  test("an empty block is frontmatter.not-mapping", () => {
    const d = only(file("---", "---", "body"));
    expect(d.code).toBe("frontmatter.not-mapping");
    expect(d.line).toBe(1);
  });

  test("unparseable YAML is frontmatter.parse-error, located", () => {
    const d = only(file("---", "title: t", "broken: [1", "---"));
    expect(d.code).toBe("frontmatter.parse-error");
    expect(d.line).toBe(3);
  });

  test("a BOM at the start of the file is stripped, not a parse error", () => {
    const r = parseFrontmatter(`\uFEFF${file("---", "title: X", "---", "body")}`, SRC);
    expect(r.frontmatter.title).toBe("X");
    expect(r.bodyStartLine).toBe(4);
  });

  test("a delimiter with trailing spaces/tabs is still a delimiter", () => {
    const r = parseFrontmatter(file("--- \t", "title: X", "---", "body"), SRC);
    expect(r.frontmatter.title).toBe("X");
    expect(r.body).toBe("body");
    expect(r.bodyStartLine).toBe(4);
  });

  test("an INDENTED opener is not a delimiter (an indented code block is body)", () => {
    const d = only(file("  ---", "  title: X", "  ---", "body"));
    expect(d.code).toBe("frontmatter.missing");
    expect(d.line).toBe(1);
  });

  test("---- (four dashes) is not an opener", () => {
    const d = only(file("----", "title: X", "----", "body"));
    expect(d.code).toBe("frontmatter.missing");
    expect(d.line).toBe(1);
  });

  test("---- (four dashes) is not a closer, so the block stays unclosed", () => {
    const d = only(file("---", "title: X", "----"));
    expect(d.code).toBe("frontmatter.missing");
    expect(d.message).toContain("not closed");
  });

  test("a `---` line in the BODY never affects the frontmatter", () => {
    const r = parseFrontmatter(file("---", "title: X", "---", "before", "---", "after"), SRC);
    expect(r.frontmatter.title).toBe("X");
    expect(r.body).toBe("before\n---\nafter");
    expect(r.bodyStartLine).toBe(4);
  });
});

describe("block scalars containing `---` lines", () => {
  test("an indented `---` (deeper than the scalar content) stays content", () => {
    const r = parseFrontmatter(
      file(
        "---", // 1
        "title: X", // 2
        "description: |", // 3
        "  text", // 4
        "    ---", // 5 — deeper indented: scalar content, NOT a fence
        "  more", // 6
        "layout: doc", // 7
        "---", // 8
        "body", // 9
      ),
      SRC,
    );
    // The pre-fix trim-based closer sliced at line 5: the scalar lost its
    // tail and every key after it — a silent misparse (a false pass). The
    // column-0 fence keeps the whole document intact.
    expect(r.frontmatter).toEqual({
      title: "X",
      description: "text\n  ---\nmore\n",
      layout: "doc",
    });
    expect(r.body).toBe("body");
    expect(r.bodyStartLine).toBe(9);
  });

  test("an indented `---` at the scalar's own indent stays content", () => {
    const r = parseFrontmatter(
      file(
        "---", // 1
        "title: X", // 2
        "description: |", // 3
        "  text", // 4
        "  ---", // 5 — yaml keeps an indented marker as scalar content
        "  more", // 6
        "layout: doc", // 7
        "---", // 8
        "body", // 9
      ),
      SRC,
    );
    expect(r.frontmatter).toEqual({
      title: "X",
      description: "text\n---\nmore\n",
      layout: "doc",
    });
    expect(r.body).toBe("body");
    expect(r.bodyStartLine).toBe(9);
  });

  test("a COLUMN-0 `---` inside a block scalar ends the block (yaml's own document-marker rule)", () => {
    // This one is genuinely ambiguous: a column-0 `---` is, by YAML's own
    // grammar, a document terminator even inside a block scalar, and
    // parseDocument ends the document there. Every frontmatter parser
    // (Jekyll, gray-matter, Hugo, Astro) resolves the ambiguity the same
    // way: the first column-0 `---` after the opener closes the frontmatter.
    // We pin that behavior so the ambiguity can never be resolved silently
    // in a different way.
    const r = parseFrontmatter(
      file(
        "---", // 1
        "title: X", // 2
        "description: |", // 3
        "  text", // 4
        "---", // 5 — column-0 marker: closes the block
        "layout: doc", // 6 — now body, like in every other frontmatter tool
        "---", // 7
        "body", // 8
      ),
      SRC,
    );
    expect(r.frontmatter).toEqual({ title: "X", description: "text\n" });
    expect(r.body).toBe("layout: doc\n---\nbody");
    expect(r.bodyStartLine).toBe(6);
  });
});

describe("full-file coordinates past line 7 (multi-line values, block scalars)", () => {
  test("an unknown key on line 10 is reported at line 10, column 1", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: Hello", // 2
        "description: |", // 3
        "  line one", // 4
        "  line two", // 5
        "  line three", // 6
        "layout: doc", // 7
        "data:", // 8
        "  x: 1", // 9
        "bogus: 1", // 10
        "---", // 11
        "body", // 12
      ),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("frontmatter.unknown-key");
    expect(ds[0].line).toBe(10);
    expect(ds[0].column).toBe(1);
    expect(ds[0].sourcePath).toBe(SRC);
  });

  test("a traversal route on line 8 is located at its key line", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: t", // 2
        "description: |", // 3
        "  a", // 4
        "  b", // 5
        "  c", // 6
        "  d", // 7
        "route: /a/../b", // 8
        "layout: doc", // 9
        "---", // 10
      ),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("route.traversal");
    expect(ds[0].line).toBe(8);
    expect(ds[0].column).toBe(1);
  });

  test("a duplicate key on line 8 is located at its key line", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: t", // 2
        "description: |", // 3
        "  x", // 4
        "  y", // 5
        "  z", // 6
        "layout: doc", // 7
        "layout: doc2", // 8
        "---", // 9
      ),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("frontmatter.duplicate-key");
    expect(ds[0].line).toBe(8);
    expect(ds[0].column).toBe(1);
  });

  test("five bad keys across later lines all come back, each at its own line", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: 42", // 2
        "description: |", // 3
        "  a", // 4
        "  b", // 5
        "draft: yes-please", // 6
        "route: /a/", // 7
        "bogus: 1", // 8
        "data: 5", // 9
        "---", // 10
      ),
    );
    expect(ds.map((d) => [d.line, d.column, d.code])).toEqual([
      [2, 8, "frontmatter.bad-value"],
      [6, 8, "frontmatter.bad-value"],
      [7, 1, "route.shape"],
      [8, 1, "frontmatter.unknown-key"],
      [9, 7, "frontmatter.bad-value"],
    ]);
  });

  test("a key with no value is located on its own line, past the colon", () => {
    const ds = rejected(file("---", "title: t", "draft:", "---"));
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("frontmatter.bad-value");
    expect(ds[0].line).toBe(3);
    expect(ds[0].column).toBe(7);
    expect(ds[0].message).toContain('"draft"');
  });
});

describe("duplicate YAML keys", () => {
  test("are located at the second occurrence", () => {
    const d = only(file("---", "title: a", "title: b", "---", "body"));
    expect(d.code).toBe("frontmatter.duplicate-key");
    expect(d.line).toBe(3);
  });

  test("multiple duplicates are all reported", () => {
    const ds = rejected(file("---", "title: t", "a: 1", "a: 2", "b: 1", "b: 2", "---"));
    const dups = ds.filter((d) => d.code === "frontmatter.duplicate-key");
    expect(dups.map((d) => d.line)).toEqual([4, 6]);
  });
});

describe("keys", () => {
  test("an unknown key is located at the key", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: Hello", // 2
        "description: A page", // 3
        "layout: doc", // 4
        "bogus: 1", // 5
        "---", // 6
        "body", // 7
      ),
    );
    expect(ds).toHaveLength(1);
    expect(ds[0].code).toBe("frontmatter.unknown-key");
    expect(ds[0].line).toBe(5);
    expect(ds[0].column).toBe(1);
    expect(ds[0].message).toContain("bogus");
  });

  test("title is required (missing-title at line 1)", () => {
    const d = only(file("---", "layout: doc", "---"));
    expect(d.code).toBe("frontmatter.missing-title");
    expect(d.line).toBe(1);
  });

  test.each([
    ['title: ""', 2],
    ["title: 42", 2],
    ["title:", 2],
  ])("bad title (%s) is frontmatter.bad-value at its line", (line) => {
    const d = only(file("---", line, "---"));
    expect(d.code).toBe("frontmatter.bad-value");
    expect(d.line).toBe(2);
  });

  test("a missing description is fine, an empty one is bad-value", () => {
    expect(
      parseFrontmatter(file("---", "title: t", "---"), SRC).frontmatter.description,
    ).toBeUndefined();
    const d = only(file("---", "title: t", "description:", "---"));
    expect(d.code).toBe("frontmatter.bad-value");
    expect(d.line).toBe(3);
    const e = only(file("---", "title: t", 'description: ""', "---"));
    expect(e.code).toBe("frontmatter.bad-value");
  });

  test("route is validated and located at its key line", () => {
    const d = only(file("---", "title: t", "route: nope", "---"));
    expect(d.code).toBe("route.shape");
    expect(d.line).toBe(3);
    expect(d.sourcePath).toBe(SRC);
  });

  test("a traversal route keeps route.traversal at the key line", () => {
    const d = only(file("---", "title: t", "route: /a/../b", "---"));
    expect(d.code).toBe("route.traversal");
    expect(d.line).toBe(3);
  });

  test("a non-normalized route (trailing slash) is an error, not fixed", () => {
    const d = only(file("---", "title: t", "route: /a/", "---"));
    expect(d.code).toBe("route.shape");
    expect(d.line).toBe(3);
  });

  test("draft must be a boolean", () => {
    const d = only(file("---", "title: t", 'draft: "yes"', "---"));
    expect(d.code).toBe("frontmatter.bad-value");
    expect(d.line).toBe(3);
  });

  test("data must be a plain object", () => {
    expect(
      parseFrontmatter(file("---", "title: t", "data:", "  x: 1", "---"), SRC).frontmatter.data,
    ).toEqual({
      x: 1,
    });
    const d = only(file("---", "title: t", "data: 5", "---"));
    expect(d.code).toBe("frontmatter.bad-value");
    expect(d.line).toBe(3);
    const e = only(file("---", "title: t", "data:", "  - 1", "---"));
    expect(e.code).toBe("frontmatter.bad-value");
  });

  test("a YAML __proto__ key inside data is an own entry: stored, never polluting", () => {
    // eemeli/yaml builds toJS results with own data properties, so a
    // `__proto__:` key arrives as an OWN key — it must round-trip as data,
    // and neither the parse nor the storage may touch Object.prototype.
    const r = parseFrontmatter(
      file("---", "title: t", "data:", "  __proto__:", "    polluted: 1", "---"),
      SRC,
    );
    const data = r.frontmatter.data as Record<string, unknown>;
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    // biome-ignore lint: bracket notation is deliberate — a dotted `.__proto__` would read like prototype access
    expect(data["__proto__"]).toEqual({ polluted: 1 });
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a scalar-valued YAML __proto__ key is an inert own entry", () => {
    const r = parseFrontmatter(
      file("---", "title: t", "data:", "  __proto__: somestr", "---"),
      SRC,
    );
    const data = r.frontmatter.data as Record<string, unknown>;
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    // biome-ignore lint: bracket notation is deliberate — a dotted `.__proto__` would read like prototype access
    expect(data["__proto__"]).toBe("somestr");
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a non-string route value is route.invalid at its key line", () => {
    const d = only(file("---", "title: t", "route: 42", "---"));
    expect(d.code).toBe("route.invalid");
    expect(d.line).toBe(3);
  });
});

describe("error collection", () => {
  test("all problems are reported together, sorted by line", () => {
    const ds = rejected(
      file(
        "---", // 1
        "title: 42", // 2 — bad-value
        "layout: doc", // 3
        "draft: yes-please", // 4 — bad-value
        "bogus: 1", // 5 — unknown-key
        "---", // 6
      ),
    );
    expect(ds.map((d) => [d.line, d.code])).toEqual([
      [2, "frontmatter.bad-value"],
      [4, "frontmatter.bad-value"],
      [5, "frontmatter.unknown-key"],
    ]);
  });

  test("every diagnostic carries the sourcePath and a severity", () => {
    for (const d of rejected(file("---", "title: 42", "bogus: 1", "---"))) {
      expect(d.sourcePath).toBe(SRC);
      expect(d.severity).toBe("error");
    }
  });
});
