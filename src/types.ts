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
      flags: string[];
    }
  | { kind: "function"; name: string; args: string[] }
  | { kind: "time"; label: string }
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
