import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** The core tools pi exposes through its public create*ToolDefinition factories. */
export const CORE_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export function coreToolLabel(names: readonly string[]): string {
  return names.length === 0 ? "no tools" : `${names.length} tool${names.length === 1 ? "" : "s"}`;
}

/**
 * Wrap a pi ToolDefinition into an AgentTool for the raw side Agent.
 *
 * The raw Agent loop applies `prepareArguments`, validates parameters, and
 * executes without an ExtensionContext; all seven core tools tolerate a
 * missing ctx (bash skips PI_* session-env injection, read skips the
 * non-vision image note).
 */
function wrapDefinition<TDetails = unknown>(definition: ToolDefinition<any, TDetails>): AgentTool<any, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    constrainedSampling: definition.constrainedSampling,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
  };
}

/** Build the full core tool set for a side branch rooted at `cwd`. */
export function createCoreAgentTools(cwd: string): AgentTool<any>[] {
  return [
    wrapDefinition(createReadToolDefinition(cwd)),
    wrapDefinition(createWriteToolDefinition(cwd)),
    wrapDefinition(createEditToolDefinition(cwd)),
    wrapDefinition(createBashToolDefinition(cwd)),
    wrapDefinition(createGrepToolDefinition(cwd)),
    wrapDefinition(createFindToolDefinition(cwd)),
    wrapDefinition(createLsToolDefinition(cwd)),
  ];
}
