// @crust/site — the crust site generator.
//
// Scaffold (chunk 1 of the v1 build; plan: ~/.opencode/plan/crust-site-v1.md).
// This module is the public API the later chunks fill in:
//
//   defineSite — the config contract (site URL, content, assets, output)
//   html       — the fenced template runtime (value-range fence + escaping)
//   build      — the SSG pipeline (Bun.build per entrypoint, render, emit,
//                publish with the rename/copy contract)
//
// It deliberately imports NOTHING third-party yet: the scaffold must typecheck
// and test with the workspace installed but the renderer unused.
//
// Packaging: this ships as a PLAIN npm package run under Bun
// (`bunx @crust/site build`), not as a compiled binary. A compiled Bun binary
// cannot resolve bare npm specifiers from files OUTSIDE its own bundle
// (measured 2026-11-12, Bun 1.4.3/1.4.4 — crust AGENTS.md), and a site's
// `site.config.ts` and layouts are imported from disk at run time. The crust
// binary therefore carries only a redirect stub named `site`
// (crust: src/builtinFns/site.ts) that points back here.

/**
 * The version of the BuildResult/diagnostic contract (v1 = 1).
 *
 * Versioning rules (plan, "Locked decisions" 4): additive fields and enum
 * widening are minor; renames/removals/narrowing are major; diagnostic codes
 * are never repurposed; narrow enums are typed as documented-open unions.
 */
export const contractVersion = 1;
