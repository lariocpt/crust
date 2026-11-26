// The config contract: `defineSite` validates EVERYTHING at definition time
// (IDE-time for TS users, runtime for everyone) and collects ALL errors into
// one BuildError — never a throw on first, so a config with five problems
// reports five problems. Unknown keys at any level are errors, not ignored
// extras: a typo'd key that silently does nothing is a false pass.

import { BuildError, type Diagnostic } from "./diagnostics";
import { isWindowsPath, pathContains, filesystemPath as posix } from "./fs-path";
import type {
  ContentConfig,
  DevConfig,
  LayoutFn,
  ResolvedSite,
  RobotsConfig,
  Site,
  SiteConfig,
} from "./types";

type Obj = Record<string, unknown>;

const ROOT_KEYS = [
  "site",
  "content",
  "layouts",
  "assets",
  "output",
  "sitemap",
  "robots",
  "dev",
  "lang",
];
const CONTENT_KEYS = ["directory", "include", "exclude", "defaultLayout", "route", "parseData"];
const ASSETS_KEYS = ["scripts", "styles", "publicDirectory"];
const OUTPUT_KEYS = ["directory", "trailingSlash"];
const ROBOTS_KEYS = ["indexable"];
const DEV_KEYS = ["hostname", "port"];

const ASSET_NAME = /^[A-Za-z0-9_-]+$/;

function asObject(value: unknown): Obj | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Obj;
}

function dotted(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function unknownKey(errors: Diagnostic[], path: string): void {
  errors.push({
    code: "config.unknown-key",
    severity: "error",
    message: `unknown config key "${path}"`,
  });
}

function typeError(errors: Diagnostic[], path: string, expected: string): void {
  errors.push({
    code: "config.type",
    severity: "error",
    message: `config key "${path}" must be ${expected}`,
  });
}

function checkKeys(
  obj: Obj,
  allowed: readonly string[],
  prefix: string,
  errors: Diagnostic[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) unknownKey(errors, dotted(prefix, key));
  }
}

function stringArray(value: unknown, path: string, errors: Diagnostic[]): string[] | undefined {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    typeError(errors, path, "an array of strings");
    return undefined;
  }
  return value as string[];
}

/**
 * Absolute http(s) URL, optional path prefix, no trailing slash, no
 * query/fragment — and ALREADY in canonical form (see the strict check
 * below). `canonicalUrl` is plain string concatenation of this value, so
 * anything the WHATWG parser would silently normalize (padding, empty
 * `?`/`#`, default ports, upper-case host) is a config error, never a
 * silent fix.
 */
function validateSiteUrl(value: unknown, errors: Diagnostic[]): string {
  const bad = (why: string): string => {
    errors.push({
      code: "config.site",
      severity: "error",
      message: `config key "site" must be an absolute http(s) URL${why === "" ? "" : ` ${why}`}, got ${JSON.stringify(value)}`,
    });
    return "";
  };
  if (typeof value !== "string" || value === "") return bad("");
  // Literal `?`/`#` anywhere: an EMPTY query/fragment (`https://x.dev?`)
  // parses with url.search === "" and would sail through the URL-object
  // checks while the raw `?` is still in the string — and concatenation
  // would then turn every later segment into query text.
  if (value.includes("?") || value.includes("#"))
    return bad('that must not contain a query or fragment ("?" and "#" are not allowed at all)');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad("");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return bad("with an http or https scheme");
  // A public site URL never carries credentials. Beyond being a config
  // mistake, `https://attacker@victim` is the userinfo-spoofing shape, and
  // canonicalUrl is plain concatenation — the userinfo would be stamped into
  // every canonical/og URL emitted.
  if (url.username !== "" || url.password !== "")
    return bad("that must not include a user name or password");
  if (value.endsWith("/"))
    return bad('that does not end in "/" (the trailing slash is an error, not stripped)');
  // Strict canonical form: the value must be EXACTLY what the URL serializer
  // produces (or, for a root path, that minus the trailing "/"). The parser
  // silently normalizes several things we must not accept — measured:
  // leading/trailing padding is trimmed, a dangling ":" or empty "?"/"#" is
  // dropped, internal tab/newline is removed, the default port is dropped,
  // and the scheme/host are lower-cased (IDN host becomes punycode). Each of
  // those would be stamped verbatim into every canonical/og URL emitted.
  const canonical = url.href;
  if (value !== canonical && value !== canonical.slice(0, -1)) {
    return bad(
      `already in canonical form — new URL(${JSON.stringify(value)}) serializes as ${JSON.stringify(canonical)}`,
    );
  }
  return value;
}

