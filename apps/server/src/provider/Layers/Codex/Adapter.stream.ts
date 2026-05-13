/**
 * Stream parsing — maps raw Codex provider events to canonical ProviderRuntimeEvents.
 *
 * @module CodexAdapter.stream
 */

// Re-export utilities
export {
  isFatalCodexProcessStderrMessage,
  normalizeCodexTokenUsage,
  toTurnId,
  toProviderItemId,
  toTurnStatus,
  normalizeItemType,
  toCanonicalItemType,
  itemTitle,
  itemDetail,
  toRequestTypeFromMethod,
  toRequestTypeFromKind,
  toRequestTypeFromResolvedPayload,
  toCanonicalUserInputAnswers,
  toUserInputQuestions,
  toThreadState,
  contentStreamKindFromMethod,
  extractProposedPlanMarkdown,
  asRuntimeItemId,
  asRuntimeRequestId,
  asRuntimeTaskId,
} from "./Adapter.stream.utils.ts";

// Re-export base event builders
export {
  eventRawSource,
  providerRefsFromEvent,
  runtimeEventBase,
  codexEventMessage,
  codexEventBase,
  mapItemLifecycle,
} from "./Adapter.stream.base.ts";

// Re-export main event dispatcher
export { mapToRuntimeEvents } from "./Adapter.stream.handlers.ts";
