import { hasUnquotedShellMeta, splitArgs, stripTrailingComment } from "./args";
import {
  applyBareAssignmentLine,
  builtinInShellRefusal,
  builtins,
  isBuiltin,
  isToolBuiltin,
} from "./builtins";
import { formatItem } from "./format";
import * as interrupt from "./interrupt";
import {
  formatJobLine,
  formatSpawned,
  getJob,
  jobKillOperands,
  jobWaitSpec,
  killJob,
  listJobs,
  registerJob,
  trailingBackgroundOp,
  waitJobForeground,
} from "./jobs";
import {
  classify,
  redirectTail,
  rejectHiddenSubstitution,
  shellSyntaxPreflight,
  tokenize,
} from "./lexer";
import {
  HelpExit,
  parse,
  ShellExitError,
  unterminatedHeredoc,
  unterminatedHeredocError,
} from "./parser";
import { shellEnv } from "./shellPath";
import * as suspend from "./suspend";
import type { Context } from "./types";

// Write with honest backpressure: Bun's stdout.write returns false when the
// pipe buffer is full and queues the rest — exiting at that moment truncates
// output (observed: a 4MB item cut to 64KB). Awaiting "drain" after every
// false return keeps the queue empty, so process.exit can never eat output.
function writeStdout(s: string): Promise<void> | undefined {
  if (process.stdout.write(s)) return undefined;
  return new Promise((res) => process.stdout.once("drain", () => res()));
}

// REPL terminal hooks, passed only by the interactive loop. Scripts, -c and
// piped stdin never construct one, so those paths are structurally unchanged.
export interface ReplTty {
  /** Arm a Ctrl-C watcher (raw-mode 0x03, not SIGINT). Returns dispose. */
  onInterrupt(cb: () => void): () => void;
  /** Arm a Ctrl-Z watcher (raw-mode 0x1a): suspend the line's job(s), SIGSTOP. */
  onSuspend(cb: () => void): () => void;
  /** Cooked mode + paused editor for inherit-stdio children. Returns restore. */
  suspend(): () => void;
}

