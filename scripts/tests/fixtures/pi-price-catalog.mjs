export class ModelRuntime {
  static async create() {
    return { getModels: () => [
      { provider: 'openai-codex', id: 'gpt-6-sol', cost: { input: 2, tiers: [{ inputTokensAbove: 272000, input: 4 }] } },
      { provider: 'openrouter', id: 'openai/gpt-6-sol', cost: { input: 2 } },
      { provider: 'fluxion-claude', id: 'claude-opus-5-5', cost: { input: 0 } },
      { provider: 'openrouter', id: 'anthropic/claude-opus-5-5', cost: { input: 4 } },
      { provider: 'anthropic', id: 'claude-sonnet-5-5', cost: { input: 3 } },
      { provider: 'provider-a', id: 'conflicting', cost: { input: 1 } },
      { provider: 'provider-b', id: 'conflicting', cost: { input: 3 } },
    ] };
  }
}
