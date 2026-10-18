# G12 — close-out sweep (do this last, and do not skip it)

The \"Limits in v0.2\" section is the surface that rots, because nothing fails
when it drifts. This section makes the whole exercise consistent.

## 1. Rewrite `docs/USAGE.md:2175-2204`

Rename to **\"Limits\"** (no version — the section said \"v0.1.5\"/\"v0.2\"
targets while `package.json` is `0.2.0-dev`, which is how it read as pending
work). Structure:

- **Limits** — only what is still true on that commit, one line each, with the
  workaround named inline.
- **Syntax we deliberately did not add** — G02's `|>` and `[0..9]`, with the
  collision reason, so nobody re-adds them as a TODO.
- Drop every bullet that a gap above closed. A closed limit with its bullet still
  in the list is a documentation bug: users read that list as the contract.

Every crust line in the rewritten section is parsed by
`tests/docs-lint.test.ts`; run `bun test tests/docs-lint.test.ts` before commit.

## 2. Repo docs that repeat the same claims

- `docs/PLAN.md` — the parked entries for job control, `|>`, `[0..9]`,
  substitution, script args: mark each **done** (with the commit/PR) or **won't
  fix** (with the reason). Correct the \"job control needs Bun-side support\"
  line (G10's measurement).
- `docs/spec/v0.1-contract.md` — the stretch list entries (line ~128 and
  neighbours): same.
- `README.md` — feature/limits copy (grep `not supported`, `Limits`, `Ctrl`).
- `CHANGELOG.md` — every gap has its own `## [Unreleased]` entry at commit time;
  this pass checks they all exist and are in the right Added/Fixed order, and
  that behaviour changes to `export` (G04) and the script-args rejection
  removal (G05) are called out as changes, not silent additions.
- `examples/` — add the runnable examples promised in G05/G07 (args,
  capture-as-substitution) so the docs can point at a file, not just a snippet.

## 3. Website parity (`/home/lario/Projects/static-websites/crust-website`)

Branch `docs/limits-gap-closure`. The site is the half that gets forgotten —
PRs #6-#8 shipped docs changes here and left the site behind until 2026-09-09.

- Per-gap pages named in each gap file: `src/pages/docs/quickstart.mdx`,
  `intro.mdx`, `pipes-vs-typescript.mdx`, `agent-skills/cli.mdx`,
  `agent-skills/builtins.mdx`, `agent-skills/pipelines.mdx`,
  `mock-server.mdx` (it is the only page that mentions \"Limits\" today — check
  what it promises), and `src/components/Sidebar.astro` if a page is added.
- Remove any site copy that states a limit that is now closed, and any copy that
  advertises a feature that was not built.
- Gates, in this order, from the website repo, with the crust binary built first
  (`bun run build` in crust):
  1. `bun run build`
  2. `node scripts/lint-examples.mjs /home/lario/Projects/personal/crust/bin/crust`
  3. `bun run check-links`
- Open the PR even if it is \"only docs\" — an unopened website PR means the gap
  is unshipped (AGENTS.md).

## 4. crust agent KB (`/home/lario/Projects/personal/agents/hermes/crust-agent`, submodule)

Branch `docs/limits-gap-closure` **inside the submodule**:

- New `knowledge/learnings/round-10-*.md` files as named by the gaps (there may
  be more than one topic file — that is fine, rounds stop at 9, so `round-10`).
  Each must record the *measurement*, not just the fix: the SIGSTOP/SIGTSTP and
  `Subprocess.signal` findings, the piped-mode-vs-script stdin difference, the
  `capture` trailing newline, the highlighting×cursor-column trap. These are the
  things a future round re-derives at cost otherwise.
- Update `knowledge/internals/round-5-repl-and-logs.md` for every editor-seam
  change (G08, G09, G11) — that file is the map for the editor.
- `dogfood/NEXT-STEPS.md` / `CURRENT-STATE.md`: state which limits are closed and
  which remain, with the crust branch/PR, in the existing table style.
- Re-ingest so the RAG actually sees it: `agents/deploy/ingest_kb.py crust-agent`
  (read its usage first; do not guess the collection argument).
- Then commit inside the submodule, then commit the **submodule pointer bump** in
  `agents` — a KB commit that the parent doesn't reference is invisible.

## 5. Final verification, before opening the crust PR

```
cd /home/lario/Projects/personal/crust
bun test                     # baseline was 1113 pass / 1 skip / 0 fail
bun run typecheck
bunx biome check .
bun run build                # the compiled artifact is the deliverable
bin/crust --check 'range(1,3) | cat > /tmp/x.txt'   # spot-check the binary, not just src
```

Then re-run the limits list end-to-end by hand against `bin/crust`: every bullet
still in the rewritten section must be reproducible, and every closed one must
now behave the other way. This is the one check that proves the section is
true rather than merely newer.

## 6. Mark this file done

Tick the G12 box in `../CRUST_GAPS_PLAN.md` only when all three PRs are open and
all gates are green, and write the three PR numbers into this file so the trail
is recoverable.

## Commit

`docs(limits): the limits section describes what the binary actually does`