// A line ending in a backslash continues on the next one.
//
// This is the shape every multi-line pipeline in this repo's docs and the
// website is written in (`load … | stats \` / `  | assert (…)`), and crust did
// not have it: a trailing backslash is a shell metacharacter, so the line was
// classified `shell`, handed to `sh -c`, and answered `syntax error near
// unexpected token` — while BOTH doc linters join `\`+newline before parsing,
// which is exactly how the examples stayed green in CI and died in a terminal.
//
// Joined with a single space, mirroring the linters, and only after an ODD run
// of trailing backslashes: `…\\` at end of line is an escaped backslash, not a
// continuation, and stays its own line (a test pins this, because the naive
// version passes every other case here). Continuation is never inferred from
// indentation — a leading `|` is still crust's empty-stage refusal.
//
// Scripts, piped stdin, multi-line `-c` and `--check`. Not the REPL: there,
// Enter means run.
export function splitLines(source: string): string[] {
  const lines: string[] = [];
  let pending: string | null = null;
  for (const raw of source.split("\n")) {
    const line: string = pending === null ? raw : `${pending} ${raw.trim()}`;
    pending = null;
    const body: string = line.trimEnd();
    let slashes = 0;
    while (body.length > slashes && body[body.length - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1 && body.length > slashes) {
      pending = body.slice(0, -1);
      continue;
    }
    lines.push(line);
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

// Run a block of lines — a script file, piped stdin, multi-line `-c`, or a
// `source`d .crust file. Fail-fast: stop at the first failing line and
// return ITS code. Blank lines and `#` comments are skipped, which also
// covers a `#!/usr/bin/env crust` shebang on line 1.
// (builtins.ts imports this while this module imports builtins.ts — the
// cycle is call-time-only, so it's safe under ESM.)
export async function runLines(source: string, ctx: Context): Promise<number> {
  let last = 0;
  for (const l of splitLines(source)) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    last = await runLine(l, ctx);
    if (last !== 0) break;
  }
  return last;
}

// Expand aliases at the head of EVERY stage, not just the line. `alias
// hc='GET :3000/health'` is only useful if `range(0,99) | parallel 50 | hc`
// resolves it; previously only a line-leading alias expanded and anything
// mid-pipeline fell through to sh as "command not found".
//
// Single pass, deliberately: an expansion is not re-scanned, so `alias
// ls='ls -la'` terminates instead of recursing. The line is rebuilt ONLY when
// something actually expanded — tokenize() trims, so rebuilding unconditionally
// would rewrite the whitespace of every pure-shell line handed to `sh -c`.
function expandAliases(line: string, aliases: Map<string, string>): string {
  if (aliases.size === 0) return line;
  let changed = false;
  const stages = tokenize(line).map((t) => {
    const sp = t.text.indexOf(" ");
    const head = sp === -1 ? t.text : t.text.slice(0, sp);
    const expansion = aliases.get(head);
    if (expansion === undefined) return t.text;
    changed = true;
    return expansion + (sp === -1 ? "" : t.text.slice(sp));
  });
  return changed ? stages.join(" | ") : line;
}

export async function runLine(line: string, ctx: Context, tty?: ReplTty): Promise<number> {
  const trimmed = line.trim();
  if (!trimmed) return 0;

  const expanded = expandAliases(trimmed, ctx.aliases);

  const exFirstSpace = expanded.indexOf(" ");
  const exHead = exFirstSpace === -1 ? expanded : expanded.slice(0, exFirstSpace);
  const exArgs = exFirstSpace === -1 ? "" : stripTrailingComment(expanded.slice(exFirstSpace + 1));

  // `kill %1` is crust's; `kill -9 1234` is sh's. The operand decides, because a
  // pid is the outer shell's business and crust has no opinion about one — and
  // registering `kill` as a builtin wholesale would take a name every shell
  // already has (AGENTS rule 3). So only the `%job` shape is intercepted here and
  // every other `kill` line continues down to `sh -c` untouched.
  if (exHead === "kill") {
    const targets = jobKillOperands(exArgs.trim() ? splitArgs(exArgs.trim()) : []);
    if (targets) {
      let code = 0;
      for (const target of targets) {
        const job = getJob(target.spec);
        if (!job) {
          process.stderr.write(`crust: no job ${target.spec}\n`);
          code = 1;
          continue;
        }
        if (!killJob(job, target.signal)) {
          // The signal hit nothing. Saying `killed` would be the lie this repo
          // exists not to tell, so the line fails.
          process.stderr.write(`crust: job ${job.index} is already gone\n`);
          code = 1;
          continue;
        }
        // What crust KNOWS is that the signal was sent — not that the job is dead.
        // A `sh -c` still starting up holds SIGTERM pending (measured: on the very
        // next line, ~3ms later, the child was alive and listed `Running`, and died
        // within 20ms), and a job that traps the signal can outlive it entirely. So
        // the line names the send, and `jobs` reports the state it has verified.
        process.stdout.write(
          `Sent ${typeof target.signal === "number" ? `signal ${target.signal}` : target.signal} to job ${job.index} (pid ${job.pid})\n`,
        );
      }
      return code;
    }
  }

  // `wait %1` is the job wait; `wait :3000/health` is crust's readiness STAGE
  // (src/builtinFns/wait.ts). Registering `wait` as a builtin wholesale is what a
  // first pass did, and it silently swallowed every documented readiness line —
  // so, exactly as with `kill` above, the operand decides whose the line is. Bare
  // `wait` stays the stage's: waiting for ALL jobs is not implemented, and a name
  // that quietly meant two things is the thing this repo refuses to ship.
  if (exHead === "wait") {
    const spec = jobWaitSpec(exArgs.trim() ? splitArgs(exArgs.trim()) : []);
    if (spec !== null) {
      const job = getJob(spec);
      if (!job) {
        process.stderr.write(`crust: no job ${spec}\n`);
        return 1;
      }
      // This line bypasses the builtin branch below, so it arms the suspend
      // watcher here on the same terms: Ctrl-Z stops THE JOB (148), it does not
      // cancel the session. Without this, `wait %1` was the one foreground wait
      // with no way out except killing crust.
      // Both keys, on the same terms as the builtin branch below: this line
      // bypasses it, so arming only Ctrl-Z left `wait %1` with no Ctrl-C at all —
      // measured as a 15s hang with the prompt gone.
      const dispose = tty?.onInterrupt(() => {
        process.stdout.write("^C\n");
        process.emit("SIGINT");
      });
      const disposeZ = tty?.onSuspend(() => {
        process.stdout.write("^Z\n");
        suspend.fire();
      });
      if (tty) suspend.beginRun();
      try {
        // 148 (suspend) and 130 (Ctrl-C) both come back from waitJobForeground
        // itself when the press lands.
        return await waitJobForeground(job, false);
      } finally {
        if (tty) suspend.endRun();
        dispose?.();
        disposeZ?.();
      }
    }
  }

  if (isBuiltin(exHead) && !hasUnquotedShellMeta(expanded)) {
    // sh strips trailing comments from shell stages; builtin lines get the
    // same courtesy here so `dotenv .env.test # matrix run` works everywhere.
    const args = exArgs;
    // At the REPL, Ctrl-C reaches builtins as a synthetic in-process SIGINT —
    // that's what mock-server's and procs' "wait for SIGINT" handlers listen
    // for, and raw mode means no real signal ever arrives. Builtins that hold
    // the terminal (logs) arm their own watcher first thing, shadowing this.
    let fired = false;
    const dispose = tty?.onInterrupt(() => {
      fired = true;
      process.stdout.write("^C\n");
      process.emit("SIGINT");
    });
    // Ctrl-Z during a builtin suspends WHAT it is waiting on (`wait %1`, `fg %1`),
    // not the session: the bus is armed here so a builtin can register itself, and
    // the ^Z echo lives here so every builtin answers the key the same way. The
    // line reports 148 — 128+SIGTSTP, the code a shell gives a suspended job.
    let suspended = false;
    const disposeZ = tty?.onSuspend(() => {
      suspended = true;
      process.stdout.write("^Z\n");
      suspend.fire();
    });
    if (tty) suspend.beginRun();
    try {
      const result = await builtins[exHead]!(args, ctx);
      return suspended ? 148 : fired ? 130 : (result ?? 0);
    } catch (err) {
      process.stderr.write(`crust: ${(err as Error).message}\n`);
      return 1;
    } finally {
      if (tty) suspend.endRun();
      dispose?.();
      disposeZ?.();
    }
  }

  // A line of pure assignments — `FOO=x`, `PATH=$PATH:/x/bin`, `A=1 B=2` — is
  // session state, and it used to be a subprocess that forgot: `FOO=bar` ran as
  // `sh -c 'FOO=bar'`, exited 0, and the next line still expanded `$FOO` to
  // nothing. `export FOO=x` is the same code path; the two spellings now differ
  // only in typing. `FOO=x cmd` is NOT this (sh's transient prefix — the
  // variable lives for that command only) and stays sh's, as does anything
  // carrying a real metacharacter — which is only whether crust may *apply* a
  // line, not whether it may refuse one: `FOO=$(date | head -1)` has a pipe and
  // still has to be refused, or the false pass escapes through the carve-out.
  if (exHead.includes("=")) {
    const code = applyBareAssignmentLine(
      stripTrailingComment(expanded),
      !hasUnquotedShellMeta(expanded),
    );
    if (code !== null) return code;
  }

  // The gate above steps aside for shell metacharacters so `export DB='…&b=2'`
  // and friends still reach sh. A TOOL builtin NAME carrying a redirect is not
  // one of those: `mock-server spec.json > out.log` fell through to `sh -c`,
  // answered `sh: line 1: mock-server: command not found` and exited 127 — which
  // reads as crust not having the builtin. Tools run in-process, so the redirect
  // has to wrap the whole invocation. `Bun.which` keeps this from shadowing a
  // real binary by one of these names (a user's `dotenv` stays theirs).
  const redirect = isToolBuiltin(exHead) ? redirectTail(expanded) : null;
  if (redirect !== null && !Bun.which(exHead)) {
    const rest = expanded.slice(0, expanded.length - redirect.length).trim();
    process.stderr.write(
      `crust: ${exHead} is a crust builtin, it runs in-process and cannot redirect. ` +
        `Redirect the whole invocation instead: crust -c '${rest}' ${redirect.trim()}\n`,
    );
    return 1;
  }

  try {
    const tokens = tokenize(expanded);
    const isPureShell = tokens.every((t) => {
      // An empty stage is not "pure shell": sh rejects it as a syntax error
      // (`| head -3`), and crust's own message says which pipe is empty. Let it
      // through to parse(), which refuses it.
      if (t.text === "") return false;
      const kind = classify(t.text);
      // grep counts as shell here: a pure shell line (`ps aux | grep node`)
      // must keep inherit-stdio `sh -c` byte-for-byte. The native stage only
      // engages mid-pipeline in MIXED pipelines — where block-buffering bites.
      if (kind.kind !== "shell" && kind.kind !== "grep") return false;
      const h = t.text.trim().split(/\s+/)[0]!;
      return !ctx.functions.has(h);
    });

    if (!isPureShell) {
      // A pure-shell line above is one `sh -c` that parses the WHOLE line
      // before executing anything, so its syntax errors are already atomic.
      // This line is a MIXED pipeline: each shell stage becomes its own
      // `sh -c` child, so without a preflight a syntax error in stage N would
      // surface only when that child exits — after stages 1..N-1 have run.
      // Ask sh, in NOEXEC mode, about every shell stage first: a bad line
      // dies here with the stage named, and nothing has run. (F19)
      const problem = await shellSyntaxPreflight(tokens);
      if (problem) {
        const where = problem.stage === expanded.trim() ? "" : ` (stage: ${problem.stage})`;
        process.stderr.write(
          `crust: shell stage does not parse${where}: ${problem.first}\n  in: ${line}\n`,
        );
        return 2;
      }
    }

    if (isPureShell) {
      // parse() is never called on this path, so its head guard never runs —
      // and a head whose `$(…)` masks a crust stage is exactly what the guard
      // is for: `range(1,$(echo 3))` classifies as shell and would reach sh
      // as a syntax error. Mask the spans and reclassify; a genuine shell
      // head (`echo $(seq 3)`) masks back to shell and runs untouched.
      rejectHiddenSubstitution(tokens[0]!.text);
      // One crust builtin among the stages and sh reports `command not found`
      // for a tool crust runs in-process. Check every stage, not just the head:
      // `echo hi | mock-server spec.json` is the common shape of this mistake.
      for (const t of tokens) {
        const refusal = builtinInShellRefusal(t.text);
        if (refusal !== null) {
          process.stderr.write(`crust: ${refusal}\n`);
          return 1;
        }
      }
      // parse() is never called on this path, so its heredoc guard never
      // runs — ask the same question here over the whole line: one `sh -c`
      // takes it all, and sh would exit 0 on a missing terminator (the false
      // pass the refusal exists to kill).
      const marker = unterminatedHeredoc(expanded);
      if (marker !== null) throw new Error(unterminatedHeredocError(marker));
      // `cmd &` on a pure-shell line is crust's own background job. Before this it
      // "worked" by accident: sh forked a grandchild, crust forgot about it, and
      // nothing could list, wait or stop it. The job is DETACHED — its own process
      // group, so `kill %N` and Ctrl-Z reach a forking sh's whole tree. Its stdin
      // is /dev/null for the same reason sh does it: a background job must not
      // steal keystrokes from the raw-mode editor. Output stays on the terminal,
      // so a job's late output interleaves with the prompt, as it does in a shell.
      //
      // And deliberately NOT `unref()`'d, which is the opposite of what the
      // feasibility notes said to do. Measured in the real binary: a script's line
      // loop holds no event-loop handle of its own, so an unref'd child let Bun
      // decide the process was DONE — `sleep 30 &` in a .crust file skipped every
      // later line and exited 0, silently. That is the false pass this repo exists
      // to prevent. Keeping the child ref'd costs nothing instead: the REPL is held
      // open by stdin, and every crust exit goes through `shutdown()` →
      // `process.exit()`, which does not wait for children — measured 9ms to exit
      // with a 30s job still running.
      const background = trailingBackgroundOp(expanded);
      if (background !== null) {
        const proc = Bun.spawn(["sh", "-c", background], {
          stdio: ["ignore", "inherit", "inherit"],
          env: shellEnv(),
          detached: true,
        });
        const job = registerJob(proc, background, { group: true });
        process.stdout.write(`${formatSpawned(job)}\n`);
        return 0;
      }
      // At the REPL, hand the child a real terminal: cooked mode so the tty
      // itself delivers Ctrl-C (SIGINT to the foreground process group — the
      // child AND crust; we ignore ours) and interactive children (less, vim)
      // stop fighting the raw-mode editor for bytes.
      const restore = tty?.suspend();
      const ignoreSigint = (): void => {};
      if (tty) process.on("SIGINT", ignoreSigint);
      try {
        const proc = Bun.spawn(["sh", "-c", expanded], {
          stdio: ["inherit", "inherit", "inherit"],
          // Live env, not the startup snapshot — `capture` writes process.env
          // at run time and later shell lines must see $NAME. shellEnv also
          // prepends ancestor node_modules/.bin, npm-run style.
          env: shellEnv(),
        });
        await proc.exited;
        return proc.exitCode ?? 0;
      } finally {
        if (tty) process.off("SIGINT", ignoreSigint);
        restore?.();
      }
    } else if (tty) {
      // REPL pipeline: race the drain against the interrupt bus. On Ctrl-C
      // fire the bus (kills registered children, wakes parked poll sleeps),
      // queue the generator's return, and DON'T await the drain — the bus
      // guarantees unwind within a poll tick, and the prompt must come back
      // immediately.
      //
      // Ctrl-Z is the same race with the opposite effect: the bus SIGSTOPs the
      // children and turns them into jobs, and the drain is LEFT RUNNING — not
      // returned, not cancelled. A suspended pipeline is still one pipeline, and
      // `bg` has to resume it as one; unwinding here would tear the stages down
      // around a stopped child and leave the survivor writing into a closed pipe.
      interrupt.beginRun();
      suspend.beginRun();
      let seenJobs = listJobs().length;
      const dispose = tty.onInterrupt(() => {
        process.stdout.write("^C\n");
        process.emit("SIGINT");
        interrupt.fire();
      });
      const disposeZ = tty.onSuspend(() => {
        process.stdout.write("^Z\n");
        suspend.fire();
        // Say which job stopped, in the shape `jobs` uses, so the user has the
        // `%N` to hand for `bg`/`fg`/`kill` — a bare ^Z would leave them guessing.
        const all = listJobs();
        for (const job of all.slice(seenJobs)) {
          process.stdout.write(`${formatJobLine(job, true)}\n`);
        }
        seenJobs = all.length;
      });
      try {
        const gen = parse(expanded, true)(ctx).lines()[Symbol.asyncIterator]();
        const drain = (async () => {
          let res = await gen.next();
          while (!res.done) {
            const w = writeStdout(`${formatItem(res.value)}\n`);
            if (w) await w;
            res = await gen.next();
          }
        })();
        const outcome = await Promise.race([
          drain.then(() => "done" as const),
          interrupt.interruptPromise().then(() => "interrupted" as const),
          suspend.suspendPromise().then(() => "suspended" as const),
        ]);
        if (outcome === "interrupted") {
          // Late unwind errors are the cancellation, not news.
          drain.catch(() => {});
          gen.return?.(undefined)?.catch(() => {});
          return 130;
        }
        if (outcome === "suspended") {
          // 128+SIGTSTP, the code a shell reports for a suspended job. The drain
          // stays parked: it wakes when `bg` resumes the job and its output goes
          // to the terminal from there. Errors after this point — a `kill %N`
          // closing the pipe, a stage failing on resume — are not this line's news.
          drain.catch(() => {});
          return 148;
        }
        return 0;
      } finally {
        dispose();
        disposeZ();
        interrupt.endRun();
        suspend.endRun();
      }
    } else {
      const pipeline = parse(expanded)(ctx);
      for await (const item of pipeline.lines()) {
        const w = writeStdout(`${formatItem(item)}\n`);
        if (w) await w;
      }
      return 0;
    }
  } catch (err) {
    // `-h`/`--help` on a registered builtin is the usage screen, not a
    // failure: the line never ran (no request, no connection, no item
    // consumed), so the answer is the screen on stdout and exit 0 — the same
    // contract as every tool builtin's `--help`.
    if (err instanceof HelpExit) {
      process.stdout.write(`${err.usage}\n`);
      return 0;
    }
    // A shell stage that exited nonzero is reported by sh itself on the
    // inherited stderr ("command not found", tee's ENOENT, …). Adding a
    // `crust:` line on top would be noise; the child's code IS the answer.
    if (err instanceof ShellExitError) return err.code;
    process.stderr.write(`crust: ${(err as Error).message}\n`);
    return 1;
  }
}
