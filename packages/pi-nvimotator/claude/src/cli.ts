import { snapshotClaudeLastMessage } from "./snapshot.ts";
import { CliExitError, isMainModule, runFileStoreCli, type CliIo } from "../../src/file-cli.ts";

const VERSION = "0.2.0";

export { CliExitError, type CliIo };

export async function runNvimotatorCli(argv: string[], io: CliIo = process): Promise<void> {
  await runFileStoreCli(argv, io, {
    name: "nvimotator",
    version: VERSION,
    summary: "Claude Code file-store CLI for Neovim annotation",
    exportSnapshot: (options) => snapshotClaudeLastMessage({
      logPath: options.logPath,
      cwd: options.cwd,
    }),
    annotateSessionId: () => process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "claude-nvimotator",
  });
}

if (isMainModule(import.meta.url)) {
  runNvimotatorCli(process.argv).catch((error) => {
    if (error instanceof CliExitError) process.exit(error.exitCode);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
