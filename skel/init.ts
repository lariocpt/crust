// crust user config — copied to ~/.config/crust/init.ts on first install.
// Anything you import or register here becomes available at the shell.

declare const crust: {
  alias(name: string, cmd: string): void;
  unalias(name: string): void;
  fn(name: string, handler: (...args: any[]) => any): void;
  prompt?: (cwd: string, gitBranch: string | null) => string;
  onBeforeStart?: () => void | Promise<void>;
  onExit?: (code: number) => void | Promise<void>;
  onSignal(
    sig: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGUSR1" | "SIGUSR2",
    handler: () => void | Promise<void>,
  ): void;
};

// Aliases: shorthand for shell commands.
crust.alias("ll", "ls -la");
crust.alias("g", "git");

// Custom functions: any globally-installed npm package can become a shell stage.
// Example (uncomment after `bun add --global chalk`):
//
//   import chalk from "chalk";
//   crust.fn("red", (text: string) => chalk.red(text));
//
// Then in the shell:  echo "warning" | red

// Prompt override (optional): cwd is already ~-substituted, gitBranch is null when not in a repo.
// crust.prompt = (cwd, git) => `${cwd}${git ? ` (${git})` : ""} > `;

// Lifecycle hooks (optional):
//
//   crust.onBeforeStart = () => console.error("crust ready");
//   crust.onExit = (code) => console.error(`bye (${code})`);
//   crust.onSignal("SIGUSR1", () => console.error("got SIGUSR1"));
