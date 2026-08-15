import { FlagError, type FlagSpec, parseFlags } from "../args";

// `bundle` is the last flag surface that hand-rolled its own loop, so it kept
// the value-swallow bug the tool builtins were cured of: `--outdir` did
// `String(args[++i])` with no guard, so `bundle x.ts --outdir --minify` used
// the literal string "--minify" as the output directory and cheerfully created
// one on disk.
const SPEC: FlagSpec = {
  outdir: { type: "string" },
  outfile: { short: "o", type: "string" },
  target: { type: "string" },
  sourcemap: { type: "string" },
  minify: { short: "m", type: "boolean" },
};

const TARGETS = ["browser", "bun", "node"] as const;
const SOURCEMAPS = ["none", "inline", "external", "linked"] as const;

export async function bundle(...args: unknown[]): Promise<unknown> {
  // Called mid-pipeline the parser passes the upstream item first; a string
  // item is an entrypoint, anything else is not ours to interpret.
  const argv = args.filter((a): a is string => typeof a === "string");

  let entrypoints: string[];
  let outdir: string | undefined;
  let outfile: string | undefined;
  let target: (typeof TARGETS)[number] = "bun";
  let minify = false;
  let sourcemap: (typeof SOURCEMAPS)[number] = "none";

  try {
    // A bare `--sourcemap` has always meant "linked". parseFlags requires a
    // value for a string flag, so normalise the shorthand rather than teach the
    // parser about optional values.
    const normalised = argv.map((a) => (a === "--sourcemap" ? "--sourcemap=linked" : a));
    const { values, rest } = parseFlags(normalised, SPEC);
    entrypoints = rest;
    outdir = values.outdir as string | undefined;
    outfile = values.outfile as string | undefined;
    minify = values.minify === true;

    const t = values.target as string | undefined;
    if (t !== undefined) {
      if (!(TARGETS as readonly string[]).includes(t)) {
        throw new FlagError(`--target must be one of ${TARGETS.join(", ")} — got "${t}"`);
      }
      target = t as typeof target;
    }
    const sm = values.sourcemap as string | undefined;
    if (sm !== undefined) {
      if (!(SOURCEMAPS as readonly string[]).includes(sm)) {
        throw new FlagError(`--sourcemap must be one of ${SOURCEMAPS.join(", ")} — got "${sm}"`);
      }
      sourcemap = sm as typeof sourcemap;
    }
  } catch (err) {
    throw new Error(`bundle: ${(err as Error).message}`);
  }

  if (entrypoints.length === 0) {
    throw new Error("bundle: need at least one entrypoint");
  }

  const result = await Bun.build({ entrypoints, outdir, target, minify, sourcemap });

  if (!result.success) {
    const msgs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`bundle: ${msgs || "build failed"}`);
  }

  if (outfile) {
    const first = result.outputs[0];
    if (!first) throw new Error("bundle: build produced no outputs");
    await Bun.write(outfile, first);
    return { outfile, bytes: (await Bun.file(outfile).arrayBuffer()).byteLength };
  }

  return {
    outputs: result.outputs.map((o) => ({ path: o.path, kind: o.kind })),
    success: true,
  };
}
