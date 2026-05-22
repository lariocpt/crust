import { diff, expandTarget } from "../fixtures";
import type { MetaFixture } from "./types";

export async function loadMetaFixtures(target: string): Promise<MetaFixture[]> {
  let files: string[];
  try {
    files = await expandTarget(target);
  } catch (err) {
    throw new Error(`verify-web-links: ${(err as Error).message}`);
  }
  if (files.length === 0) {
    throw new Error(`verify-web-links: no fixture files matched ${target}`);
  }
  const out: MetaFixture[] = [];
  for (const file of files) {
    let mod: { default?: unknown };
    try {
      mod = await import(file);
    } catch (err) {
      throw new Error(`verify-web-links: import ${file} failed: ${(err as Error).message}`);
    }
    let raw = mod.default;
    if (typeof raw === "function") {
      raw = await (raw as () => unknown)();
    }
    if (raw == null) {
      throw new Error(`verify-web-links: ${file}: no default export`);
    }
    const items = Array.isArray(raw) ? raw : [raw];
    for (const it of items) {
      if (
        typeof it !== "object" ||
        it === null ||
        typeof (it as MetaFixture).url !== "string" ||
        typeof (it as MetaFixture).meta !== "object"
      ) {
        throw new Error(`verify-web-links: ${file}: fixture must be { url, meta }`);
      }
      out.push(it as MetaFixture);
    }
  }
  return out;
}

export { diff };
