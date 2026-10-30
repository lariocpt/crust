# G35 — the `bin/crust` launcher dies when invoked through a symlinked bin (BLOCKER)

**Status: FIXED 2026-10-30** — crust `608eb33`.

Reported in the 2026-10-30 dogfood (BUG-2), confirmed on this
checkout. Severity: blocker for the common install shapes — the launcher is what npm
ships.

## The defect

`bin/crust` in full:

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$SCRIPT_DIR/crust-bin" ]]; then
  exec "$SCRIPT_DIR/crust-bin" "$@"
else
  exec bun "$SCRIPT_DIR/../src/index.ts" "$@"
fi
```

`${BASH_SOURCE[0]}` is the path **as invoked**, not the file's real location. Bun and
npm install bins as symlinks into `node_modules/.bin/`, so `$BASH_SOURCE` is
`…/node_modules/.bin/crust` and `SCRIPT_DIR` is `.bin`, where neither branch exists:

```
error: Module not found "…/node_modules/.bin/../src/index.ts"
```

Reproduced in the dogfood through a `file:` dependency; reported as working when
invoked by real path, which is why local use never shows it.

## Why it matters more than it looks

`npm/package.json` declares `"bin": { "crust": "./bin/crust" }` and ships `bin` in
`files` — this script **is** the published launcher, and package managers install
bins by symlink. Both branches are wrong at once: no sibling `crust-bin`, and no
`../src/index.ts` beside a `.bin` directory.

## Fix

Resolve the real path before taking its directory:

```bash
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
```

`readlink -f` is GNU; macOS ships BSD `readlink` without `-f`, and the release matrix
builds darwin (x64 + arm64), so fall back (the `|| echo` above, or a `dirname`/`cd
-P` loop) rather than assuming GNU. The `[[ -x … ]]` guard already means a wrong
`SCRIPT_DIR` degrades to the second branch instead of erroring early — worth keeping,
but the second branch needs the same realpath treatment.

## Tests

- No bash test harness exists in this repo; add one that **runs the launcher from a
  symlink** in a temp dir (the exact installed shape) and asserts it executes and
  prints `--version`, with and without a sibling `crust-bin`.
- Control: invoking by real path keeps working (the case that always passed).
- Mutation-pin: revert the `readlink` line and the symlinked-bin test must go red —
  otherwise the test is only proving the case that already worked.

## Docs / KB

Behavioural, invisible in the CLI surface — no USAGE change (nothing a user types
changes), but the release note should say installs through `node_modules/.bin` work,
because that is the shape users actually have.