function validateAssetMap(
  value: unknown,
  path: string,
  errors: Diagnostic[],
): Record<string, string> {
  if (value === undefined) return {};
  const obj = asObject(value);
  if (!obj) {
    typeError(errors, path, "an object mapping asset names to entrypoint paths");
    return {};
  }
  const pairs: [string, string][] = [];
  for (const [name, entry] of Object.entries(obj)) {
    if (!ASSET_NAME.test(name)) {
      errors.push({
        code: "config.asset-name",
        severity: "error",
        message: `asset name "${name}" (config key "${path}.${name}") must match ${ASSET_NAME}`,
      });
    }
    if (typeof entry !== "string") typeError(errors, `${path}.${name}`, "a path string");
    pairs.push([name, entry as string]);
  }
  // Object.fromEntries stores own DATA properties: a `__proto__` key (own,
  // e.g. from JSON.parse) is stored as an entry, never invoked as the
  // prototype setter — a plain `out[name] = entry` would clobber the map's
  // own prototype and leak lookups through the user's object.
  return Object.fromEntries(pairs);
}

/**
 * Validate a site config and return the branded, opaque `Site`. Paths stay
 * RAW (relative to the config file); resolve them with `resolveConfigPaths`.
 * Throws `BuildError` with every problem found, sorted.
 */
