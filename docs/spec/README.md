# crust spec docs

Reference material — **not** parser input. Crust hand-writes a tiny parser to a defined subset; these specs are the checklist for "is this feature in or out of v0.1."

## Files

- `v0.1-contract.md` — what crust v0.1 must do, organised by module. Each section maps to a test file in `tests/`. **This is the source of truth for the green-light test suite.**
- `bash-reference.txt` — GNU bash 5.x reference manual (plaintext, fetched from gnu.org). Used as reading material when deciding "does bash do X here?" Crust does **not** reimplement bash — within-stage shell parsing is delegated to `sh -c`. The manual is here so reviewers can verify our delegation behaves bash-ish for the cases we claim to support.

## Why no POSIX spec

POSIX shell language (IEEE 1003.1 ch.2) is the formal standard but its plaintext isn't freely redistributable. The bash manual is a superset and is GPL-licensed for redistribution. For v0.1 we cite bash; v0.2+ may add a POSIX-subset compatibility note if we start caring about portability across non-bash `sh` implementations.
