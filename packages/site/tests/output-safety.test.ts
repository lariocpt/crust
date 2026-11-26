import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../src/build";
import { BuildError } from "../src/diagnostics";

const roots: string[] = [];
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function snapshot(root: string, rel = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, name));
    else result[name] = (await readFile(join(root, name))).toString("base64");
  }
  return result;
}

async function fixture(output: string): Promise<{ root: string; config: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "crust-output-safety-"));
  roots.push(root);
  const dir = join(root, "project", "deep", "config");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, "content"));
  await writeFile(join(root, "content", "index.md"), "---\ntitle: Home\n---\n\n# Hello\n");
  await writeFile(join(root, "project", "keep.txt"), "unrelated bytes\n");
  const config = join(dir, "site.config.ts");
  await writeFile(
    config,
    `import { defineSite, html } from ${JSON.stringify(index)};
export default defineSite({
  site: "https://example.dev",
  content: { directory: "../../../content", defaultLayout: "base", route: () => "/" },
  layouts: { base: (ctx) => html\`<html><head><meta charset="utf-8">${"$"}{ctx.head()}</head><body>${"$"}{ctx.content}</body></html>\` },
  output: { directory: ${JSON.stringify(output)} }
});`,
  );
  return { root, config, dir };
}

describe("output cannot eat its config", () => {
  test.each([".", "..", "../.."])(
    "rejects %s before cleanup, staging, or publishing",
    async (output) => {
      const { root, config } = await fixture(output);
      const before = await snapshot(root);
      let error: unknown;
      try {
        await build({ configFile: config });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BuildError);
      expect((error as BuildError).diagnostics.map((d) => d.code)).toEqual([
        "config.output-overlap",
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect((await readdir(root)).some((name) => name.startsWith(".crust-"))).toBe(false);
    },
  );

  test.each(["dist", "../config-other"])(
    "allows safe %s and preserves the sources",
    async (output) => {
      const { root, config, dir } = await fixture(output);
      const before = await readFile(config, "utf8");
      const result = await build({ configFile: config });
      expect(result.pages).toHaveLength(1);
      expect(await readFile(join(dir, output, "index.html"), "utf8")).toContain(
        "<title>Home</title>",
      );
      expect(await readFile(config, "utf8")).toBe(before);
      expect(await readFile(join(root, "project", "keep.txt"), "utf8")).toBe("unrelated bytes\n");
      expect((await readdir(join(dir, ".."))).filter((name) => name.startsWith(".crust-"))).toEqual(
        [],
      );
      expect((await readdir(dir)).filter((name) => name.startsWith(".crust-"))).toEqual([]);
    },
  );
});
