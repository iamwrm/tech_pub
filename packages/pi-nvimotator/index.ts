import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureLatestAssistantSnapshot } from "./src/assistant-message.ts";
import { NvimotatorBridge } from "./src/bridge.ts";

const STATUS_KEY = "pi-nvimotator";

function attachCommand(bridgeId: number): string {
  return `nvim -c 'NvimotatorAttach ${bridgeId}'`;
}

export interface NvimotatorActivationOptions {
  createBridge?: (options: ConstructorParameters<typeof NvimotatorBridge>[0]) => NvimotatorBridge;
}

function safeNotify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  try { ctx.ui.notify(message, type); } catch { /* stale contexts must not crash Pi */ }
}

function safeStatus(ctx: ExtensionCommandContext, value: string | undefined): void {
  try { ctx.ui.setStatus(STATUS_KEY, value); } catch { /* stale contexts must not crash Pi */ }
}

export function activateNvimotator(pi: ExtensionAPI, options: NvimotatorActivationOptions = {}): void {
  const createBridge = options.createBridge ?? ((bridgeOptions) => new NvimotatorBridge(bridgeOptions));
  let bridge: NvimotatorBridge | undefined;
  let generation = 0;
  let operations: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };

  pi.registerCommand("nvim-last", {
    description: "Expose the latest assistant message to Neovim and print its numeric attach ID",
    handler: async (_args, ctx) => {
      const commandGeneration = generation;
      if (ctx.mode !== "tui") {
        safeNotify(ctx, "/nvim-last requires Pi's interactive TUI.", "error");
        return;
      }
      await ctx.waitForIdle();
      if (commandGeneration !== generation) return;
      let snapshot;
      try {
        snapshot = captureLatestAssistantSnapshot(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
      } catch (error) {
        safeNotify(ctx, error instanceof Error ? error.message : String(error), "error");
        return;
      }
      try {
        const manifest = await serialize(async () => {
          if (commandGeneration !== generation) return undefined;
          if (bridge?.isActive()) return bridge.updateSnapshot(snapshot);
          if (bridge) {
            const stale = bridge;
            bridge = undefined;
            await stale.stop().catch(() => undefined);
          }
          let candidate!: NvimotatorBridge;
          candidate = createBridge({
            snapshot,
            onSubmit: (prompt) => {
              pi.sendUserMessage(prompt, { deliverAs: "followUp" });
            },
            onClosed: () => {
              if (bridge === candidate) bridge = undefined;
              if (commandGeneration === generation) safeStatus(ctx, undefined);
            },
          });
          bridge = candidate;
          try {
            const started = await candidate.start();
            if (commandGeneration === generation) return started;
            if (bridge === candidate) bridge = undefined;
            await candidate.stop().catch(() => undefined);
            return undefined;
          } catch (error) {
            if (bridge === candidate) bridge = undefined;
            await candidate.stop().catch(() => undefined);
            throw error;
          }
        });
        if (!manifest || commandGeneration !== generation) return;
        safeStatus(ctx, `nvim-last ${manifest.bridgeId}`);
        safeNotify(
          ctx,
          `Nvimotator ready (${manifest.bridgeId})\n${attachCommand(manifest.bridgeId)}`,
          "info",
        );
      } catch (error) {
        if (commandGeneration === generation) {
          safeNotify(ctx, `Could not start Nvimotator: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    },
  });

  pi.on("session_shutdown", async () => {
    generation += 1;
    await serialize(async () => {
      const current = bridge;
      bridge = undefined;
      await current?.stop().catch(() => undefined);
    });
  });
}

export default activateNvimotator;
