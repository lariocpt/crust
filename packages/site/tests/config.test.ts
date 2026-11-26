// The config contract: defineSite validates EVERYTHING at definition time and
// collects ALL errors into one sorted BuildError (never a throw on first);
// resolveConfigPaths anchors every path at the CONFIG FILE's directory, never
// cwd; checkOutputOverlap compares by path COMPONENTS so /out vs /output do
// not false-match.
import { describe, expect, test } from "bun:test";
import { checkOutputOverlap, defineSite, resolveConfigPaths } from "../src/config";
import { BuildError, type Diagnostic } from "../src/diagnostics";
import type { ResolvedSite, SiteConfig } from "../src/types";

function baseConfig(): SiteConfig {
  return {
    site: "https://x.dev",
    content: { directory: "content", defaultLayout: "base" },
    layouts: { base: () => "" },
    output: { directory: "dist" },
  };
}

/** defineSite must reject `input`; returns the sorted diagnostics it carried. */
function rejected(input: unknown): Diagnostic[] {
  try {
    defineSite(input as SiteConfig);
  } catch (e) {
    expect(e).toBeInstanceOf(BuildError);
    return (e as BuildError).diagnostics;
  }
  throw new Error("defineSite accepted an invalid config — a false pass");
}

function codesFor(input: unknown): string[] {
  return rejected(input).map((d) => d.code);
}

function messagesFor(input: unknown): string {
  return rejected(input)
    .map((d) => d.message)
    .join("\n");
}

describe("defineSite — a valid minimal config", () => {
  test("applies every documented default", () => {
    const site = defineSite(baseConfig());
    expect(site.content.include).toEqual(["**/*.md"]);
    expect(site.content.exclude).toEqual([]);
    expect(site.sitemap).toBe(true);
    expect(site.lang).toBe("en");
    expect(site.output.trailingSlash).toBe("never");
    expect(site.assets.scripts).toEqual({});
    expect(site.assets.styles).toEqual({});
    expect(site.site).toBe("https://x.dev");
    // raw paths are stored untouched
    expect(site.content.directory).toBe("content");
    expect(site.output.directory).toBe("dist");
  });

  test("keeps explicit values and the layout functions", () => {
    const layout = (ctx: { title: string }) => `<h1>${ctx.title}</h1>`;
    const route = ({ relativePath }: { relativePath: string }) => `/${relativePath}`;
    const site = defineSite({
      ...baseConfig(),
      lang: "pt-PT",
      sitemap: false,
      robots: { indexable: false },
      dev: { hostname: "0.0.0.0", port: 8080 },
      content: { ...baseConfig().content, route },
      layouts: { base: layout },
    });
    expect(site.lang).toBe("pt-PT");
    expect(site.sitemap).toBe(false);
    expect(site.robots).toEqual({ indexable: false });
    expect(site.dev).toEqual({ hostname: "0.0.0.0", port: 8080 });
    expect(site.content.route).toBe(route);
    expect(site.layouts.base).toBe(layout);
  });
});

describe("defineSite — unknown keys at any level", () => {
  test("collects them together, carrying the dotted key path", () => {
    const input = {
      ...baseConfig(),
      theme: "dark", // top level
      content: { ...baseConfig().content, bogus: 1 }, // level 2
      output: { directory: "dist", nested: { deeper: true } }, // level 2
      assets: { scripts: { app: "src/app.ts" }, extra: true }, // level 2
      robots: { indexable: true, nope: 1 }, // level 2
    };
    const messages = messagesFor(input);
    expect(codesFor(input)).toEqual([
      "config.unknown-key",
      "config.unknown-key",
      "config.unknown-key",
      "config.unknown-key",
      "config.unknown-key",
    ]);
    for (const path of ["theme", "content.bogus", "output.nested", "assets.extra", "robots.nope"]) {
      expect(messages).toContain(`"${path}"`);
    }
  });

  test("a wrong-typed known key is config.type, not config.unknown-key", () => {
    const input = { ...baseConfig(), content: { directory: 42, defaultLayout: "base" } };
    expect(codesFor(input)).toEqual(["config.type"]);
    expect(messagesFor(input)).toContain('"content.directory"');
  });
});

