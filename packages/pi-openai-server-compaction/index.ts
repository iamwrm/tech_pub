/**
 * pi-openai-server-compaction — default-on native OpenAI Responses server
 * compaction (Compaction V2) for strict Codex, Fluxion-mirror, and xAI
 * Responses allowlists with explicit opt-outs.
 *
 * Extracted from `ren-public-package` `0017-openai-server-compaction` (0.10.6)
 * into this standalone package (0.1.0). Persisted entry-type names keep the
 * `ren-public-package.*` prefix so historical transcript cards in existing
 * sessions continue to render. Lifecycle ownership: IV-0003.
 *
 * Install:
 *   pi install ./packages/pi-openai-server-compaction
 */
export { default } from "./openai-server-compaction.ts";
export * from "./openai-server-compaction.ts";
