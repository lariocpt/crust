# G22 — api-smoke-tests recipe: "Using the `sql` builtin directly" claims the upstream item is *not* auto-bound; the code binds it as the first parameter

**FIXED 2026-10-31** — site `dc4b47f` (one page:
`src/pages/docs/recipes/api-smoke-tests.mdx` — the L335 sentence now states
the current contract, the bash transform example's broken lambda is fixed,
and the ts "Source equivalent" block collects rows instead of `[]`) · W477
`X` stands and is annotated — the claim refuted live (the item binds; a
declared param wins), the row's queued (b) transform-mode probes ran and
settled its open items, and the probe found a **third defect** the audit had
only suspected: the page's own transform example crashes (`~/tmp/g22/`) ·
X-census entry annotated · audit (this commit) · KB (crust-agent submodule,
local commit only — ingest is operator-controlled, `e5dbce63`):
`round-9-registered-fns.md` gains §5 (the `sql` item-binding contract
measured; a transform emits rows one per item; `Pipeline.of([])` never runs
the pipe fn). **MCP reviewed — no overlap**: the fix is docs-only — one site
page; no `crust_*` tool's behaviour or surface changed (the binding contract
is the binary's existing behaviour, now finally documented correctly), so
`src/mcp/` and `skills/crust-mcp/SKILL.md` stay as-is (the standing order's
display-only case, recorded not skipped).

## Measured (page vs `src/builtinFns/sql.ts`, both read 2026-10-18)

Page L335: "As a transform, the static args become `(query, ...params)`; the
upstream item is *not* auto-bound, so reach for a lambda when you need to
inject a value from the stream."

`src/builtinFns/sql.ts` L276–283 (`sqlStage`) — as filed L66–74; the refs
drifted when G34's `toDollarPlaceholders` landed above it (2026-10-30),
corrected in place 2026-10-31:

```ts
const [query, ...declared] = args;
// Bind the piped item as the first parameter when the line declares none.
// It used to be dropped on the floor, so `range(1,1) | sql "… WHERE id = ?"`
// ran with zero params and returned [] — indistinguishable from "no rows
// matched". An explicitly declared parameter still wins.
const params = declared.length === 0 && item !== undefined && item !== null ? [item] : declared;
return runQuery(queryOf(query), params);
```

