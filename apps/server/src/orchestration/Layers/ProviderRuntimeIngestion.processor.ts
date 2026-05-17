/**
 * ProviderRuntimeIngestion.processor — processRuntimeEvent factory.
 *
 * Encapsulates the per-event runtime ingestion logic as a factory that accepts
 * pre-built cache helpers and service references.
 *
 * @module ProviderRuntimeIngestion.processor
 */
import { EventId, MessageId, ThreadId, type ThinkingActivityStreamKind } from "@bigbud/contracts";
import { Effect } from "effect";

import { type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { type OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { type ServerSettingsShape } from "../../ws/serverSettings.ts";
import { type ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
export { makeRuntimeEventProcessor } from "./ProviderRuntimeIngestion.processor.runtime.ts";

/** Service references threaded into the processor. */
export interface RuntimeProcessorServices {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly projectionTurnRepository: ProjectionTurnRepositoryShape;
}

/** Cache helpers threaded into the processor. */
export interface RuntimeProcessorCacheHelpers {
  readonly rememberAssistantMessageId: (
    threadId: ThreadId,
    turnId: string,
    messageId: MessageId,
  ) => Effect.Effect<void>;
  readonly forgetAssistantMessageId: (
    threadId: ThreadId,
    turnId: string,
    messageId: MessageId,
  ) => Effect.Effect<void>;
  readonly getAssistantMessageIdsForTurn: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<Set<MessageId>>;
  readonly clearAssistantMessageIdsForTurn: (
    threadId: ThreadId,
    turnId: string,
  ) => Effect.Effect<void>;
  readonly appendBufferedAssistantText: (
    messageId: MessageId,
    delta: string,
  ) => Effect.Effect<string>;
  readonly takeBufferedAssistantText: (messageId: MessageId) => Effect.Effect<string>;
  readonly clearBufferedAssistantText: (messageId: MessageId) => Effect.Effect<void>;
  readonly appendBufferedProposedPlan: (
    planId: string,
    delta: string,
    createdAt: string,
  ) => Effect.Effect<void>;
  readonly takeBufferedProposedPlan: (
    planId: string,
  ) => Effect.Effect<{ text: string; createdAt: string } | undefined>;
  readonly clearBufferedProposedPlan: (planId: string) => Effect.Effect<void>;
  readonly appendBufferedThinking: (input: {
    activityId: EventId;
    threadId: ThreadId;
    turnId: import("@bigbud/contracts").TurnId | undefined;
    streamKind: ThinkingActivityStreamKind;
    createdAt: string;
    delta: string;
  }) => Effect.Effect<void>;
  readonly takeBufferedThinking: (
    activityId: string,
  ) => Effect.Effect<import("../thinkingActivity.ts").BufferedThinkingActivity | undefined>;
  readonly listBufferedThinkingActivityIdsByThreadPrefix: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly listBufferedThinkingActivityIdsByTurnPrefix: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly listBufferedThinkingActivityIdsByItemToken: (
    token: string,
  ) => Effect.Effect<ReadonlyArray<string>>;
  readonly clearTurnStateForSession: (threadId: ThreadId) => Effect.Effect<void>;
}
