/**
 * pa-openai-server-compaction — Prime Agent entry point.
 *
 * Load this extension to replace Prime Agent's readable LLM summarizer with
 * OpenAI Responses server-side compaction for allowlisted GPT-series models
 * (see openai-server-compaction.ts for the full protocol and safety model).
 */
export {
	PA_SERVER_COMPACTION_ENV,
	buildCodexCompactionHeaders,
	buildCompactionSupportReport,
	buildCompactionWidgetLines,
	buildCompactionRequestFromSnapshot,
	buildPreparedCompactionRequest,
	buildReplacementHistory,
	buildStandardCompactionHeaders,
	buildStandardCompactionRequest,
	createOpenAIServerCompactionExtension,
	SERVER_COMPACTION_BLOCKED_REPLAY_MESSAGE,
	extractCodexAccountId,
	extractServerCompactionDetails,
	featureEnabled,
	formatCompactionSupportReport,
	formatCompactionUsage,
	injectReplayIntoSummarizationPayload,
	isPaSummarizationPayload,
	isSupportedCodexModel,
	isSupportedServerCompactionModel,
	isSupportedStandardResponsesModel,
	parseCompactionSse,
	parseRemoteUsage,
	parseStandardCompactionResponse,
	reconstructReplayHistory,
	resolveFinalProviderPayload,
	retainRecentUserItems,
	rewritePayload,
	safeDiagnostic,
	SERVER_COMPACTION_CHECK_COMMAND,
	SERVER_COMPACTION_FALLBACK_TEXT,
	SERVER_COMPACTION_SHIM_SUMMARY,
	SERVER_COMPACTION_STRATEGY,
	SERVER_COMPACTION_WIDGET_KEY,
} from "./openai-server-compaction.ts";
export { default } from "./openai-server-compaction.ts";
