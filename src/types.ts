export interface Token {
  kind: "stage";
  text: string;
}

export type StageKind =
  | { kind: "glob"; pattern: string }
  | { kind: "range"; start: number; end: number }
  | { kind: "lambda"; source: string }
  | {
      kind: "http";
      verb: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      /** raw "Key: value" strings from -H flags (env-expanded at parse time) */
      headers: string[];
    }
  | { kind: "function"; name: string; args: string[] }
  | { kind: "time"; label: string }
  | { kind: "tail"; paths: string[]; lines: number; follow: boolean }
  | { kind: "procs"; source: string }
  | { kind: "json"; source: string }
  | { kind: "assert"; source: string }
  | { kind: "readsrc"; pattern: string }
  | { kind: "parallel"; n: number }
  | { kind: "expect"; status: number }
  | { kind: "stats"; everySec?: number }
  | { kind: "shell"; text: string };

export interface DotenvLoadRecord {
  path: string;
  mode: "overwrite" | "append";
  ts: number;
  keys: string[];
}

export interface DotenvState {
  history: DotenvLoadRecord[];
  snapshot: Record<string, string | undefined> | null;
}

export type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGUSR1" | "SIGUSR2";

export type SignalHandler = () => void | Promise<void>;

export interface Context {
  aliases: Map<string, string>;
  functions: Map<string, (...args: unknown[]) => unknown>;
  history: string[];
  exit: (code?: number) => Promise<never>;
  dotenv: DotenvState;
  signalHandlers: Map<SignalName, SignalHandler[]>;
}