export function defineSite(input: SiteConfig): Site {
  const errors: Diagnostic[] = [];
  const root = asObject(input);
  if (!root) {
    errors.push({
      code: "config.type",
      severity: "error",
      message: "the site config must be an object",
    });
    throw new BuildError(errors);
  }
  checkKeys(root, ROOT_KEYS, "", errors);

  const siteUrl = validateSiteUrl(root.site, errors);

  // content
  interface ContentDraft {
    directory: string;
    include: string[];
    exclude: string[];
    defaultLayout: string;
    route?: (arg: { relativePath: string }) => string;
    parseData?: (value: unknown, ctx: { sourcePath: string }) => unknown;
  }
  const content: ContentDraft = {
    directory: "",
    include: ["**/*.md"],
    exclude: [],
    defaultLayout: "",
  };
  const contentObj = asObject(root.content);
  if (!contentObj) {
    typeError(errors, "content", "an object");
  } else {
    checkKeys(contentObj, CONTENT_KEYS, "content", errors);
    if (typeof contentObj.directory === "string" && contentObj.directory !== "") {
      content.directory = contentObj.directory;
    } else {
      typeError(errors, "content.directory", "a non-empty path string");
    }
    if (contentObj.include !== undefined) {
      const include = stringArray(contentObj.include, "content.include", errors);
      if (include) content.include = include;
    }
    if (contentObj.exclude !== undefined) {
      const exclude = stringArray(contentObj.exclude, "content.exclude", errors);
      if (exclude) content.exclude = exclude;
    }
    if (typeof contentObj.defaultLayout !== "string" || contentObj.defaultLayout === "") {
      typeError(errors, "content.defaultLayout", "a non-empty string naming a key of layouts");
    } else {
      content.defaultLayout = contentObj.defaultLayout;
    }
    if (contentObj.route !== undefined && typeof contentObj.route !== "function") {
      typeError(errors, "content.route", "a function (relativePath) => route");
    } else if (typeof contentObj.route === "function") {
      content.route = contentObj.route as ContentConfig["route"];
    }
    if (contentObj.parseData !== undefined && typeof contentObj.parseData !== "function") {
      typeError(errors, "content.parseData", "a function (value, ctx) => data");
    } else if (typeof contentObj.parseData === "function") {
      content.parseData = contentObj.parseData as ContentConfig["parseData"];
    }
  }

  // layouts — non-empty registry of functions. The registry is
  // prototype-LESS and entries are stored with defineProperty: a `__proto__`
  // layout name (own, e.g. from JSON.parse) must be a map entry, not a
  // prototype assignment — and the defaultLayout lookup below must use
  // hasOwn, because `in` walks a clobbered prototype and would match
  // Function.prototype members ("call" in layouts) on a false pass.
  const layouts = Object.create(null) as Record<string, LayoutFn>;
  const layoutsObj = asObject(root.layouts);
  if (!layoutsObj) {
    typeError(errors, "layouts", "an object mapping layout names to functions");
  } else {
    for (const [name, fn] of Object.entries(layoutsObj)) {
      if (typeof fn !== "function") {
        errors.push({
          code: "config.layout-type",
          severity: "error",
          message: `layout "${name}" (config key "layouts.${name}") must be a function`,
        });
      } else {
        Object.defineProperty(layouts, name, {
          value: fn as LayoutFn,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (Object.keys(layoutsObj).length === 0) {
      errors.push({
        code: "config.layout-type",
        severity: "error",
        message: 'config key "layouts" must declare at least one layout',
      });
    }
  }
  if (
    content.defaultLayout !== "" &&
    layoutsObj &&
    !Object.hasOwn(layouts, content.defaultLayout)
  ) {
    errors.push({
      code: "config.layout-type",
      severity: "error",
      message: `content.defaultLayout "${content.defaultLayout}" is not a key of layouts`,
    });
  }

  // assets
  let scripts: Record<string, string> = {};
  let styles: Record<string, string> = {};
  let publicDirectory: string | undefined;
  if (root.assets !== undefined) {
    const assets = asObject(root.assets);
    if (!assets) {
      typeError(errors, "assets", "an object");
    } else {
      checkKeys(assets, ASSETS_KEYS, "assets", errors);
      scripts = validateAssetMap(assets.scripts, "assets.scripts", errors);
      styles = validateAssetMap(assets.styles, "assets.styles", errors);
      if (assets.publicDirectory !== undefined) {
        if (typeof assets.publicDirectory === "string" && assets.publicDirectory !== "") {
          publicDirectory = assets.publicDirectory;
        } else {
          typeError(errors, "assets.publicDirectory", "a non-empty path string");
        }
      }
      // scripts and styles share ONE namespace: one manifest, one output dir.
      for (const name of Object.keys(scripts).sort()) {
        if (Object.hasOwn(styles, name)) {
          errors.push({
            code: "config.asset-name-clash",
            severity: "error",
            message: `asset name "${name}" is declared in both assets.scripts and assets.styles; they share one namespace`,
          });
        }
      }
    }
  }

  // output
  let outputDir = "";
  const trailingSlash = "never";
  const outputObj = asObject(root.output);
  if (!outputObj) {
    typeError(errors, "output", "an object");
  } else {
    checkKeys(outputObj, OUTPUT_KEYS, "output", errors);
    if (typeof outputObj.directory === "string" && outputObj.directory !== "") {
      outputDir = outputObj.directory;
    } else {
      typeError(errors, "output.directory", "a non-empty path string");
    }
    if (outputObj.trailingSlash !== undefined && outputObj.trailingSlash !== "never") {
      errors.push({
        code: "config.type",
        severity: "error",
        message: `config key "output.trailingSlash" only accepts "never" in v1, got ${JSON.stringify(outputObj.trailingSlash)}`,
      });
    }
  }

  // sitemap / robots / dev / lang
  let sitemap = true;
  if (root.sitemap !== undefined) {
    if (typeof root.sitemap !== "boolean") typeError(errors, "sitemap", "a boolean");
    else sitemap = root.sitemap;
  }
  let robots: RobotsConfig | undefined;
  if (root.robots !== undefined) {
    const robotsObj = asObject(root.robots);
    if (!robotsObj) {
      typeError(errors, "robots", "an object");
    } else {
      checkKeys(robotsObj, ROBOTS_KEYS, "robots", errors);
      if (typeof robotsObj.indexable === "boolean") {
        robots = { indexable: robotsObj.indexable };
      } else {
        typeError(errors, "robots.indexable", "a boolean");
      }
    }
  }
  let dev: DevConfig | undefined;
  if (root.dev !== undefined) {
    const devObj = asObject(root.dev);
    if (!devObj) {
      typeError(errors, "dev", "an object");
    } else {
      checkKeys(devObj, DEV_KEYS, "dev", errors);
      dev = {};
      if (devObj.hostname !== undefined) {
        if (typeof devObj.hostname === "string" && devObj.hostname !== "")
          dev.hostname = devObj.hostname;
        else typeError(errors, "dev.hostname", "a non-empty string");
      }
      if (devObj.port !== undefined) {
        const port = devObj.port;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
          // JSON.stringify(NaN) is "null" — a NaN port would be reported as
          // "got null", which points the user at the wrong mistake.
          const shown =
            port === undefined ? "undefined" : Number.isNaN(port) ? "NaN" : JSON.stringify(port);
          errors.push({
            code: "config.port",
            severity: "error",
            message: `config key "dev.port" must be an integer between 1 and 65535, got ${shown}`,
          });
        } else {
          dev.port = port;
        }
      }
    }
  }
  let lang = "en";
  if (root.lang !== undefined) {
    if (typeof root.lang !== "string" || root.lang === "")
      typeError(errors, "lang", "a non-empty BCP 47 string");
    else lang = root.lang;
  }

  if (errors.length > 0) throw new BuildError(errors);

  const draft = {
    site: siteUrl,
    content,
    layouts,
    assets: {
      scripts,
      styles,
      ...(publicDirectory !== undefined ? { publicDirectory } : {}),
    },
    output: { directory: outputDir, trailingSlash },
    sitemap,
    ...(robots !== undefined ? { robots } : {}),
    ...(dev !== undefined ? { dev } : {}),
    lang,
  };
  return draft as unknown as Site;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolute(p: string): boolean {
  return posix.isAbsolute(p);
}

function resolveUnder(configDir: string, rel: string): string {
  const r = toPosix(rel);
  // A root-relative Windows path inherits the CONFIG's drive/share, not cwd.
  // Keep explicit POSIX fixtures portable when validating on Windows.
  if (isWindowsPath(configDir)) return posix.resolve(configDir, r);
  return posix.normalize(isAbsolute(r) ? r : posix.join(toPosix(configDir), r));
}

/**
 * Resolve every stored path against the CONFIG FILE's directory — never cwd
 * (a build must not depend on where it was invoked from). Returns a plain
 * resolved view; the brand stops here, this is an internal working shape.
 */
export function resolveConfigPaths(site: Site, configDir: string): ResolvedSite {
  const errors: Diagnostic[] = [];
  const dir = toPosix(configDir);
  if (typeof configDir !== "string" || !isAbsolute(dir)) {
    errors.push({
      code: "config.type",
      severity: "error",
      message: `configDir must be an absolute path, got ${JSON.stringify(configDir)}`,
    });
    throw new BuildError(errors);
  }
  return {
    configDir: posix.normalize(dir),
    site: site.site,
    content: { ...site.content, directory: resolveUnder(dir, site.content.directory) },
    layouts: site.layouts,
    assets: {
      scripts: Object.fromEntries(
        Object.entries(site.assets.scripts).map(([name, p]) => [name, resolveUnder(dir, p)]),
      ),
      styles: Object.fromEntries(
        Object.entries(site.assets.styles).map(([name, p]) => [name, resolveUnder(dir, p)]),
      ),
      ...(site.assets.publicDirectory !== undefined
        ? { publicDirectory: resolveUnder(dir, site.assets.publicDirectory) }
        : {}),
    },
    output: { ...site.output, directory: resolveUnder(dir, site.output.directory) },
    sitemap: site.sitemap,
    ...(site.robots !== undefined ? { robots: site.robots } : {}),
    ...(site.dev !== undefined ? { dev: site.dev } : {}),
    lang: site.lang,
  };
}

function overlaps(a: string, b: string): boolean {
  return pathContains(a, b) || pathContains(b, a);
}

/**
 * The output directory must not overlap any input root — otherwise a build
 * eats its own source:
 *   - content directory and publicDirectory: either containment direction is
 *     dangerous (emit into the sources, or the copy step copying a directory
 *     into itself);
 *   - every asset entrypoint: only the direction in which the OUTPUT
 *     CONTAINS the file is dangerous — emit writes, the staging→out rename
 *     and the startup `*.old`/`*.tmp-*` cleanup all write inside the output,
 *     so a source file living inside it can be clobbered. The reverse (output
 *     inside the entrypoint's directory) only adds new files to the source
 *     tree, clobbers nothing, and is the common layout (config + entrypoints
 *     at the project root, output in a subdirectory) — the same "output
 *     inside the config directory" case the one-way rule below allows.
 * Compared by path COMPONENTS, so `/out` and `/output` do not false-match.
 * Throws BuildError naming both paths of every overlap.
 */
export function checkOutputOverlap(resolved: ResolvedSite): void {
  const out = toPosix(resolved.output.directory);
  const inputs: [string, string][] = [["content.directory", toPosix(resolved.content.directory)]];
  if (resolved.assets.publicDirectory !== undefined) {
    inputs.push(["assets.publicDirectory", toPosix(resolved.assets.publicDirectory)]);
  }

  const errors: Diagnostic[] = [];
  for (const [label, path] of inputs) {
    if (overlaps(out, path)) {
      errors.push({
        code: "config.output-overlap",
        severity: "error",
        message: `output.directory "${out}" overlaps ${label} "${path}" (one contains the other or they are equal)`,
      });
    }
  }
  for (const [plane, map] of [
    ["assets.scripts", resolved.assets.scripts],
    ["assets.styles", resolved.assets.styles],
  ] as const) {
    for (const [name, entrypoint] of Object.entries(map)) {
      const file = toPosix(entrypoint);
      if (pathContains(out, file)) {
        errors.push({
          code: "config.output-overlap",
          severity: "error",
          message: `output.directory "${out}" contains ${plane}.${name} "${file}" — the build writes and cleans up inside the output and would clobber its own entrypoint`,
        });
      }
    }
  }
  // Only OUTPUT-containing-config is dangerous. The reverse is the normal
  // project/dist layout, but an ancestor output would delete the config too.
  if (pathContains(out, toPosix(resolved.configDir))) {
    errors.push({
      code: "config.output-overlap",
      severity: "error",
      message: `output.directory "${out}" contains the config directory "${resolved.configDir}" (or is the config directory itself) — publishing would delete its own config`,
    });
  }
  if (errors.length > 0) throw new BuildError(errors);
}
