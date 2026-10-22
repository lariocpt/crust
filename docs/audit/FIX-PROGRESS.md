# FIX PROGRESS

Orchestrated fix phase (2026-10-22). One line per G task; the fast 64k
subagent implements, the orchestrator verifies on disk (gates + commit) and
records the line. NEXT = the task to run next.

- NEXT: G08
- G06 | done | crust `940658a` + `e0c78a3` (tick), site `f40f6b6`, KB `22d1634d` (local only — publication/pin operator-controlled) | source runs bash scripts, exported env delta returns; 10 tests red-first; gates green (1197/0, site 351 examples / 1163 links); KB re-ingest HELD (report-only per plan)
- G07 | done | crust `085e0bf` + `e3bbf6b` (tick), site `b226311`, KB `d39aa4a` (local only; agents pointer `88372c6` local — ingest held, operator-controlled) | refuse `$(…)`/backticks on crust stages (guard in lexer+parser+runLine; names the two working routes), captureEnv trims trailing newlines; 13 tests red-first; gates green (1210/0, site 351/1163); compiled binary spot-checked (refusal exit 1 exact message; capture round-trip `[7]`; tee-through matches the documented "Items pass through unchanged")