describe("defineSite — the site URL", () => {
  test.each([
    "https://x.dev",
    "http://x.dev",
    "https://x.dev/docs",
    "https://x.dev/a/b",
    "https://x.dev:8080/docs",
    // root path with a NON-default port: the serializer's trailing "/" of a
    // root path is exactly what the config form omits — accepted, stored as-is
    "https://x.dev:8080",
    "http://x.dev:8080",
  ])("accepts %s", (site) => {
    expect(defineSite({ ...baseConfig(), site }).site).toBe(site);
  });

  test.each([
    "https://x.dev/", // trailing slash is an error, not stripped
    "https://x.dev/docs/",
    "https://x.dev/docs?q=1",
    "https://x.dev/#top",
    "https://x.dev/docs#frag",
    "https://evil@x.dev", // userinfo: the spoofing shape; never a site URL
    "https://user:pass@x.dev",
    "ftp://x.dev",
    "x.dev",
    "/docs",
    "",
    // The WHATWG parser SILENTLY normalizes all of the following (measured):
    // trimming padding, dropping a dangling ":" or an empty "?"/"#", removing
    // internal tabs/newlines, dropping the default port, lower-casing the
    // scheme/host. The raw value is what canonicalUrl concatenates, so every
    // one of these is a config error — accepting any of them stamps garbage
    // into every canonical/og URL (a false pass).
    "https://x.dev ", // trailing space (parser trims it, raw keeps it)
    "https://x.dev\n", // trailing newline
    "https://x.dev?\n", // empty query: url.search === "" hides it
    "https://x.dev#", // empty fragment: url.hash === "" hides it
    "https://x.dev:", // dangling colon
    "https://x.dev:443", // default port: the serializer drops it
    "https://X.DEV", // upper-case host: the serializer lower-cases it
    "https://x\t.dev", // internal tab: the parser removes it
  ])("rejects %s", (site) => {
    expect(codesFor({ ...baseConfig(), site })).toEqual(["config.site"]);
  });

  test("a non-canonical site error shows the canonical form to fix against", () => {
    const messages = messagesFor({ ...baseConfig(), site: "https://x.dev " });
    // The message must name the serializer's output, so the user knows
    // exactly what to type instead of guessing.
    expect(messages).toContain('"https://x.dev/"');
  });

  test("rejects a non-string site", () => {
    expect(codesFor({ ...baseConfig(), site: 42 })).toContain("config.site");
  });
});

describe("defineSite — layouts", () => {
  test("a non-function layout value is config.layout-type", () => {
    const input = { ...baseConfig(), layouts: { base: () => "", broken: "<html>" } };
    expect(codesFor(input)).toEqual(["config.layout-type"]);
    expect(messagesFor(input)).toContain('"broken"');
  });

  test("an empty registry is config.layout-type", () => {
    const codes = codesFor({ ...baseConfig(), layouts: {} });
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((c) => c === "config.layout-type")).toBe(true);
    expect(messagesFor({ ...baseConfig(), layouts: {} })).toContain("at least one layout");
  });

  test("defaultLayout must be a key of layouts", () => {
    const input = { ...baseConfig(), content: { directory: "c", defaultLayout: "missing" } };
    expect(codesFor(input)).toEqual(["config.layout-type"]);
    expect(messagesFor(input)).toContain("missing");
  });
});

describe("defineSite — assets", () => {
  test("the same name in scripts and styles clashes (one shared namespace)", () => {
    const input = {
      ...baseConfig(),
      assets: { scripts: { app: "src/app.ts" }, styles: { app: "src/app.css" } },
    };
    expect(codesFor(input)).toEqual(["config.asset-name-clash"]);
    expect(messagesFor(input)).toContain('"app"');
  });

  test.each(["my.app", "a b", "ünï", "app/", ""])("rejects the asset name %s", (name) => {
    const input = { ...baseConfig(), assets: { scripts: { [name]: "src/app.ts" } } };
    expect(codesFor(input)).toEqual(["config.asset-name"]);
  });

  test("accepts names matching /^[A-Za-z0-9_-]+$/", () => {
    const input = {
      ...baseConfig(),
      assets: { scripts: { "app-1_A": "src/app.ts" }, styles: { main_css: "src/main.css" } },
    };
    const site = defineSite(input as SiteConfig);
    expect(site.assets.scripts).toEqual({ "app-1_A": "src/app.ts" });
    expect(site.assets.styles).toEqual({ main_css: "src/main.css" });
  });
});

