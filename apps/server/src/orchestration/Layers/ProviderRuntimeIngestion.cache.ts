import {
  type EventId,
  type MessageId,
  type ThinkingActivityStreamKind,
  type ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { Cache, Duration, Effect, Option } from "effect";

import {
  appendBufferedThinkingActivity,
  createBufferedThinkingActivity,
  type BufferedThinkingActivity,
  thinkingActivityThreadPrefix,
} from "../thinkingActivity.ts";
import {
  BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
  BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
  MAX_BUFFERED_ASSISTANT_CHARS,
  TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
} from "./ProviderRuntimeIngestion.helpers.ts";
import type { RuntimeProcessorCacheHelpers } from "./ProviderRuntimeIngestion.processor.ts";

const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const BUFFERED_THINKING_BY_ACTIVITY_ID_TTL = Duration.minutes(120);
const BUFFERED_THINKING_BY_ACTIVITY_ID_CAPACITY = 10_000;

const providerTurnKey = (threadId: ThreadId, turnId: string) => `${threadId}:${turnId}`;

export const makeRuntimeProcessorCacheHelpers = Effect.fn("makeRuntimeProcessorCacheHelpers")(
  function* (): Effect.fn.Return<RuntimeProcessorCacheHelpers> {
    const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
      capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
      timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
      lookup: () => Effect.succeed(new Set<MessageId>()),
    });

    const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
      capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
      timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
      lookup: () => Effect.succeed(""),
    });

    const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>(
      {
        capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
        timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
        lookup: () => Effect.succeed({ text: "", createdAt: "" }),
      },
    );

    const bufferedThinkingByActivityId = yield* Cache.make<string, BufferedThinkingActivity>({
      capacity: BUFFERED_THINKING_BY_ACTIVITY_ID_CAPACITY,
      timeToLive: BUFFERED_THINKING_BY_ACTIVITY_ID_TTL,
      lookup: () =>
        Effect.die(new Error("bufferedThinkingByActivityId lookup should not be used without set")),
    });

    const rememberAssistantMessageId = (threadId: ThreadId, turnId: string, messageId: MessageId) =>
      Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
        Effect.flatMap((existingIds) =>
          Cache.set(
            turnMessageIdsByTurnKey,
            providerTurnKey(threadId, turnId),
            Option.match(existingIds, {
              onNone: () => new Set([messageId]),
              onSome: (ids) => {
                const nextIds = new Set(ids);
                nextIds.add(messageId);
                return nextIds;
              },
            }),
          ),
        ),
      );

    const forgetAssistantMessageId = (threadId: ThreadId, turnId: string, messageId: MessageId) =>
      Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
        Effect.flatMap((existingIds) =>
          Option.match(existingIds, {
            onNone: () => Effect.void,
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.delete(messageId);
              if (nextIds.size === 0) {
                return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
              }
              return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
            },
          }),
        ),
      );

    const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: string) =>
      Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
        Effect.map((existingIds) =>
          Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
        ),
      );

    const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: string) =>
      Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

    const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
      Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
        Effect.flatMap(
          Effect.fn("appendBufferedAssistantText")(function* (existingText) {
            const nextText = Option.match(existingText, {
              onNone: () => delta,
              onSome: (text) => `${text}${delta}`,
            });
            if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
              yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
              return "";
            }

            yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
            return nextText;
          }),
        ),
      );

    const takeBufferedAssistantText = (messageId: MessageId) =>
      Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
        Effect.flatMap((existingText) =>
          Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
            Effect.as(Option.getOrElse(existingText, () => "")),
          ),
        ),
      );

    const clearBufferedAssistantText = (messageId: MessageId) =>
      Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

    const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
      Cache.getOption(bufferedProposedPlanById, planId).pipe(
        Effect.flatMap((existingEntry) => {
          const existing = Option.getOrUndefined(existingEntry);
          return Cache.set(bufferedProposedPlanById, planId, {
            text: `${existing?.text ?? ""}${delta}`,
            createdAt:
              existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
          });
        }),
      );

    const takeBufferedProposedPlan = (planId: string) =>
      Cache.getOption(bufferedProposedPlanById, planId).pipe(
        Effect.flatMap((existingEntry) =>
          Cache.invalidate(bufferedProposedPlanById, planId).pipe(
            Effect.as(Option.getOrUndefined(existingEntry)),
          ),
        ),
      );

    const clearBufferedProposedPlan = (planId: string) =>
      Cache.invalidate(bufferedProposedPlanById, planId);

    const appendBufferedThinking = (input: {
      activityId: EventId;
      threadId: ThreadId;
      turnId: TurnId | undefined;
      streamKind: ThinkingActivityStreamKind;
      createdAt: string;
      delta: string;
    }) =>
      Cache.getOption(bufferedThinkingByActivityId, input.activityId).pipe(
        Effect.flatMap((existingEntry) =>
          Cache.set(
            bufferedThinkingByActivityId,
            input.activityId,
            Option.match(existingEntry, {
              onNone: () => createBufferedThinkingActivity(input),
              onSome: (entry) => appendBufferedThinkingActivity(entry, input.delta),
            }),
          ),
        ),
      );

    const takeBufferedThinking = (activityId: string) =>
      Cache.getOption(bufferedThinkingByActivityId, activityId).pipe(
        Effect.flatMap((existingEntry) =>
          Cache.invalidate(bufferedThinkingByActivityId, activityId).pipe(
            Effect.as(Option.getOrUndefined(existingEntry)),
          ),
        ),
      );

    const listBufferedThinkingActivityIdsByThreadPrefix = (prefix: string) =>
      Cache.keys(bufferedThinkingByActivityId).pipe(
        Effect.map((keys) => Array.from(keys).filter((key) => key.startsWith(prefix))),
      );

    const listBufferedThinkingActivityIdsByTurnPrefix = (prefix: string) =>
      Cache.keys(bufferedThinkingByActivityId).pipe(
        Effect.map((keys) => Array.from(keys).filter((key) => key.startsWith(prefix))),
      );

    const listBufferedThinkingActivityIdsByItemToken = (token: string) =>
      Cache.keys(bufferedThinkingByActivityId).pipe(
        Effect.map((keys) => Array.from(keys).filter((key) => key.includes(token))),
      );

    const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
      threadId: ThreadId,
    ) {
      const prefix = `${threadId}:`;
      const proposedPlanPrefix = `plan:${threadId}:`;
      const thinkingPrefix = thinkingActivityThreadPrefix(threadId);
      const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
      const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
      const thinkingKeys = Array.from(yield* Cache.keys(bufferedThinkingByActivityId));
      yield* Effect.forEach(
        turnKeys,
        Effect.fn(function* (key) {
          if (!key.startsWith(prefix)) {
            return;
          }

          const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
          if (Option.isSome(messageIds)) {
            yield* Effect.forEach(messageIds.value, clearBufferedAssistantText, {
              concurrency: 1,
            }).pipe(Effect.asVoid);
          }

          yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
        }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        proposedPlanKeys,
        (key) =>
          key.startsWith(proposedPlanPrefix)
            ? Cache.invalidate(bufferedProposedPlanById, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* Effect.forEach(
        thinkingKeys,
        (key) =>
          key.startsWith(thinkingPrefix)
            ? Cache.invalidate(bufferedThinkingByActivityId, key)
            : Effect.void,
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    });

    return {
      rememberAssistantMessageId,
      forgetAssistantMessageId,
      getAssistantMessageIdsForTurn,
      clearAssistantMessageIdsForTurn,
      appendBufferedAssistantText,
      takeBufferedAssistantText,
      clearBufferedAssistantText,
      appendBufferedProposedPlan,
      takeBufferedProposedPlan,
      clearBufferedProposedPlan,
      appendBufferedThinking,
      takeBufferedThinking,
      listBufferedThinkingActivityIdsByThreadPrefix,
      listBufferedThinkingActivityIdsByTurnPrefix,
      listBufferedThinkingActivityIdsByItemToken,
      clearTurnStateForSession,
    } satisfies RuntimeProcessorCacheHelpers;
  },
);
