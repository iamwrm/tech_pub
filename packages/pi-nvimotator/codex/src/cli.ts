import { snapshotCodexLastMessage } from "./snapshot.ts";
import { CliExitError, isMainModule, runFileStoreCli, type CliIo } from "../../src/file-cli.ts";

const VERSION = "0.1.0";

export { CliExitError, type CliIo };

export async function runNvimotatorCli(argv: string[], io: CliIo = process): Promise<void> {
  await runFileStoreCli(argv, io, {
    name: "nvimotator",
    version: VERSION,
    summary: "Codex file-store CLI for Neovim annotation",
    exportSnapshot: (options) => snapshotCodexLastMessage({
      logPath: options.logPath,
      cwd: options.cwd,
    }),
    annotateSessionId: () => process.env.CODEX_THREAD_ID?.trim() || "codex-nvimotator",
  });
}

if (isMainModule(import.meta.url)) {
  runNvimotatorCli(process.argv).catch((error) => {
    if (error instanceof CliExitError) process.exit(error.exitCode);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