describe("defineSite — output, dev, misc", () => {
  test('trailingSlash only accepts "never"', () => {
    expect(
      defineSite({ ...baseConfig(), output: { directory: "d", trailingSlash: "never" } }).output
        .trailingSlash,
    ).toBe("never");
    expect(
      codesFor({ ...baseConfig(), output: { directory: "d", trailingSlash: "always" } }),
    ).toEqual(["config.type"]);
  });

  test.each([0, 65536, 3000.5, -1, "8080", NaN, Infinity])("rejects dev.port %s", (port) => {
    expect(codesFor({ ...baseConfig(), dev: { port } })).toEqual(["config.port"]);
  });

  test.each([1, 8080, 65535])("accepts dev.port %s", (port) => {
    expect(defineSite({ ...baseConfig(), dev: { port } }).dev?.port).toBe(port);
  });

  test("collects unrelated errors together instead of throwing on first", () => {
    const input = {
      site: "https://x.dev/", // config.site
      content: { directory: "c", defaultLayout: "nope" }, // config.layout-type
      layouts: { base: () => "" },
      output: { directory: "d" },
      dev: { port: 0 }, // config.port
      extra: true, // config.unknown-key
    };
    expect(codesFor(input).sort()).toEqual([
      "config.layout-type",
      "config.port",
      "config.site",
      "config.unknown-key",
    ]);
  });

  test("five simultaneous errors return five sorted diagnostics", () => {
    const input = {
      site: "https://x.dev/", // config.site
      content: { directory: 42, defaultLayout: "nope" }, // config.type + config.layout-type
      layouts: { base: () => "" },
      output: { directory: "d" },
      dev: { port: NaN }, // config.port
      extra: true, // config.unknown-key
    };
    const ds = rejected(input);
    expect(ds).toHaveLength(5);
    // no sourcePath/line on any of them → order is by code, ascending
    expect(ds.map((d) => d.code)).toEqual([
      "config.layout-type",
      "config.port",
      "config.site",
      "config.type",
      "config.unknown-key",
    ]);
  });
});

