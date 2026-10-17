// Positional arguments of the script that is running: $0 $1..$9 $@ $* $#.
//
// Module state, same discipline as interrupt.ts — crust is one session, one
// thread. The script entry point (`crust file.crust a b`) calls
// setPositionals; `source file.crust a b` swaps them in for the sourced file
// via withPositionals and restores the caller's afterwards. Nothing else
// touches the state, and nothing is stashed in process.env under keys like
// "1": positionals are not environment, and an `export` dump must not show
// them leaking into every child process.
//
// Readers: expandEnv (src/args.ts) consults getPositionals() on every
// expansion, so the tokens work everywhere crust already expands $-names —
// URLs, -H values, JSON-literal sources, tool-builtin args, and crust stages.
// Shell stages never call expandEnv; there, $1 is sh's own and is always
// empty under `sh -c`.
//
// In the REPL, `-c`, and piped stdin the state stays EMPTY: $0 and every
// $N expand to "" and $# to "0" — sh's answer for a shell with no args,
// which is what a session without a script is.

export interface Positionals {
  /** The script's own path — `$0`. Empty in `-c` / piped / REPL mode. */
  argv0: string;
  /** `$1`..`$9` from here; absent positions are empty, not errors. */
  args: string[];
}

const EMPTY: Positionals = { argv0: "", args: [] };

let current: Positionals = EMPTY;

export function setPositionals(argv0: string, args: string[]): void {
  current = { argv0, args: [...args] };
}

export function getPositionals(): Positionals {
  return current;
}

/**
 * Run fn with swapped-in positionals, restoring the caller's afterwards.
 * `source` uses it so a sourced script sees ITS argv0/args and the session
 * returns to the caller's when the file ends. Awaits fn, so the restore
 * happens after the sourced lines have actually run, not before.
 */
export async function withPositionals<T>(
  argv0: string,
  args: string[],
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = current;
  setPositionals(argv0, args);
  try {
    return await fn();
  } finally {
    current = saved;
  }
}