When the line declares NO params, the piped item IS bound as the first
parameter — the opposite of the page's sentence. The code comment documents
the flip: the item "used to be dropped on the floor", i.e. the page's wording
describes the pre-fix behavior. The advice after the claim ("reach for a
lambda") is still sound for EXPLICIT binding, but the factual premise is
stale.

## Corroboration (the pair agrees on the other side)

`skills/crust-builtins/SKILL.md` L89 (item-meaning table, `sql` row — as
filed L54; ref drifted with the file's growth, corrected in place): "the
query stays the one you wrote; the item **binds as the first parameter** when
the line declares none" — the current contract, matching the code. The two
website surfaces (api-smoke-tests L335 vs agent-skills/builtins.mdx
item-meaning table, audit W241) contradict each other; the code sides with
the SKILL/builtins side.

## Sub-claim (3) — the ts "Source equivalent" block collects an empty array (settled in code, group (e), 2026-10-19)

Page ts embed (same section): `const emails = await
Pipeline.of([]).pipe(() => Bun.sql`select id, email from users order by id
desc limit 5`).collect();` — labelled the source-equivalent of the bash
`sql "…" | (r => r.email)` line. It yields `emails = []`
deterministically: `Pipeline.of([])` takes the array arm (pipeline.ts
L30–35, body L33 — as filed L31–33) → an empty async generator; `pipe`'s
fn-arm (L76–82, body L80 — as filed L75–83) runs
`for await (const item of upstream()) yield await fn(item)` — ZERO
iterations on an empty seed, so the zero-arg fn is NEVER invoked;
`collect()` (L107–111) returns `[]`. Even if the fn had run, the rows
array would arrive as ONE item (L80 — no mid-pipeline flattening), not
five rows — doubly broken. Working forms: `Pipeline.of(await Bun.sql`…`)`
(await → array → per-row items) or the direct `Bun.sql` block the page
already carries. Refutation recorded on the W477 row this unit. **Confirmed
live 2026-10-31** — see Measured below.

## Out of scope for this gap (cross-refs, NOT closed here)

The rest of W477's probe plan (runtime against a scratch DB: what
`range(0,0)` yields, source-mode one-row-per-item streaming, the direct-
`Bun.sql` escape) stays in the (b) queue on the W477 row. (The TS-half
`collect()` question formerly listed here was SETTLED by the code review
above — refuted — and is IN scope for this gap.) The open `$1`-as-bind
question (SKILL's worked example uses `?`, the page used `$1`) was **mooted
by G34** before this gap ran: site `bad3f38` ("stop teaching `$1` as the SQL
bind") already converted the page to `?` — verified 2026-10-31 (the page's
transform example now uses `?`). The param-count-mismatch probes (a `?` with
no param and no item; two params for one `?`) stay queued on the row.

## Measured (probed 2026-10-31, `~/tmp/g22/` — `probe.sh` → `probe.log`)

Rig: scratch sqlite DB (`setup.mjs`: users 1 alpha a@example.com, 2 beta
b@example.com, 3 gamma g@other.com) via `DATABASE_URL=sqlite://./g22.sqlite`;
the real binary (`bin/crust-bin`). `range()` is INCLUSIVE (`sources.ts`
`i <= end`) — the W213 data point the W477 row asked for: `range(0,0)`
yields one item, `range(2,2)` yields `2`.

**P1a — the item auto-binds when the line declares none (the page's claim
refuted live):**

```
range(2,2) | sql "select name from users where id = ?"   →  {"name":"beta"}  exit 0
```

**P1b — control: an explicitly declared parameter still wins:**

```
range(2,2) | sql "select name from users where id = ?" 1  →  {"name":"alpha"}  exit 0
```

**P2 — the ts half (sub-claim (3) confirmed live, `ts-half.mjs`):**

```
P2a (page block as written): [] len=0
P2b (fixed form): ["g@other.com","b@example.com","a@example.com"] len=3
```

The empty seed never invokes the zero-arg pipe fn; `Pipeline.of(await
Bun.sql…)` puts the rows in the array arm and each row streams as one item.

**P3 — NEW FINDING (probe-driven): the page's own bash transform example
CRASHES:**

```
range(0, 0) | sql "select count(*) as n from users where email like ?" "%@example.com" | (rows => rows[0].n)
→ crust: undefined is not an object (evaluating 'rows[0].n')   exit 1
```

The transform streams ROWS one per item — the lambda receives the row object
(`(r => JSON.stringify(r))` → `{"n":2}`), not the array and not the item —
so `rows[0]` is undefined. The W477 row had predicted exactly this fork ("a
crash would be a page bug in the example, a finding"); the crash is measured.
The working tail is `(r => r.n)` → prints `2`, exit 0.

**P4 — source mode streams one row per item (the section's first bash
example):**

```
sql "select id, email from users order by id desc limit 5" | (r => r.email)
→ g@other.com / b@example.com / a@example.com   exit 0
```

## The fix

Site `api-smoke-tests.mdx`, three edits in the one section:

1. **L335 sentence** → the current contract: "when the line declares no
   params, the upstream item **binds as the first parameter** (an explicitly
   declared parameter still wins) — use a lambda when you need to control
   the value you inject." Aligned with the builtins item-meaning table and
   SKILL L89 wording.
2. **Bash transform example** (probe-found): tail `(rows => rows[0].n)` →
   `(r => r.n)` (measured: prints `2`), and the comment now states the truth
   ("the declared param wins over the item, and the rows stream one per item
   downstream") instead of "last item passes through".
3. **ts "Source equivalent" block** → `Pipeline.of(await Bun.sql\`…\`)` with
   `.pipe((r) => r.email)` — the true source equivalent of the bash line
   (rows stream as items; the lambda projects the column; `emails` actually
   holds emails).

Site gates at `dc4b47f`: build 31 pages; lint-examples 362 checked / 0
failed (the fixed bash line parses under the current binary); check-links
1313 (41 with an anchor) / 0 dead — all at baseline. No crust code changed —
the binary was already right; the crust-side change is docs/audit only.

## W477 resolution (this commit, `full-audit.md`)

- **W477** (L1170): the **X** verdict stands and is annotated — the L335
  claim refuted live (P1a/P1b), the ts half confirmed (`[]` captured), and
  the row's transform-mode fork resolved as the CRASH branch: the page's own
  example was broken and is fixed (the third defect, probe-driven, following
  the sub-claim-(3) scope-extension precedent — same section, same commit).
  Settled by the same run: `range(0,0)` INCLUSIVE (the W213 data point),
  source mode one-row-per-item, the `$1` question mooted by G34's
  `bad3f38`. Still queued on the row: the param-count-mismatch probes.
- **X census** (L110–114): `W477 (api-smoke-tests … → G22)` annotated
  `FIXED 2026-10-31 via site \`dc4b47f\``. The sub-claim-(3) census mention
  (group (e) extension) stands as filed — the main entry carries the stamp.

## Commit

- site `dc4b47f` — `docs(recipes): api-smoke-tests sql section — item binds as first param when none declared (audit W477)` (10 insertions / 6 deletions)
- crust (this commit) — dossier + plan tick + FIX-PROGRESS ⑥ + the W477 row and X-census entry in `full-audit.md`
- KB (crust-agent submodule, local commit only — ingest is operator-controlled, `e5dbce63`) — `round-9-registered-fns.md` gains "## 5. `sql` binds the piped item when the line declares no params — and the docs drifted"
