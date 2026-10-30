# G24 — npm-packages TS tour claims "no crust runtime needed"; the bare globals it uses exist only inside the crust runtime

**Doc:** website `src/pages/docs/recipes/npm-packages.mdx` L60–81 (the TS
tour: `// bun run script.ts — direct ESM import, no crust runtime needed`,
`import slugify from "slugify"; await Pipeline.of(["Hello World"]).pipe(
(s) => slugify(s))  // → "Hello-World"`; `dedent`…; `await glob("*.md").pipe(
…) .collect()`). Audit W144 (X, severity settled), code review group (d),
2026-10-19.

## Measured (page vs `src/`, read 2026-10-18/19)

The tour's comment promises the file runs under plain bun. The three bare
names it then uses — `Pipeline`, `glob`, `range` (and the whole tour's
idiom) — are not Bun globals and are not imported in the snippet. They exist
only in the loadConfig-injected map:

- `src/config.ts` L69–90 installs the runtime globals (`Pipeline`, `range`,
  `glob`, `read`, `readAll`, `readLines`, `tail`, `procs`, `GET`/`POST`/…,
  `$`, `parallel`, `load`, `timedGet`, `statsStage`, `g.expectStage =
  expect` at L83, plus the `crust` object at L37) — inside `loadConfig`
  (L34), which runs once per process in every CRUST entry mode (index.ts
  L80/L145/L240/267/278/282). A file run by plain `bun script.ts` never
  calls loadConfig, so nothing is injected: the snippet throws
  `ReferenceError: Pipeline is not defined` as written. (W227 C, group (d);
  G13 R1.)
- There is no import escape hatch yet either: the published `crust` npm
  package has NO exports map (G13 Q1/Q2, probes P5/C2; the 2026-10-06
  drift-fix commit 288b2d3 states it plainly: "the npm package ships
  bin/lib/scripts/skills/README, no exports map"). So `from "crust/…"` is
  not a published shape the tour can rely on.
- The ONE line in the snippet that would work under plain bun is
  `import slugify from "slugify"` — standard node_modules resolution from
  the file's location (G13 R1). The failure is specifically the
  bare-globals premise, not the third-party import.
- Sub-claim (1)/(3), corrected in place 2026-10-30: the annotation question
  was inverted in the original audit. slugify 1.6.9 — the registry-current
  and audit-era version (published 2026-04-01) — does NOT lowercase by
  default: README L27 `lower: false, // convert to lower case, defaults to
  false`; source `if (options.lower)` (index.js L57). Measured 2026-10-30
  against slugify@1.6.9 pinned in node_modules: default
  `slugify("Hello World")` → `"Hello-World"`, `slugify("My Cool Title")` →
  `"My-Cool-Title"`, and only `slugify("Hello World", {lower: true})` →
  `"hello-world"`. So the TS annotation `// → "Hello-World"` was CORRECT as
  written, and the bash-twin comments (`# → hello-world`, W143; `# →
  my-cool-title` in Common patterns) were the wrong ones — corrected in
  place in the G24 site commit (see ## Commit). The W144 "X" verdict stands
  on the bare-globals premise above, not on this sub-claim.

Context: 288b2d3 (2026-10-06) already fixed this exact drift class on five
other pages ("quickstart's `bun script.ts gets crust globals` claim inverted
reality: a file run by plain bun never starts crust and gets none of them").
The npm-packages TS tour is the one surviving instance.

## Impact

A user copying the tour gets a `ReferenceError` on line one of the pipeline
and an incorrect case expectation on the slugify output — the page's central
"run it with plain bun" promise is false. This is the npm-packages page's
headline tour, so the trust cost is high relative to the fix size.

## Out of scope for this gap (cross-refs, NOT closed here)

The W143 bash tour's commands and its probe stay as-is (correct as written);
its output annotations (`# → hello-world`, `# → my-cool-title`) were wrong
under slugify 1.6.9 and were corrected in place in the G24 site commit
(2026-10-30) — the W143 row's "correct as written" basis for those comments
is thereby void. The U129
checkout-import mode (`../src/…` paths) is the honest alternative the tour
could adopt and is settled C on its own row. The (b) probes (W144's
`bun -e 'console.log(typeof range)'`-style confirmation) ride the queue and
corroborate; they are not needed for the fix.

## Fix

Website, npm-packages.mdx L60–81: rewrite the tour so it runs, keeping the
same teaching arc. Preferred shape (matches W227's own "Import what you
need from the modules, or run the file under crust" advice): (a) keep the
file as a host-mode .ts but run it inside the crust runtime — `source
script.ts` from a session (the `source` builtin dynamically imports .ts
into the runtime where the injected globals already live — U61's source
row, settled in (a)), so the bare `Pipeline`/`glob` names resolve; or
(b) keep `bun script.ts` but import explicitly from the checkout
(`import { Pipeline } from "../src/pipeline"`-style, per U129's honest
form) and drop the "no crust runtime needed" comment. (c), corrected in
place 2026-10-30: the TS annotation `// → "Hello-World"` is already CORRECT
as written (slugify 1.6.9 does not lowercase by default — see the measured
sub-claim above); the wrong annotations were the bash-twin comments,
corrected in place. Check the db-drivers.mdx
and quickstart.mdx tours for the same bare-globals idiom (288b2d3 covered
them; verify nothing regressed) and align `docs/USAGE.md` if it echoes the
"no crust runtime needed" line.

Verification: run the tour's file both ways (`bun script.ts` and under
crust) and confirm the snippet's outputs match its comments; website gates
(`bun run build`, `bun scripts/lint-examples.mjs ../crust/bin/crust`,
`bun run check-links`); the (b) W144 probe as runtime corroboration.

## Commit

`docs(recipes): npm-packages TS tour — run under the crust runtime, not plain bun (audit W144)` (site).
