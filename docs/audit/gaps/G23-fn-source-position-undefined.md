# G23 — npm-packages page: `crust.fn` "source position" calls claim the first arg is `undefined`; the code omits the item slot entirely

**Doc:** website `src/pages/docs/recipes/npm-packages.mdx` L37–40 (the
"calling convention" block) and L183–185 ("A `crust.fn` works in both
positions"). Audit W141 (X) + W154 (duplicate claim), code review group
(b), 2026-10-18.

## Measured (page vs `src/parser.ts`, both read 2026-10-18)

Page L37–40: "Inside the pipeline the package is invoked as
`fn(item, ...staticArgs)`" — and: "Source position (`pkg arg1 | …`):
`pkg(undefined, \"arg1\")` — 'the first arg is `undefined`'". Page L183–185
repeats it: "As a **source** (first stage), the first arg is `undefined`."

`src/parser.ts` L298–313 (`buildSource`, the `function` case):

```ts
const fn = ctx?.functions.get(kind.name);
if (!fn) throw new Error(`function "${kind.name}" not registered`);
builtinHelp(kind.name, kind.args, ctx);
// Function-as-source: invoke fn(...staticArgs). If it returns (or resolves
// to) an Array, stream each element as its own item …
return Pipeline.of(
  (async function* () {
    const result = await (fn === sql ? sqlSource(kind.args) : fn(...kind.args));
    if (Array.isArray(result)) {
      for (const r of result) yield r;
    } else {
      yield result;
    }
  })(),
);
```

Source position invokes `fn(...staticArgs)` — a ZERO-ITEM call: there is no
item slot at all, so `pkg arg1 | …` calls `pkg("arg1")` and the handler's
FIRST parameter receives the first STATIC ARG, not `undefined`. The page's
documented call shape `pkg(undefined, "arg1")` (two args, first `undefined`)
is contradicted. The transform half is correct as written — `applyStage`'s
`function` case (L441–456) calls `fn(item, ...kind.args)`, exactly
`pkg(currentItem, "arg1", "arg2")`.

## Impact

A handler written against the page's documented `(item, ...staticArgs)`
contract and used in source position WITH static args will misread its
arguments: the parameter the user names `item` receives the first static
arg. Zero-static-arg sources (the page's own `listUsers` example, W155)
behave identically either way — the contradiction is in the stated general
contract, not in the worked examples.

## Out of scope for this gap (cross-refs, NOT closed here)

The (b) probe (a registered `crust.fn` that logs `arguments` in source
position) stays queued on the W141 row as runtime corroboration. The
"staticArgs are string tokens" half (lexed, env-expanded strings —
parser.ts L204 `splitArgs(...).slice(1).map(expandEnv)`) was confirmed C at
W151 and is not part of this finding.

## Fix

Website: rewrite both call-shape statements to the current contract, e.g.
"Transform position (`… | pkg arg1 arg2`): `pkg(currentItem, \"arg1\",
\"arg2\")`. Source position (`pkg arg1 | …`): `pkg(\"arg1\")` — the item
slot is absent, so a source handler's parameters are the static args
directly (and zero-arg sources simply call `fn()`)." Keep the
transform-position sentence as-is (it is correct). Check `docs/USAGE.md`
and the crust-builtins SKILL for the same call-shape claim and align all
surfaces. (Alternative — rejected as the minimal fix: change the code to
pass `undefined` first; that is a behavior change to the function-stage
contract with test implications, and the page's worked examples already fit
the code.)

Verification: the (b) source-position logging probe (register a fn, run it
as a source WITH a static arg, confirm the logged arguments are exactly the
static args); website gates (`bun run build`,
`bun scripts/lint-examples.mjs ../crust/bin/crust`, `bun run check-links`);
`bun test` if any code-side change is chosen instead.

## Commit

`docs(recipes): npm-packages crust.fn calling convention — source position has no item slot (audit W141)` (site).
