export async function bundle(...args: unknown[]): Promise<unknown> {
  const positionals: string[] = [];
  let outdir: string | undefined;
  let outfile: string | undefined;
  let target: "browser" | "bun" | "node" = "bun";
  let minify = false;
  let sourcemap: "none" | "inline" | "external" | "linked" = "none";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string") continue;
    if (a === "--outdir") outdir = String(args[++i]);
    else if (a.startsWith("--outdir=")) outdir = a.slice("--outdir=".length);
    else if (a === "--outfile") outfile = String(args[++i]);
    else if (a.startsWith("--outfile=")) outfile = a.slice("--outfile=".length);
    else if (a === "--target") target = String(args[++i]) as typeof target;
    else if (a.startsWith("--target=")) target = a.slice("--target=".length) as typeof target;
    else if (a === "--minify") minify = true;
    else if (a === "--sourcemap") sourcemap = "linked";
    else if (a.startsWith("--sourcemap="))
      sourcemap = a.slice("--sourcemap=".length) as typeof sourcemap;
    else if (a.startsWith("--")) throw new Error(`bundle: unknown flag '${a}'`);
    else positionals.push(a);
  }

  if (positionals.length === 0) {
    throw new Error("bundle: need at least one entrypoint");
  }

  const result = await Bun.build({
    entrypoints: positionals,
    outdir,
    target,
    minify,
    sourcemap,
  });

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
