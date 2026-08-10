/**
 * SDK-level verification of the /server-compaction-check command in a real
 * Prime Agent session: the extension is loaded through the package manager
 * (settings.packages), then the command is executed via session.prompt.
 */
import { createAgentSession } from "/home/wr/.nvm/versions/node/v24.1.0/lib/node_modules/prime-agent/dist/core/sdk.js";

process.env.PRIME_AGENT_CODING_AGENT_DIR = "/tmp/pa-dogfood-agent";

const { session } = await createAgentSession({
  cwd: "/tmp",
  agentDir: "/tmp/pa-dogfood-agent",
  thinkingLevel: "off",
  sessionManager: undefined,
});
console.log("session model:", session.getModelInfo ? JSON.stringify(session.getModelInfo()) : "(n/a)");

// Static check
await session.prompt("/server-compaction-check");
// Live dry run (real backend request, few fractions of a cent)
await session.prompt("/server-compaction-check live");

await session.dispose();
console.log("DONE");