describe("defineSite — hostile keys (__proto__/constructor) must not crash or pollute", () => {
  // Object LITERALS consume `__proto__` into the prototype (invisible);
  // JSON.parse and defineProperty create OWN properties — those are the
  // real clobbering inputs, so the fixtures are built that way.
  // biome-ignore lint/suspicious/noExplicitAny: JSON.parse returns a genuinely untyped shape; the tests assert its own keys explicitly
  const ownProtoJson = (json: string): any => JSON.parse(json);

  test("an own __proto__ asset entry (string value) is STORED, not a prototype write", () => {
    const site = defineSite({
      ...baseConfig(),
      assets: ownProtoJson('{"scripts": {"app": "src/app.ts", "__proto__": "src/proto.ts"}}'),
    });
    const scripts = site.assets.scripts as Record<string, string>;
    expect(Object.hasOwn(scripts, "__proto__")).toBe(true);
    // biome-ignore lint: bracket notation is deliberate — a dotted `.__proto__` would read like prototype access
    expect(scripts["__proto__"]).toBe("src/proto.ts");
    expect(Object.keys(scripts).sort()).toEqual(["__proto__", "app"]);
    // the stored map's own prototype was not clobbered by the assignment…
    expect(Object.getPrototypeOf(scripts)).toBe(Object.prototype);
    // …and Object.prototype itself was never polluted
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("an own __proto__ asset entry with an object value is a type error, not a clobber", () => {
    const ds = rejected({
      ...baseConfig(),
      assets: ownProtoJson('{"scripts": {"__proto__": {"polluted": 1}}}'),
    });
    expect(ds.map((d) => d.code)).toEqual(["config.type"]);
    expect(ds[0].message).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("the shared namespace clash check fires for __proto__ too", () => {
    const ds = rejected({
      ...baseConfig(),
      assets: {
        scripts: ownProtoJson('{"__proto__": "a.ts"}'),
        styles: ownProtoJson('{"__proto__": "b.css"}'),
      },
    });
    expect(ds.map((d) => d.code)).toEqual(["config.asset-name-clash"]);
    expect(ds[0].message).toContain("__proto__");
  });

  test("a __proto__ layout cannot fake a defaultLayout match (no `in` walk)", () => {
    // Pre-fix: layouts["__proto__"] = fn SET THE REGISTRY'S PROTOTYPE to the
    // user's function, so `defaultLayout in layouts` matched
    // Function.prototype members ("call") and validation silently passed.
    const layouts: Record<string, unknown> = {};
    Object.defineProperty(layouts, "__proto__", {
      value: () => "",
      enumerable: true,
    });
    const ds = rejected({
      ...baseConfig(),
      content: { ...baseConfig().content, defaultLayout: "call" },
      layouts,
    });
    expect(ds.map((d) => d.code)).toEqual(["config.layout-type"]);
    expect(ds[0].message).toContain('"call"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("an own __proto__ at the root level is an unknown key", () => {
    const ds = rejected({ ...baseConfig(), ...ownProtoJson('{"__proto__": "x"}') });
    expect(ds.map((d) => d.code)).toEqual(["config.unknown-key"]);
    expect(ds[0].message).toContain("__proto__");
  });

  test("a constructor key is an unknown key, not a write to Object.prototype.constructor", () => {
    const ds = rejected({ ...baseConfig(), constructor: "x" });
    expect(ds.map((d) => d.code)).toEqual(["config.unknown-key"]);
    expect(ds[0].message).toContain("constructor");
    expect(Object.prototype.constructor).toBe(Object);
  });
});

describe("resolveConfigPaths", () => {
  function resolved(): ResolvedSite {
    const site = defineSite({
      ...baseConfig(),
      assets: {
        scripts: { app: "src/app.ts" },
        styles: { main: "assets/main.css" },
        publicDirectory: "static",
      },
    });
    return resolveConfigPaths(site, "/proj");
  }

  test("resolves every path against the config dir — never cwd", () => {
    const r = resolved();
    expect(r.configDir).toBe("/proj");
    expect(r.content.directory).toBe("/proj/content");
    expect(r.output.directory).toBe("/proj/dist");
    expect(r.assets.scripts).toEqual({ app: "/proj/src/app.ts" });
    expect(r.assets.styles).toEqual({ main: "/proj/assets/main.css" });
    expect(r.assets.publicDirectory).toBe("/proj/static");
  });

  test("keeps absolute paths absolute and normalizes dot segments", () => {
    const site = defineSite({
      ...baseConfig(),
      content: { directory: "/elsewhere/content", defaultLayout: "base" },
      output: { directory: "./out/../dist" },
    });
    const r = resolveConfigPaths(site, "/proj");
    expect(r.content.directory).toBe("/elsewhere/content");
    expect(r.output.directory).toBe("/proj/dist");
  });

  test("rejects a relative configDir instead of silently using cwd", () => {
    const site = defineSite(baseConfig());
    let thrown: unknown;
    try {
      resolveConfigPaths(site, "./proj");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BuildError);
    expect((thrown as BuildError).diagnostics[0].code).toBe("config.type");
  });
});

describe("checkOutputOverlap", () => {
  function cleanLayoutPasses(): void {
    const site = defineSite(baseConfig());
    checkOutputOverlap(resolveConfigPaths(site, "/proj"));
  }

  function overlapCodes(resolved: ResolvedSite): string[] {
    try {
      checkOutputOverlap(resolved);
      return [];
    } catch (e) {
      expect(e).toBeInstanceOf(BuildError);
      return (e as BuildError).diagnostics.map((d) => d.code);
    }
  }

  function overlapMessages(resolved: ResolvedSite): string {
    try {
      checkOutputOverlap(resolved);
      return "";
    } catch (e) {
      return (e as BuildError).diagnostics.map((d) => d.message).join("\n");
    }
  }

  function resolvedWith(config: Partial<SiteConfig>, configDir: string): ResolvedSite {
    return resolveConfigPaths(defineSite({ ...baseConfig(), ...config }), configDir);
  }

  test("a clean layout passes", () => {
    expect(cleanLayoutPasses).not.toThrow();
  });

  test("/out vs /output do NOT false-match (component comparison)", () => {
    const r = resolvedWith(
      { content: { directory: "../output", defaultLayout: "base" }, output: { directory: "." } },
      "/out",
    );
    // output resolves to /out, content to /output — siblings, not overlap…
    // except /out EQUALS the config dir here, so that alone must error;
    // compare the messages to prove it is the config-dir rule, not content.
    const codes = overlapCodes(r);
    const messages = overlapMessages(r);
    expect(codes).toEqual(["config.output-overlap"]);
    expect(messages).toContain("the config directory");
    expect(messages).not.toContain("content.directory");
  });

  test("output inside content is an error naming both paths", () => {
    const r = resolvedWith({ output: { directory: "content/_site" } }, "/proj");
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
    const messages = overlapMessages(r);
    expect(messages).toContain('"/proj/content/_site"');
    expect(messages).toContain('"/proj/content"');
  });

  test("content inside output is an error (both containment directions)", () => {
    const r = resolvedWith(
      {
        content: { directory: "dist/pages", defaultLayout: "base" },
        output: { directory: "dist" },
      },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
  });

  test("output equal to the config directory is an error", () => {
    // content lives outside /proj so the config-dir equality rule is isolated
    const r = resolvedWith(
      { content: { directory: "/srv/content", defaultLayout: "base" }, output: { directory: "." } },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
    expect(overlapMessages(r)).toContain("the config directory");
  });

  test("output INSIDE the config directory is fine (the common case)", () => {
    expect(overlapCodes(resolvedWith({ output: { directory: "dist" } }, "/proj"))).toEqual([]);
  });

  test.each([".", "..", "../.."])("output %s cannot contain the config directory", (directory) => {
    for (const root of [
      "/project/deep/config",
      "C:/project/deep/config",
      "//host/share/deep/config",
    ]) {
      const r = resolvedWith(
        {
          content: { directory: "D:/external/content", defaultLayout: "base" },
          output: { directory },
        },
        root,
      );
      expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
      expect(overlapMessages(r)).toContain(`the config directory "${root}"`);
    }
  });

  test.each(["dist", "../config-other"])(
    "output %s is not an ancestor false-positive",
    (directory) => {
      for (const root of ["/project/config", "C:/project/config", "//host/share/config"]) {
        const r = resolvedWith(
          {
            content: { directory: "D:/external/content", defaultLayout: "base" },
            output: { directory },
          },
          root,
        );
        expect(overlapCodes(r)).toEqual([]);
      }
    },
  );

  test("publicDirectory inside output is an error", () => {
    const r = resolvedWith(
      { output: { directory: "dist" }, assets: { publicDirectory: "dist/files" } },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
    expect(overlapMessages(r)).toContain("assets.publicDirectory");
  });

  test("an asset entrypoint inside output is an error", () => {
    const r = resolvedWith(
      { output: { directory: "dist" }, assets: { scripts: { app: "dist/app.ts" } } },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
    expect(overlapMessages(r)).toContain("assets.scripts.app");
  });

  test("output inside the entrypoint's directory is fine (the common layout)", () => {
    // Entrypoint at the config root, output a subdirectory of it: the build
    // only ADDS new files to the source tree (emit, staging→out, cleanup —
    // all inside the output); it clobbers no source file, so this must NOT
    // error. Control: the pre-fix bidirectional dirname check rejected this
    // layout, contradicting the "output inside the config directory is the
    // common case" rule the same function documents for the config dir.
    const r = resolvedWith(
      { output: { directory: "dist" }, assets: { scripts: { app: "app.ts" } } },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual([]);
  });

  test("output equal to the entrypoint file's directory containing it errors, sibling layout passes", () => {
    // /proj/dist/app.ts INSIDE out=/proj/dist → error;
    // the same file at /proj/app.ts with out=/proj/dist → covered above.
    const r = resolvedWith(
      { output: { directory: "dist" }, assets: { styles: { main: "dist/main.css" } } },
      "/proj",
    );
    expect(overlapCodes(r)).toEqual(["config.output-overlap"]);
    expect(overlapMessages(r)).toContain("assets.styles.main");
  });
});
