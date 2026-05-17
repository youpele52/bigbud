import { TurnId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { TurnMethodDeps } from "./Adapter.session.ts";
import type { PromptResultInfo, PromptResultPart } from "./Adapter.session.prompt.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";

export function toPromptTurnEvents(input: {
  readonly record: ActiveOpencodeSession;
  readonly threadId: import("@bigbud/contracts").ThreadId;
  readonly turnId: TurnId;
  readonly promptInfo: PromptResultInfo;
  readonly promptParts: ReadonlyArray<PromptResultPart>;
  readonly syntheticEventFn: TurnMethodDeps["syntheticEventFn"];
}) {
  const { record, threadId, turnId, promptInfo, promptParts, syntheticEventFn } = input;

  return Effect.gen(function* () {
    const events = [];

    if (promptInfo.modelID) {
      record.model = promptInfo.modelID;
    }
    if (promptInfo.providerID) {
      record.providerID = promptInfo.providerID;
    }

    if (promptInfo.tokens) {
      const inputTokens = promptInfo.tokens.input ?? 0;
      const outputTokens = promptInfo.tokens.output ?? 0;
      const cachedInputTokens = promptInfo.tokens.cache?.read ?? 0;
      const usedTokens = inputTokens + outputTokens + cachedInputTokens;

      if (usedTokens > 0) {
        const usage = {
          usedTokens,
          totalProcessedTokens: usedTokens,
          ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
          ...(cachedInputTokens > 0
            ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
            : {}),
          ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
          ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
        };
        record.lastUsage = usage;
        events.push(
          yield* syntheticEventFn(
            threadId,
            "thread.token-usage.updated",
            { usage },
            {
              turnId,
              itemId: promptInfo.id,
            },
          ),
        );
      }
    }

    for (const part of promptParts) {
      if (part.type === "tool" && typeof part.tool === "string") {
        const status =
          part.state?.status === "error"
            ? "failed"
            : part.state?.status === "completed"
              ? "completed"
              : undefined;
        const detail =
          (typeof part.state?.error === "string" && part.state.error.trim().length > 0
            ? part.state.error.trim()
            : undefined) ??
          (typeof part.state?.output === "string" && part.state.output.trim().length > 0
            ? part.state.output.trim()
            : undefined);
        const title =
          (typeof part.state?.title === "string" && part.state.title.trim().length > 0
            ? part.state.title.trim()
            : undefined) ??
          (typeof part.metadata?.title === "string" && part.metadata.title.trim().length > 0
            ? part.metadata.title.trim()
            : undefined) ??
          part.tool;

        events.push(
          yield* syntheticEventFn(
            threadId,
            "item.completed",
            {
              itemType: "dynamic_tool_call",
              ...(status ? { status } : {}),
              title,
              ...(detail ? { detail } : {}),
              data: part,
            },
            {
              turnId,
              itemId: part.id,
            },
          ),
        );
      }
    }

    const assistantTextParts = promptParts.filter(
      (part) =>
        part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    );
    const assistantText = assistantTextParts
      .reduce((chunks, part) => {
        if (part.type !== "text" || typeof part.text !== "string") {
          return chunks;
        }
        const text = part.text.trim();
        if (text.length > 0) {
          chunks.push(text);
        }
        return chunks;
      }, [] as Array<string>)
      .join("\n\n");
    const assistantCompletionItemId = assistantTextParts[0]?.id ?? promptInfo.id;

    events.push(
      yield* syntheticEventFn(
        threadId,
        "item.completed",
        {
          itemType: "assistant_message",
          status: promptInfo.error ? "failed" : "completed",
          title: "Assistant message",
          ...(assistantText ? { detail: assistantText } : {}),
          data: promptInfo,
        },
        {
          turnId,
          itemId: assistantCompletionItemId,
        },
      ),
    );

    if (promptInfo.error) {
      const errorMessage =
        promptInfo.error.data?.message ?? promptInfo.error.name ?? "Unknown OpenCode error";
      record.lastError = errorMessage;

      const detail = {
        ...(promptInfo.error.name ? { name: promptInfo.error.name } : {}),
        ...(promptInfo.error.data?.message ? { message: promptInfo.error.data.message } : {}),
        ...(promptInfo.error.data?.responseBody
          ? { responseBody: promptInfo.error.data.responseBody }
          : {}),
        ...(typeof promptInfo.error.data?.statusCode === "number"
          ? { statusCode: promptInfo.error.data.statusCode }
          : {}),
      };

      events.push(
        yield* syntheticEventFn(
          threadId,
          "runtime.error",
          {
            message: errorMessage,
            class: "provider_error",
            ...(Object.keys(detail).length > 0 ? { detail } : {}),
          },
          { turnId },
        ),
      );
      events.push(
        yield* syntheticEventFn(
          threadId,
          "turn.completed",
          {
            state: "failed",
            ...(record.lastUsage ? { usage: record.lastUsage } : {}),
            errorMessage,
          },
          { turnId },
        ),
      );
    } else {
      record.lastError = undefined;
      events.push(
        yield* syntheticEventFn(
          threadId,
          "turn.completed",
          {
            state: "completed",
            ...(record.lastUsage ? { usage: record.lastUsage } : {}),
          },
          { turnId },
        ),
      );
    }

    events.push(
      yield* syntheticEventFn(threadId, "session.state.changed", {
        state: "ready",
        reason: "session.prompt.completed",
      }),
    );

    return events;
  });
}
